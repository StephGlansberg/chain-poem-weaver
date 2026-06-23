import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = process.cwd();
const jsonPath = join(root, "data", "operator-release-brief.json");
const mdPath = join(root, "data", "operator-release-brief.md");

const target = readJson("data/deploy-target-readiness.json");
const deployRun = readJson("data/deploy-production-run.json");
const releasePacket = readJson("data/release-packet.json");
const envOrigin = cleanOrigin(process.env.MINIAPP_ORIGIN || "");
const currentArtifactOrigin = cleanOrigin(target?.origin || deployRun?.origin || "");
const origin = envOrigin || currentArtifactOrigin;
const domain = origin ? new URL(origin).hostname : null;
const signingPacket = origin ? buildSigningPacket(origin) : null;

const missingInputs = [];
if (!envOrigin && !currentArtifactOrigin) missingInputs.push("MINIAPP_ORIGIN");
if (!process.env.FARCASTER_ACCOUNT_ASSOCIATION_HEADER) missingInputs.push("FARCASTER_ACCOUNT_ASSOCIATION_HEADER");
if (!process.env.FARCASTER_ACCOUNT_ASSOCIATION_PAYLOAD) missingInputs.push("FARCASTER_ACCOUNT_ASSOCIATION_PAYLOAD");
if (!process.env.FARCASTER_ACCOUNT_ASSOCIATION_SIGNATURE) missingInputs.push("FARCASTER_ACCOUNT_ASSOCIATION_SIGNATURE");
if (!process.env.VERCEL_TOKEN) missingInputs.push("VERCEL_TOKEN");
const warnings = [];
if (!process.env.CHAIN_POEM_PROVENANCE_SECRET) warnings.push("CHAIN_POEM_PROVENANCE_SECRET missing: provenance remains unsigned preview only");
if (!process.env.CHAIN_POEM_LINE_RECEIPT_CONTRACT) warnings.push("CHAIN_POEM_LINE_RECEIPT_CONTRACT missing: Base line NFT mint remains disabled");
if (!process.env.CHAIN_POEM_LINE_RECEIPT_SIGNER) warnings.push("CHAIN_POEM_LINE_RECEIPT_SIGNER missing: Base line NFT mint remains disabled");
if (!process.env.CHAIN_POEM_LINE_RECEIPT_BASE_URI) warnings.push("CHAIN_POEM_LINE_RECEIPT_BASE_URI missing: Base line NFT metadata remains disabled");

const blockers = unique([
  ...(target?.blockers || []),
  ...(deployRun?.blockers || []),
  ...(releasePacket?.blockers || []),
]);
const operatorActionChecklist = [
  {
    id: "choose_https_origin",
    owner: "operator",
    required: true,
    input: "MINIAPP_ORIGIN",
    valueShape: "https://your-real-domain.example",
    why: "Farcaster account association, manifest asset URLs, deployment verification, and client receipts all bind to one exact HTTPS origin.",
  },
  {
    id: "sign_farcaster_account_association",
    owner: "operator",
    required: true,
    input: "FARCASTER_ACCOUNT_ASSOCIATION_HEADER/PAYLOAD/SIGNATURE",
    valueShape: "three strings from the Farcaster Mini App manifest tool for the exact domain",
    why: "Farcaster/Base clients need a signed accountAssociation before the mini app can be treated as production-ready.",
  },
  {
    id: "provide_server_capable_deploy_token",
    owner: "operator",
    required: true,
    input: "VERCEL_TOKEN",
    valueShape: "Vercel token with permission to deploy this project",
    why: "The current app uses Node-style api/*.mjs routes, so Vercel is the preferred ready path.",
  },
  {
    id: "set_provenance_secret",
    owner: "operator",
    required: false,
    input: "CHAIN_POEM_PROVENANCE_SECRET",
    valueShape: "long random server secret",
    why: "Without it, provenance hashes work as unsigned preview receipts; with it, the server can sign poem provenance.",
  },
  {
    id: "deploy_base_line_receipt_contract",
    owner: "operator_and_codex",
    required: false,
    input: "CHAIN_POEM_LINE_RECEIPT_CONTRACT/SIGNER/BASE_URI",
    valueShape: "Base ERC-1155 contract address, authorized signer, and metadata base URI",
    why: "These remain optional until the poem experience is live. Without them, every line receipt mint plan stays dormant with mintAllowed=false.",
  },
  {
    id: "capture_live_client_receipt",
    owner: "operator_and_codex",
    required: true,
    input: "data/client-verification.json",
    valueShape: "filled from data/client-verification.template.json after live Farcaster/Base client testing",
    why: "This proves real launch, composeCast, Quick Auth/provenance, standard-web fallback, share fallback, and paid mint disabled.",
  },
];

