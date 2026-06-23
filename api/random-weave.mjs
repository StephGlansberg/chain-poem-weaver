import { createHash } from "node:crypto";
import { Errors, createClient } from "@farcaster/quick-auth";
import { cleanText, completePoem } from "../src/poem.js";
import { buildProvenance, canonicalizePoem, stableStringify } from "./provenance.mjs";
import { createEmptyQueueStore, createQueueStore, moderationState } from "./queue-store.mjs";

// createEmptyQueueStore is re-exported so existing callers/tests keep importing
// it from this module; the canonical definition now lives in queue-store.mjs.
export { createEmptyQueueStore };

export const RANDOM_WEAVE_TARGET_LINES = 5;
export const LINE_RECEIPT_CLAIM_ENABLED = false;
export const LINE_RECEIPT_MINT_ALLOWED = false;
export const TOKEN_ENABLED = false;
export const AIRDROP_ENABLED = false;
export const TOKEN_CONTRACT = null;

const quickAuth = createClient();
const MAX_BODY_BYTES = 16_000;
const MAX_STORED_TRACES = 500;
const WEAVE_ROLES = ["opener", "bridge", "turn", "witness", "closer"];

export default async function handler(request, response) {
  if (request.method === "POST") return handlePost(request, response);
  if (request.method === "GET") return handleGet(request, response);
  return sendJson(response, 405, { ok: false, error: "method_not_allowed" });
}

async function handlePost(request, response) {
  const auth = await verifyRequest(request);
  if (!auth.ok) return sendJson(response, auth.statusCode, auth.body);

  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    return sendJson(response, error.statusCode || 400, { ok: false, error: error.message || "invalid_json" });
  }

  // Optional, dormant wallet binding. Verified server-side when a signature is
  // present, but mint/token stay pinned false regardless — this only records
  // where a receipt would land if minting were ever armed.
  const wallet = await resolveWalletBinding(body, auth.fid, getExpectedDomain(request));

  const store = createQueueStore();
  const data = await store.load();
  const moderation = moderationState(data);
  if (moderation.bannedFids.includes(String(auth.fid))) {
    return sendJson(response, 403, { ok: false, error: "fid_banned", verified: true });
  }
  const existingOpenTrace = findOpenTraceForFid(data, auth.fid);
  if (existingOpenTrace) {
    return sendJson(response, 200, {
      ok: true,
      trace: publicTrace(existingOpenTrace),
      matchedPoemId: existingOpenTrace.matchedPoemId || null,
      status: existingOpenTrace.status,
      alreadyQueued: true,
      queue: {
        targetLines: RANDOM_WEAVE_TARGET_LINES,
        eligibleWaiting: countEligibleWaiting(data),
      },
      completion: null,
      storeDriver: store.driver,
      walletBound: Boolean(existingOpenTrace.recipientAddress),
      liveFinancialActions: {
        mintAllowed: LINE_RECEIPT_MINT_ALLOWED,
        tokenEnabled: TOKEN_ENABLED,
        airdropEnabled: AIRDROP_ENABLED,
      },
    });
  }
  const trace = createTrace({
    line: body?.line || body?.phrase || body?.text,
    auth,
    clientContext: body?.viewer || body?.context || {},
    wallet,
    now: new Date(),
  });
  if (!trace.ok) return sendJson(response, 422, { ok: false, error: trace.error });

  const added = addTraceToStore(data, trace.trace);
  const completion = completeNextRandomWeave(data, {
    now: new Date(),
    provenanceSecret: process.env.CHAIN_POEM_PROVENANCE_SECRET || "",
  });
  await store.persist(data);

  return sendJson(response, 200, {
    ok: true,
    trace: publicTrace(added),
    matchedPoemId: completion?.poemId || null,
    status: completion && completion.traceIds.includes(added.traceId) ? "matched" : added.status,
    completion: completion && completion.traceIds.includes(added.traceId) ? publicCompletedPoem(completion) : null,
    storeDriver: store.driver,
    walletBound: Boolean(wallet?.recipientAddress),
    liveFinancialActions: {
      mintAllowed: LINE_RECEIPT_MINT_ALLOWED,
      tokenEnabled: TOKEN_ENABLED,
      airdropEnabled: AIRDROP_ENABLED,
    },
  });
}

