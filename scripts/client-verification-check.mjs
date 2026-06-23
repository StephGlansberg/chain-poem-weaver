import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

const root = process.cwd();
const receiptPath = join(root, "data", "client-verification.json");
const checkPath = join(root, "data", "client-verification-check.json");
const templatePath = join(root, "data", "client-verification.template.json");
const writeTemplate = process.argv.includes("--template");

if (writeTemplate) {
  const template = buildTemplate();
  mkdirSync(dirname(templatePath), { recursive: true });
  writeFileSync(templatePath, `${JSON.stringify(template, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ok: true, templatePath, next: "Fill data/client-verification.json after live Farcaster/Base client testing." }, null, 2));
  process.exit(0);
}

const failures = [];
const warnings = [];
const receipt = readJson(receiptPath);
const deployment = readJson(join(root, "data", "live-verify-run.json"));
const deploymentConfig = readJson(join(root, "dist", "data", "deployment-config.json"));
const expectedOrigin = cleanOrigin(process.env.MINIAPP_ORIGIN || deployment?.origin || deploymentConfig?.origin || "");

if (!receipt) {
  failures.push("client_verification_receipt_missing");
} else {
  if (receipt.kind !== "chain-poem-weaver-client-verification") failures.push("client_verification_kind_invalid");
  if (!receipt.testedAtUtc || Number.isNaN(Date.parse(receipt.testedAtUtc))) failures.push("client_verification_tested_at_invalid");
  if (!receipt.tester) failures.push("client_verification_tester_missing");
  const origin = cleanOrigin(receipt.origin || "");
  if (!origin) failures.push("client_verification_origin_missing");
  if (origin && expectedOrigin && origin !== expectedOrigin) failures.push("client_verification_origin_mismatch");
  if (origin && !origin.startsWith("https://")) failures.push("client_verification_origin_not_https");
  if (!receipt.farcaster?.launchedFromClient) failures.push("farcaster_client_launch_missing");
  if (!receipt.farcaster?.composeCastOpened) failures.push("farcaster_compose_cast_missing");
  if (!receipt.farcaster?.completedPoemShared) failures.push("farcaster_completed_poem_share_missing");
  if (!receipt.farcaster?.shareUrl) failures.push("farcaster_share_url_missing");
  else {
    const shareUrl = cleanShareUrl(receipt.farcaster.shareUrl);
    if (!shareUrl) failures.push("farcaster_share_url_invalid");
    else {
      if (origin && shareUrl.origin !== origin) failures.push("farcaster_share_url_origin_mismatch");
      if (!shareUrl.searchParams.get("poem")) failures.push("farcaster_share_url_poem_payload_missing");
      if (!shareUrl.searchParams.get("poemId")) failures.push("farcaster_share_url_poem_id_missing");
    }
  }
  if (!receipt.farcaster?.embedRenderedAsMiniApp) failures.push("farcaster_embed_render_missing");
  if (!receipt.farcaster?.quickAuthTokenAccepted) failures.push("farcaster_quick_auth_token_missing");
  if (!receipt.farcaster?.provenanceHashCreated) failures.push("farcaster_provenance_hash_missing");
  if (!receipt.base?.openedAsStandardWeb) failures.push("base_standard_web_open_missing");
  if (!receipt.base?.browserFallbackWorks) failures.push("base_browser_fallback_missing");
  if (!receipt.base?.shareFallbackWorks) failures.push("base_share_fallback_missing");
  if (receipt.paidMintEnabled !== false) failures.push("client_verification_paid_mint_must_remain_disabled");
  if (!receipt.noUnexpectedWalletPrompt) failures.push("client_verification_wallet_prompt_check_missing");
  checkEvidence("farcaster", receipt.farcaster?.evidence);
  checkEvidence("base", receipt.base?.evidence);
}

const result = {
  schemaVersion: 1,
  kind: "chain-poem-weaver-client-verification-check",
  generatedAtUtc: new Date().toISOString(),
  ok: failures.length === 0,
  receiptPath,
  expectedOrigin: expectedOrigin || null,
  failures: unique(failures),
  warnings: unique(warnings),
  next: failures.length
    ? "After live HTTPS deploy, fill data/client-verification.json from data/client-verification.template.json and rerun npm run test:client-verification."
    : "Client verification receipt is complete. Keep the evidence with the release packet.",
};

mkdirSync(dirname(checkPath), { recursive: true });
writeFileSync(checkPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify(result, null, 2));
if (failures.length) process.exit(1);

function buildTemplate() {
  const deployment = readJson(join(root, "data", "live-verify-run.json"));
  const deploymentConfig = readJson(join(root, "dist", "data", "deployment-config.json"));
  const origin = cleanOrigin(process.env.MINIAPP_ORIGIN || deployment?.origin || deploymentConfig?.origin || "");
  return {
    schemaVersion: 1,
    kind: "chain-poem-weaver-client-verification",
    testedAtUtc: new Date().toISOString(),
    tester: "",
    origin: origin || "https://YOUR_REAL_DOMAIN",
    farcaster: {
      launchedFromClient: false,
      launchedFromCastUrl: "",
      composeCastOpened: false,
      completedPoemShared: false,
      shareUrl: "",
      embedRenderedAsMiniApp: false,
      quickAuthTokenAccepted: false,
      provenanceHashCreated: false,
      evidence: {
        screenshotPath: "",
        notes: "",
      },
    },
    base: {
      openedAsStandardWeb: false,
      browserFallbackWorks: false,
      shareFallbackWorks: false,
      evidence: {
        screenshotPath: "",
        notes: "",
      },
    },
    paidMintEnabled: false,
    noUnexpectedWalletPrompt: false,
    notes: "",
  };
}

function checkEvidence(label, evidence) {
  if (!evidence) {
    failures.push(`${label}_evidence_missing`);
    return;
  }
  const screenshot = String(evidence.screenshotPath || "").trim();
  const notes = String(evidence.notes || "").trim();
  const url = String(evidence.url || "").trim();
  if (!screenshot && !notes && !url) {
    failures.push(`${label}_evidence_empty`);
    return;
  }
  if (screenshot) {
    const path = isAbsolute(screenshot) ? screenshot : join(root, screenshot);
    if (!existsSync(path)) warnings.push(`${label}_screenshot_path_not_found:${screenshot}`);
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

function cleanOrigin(value) {
  const trimmed = String(value || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "https:") return "";
  return parsed.origin;
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

function unique(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}
