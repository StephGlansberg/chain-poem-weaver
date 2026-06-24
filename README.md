# Chain Poem Weaver

Farcaster/Base Mini App prototype for collaborative poems.

## Live queue wiring (2026-06-15)

The front end is now connected to the real server matching queue. Inside a
Farcaster client with a signed-in viewer, `seal it` POSTs the trace to
`/api/random-weave` under a Quick Auth token instead of producing a local
preview. The held card then reflects **real** queue state ("N of 5 gathered",
remaining-voices hint), and `check again` GETs `/api/random-weave` to
check whether the trace has been matched. When five distinct verified voices are
present the server returns a completed weave on the spot; the UI renders it as a
real (non-preview) poem and surfaces the server-computed provenance hash + per-line
receipt plan immediately. Standalone web (no Farcaster context) keeps the
deterministic **preview** path, and if the API is unreachable the ritual falls
back to a local preview rather than dead-ending. URL/localStorage poems still
never create claim/allocation records â€” only server-stored, Quick-Auth-verified,
moderation-passed lines do. The live queue needs the Vercel serverless runtime
(or `vercel dev`); the plain `npm run dev` static server serves the preview path.
A verified Farcaster FID may have only one open live trace at a time; another
submit returns the existing pending trace until that weave completes.

## Durable storage + first-class claim/allocation records (2026-06-15)

The queue and its dormant ledger now persist through a small store abstraction
(`api/queue-store.mjs`) so they survive Vercel cold starts. Two adapters share
the exact same in-memory working shape and matching logic:

- **`FileQueueStore`** â€” a JSON file (`CHAIN_POEM_QUEUE_STORE_PATH`, default
  `data/random-weave-store.local.json`). Used locally and in CI. Default driver.
- **`PostgresQueueStore`** â€” Neon serverless Postgres. Selected automatically
  when `DATABASE_URL` is set (or `CHAIN_POEM_STORE_DRIVER=postgres`). The Neon
  driver is imported lazily, so the file/CI path never needs it installed.

Each completed poem's dormant ledger is exploded into **first-class, queryable**
rows so they no longer live only inside the poem blob: `line_receipt_claims`
and `token_allocations`, keyed on `claimKey = sha256(poemHash:lineIndex:contributor)`
(the same key the on-chain `claimed[claimKey]` replay guard uses). Schema:
`sql/schema.sql`, auto-applied by `PostgresQueueStore.init()`. Every financial
column stays pinned dormant (`enabled`/`mint_allowed`/`token_enabled`/
`airdrop_enabled` = false, `claim_state = 'locked'`) â€” flipping them is a
separate gated review, never part of a normal write.

**Free database (Neon).** Provision a free Neon Postgres (this is what "Vercel
Postgres" became â€” one-click via the Vercel marketplace), then set `DATABASE_URL`
in the Vercel project env. The `@neondatabase/serverless` HTTP driver is built
for serverless functions (no pooled connections to leak). No table setup needed â€”
`init()` runs `CREATE TABLE IF NOT EXISTS` on first use.

**Retention.** Completed poems + ledgers are kept indefinitely (they are the
provenance record). The trace queue is bounded by a sliding cap
(`MAX_STORED_TRACES = 500`) only â€” no time-based expiry.

## Moderation floor (2026-06-16)

Public promotion now has a minimum moderation floor:

- `moderation_actions` is a first-class table in `sql/schema.sql`, auto-created
  by `PostgresQueueStore.init()`.
- OP can ban/unban a FID and hide/unhide a poem through
  `node scripts/moderate-admin.mjs ...`.
- `api/admin-moderation.mjs` exists for a future dashboard/API surface, but it
  fails closed unless `CHAIN_POEM_ADMIN_TOKEN` is configured.
- Banned FIDs are excluded from future queue matching, and existing eligible
  traces from that FID are marked `moderation_blocked`.
- Hidden poems are excluded from the user poem read path.

```powershell
node scripts/moderate-admin.mjs list
node scripts/moderate-admin.mjs ban_fid --fid 123 --reason "spam"
node scripts/moderate-admin.mjs hide_poem --poemId random-abc --reason "abuse"
npm run test:moderation
```

**Wallet binding (dormant).** Quick Auth verifies the Farcaster account/FID.
The wallet does not replace that. The optional wallet button only proves "this
FID can also sign from this address" so a trace can remember where a future
receipt would settle if receipt claims were ever armed. Inside Farcaster,
`link wallet (optional)` connects the host wallet via the Mini App SDK's
EIP-1193 provider (`sdk.wallet.getEthereumProvider()`) and captures an EIP-191
`personal_sign` proof. The signed message is exact and server-checked: app
domain, fid, address, purpose, and `action:none` must match before
`address_proof_verified` can become true. The address + proof ride along with
the trace and land on that contributor's locked claim row (`recipient_address`
/ `address_proof_signature` / `address_proof_verified`, verified server-side
with `viem`). This records a dormant receipt destination only; it sends no
transaction and arms no mint. No WalletConnect is needed inside a Farcaster
client.

