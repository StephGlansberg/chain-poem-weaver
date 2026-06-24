import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { addLine, completePoem, createPoem, decodePoem, encodePoem, getShareText, getWeaveMap, MAX_LINES, pendingVoiceCount, revealWeave, sealTrace } from "../src/poem.js";

const productionMode = process.argv.includes("--production");
const scriptDir = dirname(fileURLToPath(import.meta.url));

globalThis.btoa ||= (value) => Buffer.from(value, "binary").toString("base64");
globalThis.atob ||= (value) => Buffer.from(value, "base64").toString("binary");
globalThis.crypto ||= {
  getRandomValues(bytes) {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 31 + 17) % 255;
    return bytes;
  },
};

const root = resolve(scriptDir, "..");
const required = [
  "index.html",
  "package.json",
  "package-lock.json",
  "src/main.js",
  "src/poem.js",
  "src/styles.css",
  "api/me.mjs",
  "api/admin-moderation.mjs",
  "api/provenance.mjs",
  "api/random-weave.mjs",
  "contracts/ChainPoemLineReceipts.sol",
  "data/sample-poem.json",
  ".well-known/farcaster.json",
  "manifest.webmanifest",
  "vercel.json",
  "scripts/api-fail-closed-check.mjs",
  "scripts/provenance-canonical-check.mjs",
  "scripts/random-weave-queue-check.mjs",
  "scripts/moderation-floor-check.mjs",
  "scripts/moderate-admin.mjs",
  "scripts/random-weave-ui-contract-check.mjs",
  "scripts/line-receipt-contract-check.mjs",
  "scripts/deploy-target-check.mjs",
  "scripts/deploy-production.mjs",
  "scripts/operator-release-brief.mjs",
  "scripts/manifest-assert.mjs",
  "scripts/base-standard-web-check.mjs",
  "scripts/hosting-config-check.mjs",
  "scripts/vercel-dev.mjs",
  "scripts/vercel-dev-check.mjs",
  "scripts/production-rehearsal-check.mjs",
  "scripts/client-verification-check.mjs",
  "scripts/deploy-preflight.mjs",
  "scripts/verify-deployment.mjs",
  "scripts/release-packet.mjs",
  "assets/chain-poem-icon.png",
  "assets/poem-splash.png",
  "assets/chain-poem-weaver.png",
  "assets/chain-poem-hero.png",
  "assets/chain-poem-og.png",
  ".env.vercel-dev.example",
];

const failures = [];
for (const file of required) {
  if (!existsSync(join(root, file))) failures.push(`missing:${file}`);
}

const manifestPath = join(root, ".well-known/farcaster.json");
let manifest = null;
if (existsSync(manifestPath)) {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.miniapp?.name !== "Poem Weaver") failures.push("manifest_wrong_name");
  if (!manifest.miniapp?.homeUrl?.startsWith("https://")) failures.push("manifest_home_url_not_https");
  if (!manifest.accountAssociation) failures.push("manifest_missing_account_association");
  if (manifest.miniapp?.buttonTitle?.length > 32) failures.push("manifest_button_title_too_long");
  if (manifest.miniapp?.name?.length > 32) failures.push("manifest_name_too_long");
}

const main = existsSync(join(root, "src/main.js")) ? readFileSync(join(root, "src/main.js"), "utf8") : "";
if (!main.includes("sdk.actions.ready")) failures.push("sdk_ready_not_called");
if (!main.includes("composeCast")) failures.push("compose_cast_not_wired");
if (!main.includes("sdk.context")) failures.push("farcaster_context_not_wired");
if (!main.includes("quickAuth.getToken")) failures.push("quick_auth_frontend_not_wired");
if (!main.includes('fetch("/api/me"')) failures.push("quick_auth_api_fetch_not_wired");
if (!main.includes('fetch("/api/provenance"')) failures.push("provenance_api_fetch_not_wired");
if (!main.includes("Minting remains disabled")) failures.push("provenance_mint_disabled_message_missing");
if (!main.includes("line NFT receipts planned")) failures.push("line_receipt_ui_message_missing");
if (!main.includes("inferLaneFromProfile")) failures.push("profile_lane_inference_not_wired");
if (!main.includes("view=entry")) failures.push("entry_view_navigation_not_wired");
if (!main.includes("thread-view")) failures.push("thread_view_class_not_wired");
if (!main.includes("localStorage")) failures.push("local_storage_not_wired");