const brief = {
  schemaVersion: 1,
  kind: "chain-poem-weaver-operator-release-brief",
  generatedAtUtc: new Date().toISOString(),
  appId: "chain-poem-weaver",
  origin: origin || null,
  domain,
  missingInputs: unique(missingInputs),
  blockers,
  warnings: unique(warnings),
  operatorActionChecklist,
  signingPacket,
  commandPath: [
    "npm run generate:assets",
    "$env:MINIAPP_ORIGIN=\"https://YOUR_REAL_DOMAIN\"",
    "npm run signing:packet",
    "Set FARCASTER_ACCOUNT_ASSOCIATION_HEADER/PAYLOAD/SIGNATURE from the Farcaster manifest tool",
    "Set VERCEL_TOKEN",
    "npm run deploy:target-check",
    "npm run deploy:production:dry-run",
    "npm run deploy:production:live",
    "Test inside Farcaster/Base client",
    "npm run client:template",
    "Fill data/client-verification.json with live client evidence",
    "npm run test:client-verification",
  ],
  next: missingInputs.length
    ? "Provide the missing production inputs, then rerun npm run operator:release-brief and npm run deploy:production:dry-run."
    : "Production inputs are present. Run dry-run, then live deploy when ready.",
};

mkdirSync(dirname(jsonPath), { recursive: true });
writeFileSync(jsonPath, `${JSON.stringify(brief, null, 2)}\n`, "utf8");
writeFileSync(mdPath, renderMarkdown(brief), "utf8");
console.log(JSON.stringify({ ok: true, jsonPath, mdPath, missingInputs: brief.missingInputs, blockers: brief.blockers }, null, 2));

function renderMarkdown(brief) {
  const lines = [
    "# Chain Poem Weaver Operator Release Brief",
    "",
    `Generated: ${brief.generatedAtUtc}`,
    "",
    "## Status",
    "",
    `- Origin: ${brief.origin || "missing"}`,
    `- Domain: ${brief.domain || "missing"}`,
    `- Missing inputs: ${brief.missingInputs.length ? brief.missingInputs.join(", ") : "none"}`,
    `- Blockers: ${brief.blockers.length ? brief.blockers.join(", ") : "none"}`,
    `- Warnings: ${brief.warnings.length ? brief.warnings.join(", ") : "none"}`,
    "",
    "## What The Operator Can Unblock",
    "",
  ];
  for (const item of brief.operatorActionChecklist) {
    lines.push(
      `- ${item.input}: ${item.required ? "required" : "optional"}; ${item.valueShape}.`,
      `  Why: ${item.why}`,
    );
  }
  lines.push(
    "",
    "## Required Operator Inputs",
    "",
    "- Real HTTPS domain for the Mini App.",
    "- Farcaster signed account association for the exact FQDN.",
    "- `VERCEL_TOKEN` for the current server-capable deploy path.",
    "- Optional `CHAIN_POEM_PROVENANCE_SECRET` when server-signed poem provenance is desired.",
    "- Optional Base ERC-1155 line receipt contract address, signer, and metadata base URI when NFT minting is explicitly approved.",
    "- Client verification evidence after live Farcaster/Base testing.",
    "",
    "## Farcaster Signing Packet",
    "",
  );
  if (brief.signingPacket) {
    lines.push(
      `- Origin: ${brief.signingPacket.origin}`,
      `- Domain: ${brief.signingPacket.domain}`,
      `- Payload base64url: ${brief.signingPacket.payloadBase64Url}`,
      `- Manifest tool: ${brief.signingPacket.warpcastManifestTool}`,
      "",
      "The signed domain must exactly match the FQDN above, without protocol, path, or port.",
    );
  } else {
    lines.push("Set `MINIAPP_ORIGIN` first, then run `npm run signing:packet`.");
  }
  lines.push("", "## Command Path", "");
  for (const command of brief.commandPath) lines.push(`1. ${command}`);
  lines.push(
    "",
    "## Client Verification",
    "",
    "After live deploy, run `npm run client:template`, copy/fill the template as `data/client-verification.json`, then run `npm run test:client-verification`.",
    "The receipt must prove Farcaster launch, cast composer, Quick Auth/provenance, Base standard-web fallback, share fallback, line receipt mint plan visibility, and paid mint still disabled.",
  );
  lines.push("", "## Next", "", brief.next, "");
  return `${lines.join("\n")}\n`;
}

function buildSigningPacket(value) {
  const domain = new URL(value).hostname;
  const payload = { domain };
  const payloadBase64Url = Buffer.from(JSON.stringify(payload), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return {
    origin: value,
    domain,
    accountAssociationPayload: payload,
    payloadBase64Url,
    warpcastManifestTool: "https://farcaster.xyz/~/developers/mini-apps/manifest",
  };
}

function readJson(relativePath) {
  const path = join(root, relativePath);
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
  if (parsed.protocol !== "https:") throw new Error("origin must use https");
  return parsed.origin;
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}
