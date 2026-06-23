import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createQueueStore } from "../api/queue-store.mjs";

loadLocalEnv();

const args = parseArgs(process.argv.slice(2));
const store = createQueueStore();

if (args.help || !args.action) {
  printHelp();
  process.exit(args.help ? 0 : 1);
}

if (args.action === "list") {
  const data = await store.load();
  console.log(JSON.stringify({
    ok: true,
    hiddenPoemIds: data.hiddenPoemIds || [],
    bannedFids: data.bannedFids || [],
    recentActions: (data.moderationActions || []).slice(-25),
  }, null, 2));
  process.exit(0);
}

const result = await store.moderate({
  action: args.action,
  poemId: args.poemId || args.targetId,
  fid: args.fid || args.targetFid,
  reason: args.reason || "operator moderation",
  moderator: args.moderator || "opulentis-cli",
});

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);

function parseArgs(items) {
  const out = {};
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item === "--help" || item === "-h") out.help = true;
    else if (item.startsWith("--")) {
      const key = item.slice(2);
      out[key] = items[index + 1];
      index += 1;
    } else if (!out.action) {
      out.action = item;
    }
  }
  return out;
}

function printHelp() {
  console.log(`Poem Weaver moderation admin

Usage:
  node scripts/moderate-admin.mjs list
  node scripts/moderate-admin.mjs ban_fid --fid 123 --reason "spam"
  node scripts/moderate-admin.mjs unban_fid --fid 123 --reason "appeal accepted"
  node scripts/moderate-admin.mjs hide_poem --poemId random-abc --reason "abuse"
  node scripts/moderate-admin.mjs unhide_poem --poemId random-abc --reason "reviewed"

Uses DATABASE_URL/CHAIN_POEM_STORE_DRIVER when present, otherwise the local JSON store.`);
}

function loadLocalEnv() {
  const candidates = [".env.production.local", ".env.vercel-dev.local"];
  for (const file of candidates) {
    const path = join(process.cwd(), file);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const index = trimmed.indexOf("=");
      const key = trimmed.slice(0, index).trim();
      let value = trimmed.slice(index + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = value;
    }
  }
}