Standalone web now shows a top-right `connect wallet` preview control. It
prefers EIP-6963-injected wallets (Rabby, then MetaMask), falls back to legacy
`window.ethereum.providers`, and finally raw `window.ethereum`. Browser-only
proofs stay local preview state and are not sent to `/api/random-weave` unless
Quick Auth verifies the Farcaster viewer.

Wallet/connect roadmap: keep this dependency-light provider discovery for the
private validation phase. Add wagmi/Base Account/WalletConnect only when real
chain writes, mobile QR/deep links, chain switching, or paid minting are armed.
The normalized council note lives at
`artifacts/2026-06-16-poem-weaver-council-wallet-connect-recommendations.md`.

Note: `npm audit` flags `ws` (transitively via `viem`'s WebSocket transport).
This codebase only uses `viem.verifyMessage`, which is pure local secp256k1
recovery with no network/WebSocket use, so the advisory is not reachable here.

## Ritual redesign (2026-06-15)

The front end was reworked from a generic poem generator into a quiet four-page
social ritual: **intro â†’ trace â†’ unseen thread â†’ preview**. What changed and why:

- **Brand.** Reskinned from the old teal palette to the gold quill-over-weave
  brand in `assets/`. Deep near-black (`#0b0a08`), warm gold (`#d9b878`), a serif
  voice, a quill brand glyph, and faint woven threads anchored to the base of the
  screen (echoing the logo). Splash/theme color is now `#0b0a08` everywhere
  (`index.html` embed, `manifest.webmanifest`, `.well-known/farcaster.json`,
  `scripts/build-static.mjs`) so the manifest/embed stay consistent.
- **The ritual.** Each phase has its own copy and rhythm. *Intro* asks for
  consent and sets the mystery. *Trace* is a single quiet line. *Unseen thread*
  holds the line "in the dark" with a five-slot loom and a listening pulse â€”
  nothing fake is shown. *Preview* rises the weave in; companion lines are
  rendered in muted italic and labelled `awaiting a real voice`, with an honest
  "deterministic preview" disclaimer. Mystery is preserved; nothing over-explains.
- **Waiting room.** The held/unseen thread step is explicit: the user's line is
  in, more Farcasters are needed, and the invite action sends friends to
  `?view=entry&invite=weave` so they can add a phrase instead of merely viewing
  the opener's sealed line. Share/copy attempts are noted locally; actual public
  distribution is only known after the user posts a cast.
- **Random global weave.** Invite links are only a distribution path. The live
  queue itself is global: any five distinct Quick Auth-verified Farcaster FIDs
  who independently submit lines can be matched into the same completed poem.
  The server still chooses the group by stable random queue selection, then runs
  a deterministic curator pass that arranges the five untouched lines into
  opener/bridge/turn/witness/closer roles. No user text is rewritten; the
  "LLM/generator" lane can later add titles, transitions, or optional companion
  commentary, but line receipts must continue to point at the original submitted
  words.
- **Beta simulation.** The old `Begin again` control is temporarily replaced by
  `Simulate weave`. It opens a clearly labelled local five-line simulation so
  the full ritual can be inspected before the live queue fills. Simulated lines
  never create server provenance, line receipts, mints, token allocations, or
  wallet actions.
- **Buttons.** All controls are wired and there are **no hidden dead controls**.
  `begin`, `seal it`, `check again`, `open the weave`, `Invite`/`Share`,
  `Copy invite`/`Copy link`, and `Simulate weave` all work in standard-web mode
  (share uses Farcaster `composeCast` in-app and falls back to the Farcaster
  web composer; copy uses the clipboard). The Farcaster-only controls
  (`Verify Farcaster session`, `Seal provenance`) are shown **only when they can
  actually be used** â€” inside Farcaster with Quick Auth. Outside Farcaster the
  provenance panel shows a plain explanatory note instead of a disabled button.
- **NFT / provenance, end to end and fail-closed.** Completing a weave â†’
  verifying the Farcaster session (`/api/me`) â†’ sealing provenance
  (`/api/provenance`) now renders the full result in the UI: the `sha256` poem
  hash and the per-line ERC-1155 receipt mint plan (one receipt per line, with
  recipient hint and role). Minting stays **disabled** (`mintAllowed: false`,
  `contractAddress: null`) and the UI says so. The Base contract scaffold
  (`contracts/ChainPoemLineReceipts.sol`) and its env gates are unchanged.
- **Off-chain mint-readiness.** Provenance also includes `offchainMetadata`:
  ERC-721-style poem JSON plus per-line receipt metadata. It is generated,
  content-addressed, and stored with completed poem records, but remains
  `generated_offchain_not_minted`.
- **Ownership policy.** Provenance includes `ownershipPolicy`: no single owner
  for the whole poem, one future receipt per verified contributor's own line,
  and stewardship credit for the closer without control over other lines.
- **Path to real NFTs.** To turn planned line receipts into NFTs visible in a
  wallet, OpenSea, and Farcaster/Base clients, keep the order strict:
  1. publish stable metadata and images for each line receipt,
  2. deploy `contracts/ChainPoemLineReceipts.sol` on Base with a server signer
     and metadata base URI
     `https://chain-poem-weaver.vercel.app/api/line-receipt-metadata?tokenId=`,
  3. set `CHAIN_POEM_LINE_RECEIPT_CONTRACT`,
     `CHAIN_POEM_LINE_RECEIPT_SIGNER`, and
     `CHAIN_POEM_LINE_RECEIPT_BASE_URI` in Vercel,
  4. arm the Quick Auth-protected `/api/line-receipt-claim` signing endpoint,
     which only signs the verified contributor's own line claim,
  5. add an in-app claim button that uses the Farcaster/Base EVM wallet provider
     to call `claimLine`,
  6. only then flip the mint/claim flags. Until every gate is complete,
     `mintAllowed` and `contractAddress` stay false/null.
- **Accessibility.** Readable gold-on-charcoal contrast, `prefers-reduced-motion`
  honored, `:focus-visible` rings, `role="status"`/`aria-live` on status text,
  safe-area insets, and a 390px-first layout for mobile / Farcaster Mini App.
- **Preserved.** The account-association / Farcaster manifest path, the
  production build's domain rewriting, and all fail-closed NFT/provenance
  behavior are untouched. `npm test`, `npm run test:dist`, and
  `npm run test:production-rehearsal` pass; a headless browser smoke test walks
  all four phases (29/29 checks).

MVP:
- Start a poem with a title, theme, and first line.
- Add lines until the poem completes.
- Assign contribution roles and weave weights so the artifact changes based on who joins and when.
- Let contributors opt in before Farcaster profile context shapes their line.
- Verify Farcaster sessions through `/api/me` with Quick Auth when deployed on a server-capable host.
- Create server-side poem provenance packets through `/api/provenance` for future minting, while keeping `mintAllowed: false`.
- Return a dormant Base ERC-1155 line-receipt mint plan from provenance so each contributor can later mint the exact line they authored.
- Request provenance from the completed-poem UI when Farcaster Quick Auth is available.
- Encode the poem into the URL hash for shareable/offchain handoff.
- Compose a Farcaster cast with the poem invite or final poem.
- Stay standard-web compatible outside Farcaster.

Local commands:

```powershell
npm test
npm run test:hosting
npm run test:vercel-dev
npm run test:base
npm run test:manifest
npm run test:api
npm run test:provenance
npm run test:random-weave
npm run test:moderation
npm run test:random-weave-ui
npm run test:line-receipt-contract
npm run test:verify-deployment
npm run test:production-rehearsal
npm run test:dist
npm run deploy:target-check
npm run deploy:production:dry-run
npm run operator:release-brief
npm run client:template
npm run test:client-verification
npm run release:packet
npm run dev
npm run dev:vercel
```

Local serverless dev:

```powershell
Copy-Item .env.vercel-dev.example .env.vercel-dev.local
npm run dev:vercel
```

`dev:vercel` runs `vercel dev --local` on `http://127.0.0.1:3000` by default,
so the app can exercise `/api/random-weave`, `/api/me`, and `/api/provenance`
through Vercel's local serverless runtime. It defaults to the JSON file store at
`data/random-weave-store.vercel-dev.json`. To test Neon locally, put
`DATABASE_URL` in `.env.vercel-dev.local` and set `CHAIN_POEM_STORE_DRIVER=postgres`.
The script prints only whether `DATABASE_URL` is present, never the value.

Use `npm run dev` only for the static preview path. Use `npm run dev:vercel`
when testing the live queue or Postgres adapter locally. `npm run dev:vercel:linked`
is available when you intentionally want the linked Vercel project context.

Production prep:

```powershell
npm run generate:assets
$env:MINIAPP_ORIGIN="https://your-domain.example"
# Durable queue store (Neon Postgres). Without this, the file adapter is used
# and traces will not survive serverless cold starts.
$env:DATABASE_URL="postgres://...@...neon.tech/neondb?sslmode=require"
npm run signing:packet
$env:FARCASTER_ACCOUNT_ASSOCIATION_HEADER="..."
$env:FARCASTER_ACCOUNT_ASSOCIATION_PAYLOAD="..."
$env:FARCASTER_ACCOUNT_ASSOCIATION_SIGNATURE="..."
npm run deploy:target-check
npm run deploy:production:dry-run
npm run operator:release-brief
npm run build:production
npm run release:packet
npm run preflight:deploy
node dist/scripts/static-check.mjs --production
node dist/scripts/manifest-assert.mjs --production
npm run verify:deployment -- https://your-domain.example
```

`build:production` writes domain-specific manifest and embed metadata into `dist` only. It does not mutate the source placeholder manifest.
`test:hosting` writes `data/hosting-config-check.json`. It proves the current Vercel path has the production build command, `dist` output, `/poem` rewrites, `/.well-known/farcaster.json` JSON header, and Node API route assumptions OP needs before live deployment.
`test:base` writes `data/base-standard-web-readiness.json`. It proves the app can run as a standard web app when Farcaster SDK is unavailable, while Base wallet/onchain features remain dormant until Base Account or wagmi/viem is wired.
`test:production-rehearsal` writes `data/production-rehearsal-run.json`. It copies the app to a temp directory, injects fake non-secret production-shaped domain/account-association/deploy values, and proves the target, production build, release packet, preflight, manifest, Base, hosting, and production static gates without polluting the real app state.
`deploy:target-check` writes `data/deploy-target-readiness.json` with origin, account-association, deploy-provider, token, and server-capable host readiness.
`deploy:production:dry-run` writes `data/deploy-production-run.json` and chains deploy target readiness, production build, release packet, preflight, manifest, Base, hosting, and production static checks. `deploy:production:live` runs the Vercel deploy command and then `verify-deployment`.
`operator:release-brief` writes `data/operator-release-brief.md` and `.json` with the exact operator inputs, signing packet, command path, and current blockers.
`client:template` writes `data/client-verification.template.json`. After live deploy, you may fill it as `data/client-verification.json`.
`test:client-verification` writes `data/client-verification-check.json` and checks optional post-deploy Farcaster/Base client acceptance evidence: client launch, cast composer, Quick Auth/provenance, standard-web fallback, share fallback, and paid mint disabled.
There is no user-count proof gate. Client verification is optional acceptance evidence, not permission to deploy.
`test:line-receipt-contract` writes `data/line-receipt-contract-readiness.json`. It proves the Base ERC-1155 contract scaffold, replay guard, signed claim binding, provenance claim-key plan, and live-mint env gates are present while keeping deploy readiness false until contract values exist.
`test:manifest` checks that the Farcaster manifest and `fc:miniapp` embed agree on home URL, assets, domain, and account-association payload shape. Local placeholder builds warn on missing account association; production mode fails until the real signed fields exist.
`test:verify-deployment` exercises the live verifier against mocked HTTPS responses and writes `data/live-verify-run.self-test.json`.
`verify:deployment` writes `data/live-verify-run.json` after probing the live `/poem`, manifest, social embed, asset URLs, and fail-closed API routes. It still does not replace the manual Farcaster/Base client Quick Auth test.
`release:packet` writes `data/release-packet.json` with source/dist SHA-256 hashes, Quick Auth/provenance readiness, account-association status, and remaining deployment blockers.
`preflight:deploy` checks domain/account-association shape, build output, API auth scaffold, and placeholder-domain blockers before upload. It does not replace the live Farcaster/client verification step.

Creative mechanic:
- v0 uses local role/weight scaffolding: opener, bridge, turn, witness, closer.
- Later sincere contributors can outweigh earlier passive contributors in the final weave map.
- The product law is "first will be last" without turning it into an exploit: openers seed origin, late stewards can shape the final artifact more, and the interface should frame this as completion/care rather than a timing game.
- Farcaster Mini App context can shape the visible weave in v0 only when the contributor opts in. It is stored as unverified creative context, not proof of identity, wallet ownership, or token eligibility.
- The dormant `/api/me` route verifies Quick Auth JWTs with `@farcaster/quick-auth` and returns `verified: true` only after server validation.
- The dormant `/api/provenance` route requires Quick Auth, canonicalizes a complete poem, returns a SHA-256 poem hash, and keeps minting disabled until OP adds signed provenance, live auth, and operator approval.
- Provenance now includes `offchainMetadata`: ERC-721-style poem metadata plus per-line receipt metadata, generated off-chain and stored with the completed poem record.
- Provenance now includes `ownershipPolicy`: the whole poem has `no_single_owner`, each verified contributor can later claim only their own line receipt, and the completer receives stewardship credit rather than ownership over other lines.
- Provenance now includes `lineReceiptMintPlan`: a Base ERC-1155 plan with one receipt per canonical line, stable token-id seeds, stable claim keys, public line metadata, and `enabled:false` until a contract is deployed.
- `contracts/ChainPoemLineReceipts.sol` is the dormant Base ERC-1155 scaffold for signed line claims. It binds signatures to `block.chainid`, contract address, recipient, token id, claim key, poem hash, line index, and deadline, and blocks replay through `claimed`.
- The `Create provenance hash` button calls `/api/provenance` only for completed poems inside a Quick Auth context, then displays the returned hash while keeping minting disabled.
- `npm run test:provenance` proves the canonical poem hash is stable, unfinished poems are rejected, optional HMAC signatures are stable, line receipt claim keys are stable, and `mintAllowed` remains false.
- v1 can add signed Farcaster login and Base transaction/community history after explicit consent.
- Token/governance distribution stays off until usage proves the ritual is worth making financial.
- Future allocation should be pool-based: opener spark, contributor weave score, closing stewardship, curator/host, and community treasury. The poem remembers who opened the door, but it crowns the hands that finish the room; no allocation can use profile/onchain traits until those traits are explicitly consented, server-verified, and anti-sybil reviewed.

Current launch blockers:
- Five real non-dev FIDs must complete the private test loop.
- Live Quick Auth token verification must be observed inside the Farcaster client.
- A completed poem must share as a proper Farcaster embed/frame in a cast, using a URL with `?view=thread&poem=...&poemId=...`.
- `CHAIN_POEM_PROVENANCE_SECRET` and live `/api/provenance` verification are still required before any final poem hash can be treated as server-signed provenance.
- Base ERC-1155 contract deployment and wallet ownership verification are still required before line receipt NFTs can mint.
- Optional live `data/client-verification.json` receipt can document Farcaster/Base client behavior.
- Operator approval remains required before enabling paid Base minting.
