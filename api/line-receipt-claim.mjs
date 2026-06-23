import { Errors, createClient } from "@farcaster/quick-auth";
import { createQueueStore } from "./queue-store.mjs";

const quickAuth = createClient();
const MAX_BODY_BYTES = 8_000;
const BASE_CHAIN_ID = 8453n;

export default async function handler(request, response) {
  if (request.method !== "POST") {
    return sendJson(response, 405, { ok: false, error: "method_not_allowed" });
  }

  const auth = await verifyRequest(request);
  if (!auth.ok) return sendJson(response, auth.statusCode, auth.body);

  const readiness = claimReadiness();
  if (!readiness.ok) return sendJson(response, 503, { ok: false, error: readiness.error, missing: readiness.missing });

  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    return sendJson(response, error.statusCode || 400, { ok: false, error: error.message || "invalid_json" });
  }

  const selector = cleanToken(body?.claimKey || body?.tokenId);
  if (!selector) return sendJson(response, 400, { ok: false, error: "claim_key_or_token_id_required" });

  const store = createQueueStore();
  const data = await store.load();
  const claim = findClaim(data, selector);
  if (!claim) return sendJson(response, 404, { ok: false, error: "line_receipt_claim_not_found" });
  if (String(claim.contributor?.fid || "") !== String(auth.fid)) {
    return sendJson(response, 403, { ok: false, error: "claim_not_owned_by_fid" });
  }
  if (!claim.recipientAddress || !claim.addressProofVerified) {
    return sendJson(response, 422, { ok: false, error: "verified_wallet_binding_required" });
  }
  if (!claim.tokenId || !claim.claimKey || !claim.poemHash) {
    return sendJson(response, 422, { ok: false, error: "claim_record_incomplete" });
  }
  if (claim.claimState && claim.claimState !== "locked") {
    return sendJson(response, 409, { ok: false, error: "claim_not_claimable", claimState: claim.claimState });
  }

  try {
    const signed = await signLineClaim(claim, readiness);
    return sendJson(response, 200, {
      ok: true,
      chainId: Number(readiness.chainId),
      network: "base",
      contractAddress: readiness.contractAddress,
      standard: "ERC-1155",
      method: "claimLine",
      claim: signed.claim,
      signature: signed.signature,
      abi: CLAIM_LINE_ABI,
      expiresAtUtc: new Date(Number(signed.claim.deadline) * 1000).toISOString(),
    });
  } catch {
    return sendJson(response, 500, { ok: false, error: "claim_signature_failed" });
  }
}

const CLAIM_LINE_ABI = [{
  type: "function",
  name: "claimLine",
  stateMutability: "nonpayable",
  inputs: [
    {
      name: "claim",
      type: "tuple",
      components: [
        { name: "recipient", type: "address" },
        { name: "tokenId", type: "uint256" },
        { name: "claimKey", type: "bytes32" },
        { name: "poemHash", type: "bytes32" },
        { name: "lineIndex", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    { name: "signature", type: "bytes" },
  ],
  outputs: [],
}];

function claimReadiness() {
  const missing = [];
  const enabled = process.env.CHAIN_POEM_LINE_RECEIPT_CLAIM_ENABLED === "true";
  const contractAddress = normalizeAddress(process.env.CHAIN_POEM_LINE_RECEIPT_CONTRACT);
  const privateKey = normalizePrivateKey(process.env.CHAIN_POEM_LINE_RECEIPT_SIGNER_PRIVATE_KEY);
  if (!enabled) missing.push("CHAIN_POEM_LINE_RECEIPT_CLAIM_ENABLED=true");
  if (!contractAddress) missing.push("CHAIN_POEM_LINE_RECEIPT_CONTRACT");
  if (!privateKey) missing.push("CHAIN_POEM_LINE_RECEIPT_SIGNER_PRIVATE_KEY");
  return {
    ok: missing.length === 0,
    error: "line_receipt_claim_not_enabled",
    missing,
    contractAddress,
    privateKey,
    chainId: BigInt(process.env.CHAIN_POEM_LINE_RECEIPT_CHAIN_ID || "8453"),
  };
}

async function signLineClaim(claimRecord, readiness) {
  const { encodeAbiParameters, keccak256, parseAbiParameters } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(readiness.privateKey);
  const expectedSigner = normalizeAddress(process.env.CHAIN_POEM_LINE_RECEIPT_SIGNER);
  if (expectedSigner && account.address.toLowerCase() !== expectedSigner) {
    throw new Error("signer_address_mismatch");
  }
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const claim = {
    recipient: claimRecord.recipientAddress,
    tokenId: String(claimRecord.tokenId),
    claimKey: toBytes32(claimRecord.claimKey),
    poemHash: toBytes32(claimRecord.poemHash),
    lineIndex: String(claimRecord.lineIndex),
    deadline: String(deadline),
  };
  const digest = keccak256(encodeAbiParameters(
    parseAbiParameters("uint256,address,address,uint256,bytes32,bytes32,uint256,uint256"),
    [
      readiness.chainId || BASE_CHAIN_ID,
      readiness.contractAddress,
      claim.recipient,
      BigInt(claim.tokenId),
      claim.claimKey,
      claim.poemHash,
      BigInt(claim.lineIndex),
      deadline,
    ],
  ));
  const signature = await account.signMessage({ message: { raw: digest } });
  return { claim, signature };
}

function findClaim(store, selector) {
  const normalized = cleanToken(selector);
  return (store.lineReceiptClaims || []).find((claim) =>
    cleanToken(claim.claimKey) === normalized ||
    cleanToken(claim.tokenId) === normalized
  ) || null;
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
      return { ok: false, statusCode: 401, body: { ok: false, error: "invalid_token", verified: false } };
    }
    return { ok: false, statusCode: 500, body: { ok: false, error: "auth_verification_failed", verified: false } };
  }
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
  return String(value || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
}

function cleanToken(value) {
  return String(value || "").trim().replace(/[^\w:.-]/g, "").slice(0, 128);
}

function normalizeAddress(value) {
  const text = String(value || "").trim();
  return /^0x[0-9a-fA-F]{40}$/.test(text) ? text.toLowerCase() : "";
}

function normalizePrivateKey(value) {
  const text = String(value || "").trim();
  const key = text.startsWith("0x") ? text : `0x${text}`;
  return /^0x[0-9a-fA-F]{64}$/.test(key) ? key : "";
}

function toBytes32(value) {
  const hex = String(value || "").replace(/^sha256:/, "").replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("invalid_bytes32");
  return `0x${hex}`;
}

function sendJson(response, statusCode, body) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}
