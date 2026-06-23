export const MAX_LINES = 6;
export const MAX_LINE_LENGTH = 120;
export const MAX_TITLE_LENGTH = 52;
export const CONTRIBUTION_ROLES = ["opener", "bridge", "turn", "echo", "witness", "closer"];
export const LANES = [
  {
    id: "myth",
    name: "Myth",
    profileHints: ["myth", "lore", "story", "legend", "dream"],
    suggestions: ["the old signal woke beneath us", "a name returned wearing light", "we carried fire through the feed"],
    echoes: ["A second voice answered from the margin.", "The thread remembered what no one posted.", "By dusk, the omen had learned our names."],
  },
  {
    id: "memory",
    name: "Memory",
    profileHints: ["memory", "photo", "archive", "past", "family"],
    suggestions: ["i kept the door open for years", "the room still knows our voices", "some ghosts arrive as receipts"],
    echoes: ["Another keeper folded the timestamp gently.", "A quiet witness saved the missing color.", "The final line chose what to forgive."],
  },
  {
    id: "signal",
    name: "Signal",
    profileHints: ["signal", "caster", "network", "code", "builder"],
    suggestions: ["the feed blinked before the truth", "a small packet crossed the dark", "we tuned our names to static"],
    echoes: ["A nearby node heard the unfinished pulse.", "Someone translated the silence into weather.", "The channel closed only after it sang."],
  },
  {
    id: "market",
    name: "Market",
    profileHints: ["base", "token", "market", "trade", "defi", "bankr"],
    suggestions: ["liquidity dreamed in a blue room", "the candle learned to breathe", "we priced hope in tiny sparks"],
    echoes: ["Another hand found rhythm in the spread.", "The chart bent toward a human rumor.", "Profit was not the only thing compounding."],
  },
  {
    id: "machine",
    name: "Machine",
    profileHints: ["ai", "agent", "machine", "robot", "model", "code"],
    suggestions: ["the machine asked for a soul", "my agent left a candle running", "we taught the loop to wonder"],
    echoes: ["A synthetic witness softened the command.", "The model paused where the heart would be.", "The output became a doorway, not an answer."],
  },
  {
    id: "dream",
    name: "Dream",
    profileHints: ["art", "music", "poem", "dream", "night"],
    suggestions: ["the moon forgot our usernames", "i woke inside a borrowed color", "sleep spilled gold across the timeline"],
    echoes: ["A stranger carried the image one line farther.", "The room dissolved, but the rhythm stayed.", "Morning found the poem still spinning."],
  },
];

export function cleanText(value, max = MAX_LINE_LENGTH) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function getLane(value = "dream") {
  const id = cleanText(value, 24).toLowerCase();
  return LANES.find((lane) => lane.id === id || lane.name.toLowerCase() === id) || LANES[0];
}

export function pickLane(seed = "") {
  const key = cleanText(seed, 120) || `${Date.now()}`;
  const index = hashNumber(key) % LANES.length;
  return LANES[index];
}

export function inferLaneFromProfile(profile = {}) {
  const text = [
    profile.username,
    profile.displayName,
    profile.author,
    profile.profileSignal,
    profile.fid,
  ].filter(Boolean).join(" ").toLowerCase();
  for (const lane of LANES) {
    if (lane.profileHints.some((hint) => text.includes(hint))) return lane;
  }
  return pickLane(text);
}

export function getPhraseSuggestions(laneValue = "dream") {
  return [...getLane(laneValue).suggestions];
}

const HELD_NOTE = "Your trace is held in the dark. Real Farcaster co-weavers arrive when the live contribution queue opens.";
const PREVIEW_NOTE = "These companion lines are a deterministic preview of the weave's shape. Real Farcaster co-weavers will replace them when the live contribution queue opens.";

// Step 1 of the ritual: hold a single trace. No companion lines exist yet, so
// nothing fake is shown. The poem stays `open` until the weaver chooses to reveal.
export function sealTrace({ lane, phrase, contributor = null }) {
  const selected = getLane(lane);
  const safePhrase = cleanText(phrase);
  if (!safePhrase) throw new Error("phrase_required");
  const poem = createPoem({
    title: `${selected.name} weave`,
    theme: selected.id,
    firstLine: safePhrase,
    contributor,
  });
  poem.laneId = selected.id;
  poem.status = "open";
  poem.revealStatus = "held";
  poem.matchNote = HELD_NOTE;
  return poem;
}

// Number of companion voices a held trace is still waiting on.
export function pendingVoiceCount(poem) {
  const have = Array.isArray(poem?.lines) ? poem.lines.length : 0;
  return Math.max(0, MAX_LINES - have);
}

