import { Errors, createClient } from "@farcaster/quick-auth";

const quickAuth = createClient();

export default async function handler(request, response) {
  if (request.method !== "GET") {
    return sendJson(response, 405, { ok: false, error: "method_not_allowed" });
  }

  const expectedDomain = getExpectedDomain(request);
  if (!expectedDomain) {
    return sendJson(response, 503, {
      ok: false,
      error: "auth_domain_not_configured",
      verified: false,
    });
  }

  const authorization = request.headers.authorization || request.headers.Authorization || "";
  if (!authorization.startsWith("Bearer ")) {
    return sendJson(response, 401, {
      ok: false,
      error: "missing_bearer_token",
      verified: false,
    });
  }

  try {
    const payload = await quickAuth.verifyJwt({
      token: authorization.slice("Bearer ".length).trim(),
      domain: expectedDomain,
    });
    const primaryAddress = await resolvePrimaryEthereumAddress(payload.sub);
    return sendJson(response, 200, {
      ok: true,
      verified: true,
      fid: payload.sub,
      primaryAddress,
      auth: {
        issuer: payload.iss,
        audience: payload.aud,
        issuedAt: payload.iat,
        expiresAt: payload.exp,
      },
    });
  } catch (error) {
    if (error instanceof Errors.InvalidTokenError) {
      return sendJson(response, 401, {
        ok: false,
        error: "invalid_token",
        verified: false,
      });
    }
    return sendJson(response, 500, {
      ok: false,
      error: "auth_verification_failed",
      verified: false,
    });
  }
}

async function resolvePrimaryEthereumAddress(fid) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const url = `https://api.farcaster.xyz/fc/primary-address?fid=${encodeURIComponent(String(fid))}&protocol=ethereum`;
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    const body = await response.json();
    const address = String(body?.result?.address?.address || "").toLowerCase();
    return /^0x[0-9a-f]{40}$/.test(address) ? address : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
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

function sendJson(response, statusCode, body) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}
