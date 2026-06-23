import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addLine, completePoem, createPoem, MAX_LINES } from "../src/poem.js";
import { buildProvenance, canonicalizePoem } from "../api/provenance.mjs";
import { createEmptyQueueStore, createQueueStore } from "../api/queue-store.mjs";
import metadataHandler from "../api/line-receipt-metadata.mjs";
import imageHandler from "../api/line-receipt-image.mjs";

const failures = [];
const tempDir = mkdtempSync(join(tmpdir(), "chain-poem-metadata-"));
process.env.CHAIN_POEM_STORE_DRIVER = "file";
process.env.CHAIN_POEM_QUEUE_STORE_PATH = join(tempDir, "store.json");
process.env.CHAIN_POEM_PUBLIC_ORIGIN = "https://chain-poem-weaver.vercel.app";

try {
  let poem = createPoem({
    title: "The Door Under Base",
    theme: "ritual",
    firstLine: "The first hand lights the threshold.",
    contributor: {
      author: "OP",
      fid: "123",
      username: "opulentis",
      contextSource: "farcaster-context",
      signal: "verified-farcaster",
      verified: true,
    },
  });
  while (poem.lines.length < MAX_LINES) {
    poem = addLine(poem, `line ${poem.lines.length + 1}`, {
      author: `weaver-${poem.lines.length + 1}`,
      fid: String(123 + poem.lines.length),
      signal: "human",
      verified: true,
    });
  }
  poem = completePoem(poem);
  const canonical = canonicalizePoem(poem);
  if (!canonical.ok) failures.push(`canonical_failed:${canonical.error}`);
  const provenance = buildProvenance(canonical.poem, "123", "secret");
  const receipt = provenance.lineReceiptMintPlan.receipts[0];

  const store = createQueueStore();
  const data = createEmptyQueueStore();
  data.completedPoems.push({
    schemaVersion: 1,
    kind: "random-weave-completed-poem",
    poemId: canonical.poem.poemId,
    status: "complete",
    canonicalPoem: canonical.poem,
    provenance,
    dormantLedger: { lineReceiptClaims: [], tokenAllocations: [] },
  });
  await store.persist(data);

  const metadata = await callJson(metadataHandler, `/api/line-receipt-metadata?tokenId=${receipt.tokenId}.json`);
  if (metadata.statusCode !== 200) failures.push("metadata_status_not_200");
  if (metadata.headers["content-type"] !== "application/json; charset=utf-8") failures.push("metadata_content_type_wrong");
  if (!metadata.body.name?.includes("line 1")) failures.push("metadata_name_missing_line");
  if (!metadata.body.description?.includes("The first hand lights the threshold.")) failures.push("metadata_description_missing_line");
  if (!metadata.body.image?.includes(`/api/line-receipt-image?tokenId=${receipt.tokenId}`)) failures.push("metadata_image_url_missing");
  if (metadata.body.properties?.tokenId !== receipt.tokenId) failures.push("metadata_token_id_mismatch");
  if (metadata.body.properties?.claimKey !== receipt.claimKey) failures.push("metadata_claim_key_mismatch");
  if (!Array.isArray(metadata.body.attributes) || metadata.body.attributes.length < 4) failures.push("metadata_attributes_missing");

  const image = await callText(imageHandler, `/api/line-receipt-image?tokenId=${receipt.tokenId}.svg`);
  if (image.statusCode !== 200) failures.push("image_status_not_200");
  if (image.headers["content-type"] !== "image/svg+xml; charset=utf-8") failures.push("image_content_type_wrong");
  if (!image.body.includes("<svg") || !image.body.includes("POEM WEAVER")) failures.push("image_svg_missing_brand");

  const missing = await callJson(metadataHandler, "/api/line-receipt-metadata?tokenId=999999.json");
  if (missing.statusCode !== 404 || missing.body.error !== "line_receipt_not_found") failures.push("missing_token_not_404");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

const result = {
  ok: failures.length === 0,
  generatedAtUtc: new Date().toISOString(),
  checked: "line-receipt-metadata",
  failures,
};
console.log(JSON.stringify(result, null, 2));
if (failures.length) process.exit(1);

async function callJson(handler, path) {
  const result = await callText(handler, path);
  try {
    result.body = JSON.parse(result.body || "{}");
  } catch {
    result.body = {};
  }
  return result;
}

async function callText(handler, path) {
  let statusCode = 0;
  const headers = {};
  let body = "";
  const request = {
    method: "GET",
    url: `https://chain-poem-weaver.vercel.app${path}`,
    headers: {
      host: "chain-poem-weaver.vercel.app",
      "x-forwarded-proto": "https",
    },
  };
  const response = {
    setHeader(key, value) {
      headers[key.toLowerCase()] = value;
    },
    end(value) {
      body = String(value || "");
    },
    set statusCode(value) {
      statusCode = value;
    },
    get statusCode() {
      return statusCode;
    },
  };
  await handler(request, response);
  return { statusCode, headers, body };
}