async function handleGet(request, response) {
  const auth = await verifyRequest(request);
  if (!auth.ok) return sendJson(response, auth.statusCode, auth.body);

  const store = createQueueStore();
  const data = await store.load();
  const moderation = moderationState(data);
  const fid = String(auth.fid || "");
  const traces = data.traces.filter((trace) => String(trace.fid) === fid).map(publicTrace);
  const poemIds = new Set(traces.map((trace) => trace.matchedPoemId).filter(Boolean));
  const hidden = new Set(moderation.hiddenPoemIds);
  const poems = data.completedPoems
    .filter((poem) => poemIds.has(poem.poemId) && !hidden.has(poem.poemId) && poem.moderationStatus !== "hidden")
    .map(publicCompletedPoem);
  return sendJson(response, 200, {
    ok: true,
    fid,
    traces,
    poems,
    queue: {
      targetLines: RANDOM_WEAVE_TARGET_LINES,
      eligibleWaiting: countEligibleWaiting(data),
    },
  });
}

export function createTrace({ line, auth, clientContext = {}, wallet = null, now = new Date() }) {
  const text = cleanText(line, 120);
  if (!text) return { ok: false, error: "line_required" };
  const moderation = moderateLine(text);
  if (!moderation.passed) return { ok: false, error: moderation.error };

  const fid = cleanText(auth?.fid, 32);
  if (!fid) return { ok: false, error: "verified_fid_required" };
  const generatedAtUtc = now.toISOString();
  const username = cleanText(clientContext.username, 32);
  const displayName = cleanText(clientContext.displayName, 42);
  const author = cleanText(clientContext.author || displayName || (username ? `@${username}` : `fid:${fid}`), 42);
  const traceId = `trace-${sha256(`${fid}:${text}:${generatedAtUtc}`).slice(0, 24)}`;
  return {
    ok: true,
    trace: {
      schemaVersion: 1,
      traceId,
      status: "eligible",
      line: text,
      fid,
      username,
      displayName,
      author,
      contextSource: "server-quick-auth",
      verified: true,
      moderationStatus: "passed",
      moderation,
      recipientAddress: wallet?.recipientAddress || null,
      addressProofSignature: wallet?.addressProofSignature || null,
      addressProofVerified: wallet?.addressProofVerified === true,
      laneId: inferLaneFromText(text),
      createdAtUtc: generatedAtUtc,
      updatedAtUtc: generatedAtUtc,
      matchedPoemId: null,
    },
  };
}

export function addTraceToStore(store, trace) {
  const existing = store.traces.find((item) => item.traceId === trace.traceId);
  if (existing) return existing;
  store.traces.push(trace);
  if (store.traces.length > MAX_STORED_TRACES) {
    store.traces = store.traces.slice(store.traces.length - MAX_STORED_TRACES);
  }
  store.updatedAtUtc = new Date().toISOString();
  return trace;
}

