import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const dist = join(root, "dist");
const outputPath = join(root, "data", "release-packet.json");
const strict = process.argv.includes("--strict");

const packageJson = readJson(join(root, "package.json"));
const sourceManifest = readJson(join(root, ".well-known", "farcaster.json"));
const distManifest = readJson(join(dist, ".well-known", "farcaster.json"));
const deploymentBuild = readJson(join(dist, "deployment-build.json"));
const deploymentConfig = readJson(join(dist, "data", "deployment-config.json"));
const clientVerificationCheck = readJson(join(root, "data", "client-verification-check.json"));
const lineReceiptContractCheck = readJson(join(root, "data", "line-receipt-contract-readiness.json"));
const deployTarget = runDeployTargetCheck();

const sourceFiles = [
  "package.json",
  "package-lock.json",
  "index.html",
  ".well-known/farcaster.json",
  "api/me.mjs",
  "api/provenance.mjs",
  "contracts/ChainPoemLineReceipts.sol",
  "src/main.js",
  "src/poem.js",
  "src/styles.css",
  "scripts/build-static.mjs",
  "scripts/deploy-target-check.mjs",
  "scripts/deploy-production.mjs",
  "scripts/operator-release-brief.mjs",
  "scripts/manifest-assert.mjs",
  "scripts/base-standard-web-check.mjs",
  "scripts/hosting-config-check.mjs",
  "scripts/production-rehearsal-check.mjs",
  "scripts/client-verification-check.mjs",
  "scripts/deploy-preflight.mjs",
  "scripts/verify-deployment.mjs",
  "scripts/api-fail-closed-check.mjs",
  "scripts/provenance-canonical-check.mjs",
  "scripts/line-receipt-contract-check.mjs",
  "scripts/release-packet.mjs",
  "assets/chain-poem-icon.png",
  "assets/poem-splash.png",
  "assets/chain-poem-weaver.png",
  "assets/chain-poem-hero.png",
  "assets/chain-poem-og.png",
];

const distFiles = [
  "deployment-build.json",
  "package.json",
  "package-lock.json",
  "index.html",
  ".well-known/farcaster.json",
  "api/me.mjs",
  "api/provenance.mjs",
  "contracts/ChainPoemLineReceipts.sol",
  "src/main.js",
  "src/poem.js",
  "scripts/static-check.mjs",
  "scripts/deploy-target-check.mjs",
  "scripts/deploy-production.mjs",
  "scripts/operator-release-brief.mjs",
  "scripts/manifest-assert.mjs",
  "scripts/base-standard-web-check.mjs",
  "scripts/hosting-config-check.mjs",
  "scripts/production-rehearsal-check.mjs",
  "scripts/client-verification-check.mjs",
  "scripts/deploy-preflight.mjs",
  "scripts/verify-deployment.mjs",
  "scripts/api-fail-closed-check.mjs",
  "scripts/provenance-canonical-check.mjs",
  "scripts/line-receipt-contract-check.mjs",
  "scripts/release-packet.mjs",
  "assets/chain-poem-icon.png",
  "assets/poem-splash.png",
  "assets/chain-poem-weaver.png",
  "assets/chain-poem-hero.png",
  "assets/chain-poem-og.png",
];

const blockers = [];
const warnings = [];

if (!packageJson) blockers.push("package_json_missing");
if (!packageJson?.dependencies?.["@farcaster/quick-auth"]) blockers.push("quick_auth_dependency_missing");
if (!deploymentBuild) blockers.push("dist_deployment_build_missing");
if (deploymentBuild && deploymentBuild.productionMode !== true) blockers.push("dist_not_built_in_production_mode");
if (!deploymentConfig?.origin) blockers.push("production_origin_missing");
if (deploymentConfig?.origin && !String(deploymentConfig.origin).startsWith("https://")) blockers.push("production_origin_not_https");
if (deploymentConfig?.origin && String(deploymentConfig.origin).includes(".example")) blockers.push("production_origin_placeholder");
if (!distManifest) blockers.push("dist_manifest_missing");
if (distManifest && JSON.stringify(distManifest).includes(".example")) blockers.push("dist_manifest_uses_placeholder_domain");