const index = existsSync(join(root, "index.html")) ? readFileSync(join(root, "index.html"), "utf8") : "";
if (!index.includes('name="fc:miniapp"')) failures.push("fc_miniapp_meta_missing");
if (!index.includes('rel="manifest"')) failures.push("web_manifest_link_missing");
if (!index.includes('id="introPanel"')) failures.push("intro_panel_missing");
if (!index.includes('id="startButton"')) failures.push("intro_start_button_missing");
if (!index.includes('id="phraseInput"')) failures.push("ritual_phrase_input_missing");
if (!index.includes('id="contextText"')) failures.push("context_status_missing");
if (!index.includes('id="verifyButton"')) failures.push("verify_button_missing");
if (!index.includes('id="provenanceButton"')) failures.push("provenance_button_missing");

const authApi = existsSync(join(root, "api/me.mjs")) ? readFileSync(join(root, "api/me.mjs"), "utf8") : "";
if (!authApi.includes("@farcaster/quick-auth")) failures.push("quick_auth_dependency_not_wired");
if (!authApi.includes("verifyJwt")) failures.push("quick_auth_verify_not_wired");
if (!authApi.includes("missing_bearer_token")) failures.push("quick_auth_missing_token_gate_missing");
if (!authApi.includes("no-store")) failures.push("quick_auth_no_store_missing");

const provenanceApi = existsSync(join(root, "api/provenance.mjs")) ? readFileSync(join(root, "api/provenance.mjs"), "utf8") : "";
if (!provenanceApi.includes("@farcaster/quick-auth")) failures.push("provenance_quick_auth_not_wired");
if (!provenanceApi.includes("poem_not_complete")) failures.push("provenance_complete_gate_missing");
if (!provenanceApi.includes("sha256")) failures.push("provenance_hash_missing");
if (!provenanceApi.includes("mintAllowed: false")) failures.push("provenance_mint_gate_missing");
if (!provenanceApi.includes("chain-poem-line-receipt-mint-plan")) failures.push("provenance_line_receipt_plan_missing");
if (!provenanceApi.includes("ERC-1155")) failures.push("provenance_line_receipt_standard_missing");
if (!provenanceApi.includes("contractAddress: null")) failures.push("provenance_line_receipt_contract_gate_missing");
if (!provenanceApi.includes("chain-poem-offchain-metadata")) failures.push("provenance_offchain_metadata_missing");
if (!provenanceApi.includes("generated_offchain_not_minted")) failures.push("provenance_offchain_metadata_status_missing");
if (!provenanceApi.includes("chain-poem-ownership-policy")) failures.push("provenance_ownership_policy_missing");
if (!provenanceApi.includes("no_single_owner")) failures.push("provenance_whole_poem_ownership_policy_missing");
if (!provenanceApi.includes("own_line_receipt_only")) failures.push("provenance_line_receipt_scope_missing");

const randomWeaveApi = existsSync(join(root, "api/random-weave.mjs")) ? readFileSync(join(root, "api/random-weave.mjs"), "utf8") : "";
if (!randomWeaveApi.includes("@farcaster/quick-auth")) failures.push("random_weave_quick_auth_not_wired");
if (!randomWeaveApi.includes("RANDOM_WEAVE_TARGET_LINES = 5")) failures.push("random_weave_target_lines_missing");
if (!randomWeaveApi.includes("LINE_RECEIPT_MINT_ALLOWED = false")) failures.push("random_weave_mint_pin_missing");
if (!randomWeaveApi.includes("TOKEN_ENABLED = false")) failures.push("random_weave_token_pin_missing");
if (!randomWeaveApi.includes("AIRDROP_ENABLED = false")) failures.push("random_weave_airdrop_pin_missing");
if (!randomWeaveApi.includes("validateServerCompletion")) failures.push("random_weave_server_completion_gate_missing");
if (!randomWeaveApi.includes("server-quick-auth")) failures.push("random_weave_server_verified_context_missing");
if (!randomWeaveApi.includes("chain-poem-token-allocation-record")) failures.push("random_weave_token_allocation_record_missing");
if (!randomWeaveApi.includes("chain-poem-line-receipt-claim-record")) failures.push("random_weave_line_claim_record_missing");
if (!randomWeaveApi.includes("fid_banned")) failures.push("random_weave_banned_fid_gate_missing");

