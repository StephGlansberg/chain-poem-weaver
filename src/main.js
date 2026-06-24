import {
  decodePoem,
  encodePoem,
  getShareText,
  getWeaveMap,
  inferLaneFromProfile,
  pickLane,
  revealWeave,
  sealTrace,
} from "./poem.js";

const STORAGE_KEY = "op.poemWeaver.weave";
const SHARE_LOG_KEY = "op.poemWeaver.shareAttempts";
const SIMULATION_LINES = [
  "a stranger bends the light toward us",
  "the room remembers a second voice",
  "something small becomes a door",
  "we leave before the poem closes",
];

const state = {
  sdk: null,
  poem: null,
  viewer: null,
  provenance: null,
  spinning: false,
  animateReveal: false,
  view: "intro",
  // live: { trace, queue, mode } when a trace is sealed into the server queue.
  // null means the standalone-web preview path (no live matching).
  live: null,
  // Optional, dormant wallet binding: { address, signature, message }. Recorded
  // with the trace so a future receipt could settle to this address. Arms nothing.
  wallet: null,
  walletProviders: [],
};

const els = {
  weaveForm: document.querySelector("#weaveForm"),
  appTitle: document.querySelector("#appTitle"),
  introPanel: document.querySelector("#introPanel"),
  startButton: document.querySelector("#startButton"),
  whatPanel: document.querySelector("#whatPanel"),
  whatContinueButton: document.querySelector("#whatContinueButton"),
  inputHint: document.querySelector(".input-hint"),
  phraseInput: document.querySelector("#phraseInput"),
  charCount: document.querySelector("#charCount"),
  submitButton: document.querySelector("#submitButton"),
  spinPanel: document.querySelector("#spinPanel"),
  spinLabel: document.querySelector("#spinLabel"),
  shareButton: document.querySelector("#shareButton"),
  copyButton: document.querySelector("#copyButton"),
  resetButton: document.querySelector("#resetButton"),
  revealButton: document.querySelector("#revealButton"),
  verifyButton: document.querySelector("#verifyButton"),
  provenanceButton: document.querySelector("#provenanceButton"),
  provenancePanel: document.querySelector("#provenancePanel"),
  provenanceResult: document.querySelector("#provenanceResult"),
  provenanceHash: document.querySelector("#provenanceHash"),
  provenanceGate: document.querySelector("#provenanceGate"),
  receiptList: document.querySelector("#receiptList"),
  poemCard: document.querySelector("#poemCard"),
  actions: document.querySelector("#actions"),
  poemTitle: document.querySelector("#poemTitle"),
  poemTheme: document.querySelector("#poemTheme"),
  poemCount: document.querySelector("#poemCount"),
  lineList: document.querySelector("#lineList"),
  emptyState: document.querySelector("#emptyState"),
  heldHint: document.querySelector("#heldHint"),
  matchNote: document.querySelector("#matchNote"),
  waitPanel: document.querySelector("#waitPanel"),
  waitNeed: document.querySelector("#waitNeed"),
  statusText: document.querySelector("#statusText"),
  contextText: document.querySelector("#contextText"),
  walletButton: document.querySelector("#walletButton"),
  walletStatus: document.querySelector("#walletStatus"),
};

function isHeld(poem) {
  return Boolean(poem) && poem.revealStatus === "held";
}

function isRevealed(poem) {
  return Boolean(poem) && poem.revealStatus !== "held";
}

function isSimulation(poem) {
  return Boolean(poem) && poem.revealStatus === "simulation";
}

// The standalone-web deterministic preview (revealWeave) shows synthetic echo
// lines. It is never a real, finished weave — keep it labelled as a preview.
function isPreviewWeave(poem) {
  return Boolean(poem) && poem.revealStatus === "preview";
}

function hasFarcasterAuth() {
  return Boolean(state.sdk?.quickAuth && state.viewer);
}

// The live random-weave queue is only reachable from inside a Farcaster client
// with a signed-in viewer (Quick Auth signs each trace). Standalone web stays
// on the deterministic preview path.
function liveQueueAvailable() {
  return Boolean(state.sdk?.quickAuth && state.viewer);
}

function publicViewer() {
  if (!state.viewer) return {};
  return {
    username: state.viewer.username || "",
    displayName: state.viewer.displayName || "",
    author: state.viewer.author || "",
  };
}

// The dormant wallet binding only travels with the trace if the weaver opted in
// AND we are inside a Farcaster client with a verified viewer (so the fid the
// proof message is bound to is the same fid the server verifies).
function walletBindingPayload() {
  if (!state.wallet?.address || !liveQueueAvailable()) return {};
  return {
    recipientAddress: state.wallet.address,
    addressProofSignature: state.wallet.signature || "",
    addressProofMessage: state.wallet.message || "",
  };
}

