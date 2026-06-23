import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = process.cwd();
const outputPath = join(root, "data", "hosting-config-check.json");
const failures = [];
const warnings = [];
const checks = [];

const vercel = readJson(join(root, "vercel.json"));
const packageJson = readJson(join(root, "package.json"));
const apiMe = readText(join(root, "api", "me.mjs"));
const apiProvenance = readText(join(root, "api", "provenance.mjs"));
const apiRandomWeave = readText(join(root, "api", "random-weave.mjs"));
const apiLineReceiptMetadata = readText(join(root, "api", "line-receipt-metadata.mjs"));
const apiLineReceiptImage = readText(join(root, "api", "line-receipt-image.mjs"));
const apiLineReceiptClaim = readText(join(root, "api", "line-receipt-claim.mjs"));

check("vercel_json_exists", Boolean(vercel));
check("package_json_exists", Boolean(packageJson));
check("api_me_exists", existsSync(join(root, "api", "me.mjs")));
check("api_provenance_exists", existsSync(join(root, "api", "provenance.mjs")));
check("api_random_weave_exists", existsSync(join(root, "api", "random-weave.mjs")));
check("api_line_receipt_metadata_exists", existsSync(join(root, "api", "line-receipt-metadata.mjs")));
check("api_line_receipt_image_exists", existsSync(join(root, "api", "line-receipt-image.mjs")));
check("api_line_receipt_claim_exists", existsSync(join(root, "api", "line-receipt-claim.mjs")));

if (vercel) {
check("vercel_build_command_production", vercel.buildCommand === "npm run build:production");
check("vercel_install_command_npm", vercel.installCommand === "npm install");
check("vercel_dev_command_static_server", vercel.devCommand === "npm run dev");
check("vercel_output_directory_dist", vercel.outputDirectory === "dist");
  check("vercel_clean_urls_enabled", vercel.cleanUrls === true);
  check("well_known_manifest_json_header", hasHeader(vercel, "/.well-known/farcaster.json", "Content-Type", "application/json; charset=utf-8"));
  check("poem_rewrite_present", hasRewrite(vercel, "/poem", "/index.html"));
  check("poem_nested_rewrite_present", hasRewrite(vercel, "/poem/:path*", "/index.html"));
  if (Array.isArray(vercel.routes) && vercel.routes.length > 0) warnings.push("vercel_routes_present_review_for_api_shadowing");
}

if (packageJson) {
  check("package_build_production_script", packageJson.scripts?.["build:production"] === "node scripts/build-static.mjs --production");
  check("package_deploy_live_script", packageJson.scripts?.["deploy:production:live"] === "node scripts/deploy-production.mjs --live");
  check("package_verify_deployment_script", packageJson.scripts?.["verify:deployment"] === "node scripts/verify-deployment.mjs");
}

check("api_me_default_handler", apiMe.includes("export default async function handler"));
check("api_me_no_store", apiMe.includes('cache-control", "no-store"'));
check("api_me_json_content_type", apiMe.includes("application/json; charset=utf-8"));
check("api_provenance_default_handler", apiProvenance.includes("export default async function handler"));
check("api_provenance_no_store", apiProvenance.includes('cache-control", "no-store"'));
check("api_provenance_json_content_type", apiProvenance.includes("application/json; charset=utf-8"));
check("api_provenance_body_limit", apiProvenance.includes("MAX_BODY_BYTES"));
check("api_random_weave_default_handler", apiRandomWeave.includes("export default async function handler"));
check("api_random_weave_no_store", apiRandomWeave.includes('cache-control", "no-store"'));
check("api_random_weave_json_content_type", apiRandomWeave.includes("application/json; charset=utf-8"));
check("api_random_weave_body_limit", apiRandomWeave.includes("MAX_BODY_BYTES"));
check("api_line_receipt_metadata_default_handler", apiLineReceiptMetadata.includes("export default async function handler"));
check("api_line_receipt_metadata_public_cache", apiLineReceiptMetadata.includes("public, max-age=60"));
check("api_line_receipt_metadata_json_content_type", apiLineReceiptMetadata.includes("application/json; charset=utf-8"));
check("api_line_receipt_image_default_handler", apiLineReceiptImage.includes("export default async function handler"));
check("api_line_receipt_image_public_cache", apiLineReceiptImage.includes("public, max-age=60"));
check("api_line_receipt_image_svg_content_type", apiLineReceiptImage.includes("image/svg+xml; charset=utf-8"));
check("api_line_receipt_claim_default_handler", apiLineReceiptClaim.includes("export default async function handler"));
check("api_line_receipt_claim_no_store", apiLineReceiptClaim.includes('cache-control", "no-store"'));
check("api_line_receipt_claim_json_content_type", apiLineReceiptClaim.includes("application/json; charset=utf-8"));
check("api_line_receipt_claim_env_gate", apiLineReceiptClaim.includes("CHAIN_POEM_LINE_RECEIPT_CLAIM_ENABLED=true"));

const result = {
  schemaVersion: 1,
  kind: "chain-poem-weaver-hosting-config-check",
  generatedAtUtc: new Date().toISOString(),
  ok: failures.length === 0,
  provider: "vercel",
  checks,
  failures,
  warnings,
  next: failures.length
    ? "Fix hosting config failures before live deploy."
    : "Hosting config is compatible with the current Vercel/serverless deployment path.",
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify(result, null, 2));
if (failures.length) process.exit(1);

function check(label, ok) {
  const pass = Boolean(ok);
  checks.push({ label, ok: pass });
  if (!pass) failures.push(label);
}

function hasRewrite(config, source, destination) {
  return Array.isArray(config.rewrites) && config.rewrites.some((entry) => entry.source === source && entry.destination === destination);
}

function hasHeader(config, source, key, value) {
  const block = Array.isArray(config.headers) ? config.headers.find((entry) => entry.source === source) : null;
  return Boolean(block?.headers?.some((entry) => entry.key === key && entry.value === value));
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
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
