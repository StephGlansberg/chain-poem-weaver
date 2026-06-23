// Durable store abstraction for the random-weave queue + first-class claim and
// token-allocation records.
//
// The same in-memory working shape is used by both adapters:
//   { schemaVersion, updatedAtUtc, traces[], completedPoems[],
//     lineReceiptClaims[], tokenAllocations[] }
//
// `traces` and `completedPoems` are the canonical records the matching logic in
// random-weave.mjs operates on. `lineReceiptClaims` and `tokenAllocations` are
// DERIVED, first-class, queryable rows exploded out of each completed poem's
// dormant ledger so they survive cold starts and can be looked up by claimKey.
// Every financial pin stays exactly as the completed-poem record set it; this
// module only stores and re-shapes — it never arms anything.
//
// Driver selection (createQueueStore):
//   CHAIN_POEM_STORE_DRIVER=postgres  OR  DATABASE_URL present  -> Postgres
//   otherwise                                                   -> JSON file
//
// The Postgres driver imports @neondatabase/serverless lazily so the file/CI
// path never needs the dependency installed.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const STORE_SCHEMA_VERSION = 1;
const MAX_STORED_TRACES = 500;
const MAX_LOADED_POEMS = 200;

export function createEmptyQueueStore() {
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    updatedAtUtc: new Date(0).toISOString(),
    traces: [],
    completedPoems: [],
    lineReceiptClaims: [],
    tokenAllocations: [],
    moderationActions: [],
    hiddenPoemIds: [],
    bannedFids: [],
  };
}

// Rebuild the first-class claim/allocation rows from the completed poems so the
// derived arrays are always consistent with the canonical ledger. Deduped by
// claimKey — the claimKey is the replay guard, on-chain and off.
export function deriveLedgerRows(store) {
  const claims = new Map();
  const allocations = new Map();
  for (const poem of store.completedPoems || []) {
    const ledger = poem?.dormantLedger || {};
    for (const claim of ledger.lineReceiptClaims || []) {
      if (claim?.claimKey && !claims.has(claim.claimKey)) claims.set(claim.claimKey, claim);
    }
    for (const allocation of ledger.tokenAllocations || []) {
      if (allocation?.claimKey && !allocations.has(allocation.claimKey)) {
        allocations.set(allocation.claimKey, allocation);
      }
    }
  }
  return { lineReceiptClaims: [...claims.values()], tokenAllocations: [...allocations.values()] };
}

export function deriveModerationState(store) {
  const hiddenPoemIds = new Set();
  const bannedFids = new Set();
  for (const action of store.moderationActions || []) {
    if (action.action === "hide_poem" && action.poemId) hiddenPoemIds.add(action.poemId);
    if (action.action === "unhide_poem" && action.poemId) hiddenPoemIds.delete(action.poemId);
    if (action.action === "ban_fid" && action.fid) bannedFids.add(String(action.fid));
    if (action.action === "unban_fid" && action.fid) bannedFids.delete(String(action.fid));
  }
  return { hiddenPoemIds: [...hiddenPoemIds], bannedFids: [...bannedFids] };
}

export function applyModerationAction(store, input = {}, now = new Date()) {
  const action = normalizeModerationAction(input, now);
  if (!action.ok) return action;

  store.moderationActions ||= [];
  if (!store.moderationActions.some((item) => item.actionId === action.record.actionId)) {
    store.moderationActions.push(action.record);
  }
  applyModerationState(store);
  if (action.record.action === "ban_fid") {
    for (const trace of store.traces || []) {
      if (String(trace.fid) === action.record.fid && trace.status === "eligible") {
        trace.status = "moderation_blocked";
        trace.moderationStatus = "blocked_fid";
        trace.updatedAtUtc = action.record.createdAtUtc;
      }
    }
  }
  if (action.record.action === "hide_poem") {
    for (const poem of store.completedPoems || []) {
      if (poem.poemId === action.record.poemId) {
        poem.moderationStatus = "hidden";
        poem.hiddenAtUtc = action.record.createdAtUtc;
      }
    }
  }
  if (action.record.action === "unhide_poem") {
    for (const poem of store.completedPoems || []) {
      if (poem.poemId === action.record.poemId) {
        poem.moderationStatus = "visible";
        delete poem.hiddenAtUtc;
      }
    }
  }
  store.updatedAtUtc = action.record.createdAtUtc;
  return { ok: true, action: action.record, state: moderationState(store) };
}

