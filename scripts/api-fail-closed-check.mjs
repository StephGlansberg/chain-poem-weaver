const checks = [];
const failures = [];

await checkRoute("api/me.mjs", "GET", { host: "poems.opulentis.ai" }, null, "missing_bearer_token");
await checkRoute("api/provenance.mjs", "POST", { host: "poems.opulentis.ai" }, { poem: {} }, "missing_bearer_token");
await checkRoute("api/random-weave.mjs", "POST", { host: "poems.opulentis.ai" }, { line: "small gold" }, "missing_bearer_token");
await checkRoute("api/line-receipt-claim.mjs", "POST", { host: "poems.opulentis.ai" }, { tokenId: "1" }, "missing_bearer_token");
await checkRoute("api/admin-moderation.mjs", "POST", { host: "poems.opulentis.ai" }, { action: "ban_fid", fid: "1" }, "admin_token_not_configured", 503, "admin");

const result = {
  ok: failures.length === 0,
  generatedAtUtc: new Date().toISOString(),
  checks,
  failures,
};

console.log(JSON.stringify(result, null, 2));
if (failures.length) process.exit(1);

async function checkRoute(file, method, headers, body, expectedError, expectedStatus = 401, verifiedField = "verified") {
  const mod = await import(`../${file}`);
  let statusCode = 0;
  const responseHeaders = {};
  let responseBody = "";
  const request = makeRequest({ method, headers, body });
  const response = {
    setHeader(key, value) {
      responseHeaders[key.toLowerCase()] = value;
    },
    end(value) {
      responseBody = value;
    },
    set statusCode(value) {
      statusCode = value;
    },
    get statusCode() {
      return statusCode;
    },
  };

  await mod.default(request, response);
  const parsed = JSON.parse(responseBody || "{}");
  const ok = statusCode === expectedStatus &&
    parsed.error === expectedError &&
    parsed[verifiedField] === false &&
    responseHeaders["cache-control"] === "no-store";
  checks.push({ file, statusCode, error: parsed.error, verified: parsed[verifiedField], cacheControl: responseHeaders["cache-control"], ok });
  if (!ok) failures.push(`${file}_fail_closed_probe_failed`);
}

function makeRequest({ method, headers, body }) {
  return {
    method,
    headers,
    body: body ? JSON.stringify(body) : "",
    async *[Symbol.asyncIterator]() {
      if (this.body) yield Buffer.from(this.body, "utf8");
    },
  };
}
