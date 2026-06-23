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
    return sendJson(response, 200, {
      ok: true,
      verified: true,
      fid: payload.sub,
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