// Step 2 of the ritual: open the held trace into a full weave. Companion lines
// are the lane's deterministic preview echoes, clearly flagged as a preview.
export function revealWeave(poem) {
  if (!poem || !Array.isArray(poem.lines)) throw new Error("poem_required");
  const selected = getLane(poem.laneId || poem.theme);
  let next = structuredCloneSafe(poem);
  next.status = "open";
  for (const echo of selected.echoes) {
    if (next.lines.length >= MAX_LINES) break;
    next = addLine(next, echo, {
      author: "pending co-weaver",
      signal: "algorithmic-preview",
      contextSource: "preview-queue",
      verified: false,
    });
  }
  next = completePoem(next);
  next.laneId = selected.id;
  next.revealStatus = "preview";
  next.matchNote = PREVIEW_NOTE;
  return next;
}

// Backward-compatible one-shot seal+reveal (held trace immediately opened).
export function createBlindWeave({ lane, phrase, contributor = null }) {
  return revealWeave(sealTrace({ lane, phrase, contributor }));
}

export function createPoem({ title, theme, firstLine, author = "anonymous", contributor = null }) {
  const safeTitle = cleanText(title, MAX_TITLE_LENGTH) || "Untitled chain";
  const safeLine = cleanText(firstLine);
  if (!safeLine) throw new Error("first_line_required");
  const lineContributor = normalizeContributor(contributor || author, "starter");
  return {
    schemaVersion: 1,
    poemId: cryptoRandomId(),
    title: safeTitle,
    theme: cleanText(theme, 24) || "ritual",
    laneId: cleanText(theme, 24) || "ritual",
    status: "open",
    mintStatus: "none",
    revealStatus: "open",
    matchNote: "",
    createdAtUtc: new Date().toISOString(),
    updatedAtUtc: new Date().toISOString(),
    lines: [
      {
        text: safeLine,
        ...lineContributor,
        role: "opener",
        signal: lineContributor.signal,
        weaveWeight: getContributionWeight(0, lineContributor.signal),
        createdAtUtc: new Date().toISOString(),
      },
    ],
  };
}

export function addLine(poem, text, author = "anonymous") {
  if (!poem || !Array.isArray(poem.lines)) throw new Error("poem_required");
  if (poem.status === "complete") throw new Error("poem_complete");
  const safeLine = cleanText(text);
  if (!safeLine) throw new Error("line_required");
  if (poem.lines.length >= MAX_LINES) throw new Error("line_limit_reached");
  const next = structuredCloneSafe(poem);
  const lineContributor = normalizeContributor(author, "human");
  next.lines.push({
    text: safeLine,
    ...lineContributor,
    role: getContributionRole(next.lines.length),
    signal: lineContributor.signal,
    weaveWeight: getContributionWeight(next.lines.length, lineContributor.signal),
    createdAtUtc: new Date().toISOString(),
  });
  next.updatedAtUtc = new Date().toISOString();
  if (next.lines.length >= MAX_LINES) next.status = "complete";
  return next;
}

export function completePoem(poem) {
  if (!poem || !Array.isArray(poem.lines)) throw new Error("poem_required");
  const next = structuredCloneSafe(poem);
  if (next.lines.length === 0) throw new Error("empty_poem");
  next.lines = normalizeLines(next.lines);
  next.status = "complete";
  next.updatedAtUtc = new Date().toISOString();
  return next;
}

export function encodePoem(poem) {
  const slim = {
    schemaVersion: 1,
    poemId: poem.poemId,
    title: poem.title,
    theme: poem.theme,
    laneId: poem.laneId || poem.theme,
    status: poem.status,
    mintStatus: poem.mintStatus || "none",
    revealStatus: poem.revealStatus || "open",
    matchNote: poem.matchNote || "",
    lines: poem.lines || [],
  };
  const json = JSON.stringify(slim);
  return toBase64Url(unescape(encodeURIComponent(json)));
}

export function decodePoem(payload) {
  if (!payload) return null;
  const json = decodeURIComponent(escape(fromBase64Url(payload)));
  const parsed = JSON.parse(json);
  if (!parsed || !Array.isArray(parsed.lines)) throw new Error("invalid_poem_payload");
  return {
    schemaVersion: 1,
    poemId: cleanText(parsed.poemId, 64) || cryptoRandomId(),
    title: cleanText(parsed.title, MAX_TITLE_LENGTH) || "Untitled chain",
    theme: cleanText(parsed.theme, 24) || "ritual",
    laneId: cleanText(parsed.laneId, 24) || cleanText(parsed.theme, 24) || "ritual",
    status: parsed.status === "complete" ? "complete" : "open",
    mintStatus: parsed.mintStatus === "minted" ? "minted" : "none",
    revealStatus: cleanText(parsed.revealStatus, 24) || "open",
    matchNote: cleanText(parsed.matchNote, 180),
    createdAtUtc: parsed.createdAtUtc || new Date().toISOString(),
    updatedAtUtc: new Date().toISOString(),
    lines: normalizeLines(parsed.lines.slice(0, MAX_LINES).map((line) => ({
      text: cleanText(line.text),
      author: cleanText(line.author, 42) || "anonymous",
      fid: cleanText(line.fid, 20),
      username: cleanText(line.username, 32),
      displayName: cleanText(line.displayName, 42),
      pfpUrl: cleanText(line.pfpUrl, 240),
      contextSource: cleanText(line.contextSource, 32),
      verified: line.verified === true,
      profileSignal: cleanText(line.profileSignal, 48),
      onchainSignal: cleanText(line.onchainSignal, 48),
      role: cleanText(line.role, 24),
      signal: cleanText(line.signal, 32) || "human",
      weaveWeight: Number(line.weaveWeight || 0),
      createdAtUtc: line.createdAtUtc || new Date().toISOString(),
    })).filter((line) => line.text)),
  };
}

