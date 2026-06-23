-- Chain Poem Weaver — durable queue + first-class claim/allocation schema.
-- Applied automatically by PostgresQueueStore.init() (api/queue-store.mjs); this
-- file is the human-readable reference and a manual bootstrap path.
--
-- Provider: Neon Postgres (free tier). Set DATABASE_URL to the Neon connection
-- string and CHAIN_POEM_STORE_DRIVER=postgres (or just provide DATABASE_URL).
--
-- Every financial column is pinned dormant by default. Flipping enabled /
-- mint_allowed / token_enabled / airdrop_enabled is a separate, gated review —
-- never part of normal writes.

-- The live trace queue. One row per submitted, Quick-Auth-verified line.
CREATE TABLE IF NOT EXISTS traces (
  trace_id        TEXT PRIMARY KEY,
  fid             TEXT NOT NULL,
  status          TEXT NOT NULL,            -- eligible | matched
  matched_poem_id TEXT,
  created_at_utc  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at_utc  TIMESTAMPTZ NOT NULL DEFAULT now(),
  data            JSONB NOT NULL            -- full trace object
);
CREATE INDEX IF NOT EXISTS traces_status_idx ON traces (status);
CREATE INDEX IF NOT EXISTS traces_fid_idx ON traces (fid);

-- Completed canonical poems + provenance. Kept forever (provenance record).
CREATE TABLE IF NOT EXISTS poems (
  poem_id          TEXT PRIMARY KEY,
  poem_hash        TEXT,
  status           TEXT NOT NULL,
  completed_at_utc TIMESTAMPTZ NOT NULL DEFAULT now(),
  data             JSONB NOT NULL           -- canonicalPoem + provenance + dormantLedger
);

-- First-class per-line receipt claims. claim_key is the replay guard (matches
-- the on-chain claimed[claimKey] mapping). recipient_address / proof columns are
-- the dormant wallet-binding slot.
CREATE TABLE IF NOT EXISTS line_receipt_claims (
  claim_key               TEXT PRIMARY KEY,
  poem_id                 TEXT NOT NULL,
  poem_hash               TEXT,
  line_index              INTEGER NOT NULL,
  recipient_address       TEXT,
  address_proof_signature TEXT,
  address_proof_verified  BOOLEAN NOT NULL DEFAULT false,
  enabled                 BOOLEAN NOT NULL DEFAULT false,  -- pinned dormant
  mint_allowed            BOOLEAN NOT NULL DEFAULT false,  -- pinned dormant
  claim_state             TEXT NOT NULL DEFAULT 'locked',
  created_at_utc          TIMESTAMPTZ NOT NULL DEFAULT now(),
  data                    JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS line_receipt_claims_poem_idx ON line_receipt_claims (poem_id);

-- First-class per-line token allocations (dormant ledger). 1:1 with claims via
-- claim_key.
CREATE TABLE IF NOT EXISTS token_allocations (
  claim_key       TEXT PRIMARY KEY,
  poem_id         TEXT NOT NULL,
  poem_hash       TEXT,
  line_index      INTEGER NOT NULL,
  pool            TEXT,
  pending_units   NUMERIC NOT NULL DEFAULT 0,
  token_enabled   BOOLEAN NOT NULL DEFAULT false,  -- pinned dormant
  airdrop_enabled BOOLEAN NOT NULL DEFAULT false,  -- pinned dormant
  created_at_utc  TIMESTAMPTZ NOT NULL DEFAULT now(),
  data            JSONB NOT NULL
);

-- Minimum moderation floor before public promotion. These actions derive the
-- effective hidden poem set and banned FID set used by the queue.
CREATE TABLE IF NOT EXISTS moderation_actions (
  action_id      TEXT PRIMARY KEY,
  action         TEXT NOT NULL,             -- hide_poem | unhide_poem | ban_fid | unban_fid
  poem_id        TEXT,
  fid            TEXT,
  moderator      TEXT,
  created_at_utc TIMESTAMPTZ NOT NULL DEFAULT now(),
  data           JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS moderation_actions_poem_idx ON moderation_actions (poem_id);
CREATE INDEX IF NOT EXISTS moderation_actions_fid_idx ON moderation_actions (fid);
