import { mkdtempSync, mkdirSync, cpSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const outputPath = join(root, "data", "production-rehearsal-run.json");
const keepTemp = process.argv.includes("--keep-temp");
const tempRoot = mkdtempSync(join(tmpdir(), "chain-poem-weaver-rehearsal-"));
const origin = "https://rehearsal-chain-poem.opulentis.ai";
const domain = new URL(origin).hostname;

const copyEntries = [
  "index.html",
  "package.json",
  "package-lock.json",
  "favicon.svg",
  "manifest.webmanifest",
  "vercel.json",
  ".well-known",
  "api",
  "assets",
  "contracts",
  "data",
  "src",
  "scripts",
];

const env = {
  ...process.env,
  MINIAPP_ORIGIN: origin,
  FARCASTER_ACCOUNT_ASSOCIATION_HEADER: toBase64UrlJson({ type: "custody" }),
  FARCASTER_ACCOUNT_ASSOCIATION_PAYLOAD: toBase64UrlJson({ domain }),
  FARCASTER_ACCOUNT_ASSOCIATION_SIGNATURE: `0x${"b".repeat(130)}`,
  CHAIN_POEM_PROVENANCE_SECRET: "rehearsal-only-not-a-secret",
  VERCEL_TOKEN: "rehearsal-only-not-a-token",
};

const failures = [];
const warnings = [];
const copied = [];
let rehearsal = null;

try {
  for (const entry of copyEntries) {
    cpSync(join(root, entry), join(tempRoot, entry), { recursive: true, force: true });
    copied.push(entry);
  }

  const run = runNode("scripts/deploy-production.mjs", [], tempRoot, env);
  rehearsal = parseJson(run.stdout);
  if (run.status !== 0) failures.push("deploy_production_rehearsal_process_failed");
  if (!rehearsal?.ok) failures.push(...(rehearsal?.blockers || ["deploy_production_rehearsal_not_ok"]));
  if (!rehearsal?.steps?.some((step) => step.name === "base-standard-web-check" && step.ok)) {
    failures.push("rehearsal_base_standard_web_step_missing_or_failed");
  }
  if (!rehearsal?.steps?.some((step) => step.name === "hosting-config-check" && step.ok)) {
    failures.push("rehearsal_hosting_config_step_missing_or_failed");
  }
  if (!rehearsal?.steps?.some((step) => step.name === "release-packet-strict" && step.ok)) {
    failures.push("rehearsal_release_packet_step_missing_or_failed");
  }
  if (!rehearsal?.steps?.some((step) => step.name === "manifest-assert-production" && step.ok)) {
    failures.push("rehearsal_manifest_assert_step_missing_or_failed");
  }
  if (!rehearsal?.steps?.some((step) => step.name === "preflight-deploy" && step.ok)) {
    failures.push("rehearsal_preflight_step_missing_or_failed");
  }
  if (!rehearsal?.steps?.some((step) => step.name === "static-check-production" && step.ok)) {
    failures.push("rehearsal_static_check_step_missing_or_failed");
  }
  warnings.push(...(rehearsal?.warnings || []));
} finally {
  if (!keepTemp) rmSync(tempRoot, { recursive: true, force: true });
}

const result = {
  schemaVersion: 1,
  kind: "chain-poem-weaver-production-rehearsal-run",
  generatedAtUtc: new Date().toISOString(),
  ok: failures.length === 0,
  tempRoot: keepTemp ? tempRoot : null,
  origin,
  copied,
  rehearsal: rehearsal
    ? {
        ok: rehearsal.ok,
        mode: rehearsal.mode,
        origin: rehearsal.origin,
        stepSummary: rehearsal.steps.map((step) => ({
          name: step.name,
          ok: step.ok,
          exitCode: step.exitCode,
        })),
        blockers: rehearsal.blockers || [],
        warnings: rehearsal.warnings || [],
      }
    : null,
  failures: unique(failures),
  warnings: unique(warnings),
  next: failures.length
    ? "Fix rehearsal failures before asking the operator for production credentials."
    : "Production-shaped rehearsal passed in a temp app copy. Real deployment still needs real domain, signed accountAssociation, deploy token, and live Farcaster/Base client test.",
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify(result, null, 2));
if (failures.length) process.exit(1);

function runNode(script, args, cwd, childEnv) {
  return spawnSync(process.execPath, [join(cwd, script), ...args], {
    cwd,
    env: childEnv,
    encoding: "utf8",
  });
}

function parseJson(output) {
  const text = String(output || "");
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

function toBase64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}
