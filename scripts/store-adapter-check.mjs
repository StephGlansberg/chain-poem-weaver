// Exercises the queue-store abstraction: the FileQueueStore round-trips the
// working set, derives first-class claim/allocation rows, threads the dormant
// wallet binding through to claims, and keeps every financial pin locked. The
// Postgres adapter is structurally checked here and only hits a live database
// when DATABASE_URL is set (so CI stays self-contained).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addTraceToStore,
  completeNextRandomWeave,
  createTrace,
  RANDOM_WEAVE_TARGET_LINES,
} from "../api/random-weave.mjs";
import {
  FileQueueStore,
  PostgresQueueStore,
  createEmptyQueueStore,
  createQueueStore,
  deriveLedgerRows,
} from "../api/queue-store.mjs";

const failures = [];
const tempDir = mkdtempSync(join(tmpdir(), "chain-poem-store-"));
const storePath = join(tempDir, "store.json");

const lines = [
  "a quiet signal waits",
  "gold gathers under the door",
  "someone answers without knowing",
  "the thread learns our names",
  "memory folds into the feed",
  "the last line opens",
];
const boundAddress = "0x00112233445566778899aabbccddeeff00112233";

try {
  // Build six verified traces; bind a wallet to the first contributor only.
  const data = createEmptyQueueStore();
  for (let index = 0; index < RANDOM_WEAVE_TARGET_LINES; index += 1) {
    const trace = createTrace({
      line: lines[index],
      auth: { fid: String(2000 + index) },
      clientContext: { username: `weaver${index}` },
      wallet: index === 0 ? { recipientAddress: boundAddress, addressProofVerified: true } : null,
      now: new Date(Date.UTC(2026, 5, 15, 12, 0, index)),
    });
    if (!trace.ok) failures.push(`trace_create_failed:${index}:${trace.error}`);
    else addTraceToStore(data, trace.trace);
  }
  const completion = completeNextRandomWeave(data, {
    now: new Date(Date.UTC(2026, 5, 15, 12, 10, 0)),
    provenanceSecret: "store-adapter-secret",
  });
  if (!completion) failures.push("completion_not_created");

  // Driver selection: explicit file driver remains file even when DATABASE_URL
  // exists; auto-selection uses Postgres when DATABASE_URL is present.
  const explicitFile = createQueueStore({ driver: "file", path: storePath });
  if (!(explicitFile instanceof FileQueueStore)) failures.push("explicit_file_driver_not_file");
  if (explicitFile.driver !== "file") failures.push("file_driver_name_wrong");
  const auto = createQueueStore({ path: storePath });
  if (process.env.DATABASE_URL) {
    if (!(auto instanceof PostgresQueueStore)) failures.push("database_url_auto_driver_not_postgres");
  } else if (!(auto instanceof FileQueueStore)) {
    failures.push("default_driver_not_file");
  }

  // Persist + reload round-trip through the file adapter.
  const store = new FileQueueStore(storePath);
  await store.persist(data);
  const reloaded = await store.load();

  if (reloaded.traces.length !== RANDOM_WEAVE_TARGET_LINES) failures.push("reloaded_trace_count_wrong");
  if (reloaded.completedPoems.length !== 1) failures.push("reloaded_poem_count_wrong");
  if (reloaded.lineReceiptClaims.length !== RANDOM_WEAVE_TARGET_LINES) failures.push("derived_claim_count_wrong");
  if (reloaded.tokenAllocations.length !== RANDOM_WEAVE_TARGET_LINES) failures.push("derived_allocation_count_wrong");

  // Derived rows are deduped by claimKey and 1:1 between claims and allocations.
  const claimKeys = reloaded.lineReceiptClaims.map((row) => row.claimKey);
  const allocationKeys = reloaded.tokenAllocations.map((row) => row.claimKey);
  if (new Set(claimKeys).size !== claimKeys.length) failures.push("claim_rows_not_deduped");
  if (JSON.stringify(claimKeys.slice().sort()) !== JSON.stringify(allocationKeys.slice().sort())) {
    failures.push("claim_allocation_keys_mismatch");
  }

  // Every financial pin stays locked after a round-trip.
  if (!reloaded.lineReceiptClaims.every((row) => row.enabled === false && row.mintAllowed === false && row.claimState === "locked")) {
    failures.push("reloaded_claims_not_locked");
  }
  if (!reloaded.tokenAllocations.every((row) => row.tokenEnabled === false && row.airdropEnabled === false)) {
    failures.push("reloaded_allocations_not_dormant");
  }

  // Dormant wallet binding: exactly the bound contributor's claim carries the
  // address + verified proof flag; everyone else stays null.
  const bound = reloaded.lineReceiptClaims.filter((row) => row.recipientAddress === boundAddress);
  if (bound.length !== 1) failures.push("wallet_binding_count_wrong");
  if (bound[0] && bound[0].addressProofVerified !== true) failures.push("wallet_binding_proof_flag_lost");
  if (!reloaded.lineReceiptClaims.filter((row) => row !== bound[0]).every((row) => row.recipientAddress === null)) {
    failures.push("unbound_claims_have_address");
  }

  // findClaim resolves a first-class row by claimKey.
  const found = await store.findClaim(claimKeys[0]);
  if (!found || found.claimKey !== claimKeys[0]) failures.push("find_claim_failed");

  // deriveLedgerRows is idempotent.
  const rederived = deriveLedgerRows(reloaded);
  if (rederived.lineReceiptClaims.length !== RANDOM_WEAVE_TARGET_LINES) failures.push("rederive_claim_count_wrong");

  // Postgres adapter: structurally present, fails closed without a connection
  // string, and is selected when one is provided.
  if (!process.env.DATABASE_URL) {
    let threw = false;
    try {
      // eslint-disable-next-line no-new
      new PostgresQueueStore(undefined);
    } catch {
      threw = true;
    }
    if (!threw) failures.push("postgres_store_missing_dsn_guard");
  }
  const pgSelected = createQueueStore({ driver: "postgres", connectionString: "postgres://x" });
  if (!(pgSelected instanceof PostgresQueueStore)) failures.push("postgres_driver_not_selected");

  // Optional live Postgres round-trip (only when a real DATABASE_URL is set).
  if (process.env.DATABASE_URL) {
    const pg = new PostgresQueueStore(process.env.DATABASE_URL);
    await pg.persist(data);
    const pgReload = await pg.load();
    if (!pgReload.completedPoems.some((poem) => poem.poemId === completion.poemId)) {
      failures.push("postgres_round_trip_missing_poem");
    }
  }
} catch (error) {
  failures.push(`store_adapter_error:${error.message}`);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

const result = {
  ok: failures.length === 0,
  generatedAtUtc: new Date().toISOString(),
  checked: "queue-store-adapter",
  postgresLiveTested: Boolean(process.env.DATABASE_URL),
  failures,
};
console.log(JSON.stringify(result, null, 2));
if (failures.length) process.exit(1);