export function completeNextRandomWeave(store, { now = new Date(), provenanceSecret = "" } = {}) {
  const eligible = selectEligibleTraces(store);
  if (eligible.length < RANDOM_WEAVE_TARGET_LINES) return null;

  const traces = eligible.slice(0, RANDOM_WEAVE_TARGET_LINES);
  const poem = buildPoemFromTraces(traces, now);
  const validation = validateServerCompletion(poem, traces);
  if (!validation.ok) throw new Error(validation.error);

  const canonical = canonicalizePoem(poem);
  if (!canonical.ok) throw new Error(`canonicalize_failed:${canonical.error}`);
  const provenance = buildProvenance(canonical.poem, "random-weave", provenanceSecret);
  const walletByFid = buildWalletBindingMap(traces);
  const lockedLedger = buildDormantCompletionLedger(canonical.poem, provenance, walletByFid);
  const poemId = canonical.poem.poemId;
  const record = {
    schemaVersion: 1,
    kind: "random-weave-completed-poem",
    poemId,
    status: "complete",
    source: "server-random-weave",
    createdAtUtc: now.toISOString(),
    completedAtUtc: now.toISOString(),
    traceIds: traces.map((trace) => trace.traceId),
    contributorFids: traces.map((trace) => trace.fid),
    canonicalPoem: canonical.poem,
    provenance,
    dormantLedger: lockedLedger,
    invariants: {
      serverStoredOnly: true,
      quickAuthVerifiedOnly: true,
      moderationPassedOnly: true,
      distinctFidsRequired: RANDOM_WEAVE_TARGET_LINES,
      previewLinesExcluded: true,
      mintAllowedPinnedFalse: LINE_RECEIPT_MINT_ALLOWED,
      tokenEnabledPinnedFalse: TOKEN_ENABLED,
      airdropEnabledPinnedFalse: AIRDROP_ENABLED,
    },
  };

  for (const trace of traces) {
    trace.status = "matched";
    trace.matchedPoemId = poemId;
    trace.updatedAtUtc = now.toISOString();
  }
  store.completedPoems.push(record);
  store.updatedAtUtc = now.toISOString();
  return record;
}

export function selectEligibleTraces(store) {
  const seen = new Set();
  const banned = new Set(store.bannedFids || []);
  return (store.traces || [])
    .filter((trace) => trace.status === "eligible" && trace.verified === true && trace.moderationStatus === "passed")
    .filter((trace) => !banned.has(String(trace.fid)))
    .sort((a, b) => stableRandomKey(a).localeCompare(stableRandomKey(b)))
    .filter((trace) => {
      if (seen.has(trace.fid)) return false;
      seen.add(trace.fid);
      return true;
    });
}

export function findOpenTraceForFid(store, fid) {
  const id = cleanText(fid, 32);
  if (!id) return null;
  return (store.traces || [])
    .filter((trace) => String(trace.fid) === id)
    .filter((trace) => trace.status === "eligible" && trace.verified === true && trace.moderationStatus === "passed")
    .sort((a, b) =>
      String(a.createdAtUtc || "").localeCompare(String(b.createdAtUtc || "")) ||
      stableRandomKey(a).localeCompare(stableRandomKey(b))
    )[0] || null;
}

export function validateServerCompletion(poem, traces) {
  if (!poem || poem.status !== "complete") return { ok: false, error: "poem_not_complete" };
  if (!Array.isArray(poem.lines) || poem.lines.length !== RANDOM_WEAVE_TARGET_LINES) return { ok: false, error: "wrong_line_count" };
  if (!Array.isArray(traces) || traces.length !== RANDOM_WEAVE_TARGET_LINES) return { ok: false, error: "wrong_trace_count" };
  const fids = new Set();
  for (const trace of traces) {
    if (trace.status !== "eligible") return { ok: false, error: "trace_not_eligible" };
    if (trace.verified !== true || !trace.fid) return { ok: false, error: "trace_not_verified" };
    if (trace.moderationStatus !== "passed") return { ok: false, error: "trace_not_moderation_passed" };
    if (fids.has(trace.fid)) return { ok: false, error: "duplicate_fid" };
    fids.add(trace.fid);
  }
  for (const line of poem.lines) {
    if (line.contextSource !== "server-quick-auth") return { ok: false, error: "line_not_server_verified" };
    if (line.verified !== true) return { ok: false, error: "line_not_verified" };
    if (!line.fid) return { ok: false, error: "line_missing_fid" };
  }
  return { ok: true };
}

