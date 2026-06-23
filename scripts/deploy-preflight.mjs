import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = process.cwd();
const dist = join(root, "dist");
const origin = cleanOrigin(process.env.MINIAPP_ORIGIN || process.argv[2] || "");
const domain = origin ? new URL(origin).hostname : "";
const failures = [];
const warnings = [];
const checks = [];

check("source:index", existsSync(join(root, "index.html")));
check("source:manifest", existsSync(join(root, ".well-known", "farcaster.json")));
check("source:api_me", existsSync(join(root, "api", "me.mjs")));
check("source:api_provenance", existsSync(join(root, "api", "provenance.mjs")));
check("source:package", existsSync(join(root, "package.json")));
check("source:package_lock", existsSync(join(root, "package-lock.json")));
check("dist:exists", existsSync(dist));
check("dist:api_me", existsSync(join(dist, "api", "me.mjs")));
check("dist:api_provenance", existsSync(join(dist, "api", "provenance.mjs")));
check("dist:package", existsSync(join(dist, "package.json")));
check("dist:package_lock", existsSync(join(dist, "package-lock.json")));

if (!origin) failures.push("miniapp_origin_missing");
if (origin && origin.includes(".example")) failures.push("miniapp_origin_placeholder");

const packageJson = readJson(join(root, "package.json"));
if (!packageJson?.dependencies?.["@farcaster/quick-auth"]) failures.push("quick_auth_dependency_missing");

const apiText = readText(join(root, "api", "me.mjs"));
if (!apiText.includes("@farcaster/quick-auth")) failures.push("api_me_quick_auth_import_missing");
if (!apiText.includes("verifyJwt")) failures.push("api_me_verify_jwt_missing");
if (!apiText.includes("missing_bearer_token")) failures.push("api_me_fail_closed_gate_missing");

const provenanceText = readText(join(root, "api", "provenance.mjs"));
if (!provenanceText.includes("@farcaster/quick-auth")) failures.push("api_provenance_quick_auth_import_missing");
if (!provenanceText.includes("poem_not_complete")) failures.push("api_provenance_complete_gate_missing");
if (!provenanceText.includes("mintAllowed: false")) failures.push("api_provenance_mint_gate_missing");

const association = readAssociation();
const associationCheck = validateAssociation(association, domain);
failures.push(...associationCheck.failures);
warnings.push(...associationCheck.warnings);

const deploymentBuild = readJson(join(dist, "deployment-build.json"));
if (!deploymentBuild) {
  failures.push("dist_deployment_build_missing");
} else {
  if (deploymentBuild.productionMode !== true) warnings.push("dist_not_built_in_production_mode");
  if (origin && deploymentBuild.productionConfig?.origin && deploymentBuild.productionConfig.origin !== origin) {
    failures.push("dist_origin_mismatch");
  }
}

const distManifest = readJson(join(dist, ".well-known", "farcaster.json"));
if (origin && distManifest) {
  if (distManifest.miniapp?.canonicalDomain !== domain) failures.push("dist_manifest_canonical_domain_mismatch");
  if (distManifest.miniapp?.homeUrl !== `${origin}/poem`) failures.push("dist_manifest_home_url_mismatch");
  if (JSON.stringify(distManifest).includes(".example")) failures.push("dist_manifest_uses_placeholder_domain");
}

const result = {
  ok: failures.length === 0,
  generatedAtUtc: new Date().toISOString(),
  origin: origin || null,
  domain: domain || null,
  checks,
  failures,
  warnings,
  next: failures.length
    ? "Fix failures, run npm run build:production with real association env vars, then deploy dist to a server-capable HTTPS host."
    : "Deploy dist to the HTTPS host, then run node scripts/verify-deployment.mjs $env:MINIAPP_ORIGIN.",
};

console.log(JSON.stringify(result, null, 2));
if (failures.length) process.exit(1);

function check(label, ok) {
  checks.push({ label, ok: Boolean(ok) });
  if (!ok) failures.push(`${label.replace(/[:]/g, "_")}_missing`);
}

function readAssociation() {
  const fromEnv = {
    header: process.env.FARCASTER_ACCOUNT_ASSOCIATION_HEADER || "",
    payload: process.env.FARCASTER_ACCOUNT_ASSOCIATION_PAYLOAD || "",
    signature: process.env.FARCASTER_ACCOUNT_ASSOCIATION_SIGNATURE || "",
  };
  if (fromEnv.header || fromEnv.payload || fromEnv.signature) return fromEnv;
  const manifest = readJson(join(root, ".well-known", "farcaster.json"));
  return manifest?.accountAssociation || {};
}

function validateAssociation(association, expectedDomain) {
  const localFailures = [];
  const localWarnings = [];
  for (const field of ["header", "payload", "signature"]) {
    if (!association?.[field]) localFailures.push(`account_association_${field}_missing`);
  }
  if (!association?.header || !association?.payload || !association?.signature) {
    return { failures: localFailures, warnings: localWarnings };
  }
  const header = parseBase64Json(association.header);
  const payload = parseBase64Json(association.payload);
  if (!header) localFailures.push("account_association_header_invalid_base64_json");
  if (!payload) localFailures.push("account_association_payload_invalid_base64_json");
  if (header && !["custody", "auth"].includes(header.type)) localFailures.push("account_association_header_type_invalid");
  if (payload?.domain && expectedDomain && payload.domain !== expectedDomain) localFailures.push("account_association_domain_mismatch");
  if (payload?.domain && String(payload.domain).includes("://")) localFailures.push("account_association_domain_has_protocol");
  if (String(association.signature || "").length < 64) localFailures.push("account_association_signature_too_short");
  localWarnings.push("account_association_shape_only_not_cryptographic_verification");
  return { failures: localFailures, warnings: localWarnings };
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

function parseBase64Json(value) {
  try {
    const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function cleanOrigin(value) {
  const trimmed = String(value || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "https:") throw new Error("MINIAPP_ORIGIN must use https");
  return parsed.origin;
}
