import { createHash, createHmac } from "node:crypto";
import { Errors, createClient } from "@farcaster/quick-auth";
import { MAX_LINES, cleanText, getWeaveMap } from "../src/poem.js";

const quickAuth = createClient();
const MAX_BODY_BYTES = 24_000;
export const OWNERSHIP_POLICY_VERSION = "chain-poem-ownership-v1";
export const LINE_RECEIPT_METADATA_ROUTE = "/api/line-receipt-metadata";
export const LINE_RECEIPT_IMAGE_ROUTE = "/api/line-receipt-image";

export default async function handler(request, response) {
  if (request.method !== "POST") {
    return sendJson(response, 405, { ok: false, error: "method_not_allowed" });
  }

  const auth = await verifyRequest(request);
  if (!auth.ok) return sendJson(response, auth.statusCode, auth.body);

  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    return sendJson(response, error.statusCode || 400, { ok: false, error: error.message || "invalid_json" });
  }

  const poemResult = canonicalizePoem(body?.poem);
  if (!poemResult.ok) return sendJson(response, 422, { ok: false, error: poemResult.error });

  const provenance = buildProvenance(poemResult.poem, auth.fid, process.env.CHAIN_POEM_PROVENANCE_SECRET || "");

  return sendJson(response, 200, {
    ok: true,
    provenance,
  });
}

async function verifyRequest(request) {
  const expectedDomain = getExpectedDomain(request);
  if (!expectedDomain) {
    return {
      ok: false,
      statusCode: 503,
      body: { ok: false, error: "auth_domain_not_configured", verified: false },
    };
  }

  const authorization = request.headers.authorization || request.headers.Authorization || "";
  if (!authorization.startsWith("Bearer ")) {
    return {
      ok: false,
      statusCode: 401,
      body: { ok: false, error: "missing_bearer_token", verified: false },
    };
  }

  try {
    const payload = await quickAuth.verifyJwt({
      token: authorization.slice("Bearer ".length).trim(),
      domain: expectedDomain,
    });
    return { ok: true, fid: payload.sub };
  } catch (error) {
    if (error instanceof Errors.InvalidTokenError) {
      return {
        ok: false,
        statusCode: 401,
        body: { ok: false, error: "invalid_token", verified: false },
      };
    }
    return {
      ok: false,
      statusCode: 500,
      body: { ok: false, error: "auth_verification_failed", verified: false },
    };
  }
}

export function canonicalizePoem(poem) {
  if (!poem || typeof poem !== "object") return { ok: false, error: "poem_required" };
  const rawLines = Array.isArray(poem.lines) ? poem.lines.slice(0, MAX_LINES) : [];
  const lines = getWeaveMap({ lines: rawLines })
    .filter((line) => cleanText(line.text))
    .map((line) => ({
      index: line.index,
      text: cleanText(line.text),
      author: cleanText(line.author, 42) || "anonymous",
      fid: cleanText(line.fid, 20),
      username: cleanText(line.username, 32),
      displayName: cleanText(line.displayName, 42),
      contextSource: cleanText(line.contextSource, 32),
      verified: line.verified === true,
      role: cleanText(line.role, 24),
      signal: cleanText(line.signal, 32),
      weaveWeight: Number(line.weaveWeight || 0),
    }));

  if (lines.length === 0) return { ok: false, error: "empty_poem" };
  if (poem.status !== "complete") return { ok: false, error: "poem_not_complete" };
  if (lines.some((line) => !line.text)) return { ok: false, error: "empty_line" };

  return {
    ok: true,
    poem: {
      schemaVersion: 1,
      poemId: cleanText(poem.poemId, 64),
      title: cleanText(poem.title, 52) || "Untitled chain",
      theme: cleanText(poem.theme, 24) || "ritual",
      status: "complete",
      mintStatus: "none",
      lines,
    },
  };
}

export function buildProvenance(canonicalPoem, verifierFid, secret = "") {
  const canonicalJson = stableStringify(canonicalPoem);
  const hash = createHash("sha256").update(canonicalJson).digest("hex");
  const signature = secret ? createHmac("sha256", secret).update(hash).digest("hex") : null;

  return {
    schemaVersion: 1,
    poemHash: `sha256:${hash}`,
    canonicalJson,
    signed: Boolean(signature),
    signature,
    verifierFid,
    generatedAtUtc: new Date().toISOString(),
    mintAllowed: false,
    ownershipPolicy: buildOwnershipPolicy(canonicalPoem, `sha256:${hash}`),
    offchainMetadata: buildOffchainMetadata(canonicalPoem, `sha256:${hash}`),
    lineReceiptMintPlan: buildLineReceiptMintPlan(canonicalPoem, `sha256:${hash}`),
    nextGate: signature ? "operator_paid_mint_approval_required" : "provenance_secret_missing",
  };
}