const association = distManifest?.accountAssociation || sourceManifest?.accountAssociation || {};
for (const field of ["header", "payload", "signature"]) {
  if (!association?.[field]) blockers.push(`account_association_${field}_missing`);
}
const associationShape = validateAssociation(association, distManifest?.miniapp?.canonicalDomain || deploymentConfig?.domain || "");
blockers.push(...associationShape.failures);
warnings.push(...associationShape.warnings);

const apiChecks = {
  quickAuthApi: markerCheck("api/me.mjs", ["@farcaster/quick-auth", "verifyJwt", "missing_bearer_token", "no-store"]),
  provenanceApi: markerCheck("api/provenance.mjs", ["@farcaster/quick-auth", "poem_not_complete", "sha256", "mintAllowed: false"]),
  lineReceiptMintPlan: markerCheck("api/provenance.mjs", [
    "chain-poem-line-receipt-mint-plan",
    "standard: \"ERC-1155\"",
    "contractAddress: null",
  ]),
  lineReceiptContract: markerCheck("contracts/ChainPoemLineReceipts.sol", [
    "contract ChainPoemLineReceipts is ERC1155",
    "claimLine(LineClaim calldata claim",
    "claimed[claim.claimKey]",
    "block.chainid",
  ]),
  frontendAuth: markerCheck("src/main.js", ["quickAuth.getToken", 'fetch("/api/me"', 'fetch("/api/provenance"', "Minting remains disabled"]),
};
for (const [name, check] of Object.entries(apiChecks)) {
  if (!check.ok) blockers.push(`${name}_markers_missing:${check.missing.join(",")}`);
}
if (deployTarget && deployTarget.ok === false) blockers.push(...(deployTarget.blockers || []).map((blocker) => `deploy_target:${blocker}`));
if (deployTarget?.warnings) warnings.push(...deployTarget.warnings.map((warning) => `deploy_target:${warning}`));

