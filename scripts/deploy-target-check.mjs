import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = process.cwd();
const outputPath = join(root, "data", "deploy-target-readiness.json");
const strict = process.argv.includes("--strict");

const origin = cleanOrigin(process.env.MINIAPP_ORIGIN || "");
const domain = origin ? new URL(origin).hostname : "";
const association = {
  header: process.env.FARCASTER_ACCOUNT_ASSOCIATION_HEADER || "",
  payload: process.env.FARCASTER_ACCOUNT_ASSOCIATION_PAYLOAD || "",
  signature: process.env.FARCASTER_ACCOUNT_ASSOCIATION_SIGNATURE || "",
};

const env = {
  MINIAPP_ORIGIN: Boolean(origin),
  FARCASTER_ACCOUNT_ASSOCIATION_HEADER: Boolean(association.header),
  FARCASTER_ACCOUNT_ASSOCIATION_PAYLOAD: Boolean(association.payload),
  FARCASTER_ACCOUNT_ASSOCIATION_SIGNATURE: Boolean(association.signature),
  CHAIN_POEM_PROVENANCE_SECRET: Boolean(process.env.CHAIN_POEM_PROVENANCE_SECRET),
  VERCEL_TOKEN: Boolean(process.env.VERCEL_TOKEN),
  CLOUDFLARE_API_TOKEN: Boolean(process.env.CLOUDFLARE_API_TOKEN),
  NETLIFY_AUTH_TOKEN: Boolean(process.env.NETLIFY_AUTH_TOKEN),
};

const tools = {
  npx: commandExists("npx"),
  vercel: commandExists("vercel"),
  wrangler: commandExists("wrangler"),
  netlify: commandExists("netlify"),
};

const providers = [
  {
    id: "vercel",
    serverCapableForCurrentApi: true,
    cliPresent: tools.vercel || tools.npx,
    tokenPresent: env.VERCEL_TOKEN,
    ready: (tools.vercel || tools.npx) && env.VERCEL_TOKEN,
    deployCommand: tools.vercel ? "vercel deploy --prod --token %VERCEL_TOKEN%" : "npx vercel@latest deploy --prod --token %VERCEL_TOKEN%",
    note: "Best current fit for api/*.mjs serverless routes and /poem rewrite. npx is enough when a token is configured.",
  },
  {
    id: "cloudflare-pages",
    serverCapableForCurrentApi: false,
    cliPresent: tools.wrangler,
    tokenPresent: env.CLOUDFLARE_API_TOKEN,
    ready: false,
    deployCommand: "wrangler pages deploy dist",
    note: "Static Pages alone will not run current Node-style api/*.mjs routes without a Pages Functions adapter.",
  },
  {
    id: "netlify",
    serverCapableForCurrentApi: false,
    cliPresent: tools.netlify,
    tokenPresent: env.NETLIFY_AUTH_TOKEN,
    ready: false,
    deployCommand: "netlify deploy --prod --dir dist",
    note: "Needs function adapter before current api/*.mjs routes are live.",
  },
];

const blockers = [];
const warnings = [];
if (!origin) blockers.push("miniapp_origin_missing");
if (origin && origin.includes(".example")) blockers.push("miniapp_origin_placeholder");
for (const field of ["header", "payload", "signature"]) {
  if (!association[field]) blockers.push(`account_association_${field}_missing`);
}
const associationCheck = validateAssociation(association, domain);
blockers.push(...associationCheck.failures);
warnings.push(...associationCheck.warnings);

if (!providers.some((provider) => provider.ready && provider.serverCapableForCurrentApi)) {
  blockers.push("server_capable_deploy_provider_not_ready");
}
if (!env.CHAIN_POEM_PROVENANCE_SECRET) {
  warnings.push("chain_poem_provenance_secret_missing_unsigned_preview_only");
}

const preferredProvider = providers.find((provider) => provider.ready && provider.serverCapableForCurrentApi) || providers[0];
const result = {
  schemaVersion: 1,
  kind: "chain-poem-weaver-deploy-target-readiness",
  generatedAtUtc: new Date().toISOString(),
  ok: blockers.length === 0,
  origin: origin || null,
  domain: domain || null,
  env,
  tools,
  providers,
  preferredProvider: preferredProvider.id,
  blockers: unique(blockers),
  warnings: unique(warnings),
  next: blockers.length
    ? "Set MINIAPP_ORIGIN, sign Farcaster accountAssociation, configure a server-capable deploy provider token, then rerun this check."
    : `Build production dist and deploy with ${preferredProvider.deployCommand}.`,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify(result, null, 2));
if (strict && blockers.length) process.exit(1);

function commandExists(command) {
  const result = spawnSync("cmd.exe", ["/d", "/c", `where ${command}`], { encoding: "utf8" });
  return result.status === 0;
}

function validateAssociation(value, expectedDomain) {
  const failures = [];
  const warnings = [];
  if (!value.header || !value.payload || !value.signature) return { failures, warnings };
  const header = parseBase64Json(value.header);
  const payload = parseBase64Json(value.payload);
  if (!header) failures.push("account_association_header_invalid_base64_json");
  if (!payload) failures.push("account_association_payload_invalid_base64_json");
  if (header && !["custody", "auth"].includes(header.type)) failures.push("account_association_header_type_invalid");
  if (payload?.domain && expectedDomain && payload.domain !== expectedDomain) failures.push("account_association_domain_mismatch");
  if (payload?.domain && String(payload.domain).includes("://")) failures.push("account_association_domain_has_protocol");
  if (String(value.signature || "").length < 64) failures.push("account_association_signature_too_short");
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

function cleanOrigin(value) {
  const trimmed = String(value || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "https:") throw new Error("MINIAPP_ORIGIN must use https");
  return parsed.origin;
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}
