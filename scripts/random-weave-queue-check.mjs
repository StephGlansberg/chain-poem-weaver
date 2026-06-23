import {
  AIRDROP_ENABLED,
  LINE_RECEIPT_CLAIM_ENABLED,
  LINE_RECEIPT_MINT_ALLOWED,
  RANDOM_WEAVE_TARGET_LINES,
  TOKEN_CONTRACT,
  TOKEN_ENABLED,
  addTraceToStore,
  arrangeTracesIntoPoem,
  buildWalletProofMessage,
  buildPoemFromTraces,
  completeNextRandomWeave,
  createEmptyQueueStore,
  createTrace,
  findOpenTraceForFid,
  resolveWalletBinding,
  selectEligibleTraces,
  validateServerCompletion,
} from "../api/random-weave.mjs";
import { privateKeyToAccount } from "viem/accounts";

const failures = [];

const store = createEmptyQueueStore();
const baseTime = new Date("2026-06-15T12:00:00.000Z");
const lines = [
  "a quiet signal waits",
  "gold gathers under the door",
  "someone answers without knowing",
  "the thread learns our names",
  "memory folds into the feed",
  "the last line opens",
];

for (let index = 0; index < RANDOM_WEAVE_TARGET_LINES; index += 1) {
  const trace = createTrace({
    line: lines[index],
    auth: { fid: String(1000 + index) },
    clientContext: { username: `weaver${index}`, displayName: `Weaver ${index}` },
    now: new Date(baseTime.getTime() + index * 1000),
  });
  if (!trace.ok) failures.push(`trace_create_failed:${index}:${trace.error}`);
  else addTraceToStore(store, trace.trace);
}

if (selectEligibleTraces(store).length !== RANDOM_WEAVE_TARGET_LINES) failures.push("eligible_trace_count_wrong");

const completion = completeNextRandomWeave(store, {
  now: new Date("2026-06-15T12:10:00.000Z"),
  provenanceSecret: "test-secret",
});
if (!completion) failures.push("completion_not_created");

if (completion) {
  if (completion.status !== "complete") failures.push("completion_status_wrong");
  if (completion.source !== "server-random-weave") failures.push("completion_source_wrong");
  if (completion.canonicalPoem?.lines?.length !== RANDOM_WEAVE_TARGET_LINES) failures.push("canonical_line_count_wrong");
  if (new Set(completion.contributorFids).size !== RANDOM_WEAVE_TARGET_LINES) failures.push("completion_fids_not_distinct");
  if (completion.provenance?.mintAllowed !== false) failures.push("provenance_mint_allowed_not_false");
  if (completion.provenance?.lineReceiptMintPlan?.receipts?.length !== RANDOM_WEAVE_TARGET_LINES) failures.push("receipt_plan_count_wrong");
  if (completion.dormantLedger?.lineReceiptClaims?.length !== RANDOM_WEAVE_TARGET_LINES) failures.push("claim_record_count_wrong");
  if (completion.dormantLedger?.tokenAllocations?.length !== RANDOM_WEAVE_TARGET_LINES) failures.push("allocation_record_count_wrong");
  if (!completion.dormantLedger?.lineReceiptClaims?.every((record) => record.enabled === false && record.mintAllowed === false && record.claimState === "locked")) {
    failures.push("line_receipt_claim_not_locked");
  }
  if (!completion.dormantLedger?.tokenAllocations?.every((record) =>
    record.tokenEnabled === false &&
    record.airdropEnabled === false &&
    record.tokenContract === null &&
    record.expiresAtUtc === null &&
    record.claimKey?.startsWith("sha256:") &&
    Number(record.pendingUnits) > 0
  )) {
    failures.push("token_allocation_not_dormant");
  }
  const claimKeys = completion.dormantLedger.tokenAllocations.map((record) => record.claimKey);
  const receiptKeys = completion.dormantLedger.lineReceiptClaims.map((record) => record.claimKey);
  if (JSON.stringify(claimKeys) !== JSON.stringify(receiptKeys)) failures.push("allocation_claim_keys_do_not_match_receipts");
  if (completion.invariants?.previewLinesExcluded !== true) failures.push("preview_exclusion_invariant_missing");
  if (completion.invariants?.tokenEnabledPinnedFalse !== false) failures.push("token_pin_not_false");
  if (completion.canonicalPoem?.title === "Random weave") failures.push("curated_title_not_applied");
  if (!completion.canonicalPoem?.lines?.every((line) => line.role)) failures.push("curated_roles_missing");
}

const unsafe = createTrace({
  line: "claim now free money with my seed phrase",
  auth: { fid: "9999" },
  clientContext: {},
  now: baseTime,
});
if (unsafe.ok || unsafe.error !== "unsafe_financial_or_wallet_language") failures.push("unsafe_trace_not_blocked");

const duplicateStore = createEmptyQueueStore();
for (let index = 0; index < RANDOM_WEAVE_TARGET_LINES; index += 1) {
  const trace = createTrace({
    line: `duplicate line ${index}`,
    auth: { fid: "222" },
    clientContext: {},
    now: new Date(baseTime.getTime() + index * 1000),
  });
  if (trace.ok) addTraceToStore(duplicateStore, trace.trace);
}
if (completeNextRandomWeave(duplicateStore, { now: baseTime })) failures.push("duplicate_fids_completed");