export function buildOwnershipPolicy(canonicalPoem, poemHash) {
  const lines = canonicalPoem.lines || [];
  return {
    schemaVersion: 1,
    kind: "chain-poem-ownership-policy",
    version: OWNERSHIP_POLICY_VERSION,
    poemHash,
    status: "policy_written_not_mint_armed",
    wholePoem: {
      artifactStatus: "coauthored_collective_artifact",
      owner: "no_single_owner",
      mintEligibility: "disabled_until_all_verified_line_contributors_have_clear_consent_or_operator_chooses_noncommercial_display_only",
      commercialRights: "not_granted_by_provenance",
    },
    lineReceipts: {
      claimant: "verified_line_contributor",
      rule: "one_future_receipt_may_be_claimed_for_the_contributor_own_canonical_line_only",
      transferOfCopyright: false,
      commercialLicenseGranted: false,
      canMintOtherContributorLines: false,
    },
    completer: {
      role: "stewardship_credit",
      receivesOwnershipOverOtherLines: false,
      mayReceiveFutureRecognition: true,
    },
    requiredBeforeAnyMint: [
      "explicit_operator_approval",
      "live_farcaster_client_quick_auth_receipts",
      "wallet_ownership_verification",
      "anti_sybil_review",
      "clear_user_action_to_claim_or_mint",
      "public_terms_copy_visible_to_user",
    ],
    contributorClaims: lines.map((line) => ({
      lineIndex: line.index,
      lineNumber: line.index + 1,
      fid: line.fid || "",
      username: line.username || "",
      author: line.author || "anonymous",
      claimScope: "own_line_receipt_only",
      wholePoemOwnership: false,
    })),
  };
}

export function buildOffchainMetadata(canonicalPoem, poemHash) {
  const lines = canonicalPoem.lines || [];
  const lineSummaries = lines.map((line) => ({
    lineIndex: line.index,
    lineNumber: line.index + 1,
    text: line.text,
    role: line.role,
    fid: line.fid || "",
    username: line.username || "",
    author: line.author || "anonymous",
    signal: line.signal || "",
    weaveWeight: line.weaveWeight,
  }));
  return {
    schemaVersion: 1,
    kind: "chain-poem-offchain-metadata",
    storageStatus: "generated_offchain_not_minted",
    ownershipPolicyVersion: OWNERSHIP_POLICY_VERSION,
    poem: {
      name: canonicalPoem.title,
      description: `A completed Poem Weaver collaboration with ${lines.length} verified Farcaster lines.`,
      image: null,
      external_url: null,
      animation_url: null,
      attributes: [
        { trait_type: "Theme", value: canonicalPoem.theme },
        { trait_type: "Line Count", value: lines.length },
        { trait_type: "Network", value: "Base-ready, off-chain only" },
        { trait_type: "Mint Status", value: "disabled" },
      ],
      properties: {
        poemId: canonicalPoem.poemId,
        poemHash,
        format: "coauthored-poem",
        ownershipPolicyVersion: OWNERSHIP_POLICY_VERSION,
        ownershipSummary: "Each verified contributor may later claim only their own line receipt; no single contributor owns the whole poem.",
        contributors: lineSummaries.map((line) => ({
          fid: line.fid,
          username: line.username,
          author: line.author,
          lineIndex: line.lineIndex,
        })),
        lines: lineSummaries,
      },
    },
    lineReceipts: lineSummaries.map((line) => {
      const token = buildLineReceiptToken(canonicalPoem, poemHash, line);
      return {
      name: `${canonicalPoem.title} - line ${line.lineNumber}`,
      description: line.text,
      image: buildLineReceiptImageUrl(token.tokenId),
      external_url: buildPoemExternalUrl(canonicalPoem.poemId, poemHash),
      attributes: [
        { trait_type: "Poem", value: canonicalPoem.title },
        { trait_type: "Theme", value: canonicalPoem.theme },
        { trait_type: "Role", value: line.role },
        { trait_type: "Line", value: line.lineNumber },
        { trait_type: "Signal", value: line.signal },
      ],
      properties: {
        poemId: canonicalPoem.poemId,
        poemHash,
        ownershipPolicyVersion: OWNERSHIP_POLICY_VERSION,
        claimScope: "own_line_receipt_only",
        lineIndex: line.lineIndex,
        fid: line.fid,
        username: line.username,
        author: line.author,
        text: line.text,
        tokenId: token.tokenId,
        tokenIdSeed: token.tokenIdSeed,
        claimKey: token.claimKey,
      },
    };
    }),
  };
}