export function buildPoemFromTraces(traces, now = new Date()) {
  const selected = traces.slice(0, RANDOM_WEAVE_TARGET_LINES);
  const ordered = arrangeTracesIntoPoem(selected);
  const theme = inferDominantLane(ordered);
  const seed = stableStringify(selected.map((trace) => ({ traceId: trace.traceId, fid: trace.fid, line: trace.line })));
  const poem = {
    schemaVersion: 1,
    poemId: `random-${sha256(seed).slice(0, 24)}`,
    title: buildWeaveTitle(ordered, theme, seed),
    theme,
    laneId: theme,
    status: "open",
    mintStatus: "none",
    revealStatus: "real-weave",
    matchNote: "Five verified Farcaster traces were randomly matched, then arranged into a coherent weave.",
    weaveMethod: "deterministic-curator-v1",
    createdAtUtc: now.toISOString(),
    updatedAtUtc: now.toISOString(),
    lines: ordered.map((trace, index) => ({
      text: trace.line,
      author: trace.author || `fid:${trace.fid}`,
      fid: trace.fid,
      username: trace.username || "",
      displayName: trace.displayName || "",
      pfpUrl: "",
      contextSource: "server-quick-auth",
      verified: true,
      profileSignal: trace.username ? `@${trace.username}` : `fid:${trace.fid}`,
      onchainSignal: "",
      signal: "verified-farcaster",
      role: WEAVE_ROLES[index] || "witness",
      arrangementReason: trace.arrangementReason || "random-coherence",
      createdAtUtc: trace.createdAtUtc,
    })),
  };
  return completePoem(poem);
}

export function arrangeTracesIntoPoem(traces) {
  const candidates = traces.slice(0, RANDOM_WEAVE_TARGET_LINES).map((trace, index) => ({
    ...trace,
    _originalIndex: index,
    _features: scoreTraceForArrangement(trace),
  }));
  const slots = [];
  const used = new Set();

  placeBest("opener", (item) => item._features.opener);
  placeBest("closer", (item) => item._features.closer);
  placeBest("turn", (item) => item._features.turn);
  placeBest("bridge", (item) => item._features.bridge);
  placeBest("witness", (item) => item._features.witness);

  for (const item of candidates) {
    if (!used.has(item.traceId)) slots.push(markArrangement(item, "witness", "remaining-voice"));
  }

  const byRole = new Map(slots.map((item) => [item.arrangedRole, item]));
  const ordered = WEAVE_ROLES.map((role) => byRole.get(role)).filter(Boolean);
  for (const item of slots) {
    if (!ordered.some((entry) => entry.traceId === item.traceId)) ordered.push(item);
  }
  return ordered.slice(0, RANDOM_WEAVE_TARGET_LINES);

  function placeBest(role, scoreFn) {
    const available = candidates
      .filter((item) => !used.has(item.traceId))
      .sort((a, b) => scoreFn(b) - scoreFn(a) || stableRandomKey(a).localeCompare(stableRandomKey(b)));
    const picked = available[0];
    if (!picked) return;
    used.add(picked.traceId);
    slots.push(markArrangement(picked, role, `${role}-fit`));
  }
}

function markArrangement(trace, role, reason) {
  const { _features, _originalIndex, ...publicTrace } = trace;
  return {
    ...publicTrace,
    arrangedRole: role,
    arrangementReason: reason,
  };
}