const pendingLockStore = createEmptyQueueStore();
const firstPending = createTrace({
  line: "first pending line",
  auth: { fid: "333" },
  clientContext: {},
  now: baseTime,
});
const secondPending = createTrace({
  line: "second pending line",
  auth: { fid: "333" },
  clientContext: {},
  now: new Date(baseTime.getTime() + 1000),
});
if (firstPending.ok) addTraceToStore(pendingLockStore, firstPending.trace);
if (secondPending.ok) {
  const locked = findOpenTraceForFid(pendingLockStore, "333");
  if (!locked || locked.line !== "first pending line") failures.push("duplicate_pending_fid_lock_missing");
}

const previewPoem = {
  schemaVersion: 1,
  poemId: "preview",
  status: "complete",
  lines: Array.from({ length: RANDOM_WEAVE_TARGET_LINES }, (_, index) => ({
    text: `preview ${index}`,
    fid: String(index),
    verified: false,
    contextSource: "preview-queue",
  })),
};
const previewValidation = validateServerCompletion(previewPoem, []);
if (previewValidation.ok || previewValidation.error !== "wrong_trace_count") failures.push("preview_validation_not_rejected");

const traceList = selectEligibleTraces(createEmptyQueueStore());
if (traceList.length !== 0) failures.push("empty_store_has_eligible_traces");

const poemFromTraces = buildPoemFromTraces(store.traces.slice(0, RANDOM_WEAVE_TARGET_LINES), baseTime);
if (poemFromTraces.status !== "complete") failures.push("build_poem_from_traces_not_complete");
if (!poemFromTraces.lines.every((line) => line.verified === true && line.contextSource === "server-quick-auth")) {
  failures.push("built_poem_lines_not_server_verified");
}
if (poemFromTraces.matchNote !== "Five verified Farcaster traces were randomly matched, then arranged into a coherent weave.") {
  failures.push("curator_match_note_missing");
}
if (poemFromTraces.weaveMethod !== "deterministic-curator-v1") failures.push("curator_method_missing");

const walletPrivateKey = "0x59c6995e998f97a5a0044966f094538b4fdf2a8b57f4c3bc36804c8f0e368e9f";
const walletAccount = privateKeyToAccount(walletPrivateKey);
const walletDomain = "chain-poem-weaver.vercel.app";
const walletFid = "4242";
const walletMessage = buildWalletProofMessage(walletAccount.address, walletFid, walletDomain);
const walletSignature = await walletAccount.signMessage({ message: walletMessage });
const walletBinding = await resolveWalletBinding({
  recipientAddress: walletAccount.address,
  addressProofMessage: walletMessage,
  addressProofSignature: walletSignature,
}, walletFid, walletDomain);
if (!walletBinding?.addressProofVerified) failures.push("wallet_binding_valid_signature_not_verified");
if (walletBinding?.recipientAddress !== walletAccount.address.toLowerCase()) failures.push("wallet_binding_address_not_normalized");

const wrongFidBinding = await resolveWalletBinding({
  recipientAddress: walletAccount.address,
  addressProofMessage: walletMessage,
  addressProofSignature: walletSignature,
}, "424", walletDomain);
if (wrongFidBinding?.addressProofVerified) failures.push("wallet_binding_wrong_fid_verified");

const wrongDomainBinding = await resolveWalletBinding({
  recipientAddress: walletAccount.address,
  addressProofMessage: walletMessage,
  addressProofSignature: walletSignature,
}, walletFid, "evil.example");
if (wrongDomainBinding?.addressProofVerified) failures.push("wallet_binding_wrong_domain_verified");

const tamperedMessage = walletMessage.replace("action:none", "action:mint");
const tamperedBinding = await resolveWalletBinding({
  recipientAddress: walletAccount.address,
  addressProofMessage: tamperedMessage,
  addressProofSignature: walletSignature,
}, walletFid, walletDomain);
if (tamperedBinding?.addressProofVerified) failures.push("wallet_binding_tampered_message_verified");

const deliberatelyUnordered = [
  store.traces[2],
  store.traces[4],
  store.traces[0],
  store.traces[3],
  store.traces[1],
];
const arranged = arrangeTracesIntoPoem(deliberatelyUnordered);
if (arranged.length !== RANDOM_WEAVE_TARGET_LINES) failures.push("arranged_trace_count_wrong");
if (new Set(arranged.map((trace) => trace.traceId)).size !== RANDOM_WEAVE_TARGET_LINES) failures.push("arranged_trace_duplicate");
if (!arranged.every((trace) => trace.arrangedRole && trace.arrangementReason)) failures.push("arrangement_metadata_missing");

if (LINE_RECEIPT_CLAIM_ENABLED !== false) failures.push("claim_enabled_constant_not_false");
if (LINE_RECEIPT_MINT_ALLOWED !== false) failures.push("mint_allowed_constant_not_false");
if (TOKEN_ENABLED !== false) failures.push("token_enabled_constant_not_false");
if (AIRDROP_ENABLED !== false) failures.push("airdrop_enabled_constant_not_false");
if (TOKEN_CONTRACT !== null) failures.push("token_contract_constant_not_null");

const result = {
  ok: failures.length === 0,
  generatedAtUtc: new Date().toISOString(),
  targetLines: RANDOM_WEAVE_TARGET_LINES,
  failures,
};
console.log(JSON.stringify(result, null, 2));
if (failures.length) process.exit(1);
