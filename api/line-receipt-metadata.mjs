import { createQueueStore } from "./queue-store.mjs";
import { buildLineReceiptImageUrl, buildPoemExternalUrl } from "./provenance.mjs";

export default async function handler(request, response) {
  if (request.method !== "GET") {
    return sendJson(response, 405, { ok: false, error: "method_not_allowed" }, "no-store");
  }

  const tokenId = readTokenId(request);
  if (!tokenId) return sendJson(response, 400, { ok: false, error: "token_id_required" }, "no-store");

  const store = createQueueStore();
  const data = await store.load();
  const found = findReceiptByTokenId(data, tokenId);
  if (!found) return sendJson(response, 404, { ok: false, error: "line_receipt_not_found" }, "no-store");

  const origin = requestOrigin(request);
  const receipt = found.receipt;
  const metadata = {
    name: receipt.name,
    description: receipt.description,
    image: receipt.image || buildLineReceiptImageUrl(tokenId, origin),
    external_url: receipt.externalUrl || buildPoemExternalUrl(found.poem.poemId, found.provenance.poemHash, origin),
    attributes: receipt.attributes || [],
    properties: {
      ...(receipt.metadata || {}),
      tokenId,
      tokenIdSeed: receipt.tokenIdSeed,
      claimKey: receipt.claimKey,
      poemId: found.poem.poemId,
      poemHash: found.provenance.poemHash,
      contributor: receipt.recipientHint || {},
      storageStatus: "server_stored_not_minted",
    },
  };

  return sendJson(response, 200, metadata, "public, max-age=60, s-maxage=300");
}

export function findReceiptByTokenId(store, tokenId) {
  const hidden = new Set(store.hiddenPoemIds || []);
  for (const poem of store.completedPoems || []) {
    if (hidden.has(poem.poemId) || poem.moderationStatus === "hidden") continue;
    const provenance = poem.provenance || {};
    const receipts = provenance.lineReceiptMintPlan?.receipts || [];
    const receipt = receipts.find((item) => String(item.tokenId) === String(tokenId));
    if (receipt) return { poem, provenance, receipt };
  }
  return null;
}

export function readTokenId(request) {
  const url = new URL(request.url || "/", `https://${request.headers.host || "chain-poem-weaver.vercel.app"}`);
  const raw = url.searchParams.get("tokenId") || url.searchParams.get("id") || "";
  return String(raw).trim().replace(/\.json$/i, "").replace(/[^\d]/g, "").slice(0, 90);
}

export function requestOrigin(request) {
  const host = String(request.headers["x-forwarded-host"] || request.headers.host || "").split(",")[0].trim();
  const proto = String(request.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  if (!host) return process.env.CHAIN_POEM_PUBLIC_ORIGIN || process.env.MINIAPP_ORIGIN || "";
  return `${proto === "http" ? "http" : "https"}://${host}`;
}

function sendJson(response, statusCode, body, cacheControl) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", cacheControl);
  response.end(JSON.stringify(body));
}