// Connect the host (Farcaster) wallet and capture an EIP-191 personal_sign proof
// that this fid controls the address. Records intent only: no transaction, no
// mint. Uses the Mini App SDK's EIP-1193 provider; no extra dependency, no
// WalletConnect needed inside Farcaster.
async function linkWallet() {
  if (!liveQueueAvailable()) {
    setWalletStatus("Open this inside Farcaster to link a wallet.");
    return;
  }
  let provider;
  try {
    provider = await state.sdk.wallet.getEthereumProvider();
  } catch {
    provider = null;
  }
  if (!provider?.request) {
    setWalletStatus("No wallet is available in this client.");
    return;
  }
  try {
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    const address = String(accounts?.[0] || "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) {
      setWalletStatus("Could not read a wallet address.");
      return;
    }
    const fid = state.viewer?.fid || "";
    const message = buildWalletProofMessage(address, fid);
    let signature = "";
    try {
      signature = await provider.request({ method: "personal_sign", params: [message, address] });
    } catch {
      // Signing declined; still record the address because everything stays dormant.
      signature = "";
    }
    state.wallet = { address, signature, message };
    render();
    setWalletStatus("");
  } catch {
    setWalletStatus("Wallet linking was cancelled.");
  }
}

function buildWalletProofMessage(address, fid) {
  return [
    "Poem Weaver wallet binding",
    `domain:${window.location.hostname}`,
    `fid:${fid}`,
    `address:${String(address || "").toLowerCase()}`,
    "purpose:line-receipt-destination",
    "action:none",
  ].join("\n");
}

function setWalletStatus(text) {
  if (!els.walletStatus) return;
  els.walletStatus.textContent = text;
  els.walletStatus.hidden = !text;
}

function shortWalletAddress(address) {
  const value = String(address || "");
  if (!/^0x[0-9a-f]{40}$/i.test(value)) return "";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

async function linkWalletFromAnyProvider() {
  const provider = await getWalletProvider();
  if (!provider?.request) {
    setWalletStatus("No wallet found here. Open in Farcaster/Base or install a browser wallet.");
    return;
  }
  try {
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    const address = String(accounts?.[0] || "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) {
      setWalletStatus("Could not read a wallet address.");
      return;
    }
    const fid = state.viewer?.fid || "unverified-browser";
    const message = buildWalletProofMessage(address, fid);
    let signature = "";
    try {
      signature = await provider.request({ method: "personal_sign", params: [message, address] });
    } catch {
      signature = "";
    }
    state.wallet = { address, signature, message };
    render();
    setWalletStatus("");
  } catch {
    setWalletStatus("Wallet linking was cancelled.");
  }
}

async function getWalletProvider() {
  if (liveQueueAvailable() && state.sdk?.wallet?.getEthereumProvider) {
    try {
      const provider = await state.sdk.wallet.getEthereumProvider();
      if (provider?.request) return provider;
    } catch {
      // Fall through to injected browser wallet.
    }
  }
  const discovered = await discoverInjectedWalletProviders();
  const preferred = pickInjectedWalletProvider(discovered);
  if (preferred?.request) return preferred;
  const injectedList = pickInjectedWalletProvider(window.ethereum?.providers || []);
  if (injectedList?.request) return injectedList;
  if (window.ethereum?.request) return window.ethereum;
  return null;
}

async function discoverInjectedWalletProviders() {
  if (!window.dispatchEvent || !window.addEventListener) return [];
  const providers = new Map();
  const onAnnounce = (event) => {
    const detail = event?.detail || {};
    const provider = detail.provider;
    const rdns = String(detail.info?.rdns || detail.info?.uuid || "");
    if (provider?.request) providers.set(rdns || String(providers.size), { info: detail.info || {}, provider });
  };
  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  await wait(120);
  window.removeEventListener("eip6963:announceProvider", onAnnounce);
  state.walletProviders = [...providers.values()].map((entry) => ({
    name: entry.info?.name || providerName(entry.provider),
    rdns: entry.info?.rdns || "",
  }));
  return [...providers.values()].map((entry) => entry.provider);
}

function pickInjectedWalletProvider(providers) {
  const list = providers.filter((provider) => provider?.request);
  return list.find((provider) => provider.isRabby) ||
    list.find((provider) => provider.isMetaMask) ||
    list[0] ||
    null;
}

function providerName(provider) {
  if (provider?.isRabby) return "Rabby";
  if (provider?.isMetaMask) return "MetaMask";
  return "wallet";
}

function walletButtonLabel() {
  if (state.wallet?.address) return shortWalletAddress(state.wallet.address);
  return liveQueueAvailable() ? "link wallet (optional)" : "connect wallet";
}

const RANDOM_WEAVE_TARGET = 5;

function currentTargetLines() {
  return Number(state.live?.queue?.targetLines) || RANDOM_WEAVE_TARGET;
}

function queueRemainingText(eligibleWaiting) {
  const have = Math.max(0, Number(eligibleWaiting) || 0);
  const needed = Math.max(0, currentTargetLines() - have);
  if (needed === 0) return "the weave is ready to form.";
  return `${needed} more ${needed === 1 ? "voice" : "voices"} needed.`;
}

// Step 1 (standalone web): hold a local trace and offer the deterministic preview.
function sealLocalPreview(phrase) {
  const contributor = getCurrentContributor("weaver");
  const inferredLane = state.viewer
    ? inferLaneFromProfile(state.viewer)
    : pickLane(`${phrase}:${Date.now()}`);
  state.poem = sealTrace({ lane: inferredLane.id, phrase, contributor });
  state.live = null;
  state.view = "thread";
  persistPoem({ push: true });
  els.phraseInput.value = "";
  setStatus("sealed. open the weave whenever you're ready, or leave it in the dark.");
}

// Step 1 (inside Farcaster): seal the trace into the real server queue. If five
// distinct verified voices were already waiting, the server returns a real,
// completed weave on the spot; otherwise the trace is held live.
async function sealIntoLiveQueue(phrase) {
  let result;
  try {
    const { token } = await state.sdk.quickAuth.getToken();
    const response = await fetch("/api/random-weave", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ line: phrase, viewer: publicViewer(), ...walletBindingPayload() }),
    });
    result = { status: response.status, ok: response.ok, body: await response.json() };
  } catch {
    // Network / no real Quick Auth client: never dead-end the ritual.
    setStatus("the live queue is unreachable right now; sealing a local trace instead.");
    sealLocalPreview(phrase);
    return;
  }

  if (!result.ok || !result.body?.ok) {
    const code = result.body?.error || "";
    if (result.status === 422) {
      // Content was rejected (moderation / empty): let the weaver edit it.
      setStatus(humanQueueError(code));
      state.view = "entry";
      els.phraseInput.value = phrase;
      return;
    }
    setStatus("the live queue is unreachable right now; sealing a local trace instead.");
    sealLocalPreview(phrase);
    return;
  }

  const body = result.body;
  els.phraseInput.value = "";

  if (body.status === "matched" && body.completion) {
    applyRealCompletion(body.completion, "your line met four strangers. the weave is real.");
    return;
  }

  // Held live: show the weaver's own line, then track real queue progress.
  const contributor = getCurrentContributor("weaver");
  const inferredLane = inferLaneFromProfile(state.viewer);
  state.poem = sealTrace({ lane: inferredLane.id, phrase, contributor });
  state.live = { trace: body.trace, queue: null, mode: "queued" };
  state.view = "thread";
  persistPoem({ push: true });
  setStatus(body.alreadyQueued ? "you already have a live line. wait for this weave to finish." : "sealed into the live queue. return to see whether the others arrive.");
  // Pull the current count so the held card reflects real queue state.
  await refreshLiveQueue();
}