const adminModerationApi = existsSync(join(root, "api/admin-moderation.mjs")) ? readFileSync(join(root, "api/admin-moderation.mjs"), "utf8") : "";
if (!adminModerationApi.includes("CHAIN_POEM_ADMIN_TOKEN")) failures.push("admin_moderation_token_gate_missing");
if (!adminModerationApi.includes("admin_token_not_configured")) failures.push("admin_moderation_config_gate_missing");
if (!adminModerationApi.includes("store.moderate")) failures.push("admin_moderation_store_write_missing");
if (!adminModerationApi.includes("no-store")) failures.push("admin_moderation_no_store_missing");

const lineReceiptContract = existsSync(join(root, "contracts/ChainPoemLineReceipts.sol")) ? readFileSync(join(root, "contracts/ChainPoemLineReceipts.sol"), "utf8") : "";
if (!lineReceiptContract.includes("contract ChainPoemLineReceipts is ERC1155")) failures.push("line_receipt_contract_not_erc1155");
if (!lineReceiptContract.includes("claimLine(LineClaim calldata claim")) failures.push("line_receipt_claim_function_missing");
if (!lineReceiptContract.includes("claimed[claim.claimKey]")) failures.push("line_receipt_replay_guard_missing");

const lineReceiptContractCheck = existsSync(join(root, "scripts/line-receipt-contract-check.mjs")) ? readFileSync(join(root, "scripts/line-receipt-contract-check.mjs"), "utf8") : "";
if (!lineReceiptContractCheck.includes("chain-poem-line-receipt-contract-readiness")) failures.push("line_receipt_contract_check_kind_missing");
if (!lineReceiptContractCheck.includes("CHAIN_POEM_LINE_RECEIPT_CONTRACT")) failures.push("line_receipt_contract_env_gate_missing");

const deployPreflight = existsSync(join(root, "scripts/deploy-preflight.mjs")) ? readFileSync(join(root, "scripts/deploy-preflight.mjs"), "utf8") : "";
if (!deployPreflight.includes("account_association_domain_mismatch")) failures.push("deploy_preflight_domain_check_missing");
if (!deployPreflight.includes("api_me_fail_closed_gate_missing")) failures.push("deploy_preflight_auth_check_missing");
if (!deployPreflight.includes("source:api_provenance")) failures.push("deploy_preflight_provenance_check_missing");

const apiFailClosedCheck = existsSync(join(root, "scripts/api-fail-closed-check.mjs")) ? readFileSync(join(root, "scripts/api-fail-closed-check.mjs"), "utf8") : "";
if (!apiFailClosedCheck.includes("api/provenance.mjs")) failures.push("api_fail_closed_provenance_probe_missing");

const provenanceCanonicalCheck = existsSync(join(root, "scripts/provenance-canonical-check.mjs")) ? readFileSync(join(root, "scripts/provenance-canonical-check.mjs"), "utf8") : "";
if (!provenanceCanonicalCheck.includes("poem_hash_not_stable")) failures.push("provenance_canonical_hash_test_missing");
if (!provenanceCanonicalCheck.includes("offchain_metadata_missing")) failures.push("provenance_offchain_metadata_test_missing");
if (!provenanceCanonicalCheck.includes("ownership_policy_missing")) failures.push("provenance_ownership_policy_test_missing");

const randomWeaveQueueCheck = existsSync(join(root, "scripts/random-weave-queue-check.mjs")) ? readFileSync(join(root, "scripts/random-weave-queue-check.mjs"), "utf8") : "";
if (!randomWeaveQueueCheck.includes("duplicate_fids_completed")) failures.push("random_weave_duplicate_fid_test_missing");
if (!randomWeaveQueueCheck.includes("duplicate_pending_fid_lock_missing")) failures.push("random_weave_pending_fid_lock_test_missing");
if (!randomWeaveQueueCheck.includes("token_allocation_not_dormant")) failures.push("random_weave_dormant_allocation_test_missing");
if (!randomWeaveQueueCheck.includes("preview_validation_not_rejected")) failures.push("random_weave_preview_rejection_test_missing");