export function moderationState(store) {
  applyModerationState(store);
  return {
    hiddenPoemIds: [...(store.hiddenPoemIds || [])],
    bannedFids: [...(store.bannedFids || [])],
    actionCount: (store.moderationActions || []).length,
  };
}

function applyModerationState(store) {
  const derived = deriveModerationState(store);
  store.hiddenPoemIds = derived.hiddenPoemIds;
  store.bannedFids = derived.bannedFids;
  return store;
}

function normalizeModerationAction(input, now) {
  const action = cleanToken(input.action || input.type);
  if (!["hide_poem", "unhide_poem", "ban_fid", "unban_fid"].includes(action)) {
    return { ok: false, error: "unsupported_moderation_action" };
  }
  const poemId = cleanToken(input.poemId || input.targetId);
  const fid = cleanToken(input.fid || input.targetFid);
  if (["hide_poem", "unhide_poem"].includes(action) && !poemId) return { ok: false, error: "poem_id_required" };
  if (["ban_fid", "unban_fid"].includes(action) && !fid) return { ok: false, error: "fid_required" };
  const createdAtUtc = now.toISOString();
  const reason = cleanText(input.reason, 240) || "operator_moderation";
  const moderator = cleanText(input.moderator, 80) || "opulentis";
  const actionId = `mod-${sha256(stableActionString({ action, poemId, fid, reason, moderator, createdAtUtc })).slice(0, 24)}`;
  return {
    ok: true,
    record: {
      schemaVersion: 1,
      kind: "chain-poem-moderation-action",
      actionId,
      action,
      poemId: poemId || null,
      fid: fid || null,
      reason,
      moderator,
      createdAtUtc,
    },
  };
}

function normalizeWorkingStore(parsed) {
  const base = createEmptyQueueStore();
  const store = {
    ...base,
    ...parsed,
    traces: Array.isArray(parsed?.traces) ? parsed.traces : [],
    completedPoems: Array.isArray(parsed?.completedPoems) ? parsed.completedPoems : [],
    moderationActions: Array.isArray(parsed?.moderationActions) ? parsed.moderationActions : [],
  };
  const derived = deriveLedgerRows(store);
  store.lineReceiptClaims = derived.lineReceiptClaims;
  store.tokenAllocations = derived.tokenAllocations;
  applyModerationState(store);
  return store;
}

export function defaultStorePath() {
  if (process.env.CHAIN_POEM_QUEUE_STORE_PATH) return process.env.CHAIN_POEM_QUEUE_STORE_PATH;
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "data", "random-weave-store.local.json");
}

// ---------------------------------------------------------------------------
// File adapter (local + CI default)
// ---------------------------------------------------------------------------

export class FileQueueStore {
  constructor(path = defaultStorePath()) {
    this.path = path;
    this.driver = "file";
  }

  async load() {
    if (!existsSync(this.path)) return createEmptyQueueStore();
    try {
      return normalizeWorkingStore(JSON.parse(readFileSync(this.path, "utf8")));
    } catch {
      return createEmptyQueueStore();
    }
  }

  async persist(store) {
    const derived = deriveLedgerRows(store);
    store.lineReceiptClaims = derived.lineReceiptClaims;
    store.tokenAllocations = derived.tokenAllocations;
    store.updatedAtUtc = new Date().toISOString();
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    return store;
  }

  async findClaim(claimKey) {
    const store = await this.load();
    return store.lineReceiptClaims.find((claim) => claim.claimKey === claimKey) || null;
  }

  async moderate(input, now = new Date()) {
    const store = await this.load();
    const result = applyModerationAction(store, input, now);
    if (!result.ok) return result;
    await this.persist(store);
    return result;
  }
}

// ---------------------------------------------------------------------------
// Postgres adapter (production) — Neon serverless over HTTP.
// ---------------------------------------------------------------------------

export class PostgresQueueStore {
  constructor(connectionString = process.env.DATABASE_URL) {
    if (!connectionString) throw new Error("postgres_store_requires_DATABASE_URL");
    this.connectionString = connectionString;
    this.driver = "postgres";
    this._sql = null;
    this._ready = null;
  }

  async _client() {
    if (this._sql) return this._sql;
    const { neon } = await import("@neondatabase/serverless");
    this._sql = neon(this.connectionString);
    return this._sql;
  }

