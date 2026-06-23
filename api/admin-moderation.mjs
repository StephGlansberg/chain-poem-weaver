import { createQueueStore, moderationState } from "./queue-store.mjs";

const MAX_BODY_BYTES = 8_000;

export default async function handler(request, response) {
  const auth = verifyAdmin(request);
  if (!auth.ok) return sendJson(response, auth.statusCode, auth.body);

  if (request.method === "GET") return handleGet(response);
  if (request.method === "POST") return handlePost(request, response);
  return sendJson(response, 405, { ok: false, error: "method_not_allowed" });
}

async function handleGet(response) {
  const store = createQueueStore();
  const data = await store.load();
  return sendJson(response, 200, {
    ok: true,
    moderation: moderationState(data),
    recentActions: (data.moderationActions || []).slice(-25),
  });
}

async function handlePost(request, response) {
  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    return sendJson(response, error.statusCode || 400, { ok: false, error: error.message || "invalid_json" });
  }

  const store = createQueueStore();
  const result = await store.moderate({
    action: body?.action,
    poemId: body?.poemId || body?.targetId,
    fid: body?.fid || body?.targetFid,
    reason: body?.reason,
    moderator: body?.moderator || "opulentis-admin",
  });
  if (!result.ok) return sendJson(response, 422, { ok: false, error: result.error });
  return sendJson(response, 200, {
    ok: true,
    action: result.action,
    moderation: result.state,
  });
}

function verifyAdmin(request) {
  const expected = process.env.CHAIN_POEM_ADMIN_TOKEN || "";
  if (!expected) {
    return {
      ok: false,
      statusCode: 503,
      body: { ok: false, error: "admin_token_not_configured", admin: false },
    };
  }
  const header = request.headers.authorization || request.headers.Authorization || request.headers["x-admin-token"] || "";
  const token = String(header).startsWith("Bearer ") ? String(header).slice("Bearer ".length).trim() : String(header).trim();
  if (token !== expected) {
    return {
      ok: false,
      statusCode: 401,
      body: { ok: false, error: "invalid_admin_token", admin: false },
    };
  }
  return { ok: true };
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

function sendJson(response, statusCode, body) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}
