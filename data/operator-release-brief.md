# Chain Poem Weaver Operator Release Brief

Generated: 2026-06-24T14:30:46.911Z

## Status

- Origin: missing
- Domain: missing
- Missing inputs: MINIAPP_ORIGIN, FARCASTER_ACCOUNT_ASSOCIATION_HEADER, FARCASTER_ACCOUNT_ASSOCIATION_PAYLOAD, FARCASTER_ACCOUNT_ASSOCIATION_SIGNATURE, VERCEL_TOKEN
- Blockers: miniapp_origin_missing, account_association_header_missing, account_association_payload_missing, account_association_signature_missing, server_capable_deploy_provider_not_ready
- Warnings: CHAIN_POEM_PROVENANCE_SECRET missing: provenance remains unsigned preview only, CHAIN_POEM_LINE_RECEIPT_CONTRACT missing: Base line NFT mint remains disabled, CHAIN_POEM_LINE_RECEIPT_SIGNER missing: Base line NFT mint remains disabled, CHAIN_POEM_LINE_RECEIPT_BASE_URI missing: Base line NFT metadata remains disabled

## What The Operator Can Unblock

- MINIAPP_ORIGIN: required; https://your-real-domain.example.
  Why: Farcaster account association, manifest asset URLs, deployment verification, and client receipts all bind to one exact HTTPS origin.
- FARCASTER_ACCOUNT_ASSOCIATION_HEADER/PAYLOAD/SIGNATURE: required; three strings from the Farcaster Mini App manifest tool for the exact domain.
  Why: Farcaster/Base clients need a signed accountAssociation before the mini app can be treated as production-ready.
- VERCEL_TOKEN: required; Vercel token with permission to deploy this project.
  Why: The current app uses Node-style api/*.mjs routes, so Vercel is the preferred ready path.
- CHAIN_POEM_PROVENANCE_SECRET: optional; long random server secret.
  Why: Without it, provenance hashes work as unsigned preview receipts; with it, the server can sign poem provenance.
- CHAIN_POEM_LINE_RECEIPT_CONTRACT/SIGNER/BASE_URI: optional; Base ERC-1155 contract address, authorized signer, and metadata base URI.
  Why: These remain optional until the poem experience is live. Without them, every line receipt mint plan stays dormant with mintAllowed=false.
- data/client-verification.json: optional; filled from data/client-verification.template.json after live Farcaster/Base client testing.
  Why: Optional acceptance evidence after deployment: real launch, composeCast, Quick Auth/provenance, standard-web fallback, share fallback, and paid mint disabled.

## Required Operator Inputs

- Real HTTPS domain for the Mini App.
- Farcaster signed account association for the exact FQDN.
- `VERCEL_TOKEN` for the current server-capable deploy path.
- Optional `CHAIN_POEM_PROVENANCE_SECRET` when server-signed poem provenance is desired.
- Optional Base ERC-1155 line receipt contract address, signer, and metadata base URI when NFT minting is explicitly approved.
- Optional client verification evidence after live Farcaster/Base testing.

## Farcaster Signing Packet

Set `MINIAPP_ORIGIN` first, then run `npm run signing:packet`.

## Command Path

1. npm run generate:assets
1. $env:MINIAPP_ORIGIN="https://YOUR_REAL_DOMAIN"
1. npm run signing:packet
1. Set FARCASTER_ACCOUNT_ASSOCIATION_HEADER/PAYLOAD/SIGNATURE from the Farcaster manifest tool
1. Set VERCEL_TOKEN
1. npm run deploy:target-check
1. npm run deploy:production:dry-run
1. npm run deploy:production:live
1. Test inside Farcaster/Base client
1. npm run client:template
1. Optionally fill data/client-verification.json with live client evidence
1. npm run test:client-verification

## Client Verification

Optional after live deploy: run `npm run client:template`, copy/fill the template as `data/client-verification.json`, then run `npm run test:client-verification`.
The receipt must prove Farcaster launch, cast composer, Quick Auth/provenance, Base standard-web fallback, share fallback, line receipt mint plan visibility, and paid mint still disabled.

## Next

Provide the missing production inputs, then rerun npm run operator:release-brief and npm run deploy:production:dry-run.

