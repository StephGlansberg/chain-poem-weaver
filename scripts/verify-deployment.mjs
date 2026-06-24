import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = process.cwd();
const selfTest = process.argv.includes("--self-test");
const outputPath = join(root, "data", selfTest ? "live-verify-run.self-test.json" : "live-verify-run.json");
if (selfTest) installSelfTestFetch();
const origin = cleanOrigin(selfTest ? "https://poems.opulentis.ai" : process.env.MINIAPP_ORIGIN || process.argv[2] || "");
if (!origin) fail("MINIAPP_ORIGIN or URL argument is required");

const failures = [];
const warnings = [];
const checks = [];
let homeEmbed = null;
let manifest = null;

const home = await fetchText(`${origin}/poem`, "home:/poem");
if (!home.ok) failures.push(home.error);
if (home.ok && !home.text.includes("Poem Weaver")) failures.push("home_missing_app_title");
if (home.ok && !home.text.includes('name="fc:miniapp"')) failures.push("home_missing_fc_miniapp_meta");
if (home.ok) {
  homeEmbed = readMiniappEmbed(home.text);
  if (!homeEmbed) failures.push("home_fc_miniapp_embed_invalid_json");
  else validateEmbed(homeEmbed);
}

const manifestFetch = await fetchJson(`${origin}/.well-known/farcaster.json`, "manifest");
if (!manifestFetch.ok) {
  failures.push(manifestFetch.error);
} else {
  manifest = manifestFetch.json;
  if (!String(manifestFetch.contentType || "").includes("application/json")) {
    failures.push(`manifest_wrong_content_type:${manifestFetch.contentType || "missing"}`);
  }
  if (!manifest.accountAssociation) failures.push("manifest_missing_account_association");
  for (const field of ["header", "payload", "signature"]) {
    if (!manifest.accountAssociation?.[field]) failures.push(`manifest_account_association_${field}_missing`);
  }
  const association = validateAccountAssociation(manifest.accountAssociation, new URL(origin).hostname);
  failures.push(...association.failures);
  if (manifest.miniapp?.name !== "Poem Weaver") failures.push("manifest_wrong_name");
  if (manifest.miniapp?.canonicalDomain !== new URL(origin).hostname) failures.push("manifest_canonical_domain_mismatch");
  if (manifest.miniapp?.homeUrl !== `${origin}/poem`) failures.push("manifest_home_url_mismatch");
  validateManifestEmbedAgreement(manifest, homeEmbed);
  const urls = [
    manifest.miniapp?.iconUrl,
    manifest.miniapp?.imageUrl,
    manifest.miniapp?.splashImageUrl,
    manifest.miniapp?.heroImageUrl,
    manifest.miniapp?.ogImageUrl,
  ].filter(Boolean);
  for (const url of urls) {
    if (!url.startsWith(origin)) failures.push(`manifest_asset_origin_mismatch:${url}`);
    const asset = await fetchHeadOrGet(url, `asset:${url}`);
    if (!asset.ok) failures.push(asset.error);
  }
}

const authProbe = await fetchJsonAllowStatus(`${origin}/api/me`, "auth:/api/me", [401]);
if (!authProbe.ok) {
  failures.push(authProbe.error);
} else if (authProbe.status !== 401 || authProbe.json?.error !== "missing_bearer_token" || authProbe.json?.verified !== false) {
  failures.push("auth_api_fail_closed_probe_failed");
} else if (!String(authProbe.cacheControl || "").includes("no-store")) {
  failures.push("auth_api_cache_control_missing_no_store");
}

const provenanceProbe = await fetchJsonAllowStatus(`${origin}/api/provenance`, "auth:/api/provenance", [401], {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ poem: {} }),
});
if (!provenanceProbe.ok) {
  failures.push(provenanceProbe.error);
} else if (provenanceProbe.status !== 401 || provenanceProbe.json?.error !== "missing_bearer_token" || provenanceProbe.json?.verified !== false) {
  failures.push("provenance_api_fail_closed_probe_failed");
} else if (!String(provenanceProbe.cacheControl || "").includes("no-store")) {
  failures.push("provenance_api_cache_control_missing_no_store");
}

const randomWeaveProbe = await fetchJsonAllowStatus(`${origin}/api/random-weave`, "auth:/api/random-weave", [401], {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ line: "small gold" }),
});
if (!randomWeaveProbe.ok) {
  failures.push(randomWeaveProbe.error);
} else if (randomWeaveProbe.status !== 401 || randomWeaveProbe.json?.error !== "missing_bearer_token" || randomWeaveProbe.json?.verified !== false) {
  failures.push("random_weave_api_fail_closed_probe_failed");
} else if (!String(randomWeaveProbe.cacheControl || "").includes("no-store")) {
  failures.push("random_weave_api_cache_control_missing_no_store");
}

