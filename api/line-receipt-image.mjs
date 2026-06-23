import { createQueueStore } from "./queue-store.mjs";
import { findReceiptByTokenId, readTokenId } from "./line-receipt-metadata.mjs";

export default async function handler(request, response) {
  if (request.method !== "GET") {
    return sendText(response, 405, "method_not_allowed", "text/plain; charset=utf-8", "no-store");
  }

  const tokenId = readTokenId(request);
  if (!tokenId) return sendText(response, 400, "token_id_required", "text/plain; charset=utf-8", "no-store");

  const store = createQueueStore();
  const data = await store.load();
  const found = findReceiptByTokenId(data, tokenId);
  if (!found) return sendText(response, 404, "line_receipt_not_found", "text/plain; charset=utf-8", "no-store");

  const receipt = found.receipt;
  const meta = receipt.metadata || {};
  const svg = renderReceiptSvg({
    title: meta.title || receipt.name,
    lineText: meta.lineText || receipt.description,
    role: meta.role || "line",
    lineNumber: meta.lineNumber || "",
    author: receipt.recipientHint?.username ? `@${receipt.recipientHint.username}` : receipt.recipientHint?.author || "anonymous",
    tokenId,
  });
  return sendText(response, 200, svg, "image/svg+xml; charset=utf-8", "public, max-age=60, s-maxage=300");
}

export function renderReceiptSvg({ title, lineText, role, lineNumber, author, tokenId }) {
  const lines = wrapText(lineText, 34).slice(0, 4);
  const tokenTail = String(tokenId).slice(-8);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200" viewBox="0 0 1200 1200" role="img" aria-label="Poem Weaver line receipt">
  <rect width="1200" height="1200" fill="#0b0a08"/>
  <path d="M160 915 C330 825 480 1000 650 895 C805 800 925 880 1040 800" fill="none" stroke="#d9b878" stroke-width="6" stroke-linecap="round" opacity="0.52"/>
  <path d="M225 240 C390 155 595 160 760 275 C555 318 410 430 325 610 C278 485 244 365 225 240Z" fill="#d9b878" opacity="0.94"/>
  <path d="M590 285 C520 455 415 625 275 790" fill="none" stroke="#0b0a08" stroke-width="20" stroke-linecap="round" opacity="0.64"/>
  <text x="120" y="130" fill="#d9b878" font-family="Georgia, serif" font-size="34" letter-spacing="3">POEM WEAVER</text>
  <text x="120" y="195" fill="#f4e7c4" font-family="Georgia, serif" font-size="28">line ${escapeXml(lineNumber)} / ${escapeXml(role)}</text>
  ${lines.map((line, index) => `<text x="120" y="${690 + index * 58}" fill="#fff8df" font-family="Georgia, serif" font-size="44">${escapeXml(line)}</text>`).join("")}
  <text x="120" y="985" fill="#d9b878" font-family="Georgia, serif" font-size="28">${escapeXml(author)}</text>
  <text x="120" y="1035" fill="#8e7a50" font-family="ui-monospace, monospace" font-size="22">token ${escapeXml(tokenTail)}</text>
  <text x="120" y="1080" fill="#8e7a50" font-family="ui-monospace, monospace" font-size="22">Base ERC-1155 receipt planned</text>
</svg>`;
}

function wrapText(value, maxChars) {
  const words = String(value || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : ["one small line"];
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sendText(response, statusCode, body, contentType, cacheControl) {
  response.statusCode = statusCode;
  response.setHeader("content-type", contentType);
  response.setHeader("cache-control", cacheControl);
  response.end(body);
}