// GET the queue: detect a match for our trace, or refresh the waiting count.
async function refreshLiveQueue({ announce = false } = {}) {
  if (!state.live?.trace || !state.sdk?.quickAuth) return;
  let body;
  try {
    const { token } = await state.sdk.quickAuth.getToken();
    const response = await fetch("/api/random-weave", {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    body = await response.json();
    if (!response.ok || !body?.ok) throw new Error("queue_unavailable");
  } catch {
    if (announce) setStatus("could not reach the live queue; try again in a moment.");
    return;
  }

  const myTrace = (body.traces || []).find((trace) => trace.traceId === state.live.trace.traceId);
  const matchedPoemId = myTrace?.matchedPoemId || state.live.trace.matchedPoemId;
  if (matchedPoemId) {
    const completion = (body.poems || []).find((poem) => poem.poemId === matchedPoemId);
    if (completion) {
      applyRealCompletion(completion, "the others arrived. your weave is real.");
      return;
    }
  }

  state.live.queue = {
    eligibleWaiting: Number(body.queue?.eligibleWaiting) || 0,
    targetLines: Number(body.queue?.targetLines) || RANDOM_WEAVE_TARGET,
  };
  if (announce) {
    setStatus(`still gathering: ${queueRemainingText(state.live.queue.eligibleWaiting)} come back soon.`);
  }
  render();
}

// Turn a server completion record into a renderable, real (non-preview) weave,
// and surface the server-computed provenance the same moment.
function applyRealCompletion(completion, message) {
  state.poem = poemFromCompletion(completion);
  state.provenance = provenanceFromCompletion(completion);
  state.live = { trace: state.live?.trace || null, queue: null, mode: "matched", poemId: completion.poemId };
  state.animateReveal = true;
  state.view = "thread";
  persistPoem();
  renderProvenanceResult(state.provenance);
  const shortHash = String(completion.poemHash || "").slice(0, 26);
  const receiptCount = completion.lineReceiptClaims?.length || 0;
  setContext(`Provenance sealed by the server: ${shortHash}… ${receiptCount} line NFT receipts planned. Minting remains disabled.`);
  setStatus(message);
  render();
}

function poemFromCompletion(completion) {
  const canonical = completion.canonicalPoem || {};
  return {
    schemaVersion: 1,
    poemId: canonical.poemId || completion.poemId,
    title: canonical.title || "Random weave",
    theme: canonical.theme || "dream",
    laneId: canonical.theme || "dream",
    status: "complete",
    mintStatus: "none",
    revealStatus: "real-weave",
    matchNote: canonical.matchNote || "Five verified Farcaster traces were randomly matched into this weave.",
    lines: (canonical.lines || []).map((line) => ({ ...line })),
  };
}

function simulateCompletedWeave() {
  const now = new Date().toISOString();
  const source = state.poem?.lines?.[0] || {
    text: "a small line waits",
    author: "weaver",
    signal: "simulation",
    verified: false,
  };
  const seed = `${source.text}:${state.poem?.poemId || now}`;
  const picked = rotateSimulationLines(seed).slice(0, RANDOM_WEAVE_TARGET - 1);
  const roles = ["opener", "bridge", "turn", "witness", "closer"];
  state.poem = {
    schemaVersion: 1,
    poemId: `sim-${Date.now().toString(36)}`,
    title: "Simulated weave",
    theme: state.poem?.theme || "dream",
    laneId: state.poem?.laneId || state.poem?.theme || "dream",
    status: "complete",
    mintStatus: "none",
    revealStatus: "simulation",
    matchNote: "Simulation only: five voices are shown so the ritual can be tested before the live queue fills.",
    createdAtUtc: now,
    updatedAtUtc: now,
    lines: [
      {
        ...source,
        text: source.text || "a small line waits",
        role: roles[0],
        signal: source.signal || "simulation",
        createdAtUtc: source.createdAtUtc || now,
      },
      ...picked.map((text, index) => ({
        text,
        author: `simulated voice ${index + 2}`,
        fid: "",
        username: "",
        displayName: "",
        pfpUrl: "",
        contextSource: "simulation",
        verified: false,
        profileSignal: "",
        onchainSignal: "",
        signal: "simulation",
        role: roles[index + 1],
        createdAtUtc: now,
      })),
    ],
  };
  state.live = null;
  state.provenance = null;
  state.animateReveal = true;
  state.view = "thread";
  persistPoem({ push: true });
  renderProvenanceResult(null);
  setStatus("simulation opened. real Farcaster receipts stay locked to real lines.");
  setContext("Simulation only. Real provenance unlocks after a live Farcaster weave completes.");
  render();
}

function rotateSimulationLines(seed) {
  const offset = Math.abs(hashString(seed)) % SIMULATION_LINES.length;
  return SIMULATION_LINES.slice(offset).concat(SIMULATION_LINES.slice(0, offset));
}

function provenanceFromCompletion(completion) {
  const lines = completion.canonicalPoem?.lines || [];
  return {
    poemHash: completion.poemHash,
    lineReceiptMintPlan: {
      standard: "ERC-1155",
      receipts: (completion.lineReceiptClaims || []).map((claim) => ({
        claimKey: claim.claimKey,
        recipientHint: claim.contributor || {},
        metadata: { role: lines[claim.lineIndex]?.role || "line" },
      })),
    },
  };
}

async function loadSdk() {
  try {
    const mod = await import("https://esm.sh/@farcaster/miniapp-sdk");
    state.sdk = mod.sdk;
    await state.sdk.actions.ready();
    const context = await Promise.resolve(state.sdk.context);
    state.viewer = normalizeFarcasterUser(context?.user);
    if (state.viewer) {
      // inferLaneFromProfile shapes the hidden lane from opt-in context only.
      inferLaneFromProfile(state.viewer);
      setContext(`Signed in as ${state.viewer.author}. Verify your session to seal each line.`);
    }
  } catch {
    // No Farcaster context detected: run as a standard web app, on-chain
    // features stay dormant and their controls are hidden (never dead).
    state.sdk = null;
  }
  render();
}

function loadInitialPoem() {
  const params = readPoemParams();
  const payload = params.get("poem");
  if (payload) {
    try {
      state.poem = decodePoem(payload);
      state.view = "thread";
      persistPoem();
      return;
    } catch {
      setStatus("This shared weave could not be read.");
    }
  }

  state.poem = null;
  state.view = params.get("view") === "entry" ? "entry" : params.get("view") === "what" ? "what" : "intro";
}

function persistPoem({ push = false } = {}) {
  if (!state.poem) return;
  const payload = encodePoem(state.poem);
  localStorage.setItem(STORAGE_KEY, payload);
  const url = `#view=${encodeURIComponent(state.view)}&poem=${payload}`;
  if (push) {
    window.history.pushState({ view: state.view }, "", url);
  } else {
    window.history.replaceState({ view: state.view }, "", url);
  }
}

function readPoemParams() {
  const query = new URLSearchParams(window.location.search.replace(/^\?/, ""));
  if (query.get("poem")) return query;
  return new URLSearchParams(window.location.hash.replace(/^#/, ""));
}

function buildPoemShareUrl(poem = state.poem) {
  const url = new URL(window.location.href);
  url.hash = "";
  url.search = "";
  url.searchParams.set("view", "thread");
  if (poem) {
    url.searchParams.set("poem", encodePoem(poem));
    if (poem.poemId) url.searchParams.set("poemId", poem.poemId);
    if (state.provenance?.poemHash) url.searchParams.set("poemHash", state.provenance.poemHash);
  }
  return url.toString();
}

function buildInviteShareUrl() {
  const url = new URL(window.location.href);
  url.hash = "";
  url.search = "";
  url.searchParams.set("view", "entry");
  url.searchParams.set("invite", "weave");
  if (state.live?.trace?.traceId) url.searchParams.set("trace", state.live.trace.traceId);
  return url.toString();
}

function buildCurrentShareUrl() {
  return isHeld(state.poem) ? buildInviteShareUrl() : buildPoemShareUrl(state.poem);
}

function getCurrentShareText() {
  if (isHeld(state.poem)) {
    return "I left a line in Poem Weaver. Add one small phrase and help finish it.";
  }
  if (isSimulation(state.poem)) {
    return "I am testing Poem Weaver: one line enters, five voices become a poem.";
  }
  return getShareText(state.poem);
}

function buildComposerUrl(text, shareUrl) {
  const url = new URL("https://farcaster.xyz/~/compose");
  url.searchParams.set("text", text);
  url.searchParams.set("embeds[]", shareUrl);
  return url.toString();
}

async function openShareFallback(text, shareUrl) {
  const composerUrl = buildComposerUrl(text, shareUrl);
  if (state.sdk?.actions?.openUrl) {
    try {
      await state.sdk.actions.openUrl(composerUrl);
      setStatus("composer opened. post the cast to share it.");
      return;
    } catch {
      // Fall through to the browser window fallback.
    }
  }
  window.open(composerUrl, "_blank", "noopener,noreferrer");
  setStatus("composer opened. post the cast to share it.");
}

function noteShareAttempt(kind, url) {
  try {
    const previous = JSON.parse(localStorage.getItem(SHARE_LOG_KEY) || "[]");
    const next = Array.isArray(previous) ? previous.slice(-24) : [];
    next.push({
      kind,
      url,
      poemId: state.poem?.poemId || "",
      held: isHeld(state.poem),
      createdAtUtc: new Date().toISOString(),
    });
    localStorage.setItem(SHARE_LOG_KEY, JSON.stringify(next));
  } catch {
    // Local note only; sharing must never fail because this could not be stored.
  }
}

function render() {
  const poem = state.poem;
  const hasPoem = Boolean(poem);
  const onThread = hasPoem && state.view === "thread";
  const onIntro = !hasPoem && state.view === "intro";
  const onWhat = !hasPoem && state.view === "what";
  const onEntry = !hasPoem && state.view === "entry";
  const held = isHeld(poem);
  const revealed = isRevealed(poem);
  const simulated = isSimulation(poem);
  const farcaster = hasFarcasterAuth();

  document.body.classList.toggle("has-poem", hasPoem);
  document.body.classList.toggle("is-held", held);
  document.body.classList.toggle("thread-view", onThread);
  document.body.classList.toggle("intro-view", onIntro);
  document.body.classList.toggle("what-view", onWhat);
  document.body.classList.toggle("entry-view", onEntry);

  if (els.appTitle) {
    els.appTitle.textContent = onThread
      ? held
        ? "the unseen thread"
        : "the weave opened"
      : onWhat
        ? "what is this?"
      : "leave a trace";
  }

  if (els.introPanel) els.introPanel.hidden = !onIntro;
  if (els.whatPanel) els.whatPanel.hidden = !onWhat;
  if (els.inputHint) els.inputHint.hidden = !onEntry;
  els.weaveForm.hidden = !onEntry || state.spinning;
  els.spinPanel.hidden = !state.spinning;
  els.poemCard.hidden = !onThread || state.spinning;
  els.revealButton.hidden = !onThread || !held || state.spinning;
  els.actions.hidden = !onThread || state.spinning;
  els.statusText.hidden = onIntro;

  // Provenance / NFT only appears once there is a weave to keep, and every
  // control inside it is shown only when it can actually be used (no dead controls).
  els.provenancePanel.hidden = !onThread || !revealed || simulated || state.spinning;
  els.verifyButton.hidden = !revealed || !farcaster || state.viewer?.verified === true;
  els.provenanceButton.hidden =
    !revealed || !farcaster || state.viewer?.verified !== true || poem?.status !== "complete";
  els.provenanceResult.hidden = !state.provenance;

  if (els.contextText) {
    if (!farcaster) {
      setContext("Connect a browser wallet for preview, or open inside Farcaster/Base to bind a wallet to a verified line. Minting stays off.");
    } else if (state.provenance) {
      // keep the provenance summary already set
    } else if (state.viewer?.verified === true) {
      setContext(`Verified as ${state.viewer.author}. Seal provenance to plan a receipt for every line.`);
    } else {
      setContext(`Signed in as ${state.viewer.author}. Verify your session to seal each line.`);
    }
  }

  const hasPhrase = Boolean(els.phraseInput.value.trim());
  if (els.charCount) {
    els.charCount.hidden = !onEntry;
    const max = els.phraseInput.maxLength > 0 ? els.phraseInput.maxLength : 120;
    const remaining = max - els.phraseInput.value.length;
    els.charCount.textContent = String(remaining);
    els.charCount.classList.toggle("near-limit", remaining <= 24 && remaining > 8);
    els.charCount.classList.toggle("at-limit", remaining <= 8);
  }
  if (els.submitButton) {
    els.submitButton.hidden = !hasPhrase || state.spinning;
    els.submitButton.disabled = !hasPhrase || state.spinning;
  }

  // Optional wallet link appears early. Browser links stay preview-only until
  // Farcaster Quick Auth verifies a live line claim.
  if (els.walletButton) {
    els.walletButton.hidden = !(onIntro || onWhat || onEntry) || state.spinning;
    els.walletButton.textContent = walletButtonLabel();
    els.walletButton.classList.toggle("connected", Boolean(state.wallet?.address));
  }
  if (els.walletStatus && !(onIntro || onWhat || onEntry)) els.walletStatus.hidden = true;

  const liveHeld = held && Boolean(state.live);
  const previewWeave = isPreviewWeave(poem);
  const eligibleWaiting = state.live?.queue?.eligibleWaiting;
  const targetLines = currentTargetLines();

  els.poemTitle.textContent = held
    ? liveHeld
      ? "your line is in the weave"
      : "your line is held"
    : simulated
      ? "a simulated weave took shape"
      : previewWeave
      ? "a preview weave took shape"
      : revealed
      ? "a weave took shape"
      : "not revealed yet";
  els.poemTheme.textContent = "unseen thread";
  const lineCount = poem?.lines?.length || 0;
  const gathered = Math.min(targetLines, Math.max(1, Number(eligibleWaiting) || 1));
  els.poemCount.textContent = !hasPoem
    ? "waiting"
    : held
      ? liveHeld
        ? `${gathered} of ${targetLines} gathered`
        : `1 of ${targetLines} woven`
      : previewWeave
        ? `${lineCount} lines · preview`
        : `${lineCount} lines`;

  if (els.revealButton) {
    els.revealButton.textContent = liveHeld ? "check again" : "open the weave";
  }

  if (els.shareButton) els.shareButton.textContent = held ? "Share it" : "Share";
  if (els.copyButton) els.copyButton.textContent = held ? "Copy invite" : "Copy link";
  // "Simulate weave" is a developer affordance — keep it out of the live ritual.
  if (els.resetButton) els.resetButton.hidden = true;

  els.lineList.innerHTML = "";
  els.emptyState.hidden = lineCount > 0;
  // One atmospheric line carries the wait; the panel below carries the count.
  if (els.heldHint) els.heldHint.hidden = true;
  if (els.waitPanel) {
    els.waitPanel.hidden = !held;
    const needed = liveHeld && typeof eligibleWaiting === "number"
      ? Math.max(0, targetLines - (Number(eligibleWaiting) || 0))
      : Math.max(1, targetLines - lineCount);
    els.waitNeed.textContent = needed === 0
      ? "the weave is ready to open."
      : `${needed} more ${needed === 1 ? "voice" : "voices"} and it opens.`;
  }
  // Held screen stays quiet — no extra narration paragraph.
  els.matchNote.textContent = held ? "" : poem?.matchNote || "";

  const lines = getWeaveMap(poem);
  lines.forEach((line, index) => {
    const isPreview = line.contextSource === "preview-queue";
    const item = document.createElement("li");
    if (isPreview) item.classList.add("is-preview");
    const text = document.createElement("span");
    const author = document.createElement("small");
    text.textContent = line.text;
    author.textContent = held
      ? "your line"
      : isPreview
        ? "waiting for a voice"
        : formatContributor(line);
    if (state.animateReveal) {
      item.classList.add("rise-in");
      item.style.animationDelay = `${index * 130}ms`;
    }
    item.append(text, author);
    els.lineList.append(item);
  });
  state.animateReveal = false;
}

function setStatus(message) {
  els.statusText.textContent = message;
}

function setContext(message) {
  if (els.contextText) els.contextText.textContent = message;
}

function setSpinLabel(message) {
  if (els.spinLabel) els.spinLabel.textContent = message;
}

function renderProvenanceResult(provenance) {
  if (!provenance) {
    els.provenanceResult.hidden = true;
    return;
  }
  els.provenanceHash.textContent = provenance.poemHash || "-";
  els.receiptList.innerHTML = "";
  const receipts = provenance.lineReceiptMintPlan?.receipts || [];
  receipts.forEach((receipt, index) => {
    const item = document.createElement("li");
    const line = document.createElement("span");
    const meta = document.createElement("span");
    line.className = "receipt-line";
    meta.className = "receipt-meta";
    const hint = receipt.recipientHint || {};
    const who = hint.username ? `@${hint.username}` : hint.fid ? `fid:${hint.fid}` : hint.author || "anonymous";
    line.textContent = `line ${index + 1} · ${who}`;
    meta.textContent = `${receipt.metadata?.role || "line"} · receipt planned`;
    item.append(line, meta);
    els.receiptList.append(item);
  });
  const standard = provenance.lineReceiptMintPlan?.standard || "ERC-1155";
  els.provenanceGate.textContent = `Minting stays disabled (${standard} on Base). It opens only after an operator approves it.`;
  els.provenanceResult.hidden = false;
}

els.startButton.addEventListener("click", () => {
  state.view = "what";
  state.poem = null;
  state.provenance = null;
  state.live = null;
  state.animateReveal = false;
  window.history.pushState({ view: "what" }, "", "#view=what");
  render();
  setStatus("waiting");
});

els.whatContinueButton.addEventListener("click", () => {
  state.view = "entry";
  state.poem = null;
  state.provenance = null;
  state.live = null;
  state.animateReveal = false;
  window.history.pushState({ view: "entry" }, "", "#view=entry");
  render();
  setStatus("waiting");
  requestAnimationFrame(() => els.phraseInput.focus());
});

els.phraseInput.addEventListener("input", () => {
  setStatus(els.phraseInput.value.trim() ? "ready when you are" : "waiting");
  render();
});

els.weaveForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const phrase = els.phraseInput.value;
  if (!phrase.trim()) {
    setStatus("Type one small thing first.");
    return;
  }
  state.spinning = true;
  state.provenance = null;
  state.live = null;
  setSpinLabel(liveQueueAvailable() ? "sealing into the live queue" : "sealing your trace");
  render();
  await wait(850);
  try {
    if (liveQueueAvailable()) {
      await sealIntoLiveQueue(phrase);
    } else {
      sealLocalPreview(phrase);
    }
  } catch (error) {
    setStatus(humanError(error));
  } finally {
    state.spinning = false;
    render();
  }
});

els.revealButton.addEventListener("click", async () => {
  if (!isHeld(state.poem)) return;
  const live = Boolean(state.live);
  state.spinning = true;
  setSpinLabel(live ? "looking for the others" : "finding the others");
  render();
  await wait(live ? 700 : 1100);
  try {
    if (live) {
      // Real path: ask the server whether our trace has been matched yet.
      await refreshLiveQueue({ announce: true });
    } else {
      // Standalone-web path: deterministic preview, clearly flagged as a preview.
      state.poem = revealWeave(state.poem);
      state.animateReveal = true;
      persistPoem();
      setStatus("a preview of the shape. real voices replace these when the live queue opens.");
    }
  } catch (error) {
    setStatus(humanError(error));
  } finally {
    state.spinning = false;
    render();
  }
});

els.shareButton.addEventListener("click", async () => {
  if (!state.poem) {
    setStatus("Open a weave before sharing.");
    return;
  }
  persistPoem();
  const text = getCurrentShareText();
  const shareUrl = buildCurrentShareUrl();
  noteShareAttempt("compose", shareUrl);
  if (state.sdk?.actions?.composeCast) {
    try {
      const result = await state.sdk.actions.composeCast({ text, embeds: [shareUrl], close: false });
      if (result?.cast) {
        noteShareAttempt("cast-posted", shareUrl);
        setStatus("cast posted. the weave is moving.");
      } else {
        noteShareAttempt("cast-cancelled", shareUrl);
        setStatus("cast cancelled. invite link still ready.");
      }
      return;
    } catch {
      noteShareAttempt("compose-fallback", shareUrl);
    }
  }
  await openShareFallback(text, shareUrl);
});

els.copyButton.addEventListener("click", async () => {
  if (!state.poem) {
    setStatus("Open a weave before copying.");
    return;
  }
  persistPoem();
  const shareUrl = buildCurrentShareUrl();
  noteShareAttempt("copy", shareUrl);
  try {
    await navigator.clipboard?.writeText(shareUrl);
    setStatus(isHeld(state.poem) ? "invite copied. send it to four people." : "link copied. send it into the dark.");
  } catch {
    setStatus("Could not copy the link in this context.");
  }
});

els.resetButton.addEventListener("click", () => {
  simulateCompletedWeave();
});

els.provenanceButton.addEventListener("click", async () => {
  if (!state.poem || state.poem.status !== "complete") {
    setContext("Open the weave before sealing provenance.");
    return;
  }
  if (!state.sdk?.quickAuth || !state.viewer) {
    setContext("Farcaster Quick Auth is required before sealing provenance.");
    return;
  }
  try {
    const { token } = await state.sdk.quickAuth.getToken();
    const response = await fetch("/api/provenance", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      cache: "no-store",
      body: JSON.stringify({ poem: state.poem }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok || !result.provenance?.poemHash) {
      setContext("Server provenance could not be created.");
      return;
    }
    state.provenance = result.provenance;
    renderProvenanceResult(result.provenance);
    const shortHash = result.provenance.poemHash.slice(0, 20);
    const receiptCount = result.provenance.lineReceiptMintPlan?.receipts?.length || 0;
    setContext(`Provenance sealed: ${shortHash}… ${receiptCount} line NFT receipts planned. Minting remains disabled.`);
    render();
  } catch {
    setContext("Server provenance request failed.");
  }
});

if (els.walletButton) {
  els.walletButton.addEventListener("click", () => {
    linkWalletFromAnyProvider();
  });
}

els.verifyButton.addEventListener("click", async () => {
  if (!state.sdk?.quickAuth || !state.viewer) {
    setContext("Farcaster Quick Auth is not available in this context.");
    return;
  }
  try {
    const { token } = await state.sdk.quickAuth.getToken();
    const response = await fetch("/api/me", {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    const result = await response.json();
    if (!response.ok || !result.verified) {
      setContext("Farcaster session could not be verified by the server.");
      return;
    }
    state.viewer = {
      ...state.viewer,
      fid: cleanClientText(result.fid, 20),
      verified: true,
      signal: "verified-farcaster",
    };
    render();
    setContext(`Verified as ${state.viewer.author}. Seal provenance to plan a receipt for every line.`);
  } catch {
    setContext("Farcaster session verification failed.");
  }
});

loadInitialPoem();
render();
loadSdk();

window.addEventListener("popstate", () => {
  const params = readPoemParams();
  const payload = params.get("poem");
  state.provenance = null;
  state.live = null;
  state.animateReveal = false;
  renderProvenanceResult(null);
  if (params.get("view") === "entry" && !payload) {
    state.view = "entry";
    state.poem = null;
    render();
    setStatus("waiting");
    return;
  }
  if (params.get("view") === "what" && !payload) {
    state.view = "what";
    state.poem = null;
    render();
    setStatus("waiting");
    return;
  }
  if (!payload) {
    state.view = "intro";
    state.poem = null;
    render();
    setStatus("waiting");
    return;
  }
  try {
    state.poem = decodePoem(payload);
    state.view = "thread";
    render();
  } catch {
    state.view = "entry";
    state.poem = null;
    render();
    setStatus("This shared weave could not be read.");
  }
});

function normalizeFarcasterUser(user) {
  if (!user) return null;
  const username = cleanClientText(user.username, 32);
  const displayName = cleanClientText(user.displayName, 42);
  const fid = cleanClientText(user.fid, 20);
  const author = displayName || (username ? `@${username}` : fid ? `fid:${fid}` : "");
  if (!author) return null;
  return {
    author,
    fid,
    username,
    displayName,
    pfpUrl: cleanClientText(user.pfpUrl, 240),
    contextSource: "farcaster-context",
    verified: false,
    profileSignal: username ? `@${username}` : fid ? `fid:${fid}` : "",
    onchainSignal: "",
    signal: "farcaster-context",
  };
}

function getCurrentContributor(fallbackSignal) {
  if (!state.viewer) {
    return {
      author: "weaver",
      signal: fallbackSignal,
      verified: false,
    };
  }
  return { ...state.viewer, signal: state.viewer.signal || fallbackSignal };
}

function formatContributor(line) {
  if (line.username) return `@${line.username}`;
  if (line.displayName) return line.displayName;
  if (line.fid) return `fid:${line.fid}`;
  return line.author || "you";
}

function humanError(error) {
  const code = String(error?.message || "");
  if (code === "phrase_required" || code === "first_line_required") return "Type one small thing first.";
  if (code === "line_limit_reached") return "This weave is already full.";
  return "Something interrupted the ritual. Try again.";
}

function humanQueueError(code) {
  if (code === "line_required") return "Type one small thing first.";
  if (code === "links_not_allowed") return "Links can't be woven in; try words only.";
  if (code === "unsafe_financial_or_wallet_language") return "That line reads like a pitch. Keep it human.";
  if (code === "verified_fid_required") return "Your Farcaster session couldn't be verified; reopen and try again.";
  return "That line couldn't enter the live queue. Try a different one.";
}

function cleanClientText(value, max) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashString(value) {
  let hash = 0;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0;
  }
  return hash;
}