function scoreTraceForArrangement(trace) {
  const text = cleanText(trace.line, 120);
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean);
  const length = words.length;
  const hasQuestion = /\?/.test(text);
  const hasEndingPunctuation = /[.!?]$/.test(text);
  const startsSoft = /^(a|an|the|i|we|in|under|when|before|after)\b/.test(lower);
  const temporal = /(then|now|later|before|after|again|return|still|until|dusk|morning|night|today)/.test(lower);
  const answer = /(answer|because|so|therefore|but|yet|still|while|with|without)/.test(lower);
  const witness = /(saw|heard|kept|held|remember|watch|witness|name|voice|friend|stranger)/.test(lower);
  const closure = /(end|last|close|return|home|done|whole|open|finished|forever|again)$/.test(lower)
    || /(the last|at last|finally|return|home|whole|opens?|closes?)/.test(lower);
  const image = /(gold|moon|door|thread|light|dark|room|fire|signal|ghost|dream|feed|machine|market)/.test(lower);

  return {
    opener: (startsSoft ? 6 : 0) + (length <= 6 ? 4 : 0) + (image ? 2 : 0) - (hasEndingPunctuation ? 1 : 0),
    bridge: (answer ? 4 : 0) + (temporal ? 3 : 0) + (length >= 4 && length <= 12 ? 2 : 0),
    turn: (hasQuestion ? 5 : 0) + (/(but|yet|suddenly|except|unless|why|how)/.test(lower) ? 5 : 0) + (length >= 5 ? 1 : 0),
    echo: (image ? 4 : 0) + (/(again|echo|same|still|remember|name|voice)/.test(lower) ? 4 : 0),
    witness: (witness ? 5 : 0) + (length >= 5 && length <= 14 ? 2 : 0),
    closer: (closure ? 8 : 0) + (hasEndingPunctuation ? 2 : 0) + (length <= 9 ? 2 : 0) + (temporal ? 1 : 0),
  };
}

function buildWeaveTitle(traces, theme, seed) {
  const laneTitle = {
    market: "Market weave",
    memory: "Memory weave",
    machine: "Machine weave",
    signal: "Signal weave",
    myth: "Myth weave",
    dream: "Dream weave",
  }[theme] || "Random weave";
  const keyword = pickTitleKeyword(traces, seed);
  return keyword ? `${laneTitle}: ${keyword}` : laneTitle;
}

function pickTitleKeyword(traces, seed) {
  const stop = new Set(["the", "and", "for", "with", "that", "this", "your", "into", "from", "when", "then", "still", "under", "over", "without", "someone", "something"]);
  const counts = new Map();
  for (const trace of traces) {
    const words = cleanText(trace.line, 120).toLowerCase().match(/[a-z0-9]{4,}/g) || [];
    for (const word of words) {
      if (stop.has(word)) continue;
      counts.set(word, (counts.get(word) || 0) + 1);
    }
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || sha256(`${seed}:${a[0]}`).localeCompare(sha256(`${seed}:${b[0]}`)));
  const word = ranked[0]?.[0] || "";
  return word ? word[0].toUpperCase() + word.slice(1) : "";
}

export function buildDormantCompletionLedger(canonicalPoem, provenance, walletByFid = {}) {
  const receipts = provenance?.lineReceiptMintPlan?.receipts || [];
  if (canonicalPoem.status !== "complete" || receipts.length !== RANDOM_WEAVE_TARGET_LINES) {
    throw new Error("dormant_ledger_requires_complete_real_poem");
  }
  const lineReceiptClaims = receipts.map((receipt, index) => {
    const binding = walletByFid[canonicalPoem.lines[index]?.fid] || null;
    return {
      schemaVersion: 1,
      kind: "chain-poem-line-receipt-claim-record",
      claimKey: receipt.claimKey,
      tokenId: receipt.tokenId,
      tokenIdSeed: receipt.tokenIdSeed,
      metadataUrl: receipt.metadataUrl,
      image: receipt.image,
      poemHash: provenance.poemHash,
      poemId: canonicalPoem.poemId,
      lineIndex: index,
      contributor: receipt.recipientHint,
      // Dormant wallet binding: where a receipt would land if minting were ever
      // armed. Captured + optionally proven at submit time; arms nothing.
      recipientAddress: binding?.recipientAddress || null,
      addressProofSignature: binding?.addressProofSignature || null,
      addressProofVerified: binding?.addressProofVerified === true,
      enabled: LINE_RECEIPT_CLAIM_ENABLED,
      mintAllowed: LINE_RECEIPT_MINT_ALLOWED,
      claimState: "locked",
      contractAddress: null,
    };
  });
  const tokenAllocations = receipts.map((receipt, index) => {
    const line = canonicalPoem.lines[index];
    return {
      schemaVersion: 1,
      kind: "chain-poem-token-allocation-record",
      claimKey: receipt.claimKey,
      poemHash: provenance.poemHash,
      poemId: canonicalPoem.poemId,
      lineIndex: index,
      pool: mapRoleToPool(line.role),
      pendingUnits: Number(line.weaveWeight || 0),
      tokenEnabled: TOKEN_ENABLED,
      tokenContract: TOKEN_CONTRACT,
      airdropEnabled: AIRDROP_ENABLED,
      expiresAtUtc: null,
    };
  });
  return {
    schemaVersion: 1,
    kind: "chain-poem-dormant-completion-ledger",
    generatedAtUtc: provenance.generatedAtUtc,
    lineReceiptClaims,
    tokenAllocations,
    hardPins: {
      lineReceiptClaimEnabled: LINE_RECEIPT_CLAIM_ENABLED,
      mintAllowed: LINE_RECEIPT_MINT_ALLOWED,
      tokenEnabled: TOKEN_ENABLED,
      airdropEnabled: AIRDROP_ENABLED,
      tokenContract: TOKEN_CONTRACT,
    },
  };
}

