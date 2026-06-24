import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..");
const mainPath = join(root, "src", "main.js");
const apiPath = join(root, "api", "random-weave.mjs");
const indexPath = join(root, "index.html");
const cssPath = join(root, "src", "styles.css");
const failures = [];

const main = existsSync(mainPath) ? readFileSync(mainPath, "utf8") : "";
const api = existsSync(apiPath) ? readFileSync(apiPath, "utf8") : "";
const index = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
const css = existsSync(cssPath) ? readFileSync(cssPath, "utf8") : "";

check("main_exists", Boolean(main));
check("api_exists", Boolean(api));
check("index_exists", Boolean(index));
check("css_exists", Boolean(css));

// Live queue must require Farcaster Quick Auth and never replace the standalone
// preview path. The preview remains local/offchain; the live queue is server-only.
check("live_queue_available_requires_quick_auth", /function liveQueueAvailable\(\)[\s\S]*quickAuth[\s\S]*state\.viewer/.test(main));
check("seal_live_uses_quick_auth_token", /quickAuth\.getToken\(\)[\s\S]*fetch\("\/api\/random-weave"/.test(main));
check("seal_live_posts_line_to_queue", /method:\s*"POST"[\s\S]*body:\s*JSON\.stringify\(\{\s*line:\s*phrase/.test(main));
check("standalone_preview_path_preserved", main.includes("sealLocalPreview(phrase)") && main.includes("revealWeave(state.poem)"));
check("api_unreachable_falls_back_to_preview", countMatches(main, /sealLocalPreview\(phrase\)/g) >= 2);

// Held traces should show real queue progress, not the original hardcoded
// preview count, when a server trace is present.
check("eligible_waiting_read_from_get_queue", main.includes("eligibleWaiting: Number(body.queue?.eligibleWaiting)"));
check("held_card_uses_live_count", main.includes("`${gathered} of ${targetLines} gathered`"));
check("remaining_voice_hint_present", main.includes("queueRemainingText(eligibleWaiting)"));
check("reveal_button_relabels_for_live_queue", main.includes('"check again"'));

// Completed poems returned by the queue should render as real server weaves
// and expose server-computed provenance without a second provenance request.
check("post_completion_applies_real_completion", main.includes('body.status === "matched"') && main.includes("applyRealCompletion(body.completion"));
check("get_completion_applies_real_completion", main.includes("matchedPoemId") && main.includes("applyRealCompletion(completion"));
check("real_completion_is_non_preview", /revealStatus:\s*"real-weave"/.test(main));
check("server_completion_context_message", main.includes("Five verified Farcaster traces") || main.includes("canonical.matchNote"));
check("completion_maps_provenance", main.includes("provenanceFromCompletion(completion)") && main.includes("lineReceiptClaims"));
check("completion_renders_provenance_immediately", /renderProvenanceResult\(state\.provenance\)/.test(main));
const shareUrlUsesQueryPayload =
  main.includes("function buildPoemShareUrl") &&
  main.includes('url.searchParams.set("poem"') &&
  main.includes('url.searchParams.set("poemId"');
const heldShareUsesInviteUrl =
  main.includes("function buildInviteShareUrl") &&
  main.includes('url.searchParams.set("view", "entry")') &&
  main.includes('url.searchParams.set("invite", "weave")');
const currentShareSwitchesHeldToInvite =
  main.includes("function buildCurrentShareUrl") &&
  main.includes("isHeld(state.poem) ? buildInviteShareUrl() : buildPoemShareUrl(state.poem)");
const composeCastEmbedsShareUrl =
  main.includes("const shareUrl = buildCurrentShareUrl()") &&
  main.includes("embeds: [shareUrl]") &&
  main.includes("close: false");
const shareFallbackUsesFarcasterComposer =
  main.includes("function buildComposerUrl") &&
  main.includes("farcaster.xyz/~/compose") &&
  main.includes("function openShareFallback");
const shareRecordsPostCancelFallback =
  main.includes('noteShareAttempt("cast-posted"') &&
  main.includes('noteShareAttempt("cast-cancelled"') &&
  main.includes('noteShareAttempt("compose-fallback"');
const simulationShareTextIsHonest =
  main.includes("isSimulation(state.poem)") &&
  main.includes("I am testing Poem Weaver");
const shareAttemptsAreNotedLocally =
  main.includes("function noteShareAttempt") &&
  main.includes("SHARE_LOG_KEY") &&
  main.includes('noteShareAttempt("compose"') &&
  main.includes('noteShareAttempt("copy"');

check("share_url_uses_query_payload", shareUrlUsesQueryPayload);
check("held_share_uses_invite_url", heldShareUsesInviteUrl);
check("current_share_switches_held_to_invite", currentShareSwitchesHeldToInvite);
check("compose_cast_embeds_share_url", composeCastEmbedsShareUrl);
check("share_fallback_uses_farcaster_composer", shareFallbackUsesFarcasterComposer);
check("share_records_post_cancel_fallback", shareRecordsPostCancelFallback);
check("simulation_share_text_is_honest", simulationShareTextIsHonest);
check("copy_uses_share_url", main.includes("writeText(shareUrl)"));
check("share_attempts_are_noted_locally", shareAttemptsAreNotedLocally);
check("loader_accepts_query_poem", main.includes("function readPoemParams") && main.includes("window.location.search") && main.includes("query.get(\"poem\")"));
check("simulation_button_replaces_begin_again", main.includes("function simulateCompletedWeave") && main.includes('"Simulate weave"') && main.includes('"simulation"'));
check("simulation_hides_provenance_panel", main.includes("const simulated = isSimulation(poem)") && main.includes("!revealed || simulated"));
check("live_target_reduced_to_five", main.includes("const RANDOM_WEAVE_TARGET = 5"));

// Moderation and financial safety UX should keep rejected traces editable.
check("content_rejection_stays_entry", /result\.status === 422[\s\S]*state\.view = "entry"[\s\S]*phraseInput\.value = phrase/.test(main));
check("unsafe_financial_copy_is_humanized", main.includes("unsafe_financial_or_wallet_language") && main.includes("That line reads like a pitch"));
check("browser_wallet_button_visible_before_trace", main.includes("walletButton.hidden = !(onIntro || onWhat || onEntry) || state.spinning"));
check("what_page_before_trace_present", index.includes('id="whatPanel"') && index.includes('id="whatContinueButton"') && main.includes('window.history.pushState({ view: "what" }'));
check("browser_wallet_provider_fallback_present", main.includes("function linkWalletFromAnyProvider") && main.includes("window.ethereum?.request"));
check("wallet_eip6963_discovery_present", main.includes("eip6963:requestProvider") && main.includes("eip6963:announceProvider"));
check("wallet_prefers_rabby_or_metamask", main.includes("provider.isRabby") && main.includes("provider.isMetaMask"));
check("wallet_sdk_provider_only_in_live_farcaster", main.includes("if (liveQueueAvailable() && state.sdk?.wallet?.getEthereumProvider)"));
check("wallet_legacy_multi_provider_fallback_present", main.includes("window.ethereum?.providers"));
check("wallet_button_top_right_markup", index.indexOf('id="walletButton"') < index.indexOf('<section class="ritual"'));
check("wallet_button_top_right_css", css.includes(".wallet-action") && css.includes("position: fixed") && css.includes("right: max"));
check("wallet_success_status_stays_silent", !main.includes("small signature saved for proof only.") && main.includes('setWalletStatus("");'));
check("wallet_button_label_switches_by_context", main.includes("function walletButtonLabel") && main.includes("shortWalletAddress(state.wallet.address)") && main.includes('"connect wallet"'));
check("wallet_connected_badge_class_present", main.includes('classList.toggle("connected"') && css.includes(".wallet-action.connected::before"));

// Server pins remain the source of truth. The UI may describe receipts, but it
// must not arm minting, token allocation, or airdrops.
check("server_token_pin_false", api.includes("TOKEN_ENABLED = false"));
check("server_airdrop_pin_false", api.includes("AIRDROP_ENABLED = false"));
check("server_mint_pin_false", api.includes("LINE_RECEIPT_MINT_ALLOWED = false"));
check("server_completion_requires_distinct_fids", api.includes("duplicate_fid") && api.includes("distinctFidsRequired"));
check("server_public_completion_returns_dormant_allocations", api.includes("tokenAllocations: record.dormantLedger?.tokenAllocations || []"));

const result = {
  ok: failures.length === 0,
  generatedAtUtc: new Date().toISOString(),
  checked: "random-weave-ui-contract",
  failures,
};
console.log(JSON.stringify(result, null, 2));
if (failures.length) process.exit(1);

function check(name, passed) {
  if (!passed) failures.push(name);
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}
