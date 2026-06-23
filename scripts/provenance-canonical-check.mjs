import { addLine, completePoem, createPoem, MAX_LINES } from "../src/poem.js";
import { buildProvenance, canonicalizePoem, stableStringify } from "../api/provenance.mjs";

process.env.CHAIN_POEM_PUBLIC_ORIGIN ||= "https://chain-poem-weaver.vercel.app";

const failures = [];

let poem = createPoem({
  title: "The Door Under Base",
  theme: "ritual",
  firstLine: "The first hand lights the threshold.",
  contributor: {
    author: "OP",
    fid: "123",
    username: "opulentis",
    contextSource: "farcaster-context",
    signal: "verified-farcaster",
    verified: true,
  },
});
while (poem.lines.length < MAX_LINES) {
  poem = addLine(poem, `line ${poem.lines.length + 1}`, {
    author: `weaver-${poem.lines.length + 1}`,
    signal: "human",
  });
}
poem = completePoem(poem);

const canonical = canonicalizePoem(poem);
if (!canonical.ok) failures.push(`canonical_complete_failed:${canonical.error}`);
const again = canonicalizePoem(JSON.parse(JSON.stringify(poem)));
if (!again.ok) failures.push(`canonical_roundtrip_failed:${again.error}`);

const incomplete = canonicalizePoem({ ...poem, status: "open" });
if (incomplete.ok || incomplete.error !== "poem_not_complete") failures.push("incomplete_poem_not_rejected");