// Collect the dormant wallet bindings keyed by contributor fid so the ledger
// can stamp each line's receipt claim with where it would settle.
export function buildWalletBindingMap(traces) {
  const map = {};
  for (const trace of traces) {
    if (trace.recipientAddress) {
      map[trace.fid] = {
        recipientAddress: trace.recipientAddress,
        addressProofSignature: trace.addressProofSignature || null,
        addressProofVerified: trace.addressProofVerified === true,
      };
    }
  }
  return map;
}

// Read an optional wallet binding off the request body. If a personal_sign
// proof is supplied we verify it server-side (best effort via viem); the
// address is still recorded either way, since everything downstream is dormant.
export function buildWalletProofMessage(address, fid, domain) {
  return [
    "Poem Weaver wallet binding",
    `domain:${cleanDomain(domain)}`,
    `fid:${cleanText(fid, 32)}`,
    `address:${normalizeEvmAddress(address)}`,
    "purpose:line-receipt-destination",
    "action:none",
  ].join("\n");
}

export async function resolveWalletBinding(body, fid, domain = "") {
  const recipientAddress = normalizeEvmAddress(body?.recipientAddress || body?.wallet?.address);
  if (!recipientAddress) return null;
  const signature = cleanText(body?.addressProofSignature || body?.wallet?.signature, 200) || null;
  const message = typeof (body?.addressProofMessage || body?.wallet?.message) === "string"
    ? body.addressProofMessage || body.wallet.message
    : "";
  let verified = false;
  if (signature && message === buildWalletProofMessage(recipientAddress, fid, domain)) {
    verified = await verifyPersonalSign({ address: recipientAddress, message, signature });
  }
  return {
    recipientAddress,
    addressProofSignature: signature,
    addressProofMessage: message || null,
    addressProofVerified: verified,
  };
}

function normalizeEvmAddress(value) {
  const text = cleanText(value, 64);
  return /^0x[0-9a-fA-F]{40}$/.test(text) ? text.toLowerCase() : "";
}

async function verifyPersonalSign({ address, message, signature }) {
  try {
    const { verifyMessage } = await import("viem");
    return await verifyMessage({ address, message, signature });
  } catch {
    // viem unavailable or verification threw — record the proof unverified
    // rather than failing the submission. Nothing here arms minting.
    return false;
  }
}

function publicTrace(trace) {
  return {
    traceId: trace.traceId,
    status: trace.status,
    line: trace.line,
    fid: trace.fid,
    author: trace.author,
    laneId: trace.laneId,
    createdAtUtc: trace.createdAtUtc,
    matchedPoemId: trace.matchedPoemId,
  };
}

