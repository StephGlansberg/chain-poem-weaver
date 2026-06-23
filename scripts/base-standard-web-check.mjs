import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..");
const outputPath = join(root, "data", "base-standard-web-readiness.json");
const failures = [];
const warnings = [];

const packageJson = readJson(join(root, "package.json"));
const index = readText(join(root, "index.html"));
const main = readText(join(root, "src", "main.js"));
const provenanceApi = readText(join(root, "api", "provenance.mjs"));
const vercel = readJson(join(root, "vercel.json"));
const webManifest = readJson(join(root, "manifest.webmanifest"));

check("index_html_present", Boolean(index));
check("main_js_present", Boolean(main));
check("web_manifest_present", Boolean(webManifest));
check("vercel_config_present", Boolean(vercel));
check("package_json_present", Boolean(packageJson));

if (!index.includes('<meta name="viewport"')) failures.push("viewport_meta_missing");
if (!index.includes('rel="manifest"')) failures.push("web_manifest_link_missing");
if (!index.includes("/src/main.js")) failures.push("module_script_missing");
if (!main.includes("catch")) failures.push("farcaster_sdk_failure_path_missing");
if (!main.includes("state.sdk = null")) failures.push("farcaster_sdk_null_fallback_missing");
if (!main.includes("localStorage")) failures.push("standard_web_local_persistence_missing");
if (!main.includes("farcaster.xyz/~/compose")) failures.push("standard_web_share_fallback_missing");
if (!main.includes("window.open")) failures.push("browser_share_window_fallback_missing");
if (!main.includes("function openShareFallback")) failures.push("share_fallback_function_missing");
if (!main.includes("navigator.clipboard")) failures.push("copy_link_fallback_missing");
if (!main.includes("No Farcaster context detected")) failures.push("browser_context_message_missing");
if (!main.includes("state.sdk?.quickAuth")) failures.push("quick_auth_optional_guard_missing");
if (!provenanceApi.includes("mintAllowed: false")) failures.push("paid_mint_gate_missing");
if (main.includes("ethereum.request") || main.includes("wallet_switchEthereumChain")) {
  warnings.push("direct_wallet_calls_present_review_base_account_path");
}

const deps = {
  wagmi: Boolean(packageJson?.dependencies?.wagmi || packageJson?.devDependencies?.wagmi),
  viem: Boolean(packageJson?.dependencies?.viem || packageJson?.devDependencies?.viem),
  baseAccount: Boolean(packageJson?.dependencies?.["@base-org/account"] || packageJson?.devDependencies?.["@base-org/account"]),
};

const baseWalletReady = deps.baseAccount || (deps.wagmi && deps.viem);
if (!baseWalletReady) {
  warnings.push("base_wallet_auth_not_wired_onchain_features_must_remain_dormant");
}

if (vercel) {
  const rewrites = Array.isArray(vercel.rewrites) ? vercel.rewrites : [];
  if (!rewrites.some((rewrite) => rewrite.source === "/poem" && rewrite.destination === "/index.html")) {
    failures.push("poem_rewrite_missing");
  }
}

if (webManifest) {
  if (webManifest.name !== "Poem Weaver") failures.push("web_manifest_name_mismatch");
  if (!Array.isArray(webManifest.icons) || webManifest.icons.length === 0) failures.push("web_manifest_icons_missing");
}

const result = {
  schemaVersion: 1,
  kind: "chain-poem-weaver-base-standard-web-readiness",
  generatedAtUtc: new Date().toISOString(),
  ok: failures.length === 0,
  standardWebReady: failures.length === 0,
  baseWalletReady,
  baseOnchainFeaturesDormant: !baseWalletReady && provenanceApi.includes("mintAllowed: false"),
  dependencies: deps,
  failures: unique(failures),
  warnings: unique(warnings),
  next: baseWalletReady
    ? "Base wallet path is present. Review wallet ownership and paid mint gates before enabling onchain actions."
    : "Standard web path is ready; keep Base paid/onchain actions dormant until Base Account or wagmi/viem is wired.",
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify(result, null, 2));
if (result.failures.length) process.exit(1);

function check(label, ok) {
  if (!ok) failures.push(label);
}

function readJson(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readText(path) {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}