  async init() {
    if (this._ready) return this._ready;
    this._ready = (async () => {
      const sql = await this._client();
      await sql`CREATE TABLE IF NOT EXISTS traces (
        trace_id TEXT PRIMARY KEY,
        fid TEXT NOT NULL,
        status TEXT NOT NULL,
        matched_poem_id TEXT,
        created_at_utc TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at_utc TIMESTAMPTZ NOT NULL DEFAULT now(),
        data JSONB NOT NULL
      )`;
      await sql`CREATE INDEX IF NOT EXISTS traces_status_idx ON traces (status)`;
      await sql`CREATE INDEX IF NOT EXISTS traces_fid_idx ON traces (fid)`;
      await sql`CREATE TABLE IF NOT EXISTS poems (
        poem_id TEXT PRIMARY KEY,
        poem_hash TEXT,
        status TEXT NOT NULL,
        completed_at_utc TIMESTAMPTZ NOT NULL DEFAULT now(),
        data JSONB NOT NULL
      )`;
      await sql`CREATE TABLE IF NOT EXISTS line_receipt_claims (
        claim_key TEXT PRIMARY KEY,
        poem_id TEXT NOT NULL,
        poem_hash TEXT,
        line_index INTEGER NOT NULL,
        recipient_address TEXT,
        address_proof_signature TEXT,
        address_proof_verified BOOLEAN NOT NULL DEFAULT false,
        enabled BOOLEAN NOT NULL DEFAULT false,
        mint_allowed BOOLEAN NOT NULL DEFAULT false,
        claim_state TEXT NOT NULL DEFAULT 'locked',
        created_at_utc TIMESTAMPTZ NOT NULL DEFAULT now(),
        data JSONB NOT NULL
      )`;
      await sql`CREATE INDEX IF NOT EXISTS line_receipt_claims_poem_idx ON line_receipt_claims (poem_id)`;
      await sql`CREATE TABLE IF NOT EXISTS token_allocations (
        claim_key TEXT PRIMARY KEY,
        poem_id TEXT NOT NULL,
        poem_hash TEXT,
        line_index INTEGER NOT NULL,
        pool TEXT,
        pending_units NUMERIC NOT NULL DEFAULT 0,
        token_enabled BOOLEAN NOT NULL DEFAULT false,
        airdrop_enabled BOOLEAN NOT NULL DEFAULT false,
        created_at_utc TIMESTAMPTZ NOT NULL DEFAULT now(),
        data JSONB NOT NULL
      )`;
      await sql`CREATE TABLE IF NOT EXISTS moderation_actions (
        action_id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        poem_id TEXT,
        fid TEXT,
        moderator TEXT,
        created_at_utc TIMESTAMPTZ NOT NULL DEFAULT now(),
        data JSONB NOT NULL
      )`;
      await sql`CREATE INDEX IF NOT EXISTS moderation_actions_poem_idx ON moderation_actions (poem_id)`;
      await sql`CREATE INDEX IF NOT EXISTS moderation_actions_fid_idx ON moderation_actions (fid)`;
    })();
    return this._ready;
  }

  async load() {
    await this.init();
    const sql = await this._client();
    const traceRows = await sql`SELECT data FROM traces ORDER BY created_at_utc DESC LIMIT ${MAX_STORED_TRACES}`;
    const poemRows = await sql`SELECT data FROM poems ORDER BY completed_at_utc DESC LIMIT ${MAX_LOADED_POEMS}`;
    const moderationRows = await sql`SELECT data FROM moderation_actions ORDER BY created_at_utc ASC LIMIT 1000`;
    const store = createEmptyQueueStore();
    store.traces = traceRows.map((row) => row.data).reverse();
    store.completedPoems = poemRows.map((row) => row.data).reverse();
    store.moderationActions = moderationRows.map((row) => row.data);
    const derived = deriveLedgerRows(store);
    store.lineReceiptClaims = derived.lineReceiptClaims;
    store.tokenAllocations = derived.tokenAllocations;
    applyModerationState(store);
    return store;
  }