function publicCompletedPoem(record) {
  return {
    poemId: record.poemId,
    status: record.status,
    completedAtUtc: record.completedAtUtc,
    poemHash: record.provenance?.poemHash || null,
    canonicalPoem: record.canonicalPoem,
    lineReceiptClaims: record.dormantLedger?.lineReceiptClaims || [],
    tokenAllocations: record.dormantLedger?.tokenAllocations || [],
    liveFinancialActions: record.invariants || {},
  };
}

function countEligibleWaiting(store) {
  return selectEligibleTraces(store).length;
}

function moderateLine(text) {
  const lower = text.toLowerCase();
  if (/https?:\/\//.test(lower)) return { passed: false, error: "links_not_allowed" };
  if (/(seed phrase|private key|airdrop|claim now|free money|get rich|guaranteed profit)/i.test(lower)) {
    return { passed: false, error: "unsafe_financial_or_wallet_language" };
  }
  return { passed: true };
}

function mapRoleToPool(role) {
  if (role === "opener") return "opener";
  if (role === "closer") return "closer";
  if (["bridge", "turn", "echo", "witness"].includes(role)) return role;
  return "contributor";
}

function inferLaneFromText(text) {
  const lower = text.toLowerCase();
  if (/market|base|token|trade|liquid|bankr/.test(lower)) return "market";
  if (/memory|remember|ghost|past|archive/.test(lower)) return "memory";
  if (/machine|agent|model|code|ai/.test(lower)) return "machine";
  if (/signal|feed|network|cast|node/.test(lower)) return "signal";
  if (/myth|legend|lore|omen|fire/.test(lower)) return "myth";
  return "dream";
}

function inferDominantLane(traces) {
  const counts = new Map();
  for (const trace of traces) counts.set(trace.laneId, (counts.get(trace.laneId) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || "dream";
}

function stableRandomKey(trace) {
  return sha256(`${trace.traceId}:${trace.fid}:random-weave-v1`);
}

async function verifyRequest(request) {
  const expectedDomain = getExpectedDomain(request);
  if (!expectedDomain) {
    return {
      ok: false,
      statusCode: 503,
      body: { ok: false, error: "auth_domain_not_configured", verified: false },
    };
  }
  const authorization = request.headers.authorization || request.headers.Authorization || "";
  if (!authorization.startsWith("Bearer ")) {
    return {
      ok: false,
      statusCode: 401,
      body: { ok: false, error: "missing_bearer_token", verified: false },
    };
  }
  try {
    const payload = await quickAuth.verifyJwt({
      token: authorization.slice("Bearer ".length).trim(),
      domain: expectedDomain,
    });
    return { ok: true, fid: payload.sub };
  } catch (error) {
    if (error instanceof Errors.InvalidTokenError) {
      return {
        ok: false,
        statusCode: 401,
        body: { ok: false, error: "invalid_token", verified: false },
      };
    }
    return {
      ok: false,
      statusCode: 500,
      body: { ok: false, error: "auth_verification_failed", verified: false },
    };
  }
}

async function readJsonBody(request) {
  if (request.body && typeof request.body === "object" && !Buffer.isBuffer(request.body)) return request.body;
  const text = await readTextBody(request);
  if (!text) throw Object.assign(new Error("body_required"), { statusCode: 400 });
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("invalid_json"), { statusCode: 400 });
  }
}

async function readTextBody(request) {
  if (typeof request.body === "string") return request.body;
  if (Buffer.isBuffer(request.body)) return request.body.toString("utf8");
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("body_too_large"), { statusCode: 413 });
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function getExpectedDomain(request) {
  if (process.env.CHAIN_POEM_AUTH_DOMAIN) return cleanDomain(process.env.CHAIN_POEM_AUTH_DOMAIN);
  if (process.env.MINIAPP_ORIGIN) return new URL(process.env.MINIAPP_ORIGIN).hostname;
  const host = request.headers["x-forwarded-host"] || request.headers.host || "";
  return cleanDomain(String(host).split(",")[0]);
}

function cleanDomain(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");
}

function sha256(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

function sendJson(response, statusCode, body) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}
