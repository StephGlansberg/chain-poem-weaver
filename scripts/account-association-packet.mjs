const origin = cleanOrigin(process.env.MINIAPP_ORIGIN || process.argv[2] || "");
if (!origin) fail("MINIAPP_ORIGIN or URL argument is required");

const domain = new URL(origin).hostname;
const payload = { domain };
const payloadBase64Url = Buffer.from(JSON.stringify(payload), "utf8")
  .toString("base64")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/g, "");

console.log(JSON.stringify({
  ok: true,
  origin,
  domain,
  accountAssociationPayload: payload,
  payloadBase64Url,
  warpcastManifestTool: "https://farcaster.xyz/~/developers/mini-apps/manifest",
  rule: "The signed domain must exactly match this FQDN, without protocol, path, or port.",
}, null, 2));

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