  async persist(store) {
    await this.init();
    const sql = await this._client();
    store.updatedAtUtc = new Date().toISOString();

    for (const trace of store.traces || []) {
      await sql`INSERT INTO traces (trace_id, fid, status, matched_poem_id, created_at_utc, updated_at_utc, data)
        VALUES (${trace.traceId}, ${String(trace.fid)}, ${trace.status},
          ${trace.matchedPoemId || null}, ${trace.createdAtUtc}, ${trace.updatedAtUtc}, ${toJsonb(trace)}::jsonb)
        ON CONFLICT (trace_id) DO UPDATE SET
          status = EXCLUDED.status,
          matched_poem_id = EXCLUDED.matched_poem_id,
          updated_at_utc = EXCLUDED.updated_at_utc,
          data = EXCLUDED.data`;
    }

    for (const poem of store.completedPoems || []) {
      await sql`INSERT INTO poems (poem_id, poem_hash, status, completed_at_utc, data)
        VALUES (${poem.poemId}, ${poem.provenance?.poemHash || null}, ${poem.status},
          ${poem.completedAtUtc || poem.createdAtUtc}, ${toJsonb(poem)}::jsonb)
        ON CONFLICT (poem_id) DO NOTHING`;

      const ledger = poem.dormantLedger || {};
      for (const claim of ledger.lineReceiptClaims || []) {
        const recipient = claim.contributor || {};
        await sql`INSERT INTO line_receipt_claims (claim_key, poem_id, poem_hash, line_index,
            recipient_address, address_proof_signature, address_proof_verified,
            enabled, mint_allowed, claim_state, data)
          VALUES (${claim.claimKey}, ${claim.poemId}, ${claim.poemHash}, ${claim.lineIndex},
            ${claim.recipientAddress || recipient.recipientAddress || null},
            ${claim.addressProofSignature || null}, ${claim.addressProofVerified === true},
            ${claim.enabled === true}, ${claim.mintAllowed === true},
            ${claim.claimState || "locked"}, ${toJsonb(claim)}::jsonb)
          ON CONFLICT (claim_key) DO NOTHING`;
      }
      for (const allocation of ledger.tokenAllocations || []) {
        await sql`INSERT INTO token_allocations (claim_key, poem_id, poem_hash, line_index,
            pool, pending_units, token_enabled, airdrop_enabled, data)
          VALUES (${allocation.claimKey}, ${allocation.poemId}, ${allocation.poemHash},
            ${allocation.lineIndex}, ${allocation.pool || null}, ${Number(allocation.pendingUnits || 0)},
            ${allocation.tokenEnabled === true}, ${allocation.airdropEnabled === true}, ${toJsonb(allocation)}::jsonb)
          ON CONFLICT (claim_key) DO NOTHING`;
      }
    }

    for (const action of store.moderationActions || []) {
      await sql`INSERT INTO moderation_actions (action_id, action, poem_id, fid, moderator, created_at_utc, data)
        VALUES (${action.actionId}, ${action.action}, ${action.poemId || null}, ${action.fid || null},
          ${action.moderator || null}, ${action.createdAtUtc}, ${toJsonb(action)}::jsonb)
        ON CONFLICT (action_id) DO NOTHING`;
    }

    const derived = deriveLedgerRows(store);
    store.lineReceiptClaims = derived.lineReceiptClaims;
    store.tokenAllocations = derived.tokenAllocations;
    applyModerationState(store);
    return store;
  }

  async findClaim(claimKey) {
    await this.init();
    const sql = await this._client();
    const rows = await sql`SELECT data FROM line_receipt_claims WHERE claim_key = ${claimKey} LIMIT 1`;
    return rows[0]?.data || null;
  }

  async moderate(input, now = new Date()) {
    const store = await this.load();
    const result = applyModerationAction(store, input, now);
    if (!result.ok) return result;
    await this.persist(store);
    return result;
  }
}

function toJsonb(value) {
  return JSON.stringify(value ?? null);
}

export function createQueueStore(options = {}) {
  const driver = options.driver
    || process.env.CHAIN_POEM_STORE_DRIVER
    || (process.env.DATABASE_URL ? "postgres" : "file");
  if (driver === "postgres") {
    return new PostgresQueueStore(options.connectionString || process.env.DATABASE_URL);
  }
  return new FileQueueStore(options.path);
}

function cleanToken(value) {
  return String(value || "").trim().replace(/[^\w:.-]/g, "").slice(0, 96);
}

function cleanText(value, max = 240) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function stableActionString(value) {
  return JSON.stringify(Object.keys(value).sort().reduce((acc, key) => {
    acc[key] = value[key];
    return acc;
  }, {}));
}

function sha256(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}