const moderationFloorCheck = existsSync(join(root, "scripts/moderation-floor-check.mjs")) ? readFileSync(join(root, "scripts/moderation-floor-check.mjs"), "utf8") : "";
if (!moderationFloorCheck.includes("banFid")) failures.push("moderation_ban_fid_test_missing");
if (!moderationFloorCheck.includes("hidePoem")) failures.push("moderation_hide_poem_test_missing");
if (!moderationFloorCheck.includes("bannedFidsBlockQueue")) failures.push("moderation_queue_block_test_missing");

const randomWeaveUiContractCheck = existsSync(join(root, "scripts/random-weave-ui-contract-check.mjs")) ? readFileSync(join(root, "scripts/random-weave-ui-contract-check.mjs"), "utf8") : "";
if (!randomWeaveUiContractCheck.includes("live_queue_available_requires_quick_auth")) failures.push("random_weave_ui_quick_auth_test_missing");
if (!randomWeaveUiContractCheck.includes("held_card_uses_live_count")) failures.push("random_weave_ui_live_count_test_missing");
if (!randomWeaveUiContractCheck.includes("completion_maps_provenance")) failures.push("random_weave_ui_provenance_mapping_test_missing");
if (!randomWeaveUiContractCheck.includes("server_token_pin_false")) failures.push("random_weave_ui_token_pin_test_missing");

const deployTargetCheck = existsSync(join(root, "scripts/deploy-target-check.mjs")) ? readFileSync(join(root, "scripts/deploy-target-check.mjs"), "utf8") : "";
if (!deployTargetCheck.includes("chain-poem-weaver-deploy-target-readiness")) failures.push("deploy_target_check_kind_missing");
if (!deployTargetCheck.includes("server_capable_deploy_provider_not_ready")) failures.push("deploy_target_provider_gate_missing");
if (!deployTargetCheck.includes("VERCEL_TOKEN")) failures.push("deploy_target_vercel_token_check_missing");

const deployProduction = existsSync(join(root, "scripts/deploy-production.mjs")) ? readFileSync(join(root, "scripts/deploy-production.mjs"), "utf8") : "";
if (!deployProduction.includes("chain-poem-weaver-deploy-production-run")) failures.push("deploy_production_kind_missing");
if (!deployProduction.includes("deploy:production:live")) failures.push("deploy_production_live_guidance_missing");
if (!deployProduction.includes("verify-deployment.mjs")) failures.push("deploy_production_live_verify_missing");
if (!deployProduction.includes("base-standard-web-check.mjs")) failures.push("deploy_production_base_check_missing");
if (!deployProduction.includes("hosting-config-check.mjs")) failures.push("deploy_production_hosting_check_missing");

const verifyDeployment = existsSync(join(root, "scripts/verify-deployment.mjs")) ? readFileSync(join(root, "scripts/verify-deployment.mjs"), "utf8") : "";
if (!verifyDeployment.includes("chain-poem-weaver-live-verify-run")) failures.push("verify_deployment_kind_missing");
if (!verifyDeployment.includes("--self-test")) failures.push("verify_deployment_self_test_missing");
if (!verifyDeployment.includes("embed_action_url_should_default_to_shared_url")) failures.push("verify_deployment_embed_default_url_check_missing");
if (!verifyDeployment.includes("auth_api_cache_control_missing_no_store")) failures.push("verify_deployment_cache_control_check_missing");
if (!verifyDeployment.includes("admin_moderation_fail_closed_probe_failed")) failures.push("verify_deployment_admin_moderation_check_missing");
if (!verifyDeployment.includes("live-verify-run.json")) failures.push("verify_deployment_receipt_missing");

const operatorReleaseBrief = existsSync(join(root, "scripts/operator-release-brief.mjs")) ? readFileSync(join(root, "scripts/operator-release-brief.mjs"), "utf8") : "";
if (!operatorReleaseBrief.includes("chain-poem-weaver-operator-release-brief")) failures.push("operator_release_brief_kind_missing");
if (!operatorReleaseBrief.includes("FARCASTER_ACCOUNT_ASSOCIATION_SIGNATURE")) failures.push("operator_release_brief_account_association_missing");
if (!operatorReleaseBrief.includes("VERCEL_TOKEN")) failures.push("operator_release_brief_vercel_token_missing");