const packet = {
  schemaVersion: 1,
  kind: "chain-poem-weaver-release-packet",
  appId: "chain-poem-weaver",
  generatedAtUtc: new Date().toISOString(),
  package: {
    name: packageJson?.name || null,
    version: packageJson?.version || null,
    quickAuthDependency: packageJson?.dependencies?.["@farcaster/quick-auth"] || null,
  },
  deployment: {
    productionMode: deploymentBuild?.productionMode === true,
    origin: deploymentConfig?.origin || deploymentBuild?.productionConfig?.origin || null,
    homeUrl: deploymentConfig?.homeUrl || deploymentBuild?.productionConfig?.homeUrl || null,
    domain: deploymentConfig?.domain || deploymentBuild?.productionConfig?.domain || null,
    accountAssociationReady: Boolean(
      association?.header && association?.payload && association?.signature && associationShape.failures.length === 0,
    ),
    buildGeneratedAtUtc: deploymentBuild?.generatedAtUtc || null,
  },
  deployTarget,
  manifest: {
    sourceHomeUrl: sourceManifest?.miniapp?.homeUrl || null,
    distHomeUrl: distManifest?.miniapp?.homeUrl || null,
    canonicalDomain: distManifest?.miniapp?.canonicalDomain || sourceManifest?.miniapp?.canonicalDomain || null,
  },
  authAndProvenance: {
    quickAuthFailClosedExpected: true,
    provenanceRequiresQuickAuth: true,
    mintAllowed: false,
    serverSignatureEnv: "CHAIN_POEM_PROVENANCE_SECRET",
    checks: apiChecks,
  },
  lineReceiptMint: {
    standard: "ERC-1155",
    chainId: 8453,
    network: "base",
    enabled: false,
    mintAllowed: false,
    contractReadinessPath: "data/line-receipt-contract-readiness.json",
    contractReady: lineReceiptContractCheck?.ok === true,
    deployReady: lineReceiptContractCheck?.deployReady === true,
    requiredBeforeLiveMint: [
      "CHAIN_POEM_LINE_RECEIPT_CONTRACT",
      "CHAIN_POEM_LINE_RECEIPT_SIGNER",
      "CHAIN_POEM_LINE_RECEIPT_BASE_URI",
      "wallet ownership verification",
      "operator approval",
    ],
    warnings: lineReceiptContractCheck?.warnings || ["line_receipt_contract_readiness_not_checked"],
  },
  clientVerification: {
    requiredAfterLiveDeploy: false,
    ok: clientVerificationCheck?.ok === true,
    checkPath: "data/client-verification-check.json",
    receiptPath: "data/client-verification.json",
    failures: clientVerificationCheck?.failures || ["client_verification_not_checked"],
    next: clientVerificationCheck?.next || "Optional after live deploy: run npm run client:template, fill data/client-verification.json, then run npm run test:client-verification.",
  },
  hosting: {
    provider: "vercel",
    checkPath: "data/hosting-config-check.json",
    requiredBeforeLiveDeploy: true,
    ok: readJson(join(root, "data", "hosting-config-check.json"))?.ok === true,
  },
  hashes: {
    source: hashFiles(root, sourceFiles),
    dist: hashFiles(dist, distFiles),
  },
  blockers: unique(blockers),
  warnings: unique(warnings),
  next:
    blockers.length > 0
      ? "Resolve blockers, rebuild production dist with real Farcaster account association, then deploy to HTTPS."
      : "Deploy dist, run verify-deployment against the live origin, and perform Farcaster client Quick Auth/provenance tests.",
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ok: packet.blockers.length === 0, outputPath, packet }, null, 2));
if (strict && packet.blockers.length) process.exit(1);

function hashFiles(base, files) {
  return files.map((file) => {
    const path = join(base, file);
    if (!existsSync(path)) return { file, exists: false, bytes: 0, sha256: null };
    const bytes = readFileSync(path);
    return {
      file: relative(base, path).replace(/\\/g, "/"),
      exists: true,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
}

function markerCheck(file, markers) {
  const path = join(root, file);
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const missing = markers.filter((marker) => !text.includes(marker));
  return { ok: missing.length === 0, missing };
}

function validateAssociation(association, expectedDomain) {
  const failures = [];
  const warnings = [];
  if (!association?.header || !association?.payload || !association?.signature) return { failures, warnings };
  const header = parseBase64Json(association.header);
  const payload = parseBase64Json(association.payload);
  if (!header) failures.push("account_association_header_invalid_base64_json");
  if (!payload) failures.push("account_association_payload_invalid_base64_json");
  if (header && !["custody", "auth"].includes(header.type)) failures.push("account_association_header_type_invalid");
  if (payload?.domain && expectedDomain && payload.domain !== expectedDomain) failures.push("account_association_domain_mismatch");
  if (payload?.domain && String(payload.domain).includes("://")) failures.push("account_association_domain_has_protocol");
  if (String(association.signature || "").length < 64) failures.push("account_association_signature_too_short");
  warnings.push("account_association_shape_only_not_cryptographic_verification");
  return { failures, warnings };
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

function readJson(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function runDeployTargetCheck() {
  const result = spawnSync(process.execPath, [join(root, "scripts", "deploy-target-check.mjs")], {
    cwd: root,
    encoding: "utf8",
  });
  try {
    return JSON.parse(result.stdout || "{}");
  } catch {
    return {
      ok: false,
      blockers: ["deploy_target_check_unparseable"],
      warnings: [result.stderr || "deploy_target_check_failed"],
    };
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}
