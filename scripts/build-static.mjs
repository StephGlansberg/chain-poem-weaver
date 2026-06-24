import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const dist = join(root, "dist");
const productionMode = process.argv.includes("--production") || Boolean(process.env.MINIAPP_ORIGIN);
const entries = [
  "index.html",
  "package.json",
  "package-lock.json",
  "favicon.svg",
  "manifest.webmanifest",
  "vercel.json",
  ".well-known",
  "api",
  "assets",
  "data",
  "contracts",
  "sql",
  "src",
  "scripts/static-check.mjs",
  "scripts/deploy-target-check.mjs",
  "scripts/deploy-production.mjs",
  "scripts/operator-release-brief.mjs",
  "scripts/manifest-assert.mjs",
  "scripts/base-standard-web-check.mjs",
  "scripts/hosting-config-check.mjs",
  "scripts/vercel-dev.mjs",
  "scripts/vercel-dev-check.mjs",
  "scripts/production-rehearsal-check.mjs",
  "scripts/client-verification-check.mjs",
  "scripts/deploy-preflight.mjs",
  "scripts/verify-deployment.mjs",
  "scripts/api-fail-closed-check.mjs",
  "scripts/provenance-canonical-check.mjs",
  "scripts/random-weave-queue-check.mjs",
  "scripts/moderation-floor-check.mjs",
  "scripts/moderate-admin.mjs",
  "scripts/store-adapter-check.mjs",
  "scripts/random-weave-ui-contract-check.mjs",
  "scripts/line-receipt-contract-check.mjs",
  "scripts/line-receipt-metadata-check.mjs",
  "scripts/release-packet.mjs",
  ".env.vercel-dev.example",
];

mkdirSync(dist, { recursive: true });

for (const entry of entries) {
  const source = join(root, entry);
  if (!existsSync(source)) throw new Error(`missing build input: ${entry}`);
  const target = join(dist, entry);
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true, force: true });
}

const productionConfig = productionMode ? writeProductionConfig(dist) : null;
writeStaticRouteAliases(dist);

writeFileSync(join(dist, "deployment-build.json"), `${JSON.stringify({
  schemaVersion: 1,
  appId: "chain-poem-weaver",
  generatedAtUtc: new Date().toISOString(),
  sourceRoot: root,
  files: entries,
  productionMode,
  productionConfig,
}, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  ok: true,
  dist,
  copied: entries.length,
  productionMode,
  productionConfig,
}, null, 2));

function writeProductionConfig(targetRoot) {
  const origin = cleanOrigin(process.env.MINIAPP_ORIGIN || inferStoredAssociationOrigin(targetRoot) || inferVercelOrigin() || "");
  const homePath = cleanPath(process.env.MINIAPP_HOME_PATH || "/poem");
  if (!origin) throw new Error("MINIAPP_ORIGIN is required for production build");

  const domain = new URL(origin).hostname;
  const sourceAssociation = readStoredAccountAssociation(targetRoot, domain);
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
      splashBackgroundColor: "#0b0a08",
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
  writeJson(join(targetRoot, ".well-known", "farcaster.json"), manifest);

  const indexPath = join(targetRoot, "index.html");
  let html = readFileSync(indexPath, "utf8");
  const embed = {
    version: "1",
    imageUrl,
    button: {
      title: "Leave a trace",
      action: {
        type: "launch_miniapp",
        name: "Poem Weaver",
        url: homeUrl,
        splashImageUrl,
        splashBackgroundColor: "#0b0a08",
      },
    },
  };
  html = html.replace(
    /<meta name="fc:miniapp" content='[^']*' \/>/,
    `<meta name="fc:miniapp" content='${JSON.stringify(embed)}' />`,
  );
  html = html.replace(
    /<meta property="og:image" content="[^"]*" \/>/,
    `<meta property="og:image" content="${ogImageUrl}" />`,
  );
  writeFileSync(indexPath, html, "utf8");

  writeJson(join(targetRoot, "data", "deployment-config.json"), {
    schemaVersion: 1,
    generatedAtUtc: new Date().toISOString(),
    origin,
    homePath,
    homeUrl,
    domain,
    accountAssociationReady: Object.values(association).every(Boolean),
    productionAssetUrls: { iconUrl, imageUrl, splashImageUrl, heroImageUrl, ogImageUrl },
  });

  return {
    origin,
    homePath,
    homeUrl,
    domain,
    accountAssociationReady: Object.values(association).every(Boolean),
  };
}

function inferStoredAssociationOrigin(targetRoot) {
  try {
    const stored = JSON.parse(readFileSync(join(targetRoot, "data", "farcaster-account-association.json"), "utf8"));
    return stored.domain ? `https://${stored.domain}` : "";
  } catch {
    return "";
  }
}

function inferVercelOrigin() {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || "";
  if (!host) return "";
  return host.startsWith("http") ? host : `https://${host}`;
}

function writeStaticRouteAliases(targetRoot) {
  const indexPath = join(targetRoot, "index.html");
  const html = readFileSync(indexPath, "utf8");
  writeFileSync(join(targetRoot, "poem.html"), html, "utf8");
  mkdirSync(join(targetRoot, "poem"), { recursive: true });
  writeFileSync(join(targetRoot, "poem", "index.html"), html, "utf8");
}

function cleanOrigin(value) {
  const trimmed = String(value || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "https:") throw new Error("MINIAPP_ORIGIN must use https");
  return parsed.origin;
}

function cleanPath(value) {
  const path = String(value || "/poem").trim();
  return path.startsWith("/") ? path : `/${path}`;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readStoredAccountAssociation(targetRoot, domain) {
  try {
    const stored = JSON.parse(readFileSync(join(targetRoot, "data", "farcaster-account-association.json"), "utf8"));
    if (stored.domain !== domain) return {};
    return stored.accountAssociation || {};
  } catch {
    return {};
  }
}
