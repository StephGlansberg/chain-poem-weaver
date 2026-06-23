import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = process.cwd();
const receiptPath = join(root, "data", "six-fid-private-test.json");
const checkPath = join(root, "data", "six-fid-private-test-check.json");
const templatePath = join(root, "data", "six-fid-private-test.template.json");
const writeTemplate = process.argv.includes("--template");
// The receipt filename is legacy. The current private proof rule is five real
// non-dev FIDs because Chain Poem Weaver completes a weave at five voices.
const REQUIRED_TESTERS = 5;

if (writeTemplate) {
  mkdirSync(dirname(templatePath), { recursive: true });
  writeFileSync(templatePath, `${JSON.stringify(buildTemplate(), null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ok: true, templatePath, next: "Fill data/six-fid-private-test.json after the private Farcaster run." }, null, 2));
  process.exit(0);
}

const failures = [];
const warnings = [];
const receipt = readJson(receiptPath);

if (!receipt) {
  failures.push("six_fid_receipt_missing");
} else {
  if (receipt.kind !== "chain-poem-weaver-six-fid-private-test") failures.push("six_fid_kind_invalid");
  if (!receipt.testedAtUtc || Number.isNaN(Date.parse(receipt.testedAtUtc))) failures.push("six_fid_tested_at_invalid");
  const testers = Array.isArray(receipt.testers) ? receipt.testers : [];
  if (testers.length < REQUIRED_TESTERS) failures.push("five_fid_tester_count_below_required");
  const fids = testers.map((tester) => String(tester.fid || "").trim()).filter(Boolean);
  if (fids.length < REQUIRED_TESTERS) failures.push("six_fid_values_missing");
  if (new Set(fids).size < REQUIRED_TESTERS) failures.push("six_fid_not_distinct");
  if (!testers.slice(0, REQUIRED_TESTERS).every((tester) => tester.realNonDev === true)) failures.push("six_fid_real_non_dev_not_confirmed");
  if (!testers.slice(0, REQUIRED_TESTERS).every((tester) => tester.submittedLine === true)) failures.push("six_fid_line_submission_missing");
  if (!testers.slice(0, REQUIRED_TESTERS).every((tester) => tester.quickAuthWorked === true)) failures.push("six_fid_quick_auth_missing");
  if (!receipt.completedPoem?.poemId) failures.push("six_fid_completed_poem_id_missing");
  if (!String(receipt.completedPoem?.poemHash || "").startsWith("sha256:")) failures.push("six_fid_poem_hash_missing");
  if (!receipt.completedPoem?.shareUrl) failures.push("six_fid_share_url_missing");
  else {
    const shareUrl = cleanShareUrl(receipt.completedPoem.shareUrl);
    if (!shareUrl) failures.push("six_fid_share_url_invalid");
    else {
      if (!shareUrl.searchParams.get("poem")) failures.push("six_fid_share_url_poem_payload_missing");
      if (!shareUrl.searchParams.get("poemId")) failures.push("six_fid_share_url_poem_id_missing");
    }
  }
  if (!receipt.completedPoem?.embedRenderedAsMiniApp) failures.push("six_fid_embed_render_missing");
  if (!receipt.completedPoem?.provenanceHashCreated) failures.push("six_fid_provenance_hash_not_created");
  if (!receipt.failClosedRechecked) failures.push("six_fid_fail_closed_recheck_missing");
  if (!receipt.mintAndTokenStillDisabled) failures.push("six_fid_financial_pins_not_confirmed");
  if (!receipt.ownershipIntent?.atLeastOneKeepOwnLine) failures.push("six_fid_ownership_intent_missing");
  if (!receipt.evidence?.notes && !receipt.evidence?.screenshotDirectory && !receipt.evidence?.castUrl) {
    failures.push("six_fid_evidence_missing");
  }
  if (receipt.evidence?.screenshotDirectory && !existsSync(join(root, receipt.evidence.screenshotDirectory))) {
    warnings.push(`six_fid_screenshot_directory_not_found:${receipt.evidence.screenshotDirectory}`);
  }
}

const result = {
  schemaVersion: 1,
  kind: "chain-poem-weaver-six-fid-private-test-check",
  generatedAtUtc: new Date().toISOString(),
  ok: failures.length === 0,
  receiptPath,
  failures: unique(failures),
  warnings: unique(warnings),
  next: failures.length
    ? "Run the private five-FID test, fill data/six-fid-private-test.json from the template, then rerun this check."
    : "Five-FID private test receipt is complete. Proceed to final share/client verification review.",
};

mkdirSync(dirname(checkPath), { recursive: true });
writeFileSync(checkPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify(result, null, 2));
if (failures.length) process.exit(1);

function buildTemplate() {
  return {
    schemaVersion: 1,
    kind: "chain-poem-weaver-six-fid-private-test",
    testedAtUtc: new Date().toISOString(),
    origin: "https://chain-poem-weaver.vercel.app",
    testers: Array.from({ length: REQUIRED_TESTERS }, (_, index) => ({
      slot: index + 1,
      handle: "",
      fid: "",
      realNonDev: false,
      submittedLine: false,
      quickAuthWorked: false,
      matchedOrCompleted: false,
      screenshotPath: "",
      wantsToKeepOwnLine: false,
      notes: "",
    })),
    completedPoem: {
      poemId: "",
      poemHash: "",
      shareUrl: "",
      castUrl: "",
      embedRenderedAsMiniApp: false,
      provenanceHashCreated: false,
    },
    ownershipIntent: {
      atLeastOneKeepOwnLine: false,
      notes: "",
    },
    failClosedRechecked: false,
    mintAndTokenStillDisabled: false,
    evidence: {
      screenshotDirectory: "",
      castUrl: "",
      notes: "",
    },
  };
}

function cleanShareUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    if (parsed.protocol !== "https:") return null;
    return parsed;
  } catch {
    return null;
  }
}

function readJson(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}
