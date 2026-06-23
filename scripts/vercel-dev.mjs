import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const options = parseArgs(process.argv.slice(2));

loadEnvFile(join(root, ".env.local"));
loadEnvFile(join(root, ".env.vercel-dev.local"));

const port = options.port || process.env.VERCEL_DEV_PORT || "3000";
const host = options.host || process.env.VERCEL_DEV_HOST || "127.0.0.1";
const listen = options.listen || `${host}:${port}`;

setDefault("MINIAPP_ORIGIN", "https://chain-poem-weaver.vercel.app");
setDefault("CHAIN_POEM_AUTH_DOMAIN", new URL(process.env.MINIAPP_ORIGIN).hostname);
setDefault("CHAIN_POEM_STORE_DRIVER", process.env.DATABASE_URL ? "postgres" : "file");
setDefault("CHAIN_POEM_QUEUE_STORE_PATH", join(root, "data", "random-weave-store.vercel-dev.json"));
setDefault("CHAIN_POEM_PROVENANCE_SECRET", "local-vercel-dev-not-production");

const args = ["vercel", "dev", "--yes", "--listen", listen];
if (!options.linked) args.push("--local");

console.log(JSON.stringify({
  ok: true,
  command: `npx ${args.join(" ")}`,
  url: `http://${listen}`,
  linkedProject: options.linked,
  env: {
    MINIAPP_ORIGIN: process.env.MINIAPP_ORIGIN,
    CHAIN_POEM_AUTH_DOMAIN: process.env.CHAIN_POEM_AUTH_DOMAIN,
    CHAIN_POEM_STORE_DRIVER: process.env.CHAIN_POEM_STORE_DRIVER,
    CHAIN_POEM_QUEUE_STORE_PATH: process.env.CHAIN_POEM_QUEUE_STORE_PATH,
    DATABASE_URL: Boolean(process.env.DATABASE_URL),
    CHAIN_POEM_PROVENANCE_SECRET: Boolean(process.env.CHAIN_POEM_PROVENANCE_SECRET),
  },
}, null, 2));

const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", args, {
  cwd: root,
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
  shell: process.platform === "win32",
});

child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});

function parseArgs(args) {
  const parsed = { linked: false, port: "", host: "", listen: "" };
  for (const arg of args) {
    if (arg === "--linked") parsed.linked = true;
    else if (arg.startsWith("--port=")) parsed.port = arg.slice("--port=".length);
    else if (arg.startsWith("--host=")) parsed.host = arg.slice("--host=".length);
    else if (arg.startsWith("--listen=")) parsed.listen = arg.slice("--listen=".length);
  }
  return parsed;
}

function setDefault(key, value) {
  if (!process.env[key]) process.env[key] = value;
}

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = unquote(rawValue.trim());
  }
}

function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