const manifestAssert = existsSync(join(root, "scripts/manifest-assert.mjs")) ? readFileSync(join(root, "scripts/manifest-assert.mjs"), "utf8") : "";
if (!manifestAssert.includes("fc_miniapp_embed_missing_or_invalid_json")) failures.push("manifest_assert_embed_check_missing");
if (!manifestAssert.includes("account_association_domain_mismatch")) failures.push("manifest_assert_account_association_check_missing");
if (!manifestAssert.includes("production_uses_placeholder_domain")) failures.push("manifest_assert_production_placeholder_check_missing");

const baseStandardWebCheck = existsSync(join(root, "scripts/base-standard-web-check.mjs")) ? readFileSync(join(root, "scripts/base-standard-web-check.mjs"), "utf8") : "";
if (!baseStandardWebCheck.includes("chain-poem-weaver-base-standard-web-readiness")) failures.push("base_standard_web_check_kind_missing");
if (!baseStandardWebCheck.includes("standard_web_share_fallback_missing")) failures.push("base_standard_web_share_check_missing");
if (!baseStandardWebCheck.includes("base_wallet_auth_not_wired_onchain_features_must_remain_dormant")) failures.push("base_standard_web_wallet_dormant_check_missing");

const hostingConfigCheck = existsSync(join(root, "scripts/hosting-config-check.mjs")) ? readFileSync(join(root, "scripts/hosting-config-check.mjs"), "utf8") : "";
if (!hostingConfigCheck.includes("chain-poem-weaver-hosting-config-check")) failures.push("hosting_config_check_kind_missing");
if (!hostingConfigCheck.includes("vercel_build_command_production")) failures.push("hosting_config_build_gate_missing");
if (!hostingConfigCheck.includes("poem_nested_rewrite_present")) failures.push("hosting_config_poem_rewrite_gate_missing");
if (!hostingConfigCheck.includes("api_provenance_body_limit")) failures.push("hosting_config_api_gate_missing");

const vercelDevCheck = existsSync(join(root, "scripts/vercel-dev-check.mjs")) ? readFileSync(join(root, "scripts/vercel-dev-check.mjs"), "utf8") : "";
if (!vercelDevCheck.includes("vercel-dev-wiring")) failures.push("vercel_dev_check_kind_missing");
if (!vercelDevCheck.includes("dev_vercel_script_present")) failures.push("vercel_dev_package_script_check_missing");
if (!vercelDevCheck.includes("local_env_ignored")) failures.push("vercel_dev_env_ignore_check_missing");

const productionRehearsalCheck = existsSync(join(root, "scripts/production-rehearsal-check.mjs")) ? readFileSync(join(root, "scripts/production-rehearsal-check.mjs"), "utf8") : "";
if (!productionRehearsalCheck.includes("chain-poem-weaver-production-rehearsal-run")) failures.push("production_rehearsal_kind_missing");
if (!productionRehearsalCheck.includes("mkdtempSync")) failures.push("production_rehearsal_temp_copy_missing");
if (!productionRehearsalCheck.includes('"contracts"')) failures.push("production_rehearsal_contract_copy_missing");
if (!productionRehearsalCheck.includes("base-standard-web-check")) failures.push("production_rehearsal_base_gate_missing");
if (!productionRehearsalCheck.includes("hosting-config-check")) failures.push("production_rehearsal_hosting_gate_missing");
if (!productionRehearsalCheck.includes("rehearsal_hosting_config_step_missing_or_failed")) failures.push("production_rehearsal_hosting_failure_marker_missing");
if (!productionRehearsalCheck.includes("rehearsal-only-not-a-token")) failures.push("production_rehearsal_fake_token_marker_missing");

const clientVerificationCheck = existsSync(join(root, "scripts/client-verification-check.mjs")) ? readFileSync(join(root, "scripts/client-verification-check.mjs"), "utf8") : "";
if (!clientVerificationCheck.includes("chain-poem-weaver-client-verification-check")) failures.push("client_verification_check_kind_missing");
if (!clientVerificationCheck.includes("quickAuthTokenAccepted")) failures.push("client_verification_quick_auth_gate_missing");
if (!clientVerificationCheck.includes("completedPoemShared")) failures.push("client_verification_completed_poem_share_gate_missing");
if (!clientVerificationCheck.includes("embedRenderedAsMiniApp")) failures.push("client_verification_embed_render_gate_missing");
if (!clientVerificationCheck.includes("openedAsStandardWeb")) failures.push("client_verification_base_gate_missing");
if (!clientVerificationCheck.includes("paidMintEnabled !== false")) failures.push("client_verification_paid_mint_gate_missing");

