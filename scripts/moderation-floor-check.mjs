import {
  addTraceToStore,
  completeNextRandomWeave,
  createTrace,
  RANDOM_WEAVE_TARGET_LINES,
  selectEligibleTraces,
} from "../api/random-weave.mjs";
import { applyModerationAction, createEmptyQueueStore, moderationState } from "../api/queue-store.mjs";

const failures = [];
const store = createEmptyQueueStore();
const baseTime = new Date("2026-06-16T08:00:00.000Z");

for (let index = 0; index < RANDOM_WEAVE_TARGET_LINES; index += 1) {
  const trace = createTrace({
    line: `moderation line ${index + 1}`,
    auth: { fid: String(7000 + index) },
    clientContext: { username: `modweaver${index}` },
    now: new Date(baseTime.getTime() + index * 1000),
  });
  if (!trace.ok) failures.push(`trace_create_failed:${index}:${trace.error}`);
  else addTraceToStore(store, trace.trace);
}

const ban = applyModerationAction(store, {
  action: "ban_fid",
  fid: "7000",
  reason: "private test moderation floor",
  moderator: "opulentis-test",
}, new Date("2026-06-16T08:05:00.000Z"));
if (!ban.ok) failures.push(`ban_action_failed:${ban.error}`);
if (!moderationState(store).bannedFids.includes("7000")) failures.push("banned_fid_not_derived");
if (store.traces.find((trace) => trace.fid === "7000")?.status !== "moderation_blocked") {
  failures.push("banned_existing_trace_not_blocked");
}
if (selectEligibleTraces(store).some((trace) => trace.fid === "7000")) failures.push("banned_fid_still_eligible");

const replacement = createTrace({
  line: "replacement line after moderation",
  auth: { fid: "8000" },
  clientContext: { username: "replacement" },
  now: new Date("2026-06-16T08:06:00.000Z"),
});
if (!replacement.ok) failures.push(`replacement_trace_failed:${replacement.error}`);
else addTraceToStore(store, replacement.trace);

const completion = completeNextRandomWeave(store, {
  now: new Date("2026-06-16T08:10:00.000Z"),
  provenanceSecret: "moderation-floor-secret",
});
if (!completion) failures.push("completion_after_ban_not_created");

if (completion) {
  const hide = applyModerationAction(store, {
    action: "hide_poem",
    poemId: completion.poemId,
    reason: "manual hide capability proof",
    moderator: "opulentis-test",
  }, new Date("2026-06-16T08:11:00.000Z"));
  if (!hide.ok) failures.push(`hide_action_failed:${hide.error}`);
  if (!moderationState(store).hiddenPoemIds.includes(completion.poemId)) failures.push("hidden_poem_not_derived");
  const hiddenRecord = store.completedPoems.find((poem) => poem.poemId === completion.poemId);
  if (hiddenRecord?.moderationStatus !== "hidden") failures.push("hidden_poem_status_not_set");

  const unhide = applyModerationAction(store, {
    action: "unhide_poem",
    poemId: completion.poemId,
    reason: "restore after proof",
    moderator: "opulentis-test",
  }, new Date("2026-06-16T08:12:00.000Z"));
  if (!unhide.ok) failures.push(`unhide_action_failed:${unhide.error}`);
  if (moderationState(store).hiddenPoemIds.includes(completion.poemId)) failures.push("unhidden_poem_still_hidden");
}

const bad = applyModerationAction(store, { action: "hide_poem" }, baseTime);
if (bad.ok || bad.error !== "poem_id_required") failures.push("invalid_hide_not_rejected");

const result = {
  ok: failures.length === 0,
  generatedAtUtc: new Date().toISOString(),
  checked: "moderation-floor",
  capabilities: {
    banFid: true,
    hidePoem: true,
    actionLog: true,
    bannedFidsBlockQueue: true,
  },
  failures,
};
console.log(JSON.stringify(result, null, 2));
if (failures.length) process.exit(1);