export function getWeaveMap(poem) {
  return normalizeLines(poem?.lines || []).map((line, index) => ({
    index,
    text: line.text,
    author: line.author,
    fid: line.fid || "",
    username: line.username || "",
    displayName: line.displayName || "",
    contextSource: line.contextSource || "",
    verified: line.verified === true,
    profileSignal: line.profileSignal || "",
    onchainSignal: line.onchainSignal || "",
    role: line.role,
    signal: line.signal,
    weaveWeight: line.weaveWeight,
  }));
}

export function getShareText(poem) {
  const title = poem?.title || "Untitled chain";
  const complete = poem?.status === "complete";
  const lines = Array.isArray(poem?.lines) ? poem.lines : [];
  const preview = lines.map((line) => line.text).slice(0, 4).join("\n");
  const call = poem?.revealStatus === "preview"
    ? "A trace opened into a preview weave. Real co-weavers arrive with the live queue."
    : complete
      ? "A chain poem finished on Farcaster."
      : "A trace is waiting for the others.";
  return `${title}\n\n${preview}\n\n${call}`;
}

function normalizeLines(lines) {
  return (lines || []).slice(0, MAX_LINES).map((line, index) => {
    const signal = cleanText(line.signal, 32) || (index === 0 ? "starter" : "human");
    const contributor = normalizeContributor(line, signal);
    return {
      ...line,
      ...contributor,
      role: CONTRIBUTION_ROLES.includes(line.role) ? line.role : getContributionRole(index),
      signal: contributor.signal,
      weaveWeight: getContributionWeight(index, contributor.signal),
    };
  });
}

function normalizeContributor(value, fallbackSignal = "human") {
  if (typeof value === "string") {
    return {
      author: cleanText(value, 42) || "anonymous",
      fid: "",
      username: "",
      displayName: "",
      pfpUrl: "",
      contextSource: "",
      verified: false,
      profileSignal: "",
      onchainSignal: "",
      signal: cleanText(fallbackSignal, 32) || "human",
    };
  }

  const raw = value && typeof value === "object" ? value : {};
  const username = cleanText(raw.username, 32);
  const displayName = cleanText(raw.displayName, 42);
  const author = cleanText(raw.author || displayName || (username ? `@${username}` : ""), 42) || "anonymous";
  const contextSource = cleanText(raw.contextSource, 32);
  const signal = cleanText(raw.signal, 32) || (contextSource ? "farcaster-context" : cleanText(fallbackSignal, 32) || "human");
  return {
    author,
    fid: cleanText(raw.fid, 20),
    username,
    displayName,
    pfpUrl: cleanText(raw.pfpUrl, 240),
    contextSource,
    verified: raw.verified === true,
    profileSignal: cleanText(raw.profileSignal, 48),
    onchainSignal: cleanText(raw.onchainSignal, 48),
    signal,
  };
}

function getContributionRole(index) {
  if (index >= MAX_LINES - 1) return "closer";
  return CONTRIBUTION_ROLES[index] || "witness";
}

function getContributionWeight(index, signal = "human") {
  const base = 10 + index * 3;
  const role = getContributionRole(index);
  const roleBoost = role === "opener" ? 4 : role === "closer" ? 13 : role === "witness" ? 7 : 0;
  const safeSignal = cleanText(signal, 32);
  const signalBoost = safeSignal === "starter" ? 1 : safeSignal === "farcaster-context" ? 3 : safeSignal === "verified-farcaster" ? 4 : safeSignal === "onchain-context" ? 5 : 0;
  return base + roleBoost + signalBoost;
}

function hashNumber(value) {
  let hash = 0;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function cryptoRandomId() {
  const bytes = new Uint8Array(8);
  globalThis.crypto?.getRandomValues?.(bytes);
  if (!bytes.some(Boolean)) return `poem-${Date.now().toString(36)}`;
  return `poem-${Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function structuredCloneSafe(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function toBase64Url(value) {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return atob(padded);
}