const releasePacket = existsSync(join(root, "scripts/release-packet.mjs")) ? readFileSync(join(root, "scripts/release-packet.mjs"), "utf8") : "";
if (!releasePacket.includes("chain-poem-weaver-release-packet")) failures.push("release_packet_kind_missing");
if (!releasePacket.includes("deployment-build.json")) failures.push("release_packet_deployment_build_missing");
if (!releasePacket.includes("sha256")) failures.push("release_packet_hashing_missing");
if (!releasePacket.includes("accountAssociationReady")) failures.push("release_packet_auth_readiness_missing");

if (existsSync(join(root, "manifest.webmanifest"))) {
  const webManifest = JSON.parse(readFileSync(join(root, "manifest.webmanifest"), "utf8"));
  if (webManifest.name !== "Poem Weaver") failures.push("web_manifest_wrong_name");
  if (!Array.isArray(webManifest.icons) || webManifest.icons.length === 0) failures.push("web_manifest_missing_icons");
}

if (existsSync(join(root, "package.json"))) {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (!packageJson.dependencies?.["@farcaster/quick-auth"]) failures.push("quick_auth_package_dependency_missing");
  if (!String(packageJson.packageManager || "").startsWith("npm@")) failures.push("package_manager_not_pinned_to_npm");
}

const assetSpecs = [
  ["assets/chain-poem-icon.png", 1024, 1024],
  ["assets/poem-splash.png", 200, 200],
  ["assets/chain-poem-weaver.png", 1200, 800],
  ["assets/chain-poem-hero.png", 1200, 630],
  ["assets/chain-poem-og.png", 1200, 630],
];
for (const [file, width, height] of assetSpecs) {
  const path = join(root, file);
  if (!existsSync(path)) {
    failures.push(`production_asset_missing:${file}`);
    continue;
  }
  const size = readPngSize(path);
  if (!size) {
    failures.push(`production_asset_not_png:${file}`);
    continue;
  }
  if (size.width !== width || size.height !== height) {
    failures.push(`production_asset_wrong_size:${file}:${size.width}x${size.height}`);
  }
}

if (productionMode) {
  const manifestText = manifest ? JSON.stringify(manifest) : "";
  if (manifestText.includes(".example")) failures.push("production_manifest_uses_example_domain");
  if (index.includes(".example")) failures.push("production_embed_uses_example_domain");
  if (!manifest?.miniapp?.canonicalDomain) failures.push("production_canonical_domain_missing");
  if (manifest?.miniapp?.canonicalDomain && String(manifest.miniapp.canonicalDomain).includes("://")) {
    failures.push("production_canonical_domain_has_protocol");
  }
  for (const field of ["header", "payload", "signature"]) {
    if (!manifest?.accountAssociation?.[field]) failures.push(`production_account_association_${field}_missing`);
  }
  const associationCheck = validateAccountAssociation(manifest?.accountAssociation, manifest?.miniapp?.canonicalDomain);
  failures.push(...associationCheck.failures);
  const urls = [
    manifest?.miniapp?.homeUrl,
    manifest?.miniapp?.iconUrl,
    manifest?.miniapp?.imageUrl,
    manifest?.miniapp?.splashImageUrl,
    manifest?.miniapp?.heroImageUrl,
    manifest?.miniapp?.ogImageUrl,
  ].filter(Boolean);
  for (const url of urls) {
    if (!String(url).startsWith("https://")) failures.push(`production_url_not_https:${url}`);
  }
}