if (canonical.ok && again.ok) {
  const firstJson = stableStringify(canonical.poem);
  const secondJson = stableStringify(again.poem);
  if (firstJson !== secondJson) failures.push("canonical_json_not_stable");

  const unsigned = buildProvenance(canonical.poem, "123");
  const unsignedAgain = buildProvenance(again.poem, "123");
  if (unsigned.poemHash !== unsignedAgain.poemHash) failures.push("poem_hash_not_stable");
  if (unsigned.signed !== false || unsigned.signature !== null) failures.push("unsigned_provenance_not_unsigned");
  if (unsigned.mintAllowed !== false) failures.push("mint_allowed_not_false");
  if (unsigned.nextGate !== "provenance_secret_missing") failures.push("unsigned_next_gate_wrong");
  if (unsigned.ownershipPolicy?.kind !== "chain-poem-ownership-policy") failures.push("ownership_policy_missing");
  if (unsigned.ownershipPolicy?.wholePoem?.owner !== "no_single_owner") failures.push("ownership_whole_poem_not_collective");
  if (unsigned.ownershipPolicy?.lineReceipts?.rule !== "one_future_receipt_may_be_claimed_for_the_contributor_own_canonical_line_only") {
    failures.push("ownership_line_receipt_rule_wrong");
  }
  if (unsigned.ownershipPolicy?.completer?.receivesOwnershipOverOtherLines !== false) failures.push("ownership_completer_overreach");
  if (unsigned.ownershipPolicy?.contributorClaims?.length !== MAX_LINES) failures.push("ownership_contributor_claim_count_wrong");
  if (unsigned.ownershipPolicy?.contributorClaims?.some((claim) => claim.wholePoemOwnership !== false || claim.claimScope !== "own_line_receipt_only")) {
    failures.push("ownership_contributor_scope_wrong");
  }
  if (unsigned.offchainMetadata?.kind !== "chain-poem-offchain-metadata") failures.push("offchain_metadata_missing");
  if (unsigned.offchainMetadata?.storageStatus !== "generated_offchain_not_minted") failures.push("offchain_metadata_storage_status_wrong");
  if (unsigned.offchainMetadata?.ownershipPolicyVersion !== unsigned.ownershipPolicy?.version) failures.push("offchain_ownership_policy_version_mismatch");
  if (!unsigned.offchainMetadata?.poem?.properties?.ownershipSummary?.includes("no single contributor owns the whole poem")) {
    failures.push("offchain_ownership_summary_missing");
  }
  if (unsigned.offchainMetadata?.poem?.properties?.poemHash !== unsigned.poemHash) failures.push("offchain_metadata_hash_mismatch");
  if (unsigned.offchainMetadata?.lineReceipts?.length !== MAX_LINES) failures.push("offchain_line_metadata_count_wrong");
  if (unsigned.offchainMetadata?.lineReceipts?.[0]?.properties?.claimScope !== "own_line_receipt_only") failures.push("offchain_line_claim_scope_wrong");
  if (!unsigned.offchainMetadata?.lineReceipts?.[0]?.description?.includes("The first hand lights the threshold.")) failures.push("offchain_line_metadata_text_missing");
  if (unsigned.lineReceiptMintPlan?.kind !== "chain-poem-line-receipt-mint-plan") failures.push("line_receipt_mint_plan_missing");
  if (unsigned.lineReceiptMintPlan?.standard !== "ERC-1155") failures.push("line_receipt_standard_wrong");
  if (unsigned.lineReceiptMintPlan?.chainId !== 8453) failures.push("line_receipt_chain_wrong");
  if (unsigned.lineReceiptMintPlan?.enabled !== false || unsigned.lineReceiptMintPlan?.mintAllowed !== false) failures.push("line_receipt_mint_not_dormant");
  if (unsigned.lineReceiptMintPlan?.contractAddress !== null) failures.push("line_receipt_contract_should_be_null");
  if (unsigned.lineReceiptMintPlan?.receipts?.length !== MAX_LINES) failures.push("line_receipt_count_wrong");
  if (!unsigned.lineReceiptMintPlan?.receipts?.[0]?.description?.includes("The first hand lights the threshold.")) failures.push("line_receipt_text_missing");
  if (!/^\d+$/.test(String(unsigned.lineReceiptMintPlan?.receipts?.[0]?.tokenId || ""))) failures.push("line_receipt_token_id_missing");
  if (!unsigned.lineReceiptMintPlan?.receipts?.[0]?.tokenIdSeed?.startsWith("sha256:")) failures.push("line_receipt_token_seed_missing");
  if (!unsigned.lineReceiptMintPlan?.receipts?.[0]?.claimKey?.startsWith("sha256:")) failures.push("line_receipt_claim_key_missing");
  if (!unsigned.lineReceiptMintPlan?.receipts?.[0]?.metadataUrl?.includes("/api/line-receipt-metadata?tokenId=")) failures.push("line_receipt_metadata_url_missing");
  if (!unsigned.lineReceiptMintPlan?.receipts?.[0]?.image?.includes("/api/line-receipt-image?tokenId=")) failures.push("line_receipt_image_url_missing");
  if (unsigned.lineReceiptMintPlan?.receipts?.[0]?.metadata?.tokenId !== unsigned.lineReceiptMintPlan?.receipts?.[0]?.tokenId) {
    failures.push("line_receipt_metadata_token_id_mismatch");
  }
  if (!unsigned.offchainMetadata?.lineReceipts?.[0]?.image?.includes("/api/line-receipt-image?tokenId=")) failures.push("offchain_line_image_url_missing");

  const signed = buildProvenance(canonical.poem, "123", "test-secret");
  const signedAgain = buildProvenance(again.poem, "123", "test-secret");
  if (!signed.signed || !signed.signature) failures.push("signed_provenance_missing_signature");
  if (signed.signature !== signedAgain.signature) failures.push("signature_not_stable");
  if (signed.poemHash !== unsigned.poemHash) failures.push("signed_hash_differs_from_unsigned_hash");
  if (signed.mintAllowed !== false) failures.push("signed_mint_allowed_not_false");
  if (signed.lineReceiptMintPlan.receipts[0].claimKey !== signedAgain.lineReceiptMintPlan.receipts[0].claimKey) failures.push("line_receipt_claim_key_not_stable");
}

const result = {
  ok: failures.length === 0,
  generatedAtUtc: new Date().toISOString(),
  failures,
};
console.log(JSON.stringify(result, null, 2));
if (failures.length) process.exit(1);