const moderationProbe = await fetchJsonAllowStatus(`${origin}/api/admin-moderation`, "auth:/api/admin-moderation", [401, 503], {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ action: "ban_fid", fid: "1" }),
});
if (!moderationProbe.ok) {
  failures.push(moderationProbe.error);
} else if (![401, 503].includes(moderationProbe.status) || moderationProbe.json?.admin !== false) {
  failures.push("admin_moderation_fail_closed_probe_failed");
} else if (!String(moderationProbe.cacheControl || "").includes("no-store")) {
  failures.push("admin_moderation_cache_control_missing_no_store");
}

const result = {
  schemaVersion: 1,
  kind: "chain-poem-weaver-live-verify-run",
  ok: failures.length === 0,
  generatedAtUtc: new Date().toISOString(),
  mode: selfTest ? "self-test" : "live",
  origin,
  manifestHomeUrl: manifest?.miniapp?.homeUrl || null,
  embedActionUrl: homeEmbed?.button?.action?.url || null,
  canonicalDomain: manifest?.miniapp?.canonicalDomain || null,
  checks,
  failures: unique(failures),
  warnings: unique(warnings),
  next: failures.length
    ? "Fix live deployment failures, redeploy, then rerun verify-deployment."
    : "Live deployment shape passed. Finish the manual Farcaster/Base client Quick Auth test.",
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify(result, null, 2));

if (failures.length) process.exit(1);

async function fetchText(url, label) {
  try {
    const response = await fetch(url, { redirect: "follow" });
    const contentType = response.headers.get("content-type") || "";
    checks.push({ label, url, status: response.status, contentType });
    if (!response.ok) return { ok: false, error: `${label}_http_${response.status}` };
    return { ok: true, status: response.status, contentType, text: await response.text() };
  } catch (error) {
    return { ok: false, error: `${label}_fetch_failed:${error.message}` };
  }
}

async function fetchJson(url, label) {
  const result = await fetchText(url, label);
  if (!result.ok) return result;
  try {
    return { ok: true, status: result.status, contentType: result.contentType, json: JSON.parse(result.text) };
  } catch (error) {
    return { ok: false, error: `${label}_invalid_json:${error.message}` };
  }
}

async function fetchJsonAllowStatus(url, label, allowedStatuses, options = {}) {
  try {
    const response = await fetch(url, { redirect: "follow", ...options });
    const text = await response.text();
    const contentType = response.headers.get("content-type") || "";
    const cacheControl = response.headers.get("cache-control") || "";
    checks.push({ label, url, status: response.status, contentType, cacheControl });
    if (!allowedStatuses.includes(response.status)) return { ok: false, error: `${label}_http_${response.status}` };
    return { ok: true, status: response.status, contentType, cacheControl, json: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: `${label}_fetch_failed:${error.message}` };
  }
}

async function fetchHeadOrGet(url, label) {
  try {
    let response = await fetch(url, { method: "HEAD", redirect: "follow" });
    if (response.status === 405 || response.status === 403) {
      response = await fetch(url, { method: "GET", redirect: "follow" });
    }
    const contentType = response.headers.get("content-type") || "";
    const contentLength = response.headers.get("content-length") || "";
    checks.push({ label, url, status: response.status, contentType, contentLength });
    if (!response.ok) return { ok: false, error: `${label}_http_${response.status}` };
    if (!contentType.includes("image/")) return { ok: false, error: `${label}_not_image:${contentType}` };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `${label}_fetch_failed:${error.message}` };
  }
}

function cleanOrigin(value) {
  const trimmed = String(value || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "https:") fail("origin must use https");
  return parsed.origin;
}

