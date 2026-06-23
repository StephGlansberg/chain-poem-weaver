import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = process.cwd();
const outputPath = join(root, "data", "deploy-production-run.json");
const live = process.argv.includes("--live");
const strict = process.argv.includes("--strict") || live;

const steps = [];
const blockers = [];
const warnings = [];

const target = runNodeScript("scripts/deploy-target-check.mjs", []);
steps.push(step("deploy-target-check", target));
const targetJson = parseJson(target.stdout);
if (!targetJson?.ok) {
  blockers.push(...(targetJson?.blockers || ["deploy_target_not_ready"]));
}
warnings.push(...(targetJson?.warnings || []));

let build = null;
let release = null;
let preflight = null;
let manifestAssert = null;
let baseStandardWeb = null;
let hostingConfig = null;
let productionStatic = null;
let deploy = null;
let verify = null;

if (targetJson?.ok) {
  build = runNpm(["run", "build:production"]);
  steps.push(step("build-production", build));
  if (build.status !== 0) blockers.push("build_production_failed");

  release = runNpm(["run", "release:packet:strict"]);
  steps.push(step("release-packet-strict", release));
  if (release.status !== 0) blockers.push("release_packet_strict_failed");

  preflight = runNpm(["run", "preflight:deploy"]);
  steps.push(step("preflight-deploy", preflight));
  if (preflight.status !== 0) blockers.push("preflight_deploy_failed");

  manifestAssert = runNodeScript("dist/scripts/manifest-assert.mjs", ["--production"]);
  steps.push(step("manifest-assert-production", manifestAssert));
  if (manifestAssert.status !== 0) blockers.push("production_manifest_assert_failed");

  baseStandardWeb = runNodeScript("dist/scripts/base-standard-web-check.mjs", []);
  steps.push(step("base-standard-web-check", baseStandardWeb));
  if (baseStandardWeb.status !== 0) blockers.push("base_standard_web_check_failed");

  hostingConfig = runNodeScript("dist/scripts/hosting-config-check.mjs", []);
  steps.push(step("hosting-config-check", hostingConfig));
  if (hostingConfig.status !== 0) blockers.push("hosting_config_check_failed");

  productionStatic = runNodeScript("dist/scripts/static-check.mjs", ["--production"]);
  steps.push(step("static-check-production", productionStatic));
  if (productionStatic.status !== 0) blockers.push("production_static_check_failed");

  if (live && blockers.length === 0) {
    deploy = runVercelDeploy(targetJson);
    steps.push(step("vercel-live-deploy", deploy));
    if (deploy.status !== 0) blockers.push("vercel_deploy_failed");

    verify = runNodeScript("scripts/verify-deployment.mjs", [targetJson.origin]);
    steps.push(step("verify-live-deployment", verify));
    if (verify.status !== 0) blockers.push("live_verify_failed");
  }
} else {
  warnings.push("local_production_build_skipped_until_deploy_target_ready");
}

const result = {
  schemaVersion: 1,
  kind: "chain-poem-weaver-deploy-production-run",
  generatedAtUtc: new Date().toISOString(),
  mode: live ? "live" : "dry-run",
  ok: blockers.length === 0,
  origin: targetJson?.origin || null,
  preferredProvider: targetJson?.preferredProvider || null,
  deployCommand: targetJson?.providers?.find((provider) => provider.id === targetJson.preferredProvider)?.deployCommand || null,
  steps,
  blockers: unique(blockers),
  warnings: unique(warnings),
  next: blockers.length
    ? "Resolve blockers, then rerun npm run deploy:production:dry-run before attempting live deployment."
    : live
      ? "Live deploy command finished and verify-deployment passed. Now test inside a Farcaster/Base client."
      : "Dry-run production checks passed. Run npm run deploy:production:live when ready to publish.",
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify(result, null, 2));
if (strict && blockers.length) process.exit(1);

function runNpm(args) {
  if (process.platform === "win32") {
    return spawnSync("cmd.exe", ["/d", "/c", "npm", ...args], { cwd: root, encoding: "utf8" });
  }
  return spawnSync("npm", args, { cwd: root, encoding: "utf8" });
}

function runNodeScript(script, args) {
  return spawnSync(process.execPath, [join(root, script), ...args], { cwd: root, encoding: "utf8" });
}

function runVercelDeploy(targetJson) {
  const provider = targetJson.providers?.find((entry) => entry.id === "vercel");
  if (!provider?.ready) {
    return {
      status: 1,
      stdout: "",
      stderr: "vercel provider is not ready",
    };
  }
  const args = ["vercel@latest", "deploy", "--prod", "--yes", "--token", process.env.VERCEL_TOKEN || ""];
  if (process.platform === "win32") {
    return spawnSync("cmd.exe", ["/d", "/c", "npx", ...args], { cwd: root, encoding: "utf8" });
  }
  return spawnSync("npx", args, { cwd: root, encoding: "utf8" });
}

function step(name, result) {
  return {
    name,
    exitCode: result.status,
    ok: result.status === 0,
    stdout: trimOutput(result.stdout),
    stderr: trimOutput(result.stderr || result.error?.message),
  };
}

function trimOutput(value) {
  const text = String(value || "").trim();
  if (text.length <= 12000) return text;
  return `${text.slice(0, 12000)}\n...[truncated ${text.length - 12000} chars]`;
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

function unique(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}
