import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const productionMode = process.argv.includes("--production");
const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..");
const failures = [];
const warnings = [];

const manifestPath = join(root, ".well-known", "farcaster.json");
const indexPath = join(root, "index.html");

const manifest = readJson(manifestPath);
const index = readText(indexPath);
const embed = readMiniappEmbed(index);

if (!manifest) failures.push("manifest_missing_or_invalid_json");
if (!embed) failures.push("fc_miniapp_embed_missing_or_invalid_json");

const miniapp = manifest?.miniapp || {};
const association = manifest?.accountAssociation || {};
const manifestUrls = collectManifestUrls(miniapp);
const embedUrls = collectEmbedUrls(embed);
const allUrls = [...manifestUrls, ...embedUrls];

for (const [label, value] of allUrls) {
  if (!value) failures.push(`${label}_missing`);
  else if (!isHttpsUrl(value)) failures.push(`${label}_not_https`);
}

if (miniapp.version !== "1") failures.push("manifest_version_not_1");
if (miniapp.name !== "Poem Weaver") failures.push("manifest_name_mismatch");
if (miniapp.buttonTitle !== "Leave a trace") failures.push("manifest_button_title_mismatch");
if (!miniapp.homeUrl?.endsWith("/poem")) warnings.push("manifest_home_url_not_poem_path");
if (miniapp.canonicalDomain && String(miniapp.canonicalDomain).includes("://")) {
  failures.push("manifest_canonical_domain_has_protocol");
}

if (embed?.version !== "1") failures.push("embed_version_not_1");
if (embed?.button?.title !== miniapp.buttonTitle) failures.push("embed_button_title_mismatch");
if (embed?.button?.action?.type !== "launch_miniapp") failures.push("embed_action_type_not_launch_miniapp");
if (embed?.button?.action?.name !== miniapp.name) failures.push("embed_action_name_mismatch");
if (embed?.button?.action?.url && embed.button.action.url !== miniapp.homeUrl) {
  failures.push("embed_action_url_manifest_home_mismatch");
}
if (embed?.imageUrl !== miniapp.imageUrl) failures.push("embed_image_url_manifest_image_mismatch");
if (embed?.button?.action?.splashImageUrl !== miniapp.splashImageUrl) {
  failures.push("embed_splash_url_manifest_splash_mismatch");
}
if (embed?.button?.action?.splashBackgroundColor !== miniapp.splashBackgroundColor) {
  failures.push("embed_splash_background_manifest_mismatch");
}

const homeDomain = hostname(miniapp.homeUrl);
if (miniapp.canonicalDomain && homeDomain && miniapp.canonicalDomain !== homeDomain) {
  failures.push("manifest_canonical_domain_home_domain_mismatch");
}

for (const [label, value] of allUrls) {
  const urlDomain = hostname(value);
  if (homeDomain && urlDomain && urlDomain !== homeDomain) failures.push(`${label}_domain_mismatch`);
}

const associationCheck = validateAssociation(association, miniapp.canonicalDomain || homeDomain || "", productionMode);
failures.push(...associationCheck.failures);
warnings.push(...associationCheck.warnings);

if (productionMode) {
  const serialized = JSON.stringify({ manifest, embed });
  if (serialized.includes(".example")) failures.push("production_uses_placeholder_domain");
  if (!miniapp.canonicalDomain) failures.push("production_canonical_domain_missing");
  for (const field of ["header", "payload", "signature"]) {
    if (!association[field]) failures.push(`production_account_association_${field}_missing`);
  }
}

const result = {
  ok: failures.length === 0,
  generatedAtUtc: new Date().toISOString(),
  productionMode,
  homeDomain: homeDomain || null,
  canonicalDomain: miniapp.canonicalDomain || null,
  checkedUrls: Object.fromEntries(allUrls),
  failures: unique(failures),
  warnings: unique(warnings),
  next: failures.length
    ? "Fix manifest/embed/account-association failures, then rerun npm run test:manifest."
    : "Manifest, embed, and account-association shape are internally consistent.",
};

console.log(JSON.stringify(result, null, 2));
if (result.failures.length) process.exit(1);

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

function readMiniappEmbed(html) {
  const match = String(html || "").match(/<meta\s+name=["']fc:miniapp["']\s+content='([^']*)'\s*\/?>/i);
  if (!match) return null;
  try {
    return JSON.parse(match[1].replace(/&quot;/g, '"'));
  } catch {
    return null;
  }
}

function collectManifestUrls(miniapp) {
  return [
    ["manifest_home_url", miniapp.homeUrl],
    ["manifest_icon_url", miniapp.iconUrl],
    ["manifest_image_url", miniapp.imageUrl],
    ["manifest_splash_image_url", miniapp.splashImageUrl],
    ["manifest_hero_image_url", miniapp.heroImageUrl],
    ["manifest_og_image_url", miniapp.ogImageUrl],
  ].filter(([, value]) => value !== undefined);
}

function collectEmbedUrls(embed) {
  return [
    ["embed_image_url", embed?.imageUrl],
    ["embed_action_url", embed?.button?.action?.url],
    ["embed_splash_image_url", embed?.button?.action?.splashImageUrl],
  ].filter(([, value]) => value !== undefined);
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function hostname(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return "";
  }
}

function validateAssociation(association, expectedDomain, required) {
  const localFailures = [];
  const localWarnings = [];
  for (const field of ["header", "payload", "signature"]) {
    if (!association?.[field]) {
      const issue = `account_association_${field}_missing`;
      if (required) localFailures.push(issue);
      else localWarnings.push(issue);
    }
  }
  if (!association?.header || !association?.payload || !association?.signature) {
    return { failures: localFailures, warnings: localWarnings };
  }

  const header = parseBase64Json(association.header);
  const payload = parseBase64Json(association.payload);
  if (!header) localFailures.push("account_association_header_invalid_base64_json");
  if (!payload) localFailures.push("account_association_payload_invalid_base64_json");
  if (header && !["custody", "auth"].includes(header.type)) {
    localFailures.push("account_association_header_type_invalid");
  }
  if (payload?.domain && expectedDomain && payload.domain !== expectedDomain) {
    localFailures.push("account_association_domain_mismatch");
  }
  if (payload?.domain && String(payload.domain).includes("://")) {
    localFailures.push("account_association_domain_has_protocol");
  }
  if (String(association.signature || "").length < 64) {
    localFailures.push("account_association_signature_too_short");
  }
  localWarnings.push("account_association_shape_only_not_cryptographic_verification");
  return { failures: localFailures, warnings: localWarnings };
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

function unique(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}
