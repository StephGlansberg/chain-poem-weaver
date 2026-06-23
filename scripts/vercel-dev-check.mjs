import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = process.cwd();
const failures = [];

const packageJson = readJson(join(root, "package.json"));
const wrapper = readText(join(root, "scripts", "vercel-dev.mjs"));
const envExample = readText(join(root, ".env.vercel-dev.example"));
const gitignore = readText(join(root, ".gitignore"));
const vercelConfig = readJson(join(root, "vercel.json"));

check("dev_vercel_script_present", packageJson?.scripts?.["dev:vercel"] === "node scripts/vercel-dev.mjs");
check("dev_vercel_linked_script_present", packageJson?.scripts?.["dev:vercel:linked"] === "node scripts/vercel-dev.mjs --linked");
check("vercel_dev_wrapper_present", wrapper.includes("vercel\", \"dev\"") || wrapper.includes("vercel', 'dev'"));
check("vercel_dev_uses_local_by_default", wrapper.includes('args.push("--local")'));
check("vercel_dev_sets_safe_file_store", wrapper.includes("CHAIN_POEM_QUEUE_STORE_PATH") && wrapper.includes("random-weave-store.vercel-dev.json"));
check("vercel_dev_detects_database_url", wrapper.includes("process.env.DATABASE_URL ? \"postgres\" : \"file\""));
check("vercel_dev_sets_auth_domain", wrapper.includes("CHAIN_POEM_AUTH_DOMAIN"));
check("vercel_dev_redacts_database_url", wrapper.includes("DATABASE_URL: Boolean(process.env.DATABASE_URL)"));
check("env_example_present", envExample.includes("DATABASE_URL=") && envExample.includes("CHAIN_POEM_STORE_DRIVER=file"));
check("local_env_ignored", gitignore.includes(".env.local") && (gitignore.includes(".env.vercel-dev.local") || gitignore.includes(".env.*.local")));
check("vercel_poem_rewrite_present", Array.isArray(vercelConfig?.rewrites) && vercelConfig.rewrites.some((rule) => rule.source === "/poem"));

const result = {
  ok: failures.length === 0,
  generatedAtUtc: new Date().toISOString(),
  checked: "vercel-dev-wiring",
  failures,
};
console.log(JSON.stringify(result, null, 2));
if (failures.length) process.exit(1);

function check(name, passed) {
  if (!passed) failures.push(name);
}

function readText(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function readJson(path) {
  try {
    return JSON.parse(readText(resolve(path)));
  } catch {
    return null;
  }
}
