import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..");
const outputPath = join(root, "data", "line-receipt-contract-readiness.json");
const failures = [];
const warnings = [];

const contractPath = join(root, "contracts", "ChainPoemLineReceipts.sol");
const provenancePath = join(root, "api", "provenance.mjs");
const contract = readText(contractPath);
const provenance = readText(provenancePath);

if (!contract) failures.push("line_receipt_contract_missing");
if (!contract.includes("contract ChainPoemLineReceipts is ERC1155")) failures.push("line_receipt_contract_not_erc1155");
if (!contract.includes("claimLine(LineClaim calldata claim")) failures.push("claim_line_function_missing");
if (!contract.includes("adminMintLine")) failures.push("admin_mint_line_function_missing");
if (!contract.includes("recoverSigner")) failures.push("signature_recovery_missing");
if (!contract.includes("claimed[claim.claimKey]")) failures.push("claim_replay_guard_missing");
if (!contract.includes("block.chainid")) failures.push("chain_id_signature_binding_missing");
if (!contract.includes("address(this)")) failures.push("contract_address_signature_binding_missing");
if (!contract.includes("@openzeppelin/contracts/token/ERC1155/ERC1155.sol")) failures.push("openzeppelin_erc1155_import_missing");

if (!provenance.includes("chain-poem-line-receipt-mint-plan")) failures.push("provenance_mint_plan_missing");
if (!provenance.includes("tokenIdSeed")) failures.push("provenance_token_id_seed_missing");
if (!provenance.includes("claimKey")) failures.push("provenance_claim_key_missing");
if (!provenance.includes("contractAddress: null")) failures.push("provenance_contract_dormant_gate_missing");

const env = {
  CHAIN_POEM_LINE_RECEIPT_CONTRACT: Boolean(process.env.CHAIN_POEM_LINE_RECEIPT_CONTRACT),
  CHAIN_POEM_LINE_RECEIPT_SIGNER: Boolean(process.env.CHAIN_POEM_LINE_RECEIPT_SIGNER),
  CHAIN_POEM_LINE_RECEIPT_BASE_URI: Boolean(process.env.CHAIN_POEM_LINE_RECEIPT_BASE_URI),
};

if (!env.CHAIN_POEM_LINE_RECEIPT_CONTRACT) warnings.push("line_receipt_contract_address_missing_live_mint_disabled");
if (!env.CHAIN_POEM_LINE_RECEIPT_SIGNER) warnings.push("line_receipt_signer_missing_live_mint_disabled");
if (!env.CHAIN_POEM_LINE_RECEIPT_BASE_URI) warnings.push("line_receipt_base_uri_missing_live_mint_disabled");

const result = {
  schemaVersion: 1,
  kind: "chain-poem-line-receipt-contract-readiness",
  generatedAtUtc: new Date().toISOString(),
  ok: failures.length === 0,
  deployReady: failures.length === 0 && Object.values(env).every(Boolean),
  contractPath: "contracts/ChainPoemLineReceipts.sol",
  standard: "ERC-1155",
  chainId: 8453,
  network: "base",
  env,
  failures: unique(failures),
  warnings: unique(warnings),
  next: Object.values(env).every(Boolean)
    ? "Contract scaffold and live contract environment values are present. Compile/deploy verification can be added next."
    : "Contract scaffold is present. Keep live mint disabled until contract address, signer, base URI, wallet ownership, and operator approval exist.",
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify(result, null, 2));
if (failures.length) process.exit(1);

function readText(path) {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}
