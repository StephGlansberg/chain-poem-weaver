import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const origin = cleanOrigin(process.env.MINIAPP_ORIGIN || "");
const homePath = cleanPath(process.env.MINIAPP_HOME_PATH || "/poem");
if (!origin) {
  fail("MINIAPP_ORIGIN is required, for example https://poems.opulentis.ai");
}

const domain = new URL(origin).hostname;
const sourceAssociation = readStoredAccountAssociation(domain);
const association = {
  header: process.env.FARCASTER_ACCOUNT_ASSOCIATION_HEADER || sourceAssociation.header || "",
  payload: process.env.FARCASTER_ACCOUNT_ASSOCIATION_PAYLOAD || sourceAssociation.payload || "",
  signature: process.env.FARCASTER_ACCOUNT_ASSOCIATION_SIGNATURE || sourceAssociation.signature || "",
};
const homeUrl = `${origin}${homePath}`;
const iconUrl = `${origin}/assets/chain-poem-icon.png`;
const imageUrl = `${origin}/assets/chain-poem-weaver.png`;
const splashImageUrl = `${origin}/assets/poem-splash.png`;
const heroImageUrl = `${origin}/assets/chain-poem-hero.png`;
const ogImageUrl = `${origin}/assets/chain-poem-og.png`;

const manifest = {
  accountAssociation: association,
  miniapp: {
    version: "1",
    name: "Poem Weaver",
    iconUrl,
    homeUrl,
    imageUrl,
    buttonTitle: "Leave a trace",
    splashImageUrl,
    splashBackgroundColor: "#12201d",
    subtitle: "A poem finds its others",
    description: "Leave something small. Return when it finds the voices around it.",
    primaryCategory: "art-creativity",
    tags: ["poetry", "social", "art", "base"],
    tagline: "Leave a trace",
    ogTitle: "Poem Weaver",
    ogDescription: "A quiet Farcaster Mini App for hidden collaboration.",
    heroImageUrl,
    ogImageUrl,
    canonicalDomain: domain,
  },
};

writeJson(join(root, ".well-known", "farcaster.json"), manifest);
writeJson(join(root, "data", "deployment-config.json"), {
  schemaVersion: 1,
  generatedAtUtc: new Date().toISOString(),
  origin,
  homePath,
  homeUrl,
  domain,
  accountAssociationReady: Object.values(association).every(Boolean),
  productionAssetUrls: { iconUrl, imageUrl, splashImageUrl, heroImageUrl, ogImageUrl },
});

const indexPath = join(root, "index.html");
let html = readFileSync(indexPath, "utf8");
const embed = {
  version: "1",
  imageUrl,
  button: {
    title: "Leave a trace",
    action: {
      type: "launch_miniapp",
      name: "Poem Weaver",
      splashImageUrl,
      splashBackgroundColor: "#0b0a08",
    },
  },
};
html = html.replace(
  /<meta name="fc:miniapp" content='[^']*' \/>/,
  `<meta name="fc:miniapp" content='${JSON.stringify(embed)}' />`,
);
writeFileSync(indexPath, html, "utf8");

console.log(JSON.stringify({
  ok: true,
  domain,
  homeUrl,
  accountAssociationReady: Object.values(association).every(Boolean),
}, null, 2));

function cleanOrigin(value) {
  const trimmed = String(value || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "https:") fail("MINIAPP_ORIGIN must use https");
  return parsed.origin;
}

function cleanPath(value) {
  const path = String(value || "/poem").trim();
  return path.startsWith("/") ? path : `/${path}`;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readStoredAccountAssociation(domain) {
  try {
    const stored = JSON.parse(readFileSync(join(root, "data", "farcaster-account-association.json"), "utf8"));
    if (stored.domain !== domain) return {};
    return stored.accountAssociation || {};
  } catch {
    return {};
  }
}

function fail(message) {
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
}