function fail(message) {
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
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

function validateEmbed(embed) {
  if (embed.version !== "1") failures.push("embed_version_not_1");
  if (embed.imageUrl && !embed.imageUrl.startsWith(origin)) failures.push("embed_image_origin_mismatch");
if (embed.button?.title !== "Leave a trace") failures.push("embed_button_title_mismatch");
  if (embed.button?.action?.type !== "launch_miniapp") failures.push("embed_action_type_not_launch_miniapp");
  if (embed.button?.action?.name !== "Poem Weaver") failures.push("embed_action_name_mismatch");
  if (embed.button?.action?.url !== `${origin}/poem`) failures.push("embed_action_url_mismatch");
  if (embed.button?.action?.splashImageUrl && !embed.button.action.splashImageUrl.startsWith(origin)) {
    failures.push("embed_splash_origin_mismatch");
  }
}

function validateManifestEmbedAgreement(liveManifest, embed) {
  if (!embed) return;
  const miniapp = liveManifest?.miniapp || {};
  if (embed.imageUrl !== miniapp.imageUrl) failures.push("embed_image_url_manifest_image_mismatch");
  if (embed.button?.title !== miniapp.buttonTitle) failures.push("embed_button_title_manifest_button_mismatch");
  if (embed.button?.action?.name !== miniapp.name) failures.push("embed_action_name_manifest_name_mismatch");
  if (embed.button?.action?.url !== miniapp.homeUrl) failures.push("embed_action_url_manifest_home_mismatch");
  if (embed.button?.action?.splashImageUrl !== miniapp.splashImageUrl) {
    failures.push("embed_splash_url_manifest_splash_mismatch");
  }
  if (embed.button?.action?.splashBackgroundColor !== miniapp.splashBackgroundColor) {
    failures.push("embed_splash_background_manifest_mismatch");
  }
}

function validateAccountAssociation(accountAssociation, domain) {
  const failures = [];
  if (!accountAssociation?.header || !accountAssociation?.payload || !accountAssociation?.signature) {
    return { failures };
  }
  const header = parseBase64Json(accountAssociation.header);
  const payload = parseBase64Json(accountAssociation.payload);
  if (!header) failures.push("manifest_account_association_header_invalid_base64_json");
  if (!payload) failures.push("manifest_account_association_payload_invalid_base64_json");
  if (header && !["custody", "auth"].includes(header.type)) {
    failures.push("manifest_account_association_header_type_invalid");
  }
  if (payload && payload.domain !== domain) {
    failures.push("manifest_account_association_domain_mismatch");
  }
  if (payload && String(payload.domain || "").includes("://")) {
    failures.push("manifest_account_association_domain_has_protocol");
  }
  if (String(accountAssociation.signature || "").length < 64) {
    failures.push("manifest_account_association_signature_too_short");
  }
  return { failures };
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function installSelfTestFetch() {
  const selfOrigin = "https://poems.opulentis.ai";
  const association = {
    header: "eyJ0eXBlIjoiY3VzdG9keSJ9",
    payload: "eyJkb21haW4iOiJwb2Vtcy5vcHVsZW50aXMuYWkifQ",
    signature: `0x${"a".repeat(130)}`,
  };
  const manifest = {
    accountAssociation: association,
    miniapp: {
      version: "1",
      name: "Poem Weaver",
      iconUrl: `${selfOrigin}/assets/chain-poem-icon.png`,
      homeUrl: `${selfOrigin}/poem`,
      imageUrl: `${selfOrigin}/assets/chain-poem-weaver.png`,
      buttonTitle: "Leave a trace",
      splashImageUrl: `${selfOrigin}/assets/poem-splash.png`,
      splashBackgroundColor: "#12201d",
      heroImageUrl: `${selfOrigin}/assets/chain-poem-hero.png`,
      ogImageUrl: `${selfOrigin}/assets/chain-poem-og.png`,
      canonicalDomain: "poems.opulentis.ai",
    },
  };
  const embed = {
    version: "1",
    imageUrl: manifest.miniapp.imageUrl,
    button: {
      title: manifest.miniapp.buttonTitle,
      action: {
        type: "launch_miniapp",
        name: manifest.miniapp.name,
        url: manifest.miniapp.homeUrl,
        splashImageUrl: manifest.miniapp.splashImageUrl,
        splashBackgroundColor: manifest.miniapp.splashBackgroundColor,
      },
    },
  };
  const homeHtml = `<!doctype html><title>Poem Weaver</title><meta name="fc:miniapp" content='${JSON.stringify(embed)}' /><main>Poem Weaver</main>`;
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    const method = String(options.method || "GET").toUpperCase();
    if (url === `${selfOrigin}/poem`) return textResponse(homeHtml, 200, "text/html; charset=utf-8");
    if (url === `${selfOrigin}/.well-known/farcaster.json`) {
      return textResponse(JSON.stringify(manifest), 200, "application/json; charset=utf-8");
    }
    if (url === `${selfOrigin}/api/me`) {
      return textResponse(JSON.stringify({ verified: false, error: "missing_bearer_token" }), 401, "application/json; charset=utf-8", {
        "cache-control": "no-store",
      });
    }
    if (url === `${selfOrigin}/api/provenance`) {
      return textResponse(JSON.stringify({ verified: false, error: "missing_bearer_token" }), 401, "application/json; charset=utf-8", {
        "cache-control": "no-store",
      });
    }
    if (url === `${selfOrigin}/api/random-weave`) {
      return textResponse(JSON.stringify({ verified: false, error: "missing_bearer_token" }), 401, "application/json; charset=utf-8", {
        "cache-control": "no-store",
      });
    }
    if (url === `${selfOrigin}/api/admin-moderation`) {
      return textResponse(JSON.stringify({ admin: false, error: "admin_token_not_configured" }), 503, "application/json; charset=utf-8", {
        "cache-control": "no-store",
      });
    }
    if (url.startsWith(`${selfOrigin}/assets/`) && ["GET", "HEAD"].includes(method)) {
      return new Response(method === "HEAD" ? null : new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": "4",
        },
      });
    }
    return textResponse("not found", 404, "text/plain");
  };
}

function textResponse(body, status, contentType, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": contentType,
      ...extraHeaders,
    },
  });
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