try {
  const opContributor = {
    author: "OP",
    fid: "123",
    username: "opulentis",
    displayName: "Opulentis",
    contextSource: "farcaster-context",
    profileSignal: "@opulentis",
    signal: "verified-farcaster",
    verified: true,
  };
  let poem = createPoem({ title: "Test", theme: "ritual", firstLine: "First line", contributor: opContributor });
  poem = addLine(poem, "Second line", {
    author: "Late Weaver",
    username: "lateweaver",
    contextSource: "farcaster-context",
    signal: "farcaster-context",
  });
  const payload = encodePoem(poem);
  const decoded = decodePoem(payload);
  if (decoded.lines.length !== 2) failures.push("poem_roundtrip_failed");
  if (decoded.lines[0].username !== "opulentis") failures.push("contributor_context_roundtrip_failed");
  if (decoded.lines[0].verified !== true) failures.push("verified_context_not_preserved");
  if (decoded.lines[1].contextSource !== "farcaster-context") failures.push("late_contributor_context_missing");
  while (poem.lines.length < MAX_LINES) poem = addLine(poem, `line ${poem.lines.length + 1}`, "friend");
  if (poem.status !== "complete") failures.push("poem_did_not_auto_complete");
  const final = completePoem(decoded);
  if (final.status !== "complete") failures.push("manual_complete_failed");
  const weaveMap = getWeaveMap(poem);
  if (weaveMap.length !== MAX_LINES) failures.push("weave_map_wrong_length");
  if (weaveMap[0].role !== "opener") failures.push("weave_map_missing_opener");
  if (weaveMap[MAX_LINES - 1].role !== "closer") failures.push("weave_map_missing_closer");
  if (weaveMap[MAX_LINES - 1].weaveWeight <= weaveMap[0].weaveWeight) failures.push("weave_map_late_weight_not_higher");
  if (weaveMap[0].username !== "opulentis") failures.push("weave_map_context_missing");
  if (!getShareText(final).includes("A chain poem finished")) failures.push("share_text_missing_completion");
  const heldTrace = sealTrace({ lane: "dream", phrase: "small gold", contributor: opContributor });
  if (heldTrace.status !== "open") failures.push("sealed_trace_should_stay_open");
  if (heldTrace.revealStatus !== "held") failures.push("sealed_trace_should_be_held");
  if (heldTrace.lines.length !== 1) failures.push("sealed_trace_should_have_one_line");
  if (pendingVoiceCount(heldTrace) !== MAX_LINES - 1) failures.push("held_trace_pending_voice_count_wrong");
  const heldPayload = encodePoem(heldTrace);
  const heldDecoded = decodePoem(heldPayload);
  if (heldDecoded.revealStatus !== "held") failures.push("held_trace_roundtrip_failed");
  const revealed = revealWeave(heldDecoded);
  if (revealed.status !== "complete") failures.push("revealed_weave_should_complete");
  if (revealed.revealStatus !== "preview") failures.push("revealed_weave_should_be_preview");
  if (revealed.lines.length <= heldTrace.lines.length) failures.push("revealed_weave_missing_preview_lines");
  if (!revealed.lines.slice(1).every((line) => line.contextSource === "preview-queue")) failures.push("revealed_preview_lines_not_marked");
  if (!getShareText(revealed).includes("preview weave")) failures.push("preview_share_text_not_honest");
  try {
    createPoem({ title: "", theme: "ritual", firstLine: "" });
    failures.push("empty_first_line_allowed");
  } catch {}
} catch (error) {
  failures.push(`poem_logic_error:${error.message}`);
}

if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, checked: required.length, poemLogic: true }, null, 2));

function readPngSize(path) {
  const bytes = readFileSync(path);
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24) return null;
  for (let index = 0; index < pngSignature.length; index += 1) {
    if (bytes[index] !== pngSignature[index]) return null;
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

function validateAccountAssociation(accountAssociation, canonicalDomain) {
  const failures = [];
  if (!accountAssociation?.header || !accountAssociation?.payload || !accountAssociation?.signature) {
    return { failures };
  }
  const header = parseBase64Json(accountAssociation.header);
  const payload = parseBase64Json(accountAssociation.payload);
  if (!header) failures.push("production_account_association_header_invalid_base64_json");
  if (!payload) failures.push("production_account_association_payload_invalid_base64_json");
  if (header && !["custody", "auth"].includes(header.type)) {
    failures.push("production_account_association_header_type_invalid");
  }
  if (payload && canonicalDomain && payload.domain !== canonicalDomain) {
    failures.push("production_account_association_domain_mismatch");
  }
  if (payload && String(payload.domain || "").includes("://")) {
    failures.push("production_account_association_domain_has_protocol");
  }
  if (String(accountAssociation.signature || "").length < 64) {
    failures.push("production_account_association_signature_too_short");
  }
  return { failures };
}

function parseBase64Json(value) {
  try {
    const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}