export function buildLineReceiptMintPlan(canonicalPoem, poemHash) {
  const receipts = (canonicalPoem.lines || []).map((line) => {
    const token = buildLineReceiptToken(canonicalPoem, poemHash, {
      lineIndex: line.index,
      text: line.text,
      fid: line.fid,
      username: line.username,
      author: line.author,
    });
    return {
      schemaVersion: 1,
      tokenId: token.tokenId,
      tokenIdSeed: token.tokenIdSeed,
      claimKey: token.claimKey,
      name: `${canonicalPoem.title} - line ${line.index + 1}`,
      description: `A Chain Poem Weaver line receipt for: ${line.text}`,
      image: buildLineReceiptImageUrl(token.tokenId),
      externalUrl: buildPoemExternalUrl(canonicalPoem.poemId, poemHash),
      metadataUrl: buildLineReceiptMetadataUrl(token.tokenId),
      recipientHint: {
        fid: line.fid || "",
        username: line.username || "",
        displayName: line.displayName || "",
        author: line.author || "anonymous",
      },
      metadata: {
        poemId: canonicalPoem.poemId,
        poemHash,
        ownershipPolicyVersion: OWNERSHIP_POLICY_VERSION,
        claimScope: "own_line_receipt_only",
        title: canonicalPoem.title,
        theme: canonicalPoem.theme,
        lineIndex: line.index,
        lineNumber: line.index + 1,
        lineText: line.text,
        role: line.role,
        signal: line.signal,
        weaveWeight: line.weaveWeight,
        tokenId: token.tokenId,
        tokenIdSeed: token.tokenIdSeed,
        claimKey: token.claimKey,
      },
      attributes: [
        { trait_type: "Poem", value: canonicalPoem.title },
        { trait_type: "Theme", value: canonicalPoem.theme },
        { trait_type: "Line", value: line.index + 1 },
        { trait_type: "Role", value: line.role },
        { trait_type: "Signal", value: line.signal },
        { trait_type: "Weave Weight", value: line.weaveWeight },
      ],
    };
  });
  return {
    schemaVersion: 1,
    kind: "chain-poem-line-receipt-mint-plan",
    enabled: false,
    mintAllowed: false,
    chainId: 8453,
    network: "base",
    standard: "ERC-1155",
    contractAddress: null,
    contractStatus: "not_deployed",
    mintPriceWei: null,
    currency: "ETH",
    supplyPolicy: "one_receipt_per_canonical_line",
    receipts,
    nextGate: "deploy_base_erc1155_contract_and_verify_wallet_ownership",
  };
}

export function buildLineReceiptToken(canonicalPoem, poemHash, line) {
  const index = Number(line.index ?? line.lineIndex ?? 0);
  const contributor = line.fid ? `fid:${line.fid}` : line.username ? `@${line.username}` : line.author || "anonymous";
  const tokenSeed = stableStringify({
    poemHash,
    poemId: canonicalPoem.poemId,
    lineIndex: index,
    contributor,
    text: line.text,
  });
  const tokenIdSeedHex = createHash("sha256").update(tokenSeed).digest("hex");
  const claimKeyHex = createHash("sha256").update(`${poemHash}:${index}:${contributor}`).digest("hex");
  return {
    tokenId: BigInt(`0x${tokenIdSeedHex}`).toString(10),
    tokenIdSeed: `sha256:${tokenIdSeedHex}`,
    claimKey: `sha256:${claimKeyHex}`,
  };
}

export function buildLineReceiptMetadataUrl(tokenId, origin = publicOrigin()) {
  if (!origin || !tokenId) return null;
  return `${origin}${LINE_RECEIPT_METADATA_ROUTE}?tokenId=${encodeURIComponent(String(tokenId))}.json`;
}

export function buildLineReceiptImageUrl(tokenId, origin = publicOrigin()) {
  if (!origin || !tokenId) return null;
  return `${origin}${LINE_RECEIPT_IMAGE_ROUTE}?tokenId=${encodeURIComponent(String(tokenId))}.svg`;
}

export function buildPoemExternalUrl(poemId, poemHash, origin = publicOrigin()) {
  if (!origin || !poemId) return null;
  const url = new URL("/poem", origin);
  url.searchParams.set("view", "thread");
  url.searchParams.set("poemId", poemId);
  if (poemHash) url.searchParams.set("poemHash", poemHash);
  return url.toString();
}

export function publicOrigin() {
  const origin = process.env.CHAIN_POEM_PUBLIC_ORIGIN || process.env.MINIAPP_ORIGIN || "";
  return cleanOrigin(origin);
}

async function readJsonBody(request) {
  if (request.body && typeof request.body === "object" && !Buffer.isBuffer(request.body)) return request.body;
  const text = await readTextBody(request);
  if (!text) throw Object.assign(new Error("body_required"), { statusCode: 400 });
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("invalid_json"), { statusCode: 400 });
  }
}

async function readTextBody(request) {
  if (typeof request.body === "string") return request.body;
  if (Buffer.isBuffer(request.body)) return request.body.toString("utf8");
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("body_too_large"), { statusCode: 413 });
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function getExpectedDomain(request) {
  if (process.env.CHAIN_POEM_AUTH_DOMAIN) return cleanDomain(process.env.CHAIN_POEM_AUTH_DOMAIN);
  if (process.env.MINIAPP_ORIGIN) return new URL(process.env.MINIAPP_ORIGIN).hostname;
  const host = request.headers["x-forwarded-host"] || request.headers.host || "";
  return cleanDomain(String(host).split(",")[0]);
}

function cleanDomain(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");
}

function cleanOrigin(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  try {
    const parsed = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    return parsed.protocol === "https:" ? parsed.origin : "";
  } catch {
    return "";
  }
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function sendJson(response, statusCode, body) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}
