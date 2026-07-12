import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const requireCovenant = process.argv.includes("--require-covenant");
const checks = [];

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function pass(name, detail = "") {
  checks.push({ ok: true, name, detail });
}

function fail(name, detail) {
  checks.push({ ok: false, name, detail });
}

function assert(name, condition, detail) {
  if (condition) {
    pass(name, detail);
  } else {
    fail(name, detail);
  }
}

const packageJson = readJson("package.json");
const manifest = readJson("src/contracts/compiled/raffle-round.manifest.json");
const artifact = readJson("src/contracts/compiled/raffle-round.artifact.json");
const v4Artifact = readJson("src/contracts/compiled/raffle-round-v4.artifact.json");
const appSource = readText("src/app/App.tsx");
const i18nSource = readText("src/app/i18n.ts");
const covenantSource = readText("src/kaspa/covenant.ts");
const transactionSource = readText("src/kaspa/transactions.ts");
const walletSource = readText("src/kaspa/wallet.ts");
const walletTypesSource = readText("src/kaspa/wallet-types.ts");
const networkSource = readText("src/kaspa/networks.ts");
const kasWareWalletSource = readText("src/kaspa/wallet-kasware.ts");
const kastleWalletSource = readText("src/kaspa/wallet-kastle.ts");
const metadataSource = readText("src/raffle/metadata.ts");
const ticketRangeSource = readText("src/raffle/tickets.ts");
const contractSource = readText("src/contracts/raffle_round.sil");
const v4ContractSource = readText("src/contracts/raffle_round_v4.sil");
const merkleSource = readText("src/raffle/merkle.ts");
const indexerSource = readText("indexer/raffle-indexer.mjs");
const viteSource = readText("vite.config.ts");
const wasmSource = readText("src/kaspa/wasm.ts");
const distFiles = fs.existsSync(path.join(root, "dist")) ? fs.readdirSync(path.join(root, "dist")) : [];
const distHtml = distFiles.includes("index.html") ? readText("dist/index.html") : "";

assert("Single-file SPA build exists", packageJson.scripts?.build === "tsc --noEmit && vite build && node scripts/inline-spa.mjs");
assert(
  "English and Chinese UI localization is wired",
  appSource.includes('LANGUAGE_STORAGE_KEY = "kaspa-raffle-language-v1"') &&
    appSource.includes('aria-label={t("language")}') &&
    appSource.includes("translateRuntimeText") &&
    i18nSource.includes('"app.title": "Kaspa Raffle"') &&
    i18nSource.includes('"app.title": "Kaspa 抽奖"') &&
    i18nSource.includes('export type Language = "en" | "zh"')
);
assert("Build output is one self-contained HTML file", JSON.stringify(distFiles) === JSON.stringify(["index.html"]));
assert("Kaspa WASM is embedded in the SPA", distHtml.includes("data:application/octet-stream;base64"));
assert(
  "Production SPA excludes local private-key test adapters",
  !distHtml.includes("Local participant key") &&
    !distHtml.includes("Local outsider key") &&
    !distHtml.includes("__kaspa_raffle_local_test_wallet")
);
assert(
  "Browser WASM loader bypasses the package CommonJS require",
  viteSource.includes("patchOneKeyBrowserWasmLoader") &&
    wasmSource.includes("kaspa_bg.wasm.bin?url") &&
    wasmSource.includes("module_or_path: bytes")
);
assert("Contract compile script exists", packageJson.scripts?.["compile:contract"] === "node scripts/compile-raffle-contract.mjs");
assert(
  "Network registry exposes Mainnet and Testnet 10",
  networkSource.includes('id: "mainnet"') &&
    networkSource.includes('id: "testnet-10"') &&
    networkSource.includes('ws://127.0.0.1:18110') &&
    networkSource.includes('ws://tn12-node.kaspa.com:18210')
);
assert(
  "KasWare-style network switcher is wired",
  appSource.includes('role="menu" aria-label={t("network.switch")}') &&
    appSource.includes('role="menuitemradio"') &&
    appSource.includes("handleSelectNetwork") &&
    appSource.includes("networkSettingsId")
);
assert(
  "Node and wallet networks are validated",
  appSource.includes("The node reports") &&
    appSource.includes("normalizeNetworkId") &&
    walletTypesSource.includes("requireNetworkProfile(network)") &&
    walletTypesSource.includes("profile.addressPrefix")
);
assert("Default ticket price is 0.3 KAS", metadataSource.includes('ticketPrice: "30000000"'));
assert("Default round has 10 tickets", metadataSource.includes("maxTickets: 10"));
assert("Browser covenant ticket path exists", transactionSource.includes("buyRaffleCovenantTicket") && appSource.includes("handleBuyTicket"));
assert("Share-link round import exists", appSource.includes("handleCopyRoundLink") && appSource.includes("loadSharedRoundFromUrl"));
assert(
  "Round source and action workflows use peer tab bars",
  appSource.includes('role="tablist" aria-label={t("roundSourceTabs")}') &&
    appSource.includes('role="tablist" aria-label={t("actionTabs")}') &&
    appSource.includes('id="round-history-panel"') &&
    appSource.includes('id="round-payout-panel"')
);
assert(
  "KAS-spending actions expose hover cost breakdowns",
  appSource.includes("data-cost={createCostTooltip}") &&
    appSource.includes("data-cost={buyCostTooltip}") &&
    appSource.includes("data-cost={payoutCostTooltip}") &&
    appSource.includes("data-cost={refundCostTooltip}") &&
    transactionSource.includes("export const COVENANT_BUY_FEE_SOMPI")
);
assert(
  "Round creation supports a custom registry with explicit costs",
  i18nSource.includes('"registryAddress": "Registry address"') &&
    i18nSource.includes('"sentToRegistry": "Sent to registry"') &&
    i18nSource.includes('"registryPaymentFee": "Registry payment fee"') &&
    i18nSource.includes('"automaticMarkerRefund": "Automatic marker refund"') &&
    appSource.includes('setCreateRegistryAddress') &&
    appSource.includes('registryAddress: targetRegistryAddress') &&
    appSource.includes('markerTxId && autoRefundRegistryMarker') &&
    transactionSource.includes('REGISTRY_MARKER_REFUND_FEE_SOMPI') &&
    metadataSource.includes('registryAddress: ""')
);
assert(
  "Mainnet has the requested retained-marker default registry",
  transactionSource.includes('MAINNET_DEFAULT_RAFFLE_REGISTRY_ADDRESS') &&
    transactionSource.includes('kaspa:qzrhkehvwlzpzh8dv9ecl8eadayyzhrqlkcldzfzu32mrgv2m9npqpc4a6ugh') &&
    transactionSource.includes('return { address: MAINNET_DEFAULT_RAFFLE_REGISTRY_ADDRESS, autoRefund: false }') &&
    appSource.includes('usesAutoRefundRegistry') &&
    i18nSource.includes('"registryRetainedNote"')
);
assert(
  "Carrier defaults to 0.2 KAS with a 0.1 KAS storage-safe floor",
  transactionSource.includes('DEFAULT_COVENANT_CARRIER_SOMPI = 20_000_000n') &&
    transactionSource.includes('MIN_COVENANT_CARRIER_SOMPI = 10_000_000n') &&
    transactionSource.includes('STANDARD_REFUND_MIN_SOMPI = 5_000_000n')
);
assert(
  "Registry marker uses low-cost staged funding",
  transactionSource.includes('DEFAULT_RAFFLE_REGISTRY_MARKER_SOMPI = 5_000_000n') &&
    transactionSource.includes('REGISTRY_MARKER_REFUND_FEE_SOMPI = 100_000n') &&
    transactionSource.includes('REGISTRY_PAYMENT_FEE_SOMPI = 300_000n') &&
    transactionSource.includes('const stagingAddress = lowCostFundingAddress(input.wallet.network)') &&
    transactionSource.includes('txIds: [stagingTxId, markerTxId]')
);
assert(
  "V4 covenant fees and compute budgets are mass-tested",
  metadataSource.includes('contractVersion: "raffle-v4-million-users"') &&
    transactionSource.includes('COVENANT_CREATE_FEE_SOMPI = 200_000n') &&
    transactionSource.includes('V4_COVENANT_BUY_FEE_SOMPI = 1_700_000n') &&
    transactionSource.includes('V4_COVENANT_FINALIZE_FEE_SOMPI = 2_200_000n') &&
    transactionSource.includes('V4_COVENANT_REFUND_FEE_SOMPI = 1_900_000n') &&
    transactionSource.includes('V4_RAFFLE_BUY_COMPUTE_BUDGET = 7') &&
    transactionSource.includes('V4_RAFFLE_FINALIZE_COMPUTE_BUDGET = 18') &&
    transactionSource.includes('RAFFLE_PARTICIPANT_AUTH_COMPUTE_BUDGET = 11') &&
    transactionSource.includes('V4_RAFFLE_REFUND_COMPUTE_BUDGET = 7') &&
    packageJson.scripts?.["verify:fees:v4"] === "node scripts/verify-v4-fees.mjs"
);
assert(
  "Visible amount labels use KAS instead of sompi",
  i18nSource.includes('"carrierReserveKas": "Carrier reserve (KAS)"') &&
    !appSource.includes("Carrier reserve (sompi)") &&
    !appSource.includes("KAS (${value.toString()} sompi)") &&
    transactionSource.includes("formatKasAmount(MIN_COVENANT_CARRIER_SOMPI)")
);
assert(
  "Wallet adapter registry supports KasWare and Kastle",
  appSource.includes("connectBrowserWallet") &&
    appSource.includes('t("connectWallet")') &&
    appSource.includes('role="menu" aria-label={t("chooseWallet")}') &&
    walletSource.includes("kasWareWalletAdapter") &&
    walletSource.includes("kastleWalletAdapter") &&
    walletTypesSource.includes("interface KaspaWalletAdapter") &&
    kasWareWalletSource.includes("signPskt") &&
    kasWareWalletSource.includes("requestAccounts") &&
    kastleWalletSource.includes("kas:sign_tx") &&
    kastleWalletSource.includes("kas:connect") &&
    !appSource.includes("privateKeyInput") &&
    !appSource.includes("Import wallet") &&
    !appSource.includes("Generate test wallet")
);
assert(
  "History-loaded testnet rounds recover an open development oracle key",
  appSource.includes("deriveOpenDevOracleKey") &&
    appSource.includes("recoverDevOracleKey") &&
    appSource.includes("signingOracleKey = await recoverDevOracleKey") &&
    appSource.includes("const restoredOraclePrivateKey = await recoverDevOracleKey")
);
assert("Loaded rounds restore local dev oracle keys", appSource.includes("restoreDevOracleKey") && appSource.includes("Oracle key restored; finalize is ready"));
assert("Treasury private key UI removed", !appSource.includes("Treasury private key"));
assert("Manual Pay prize UI removed", !appSource.includes("Pay prize"));
assert("Close round UI removed", !appSource.includes("Close round") && !appSource.includes("handleCloseRound"));
assert("Finalize is gated by covenant readiness", appSource.includes("assertRaffleCovenantReady()"));
assert("Finalize builder is wired", transactionSource.includes("finalizeRaffleCovenantRound") && !appSource.includes("builder is not wired yet"));
assert(
  "Finalize automatically creates a local oracle attestation",
  appSource.includes("finalizeOracleSeed = randomHex(32)") &&
    appSource.includes("signOracleSeed(signingOracleKey, closedRound.ticketRoot, finalizeOracleSeed)") &&
    v4ContractSource.includes("sha256(byte[](ticket_root) + byte[](oracle_seed))")
);
assert(
  "Finalize is allowed only when sold out or timed out",
  contractSource.includes("sold_tickets == max_tickets || tx.locktime >= refund_after_daa") &&
    transactionSource.includes("input.covenant.soldTickets >= input.round.maxTickets")
);
assert(
  "Finalize requires a ticket-holder wallet on chain",
  contractSource.includes("tx.inputs[1].scriptPubKey == byte[](new ScriptPubKeyP2PK(caller_pubkey))") &&
    contractSource.includes("require(caller_is_participant)") &&
    transactionSource.includes("input.wallet.signTransaction(tx, [1])") &&
    appSource.includes("walletIsParticipant")
);
assert(
  "Participant authorization UTXO is returned unchanged",
  contractSource.includes("tx.outputs[2].value == tx.inputs[1].value") &&
    transactionSource.includes("new TransactionOutput(authorizationUtxo.amount, callerScriptPublicKey)")
);
assert(
  "Participant finalize uses the verified v1 fee and signature layout",
  transactionSource.includes("COVENANT_FINALIZE_FEE_SOMPI = 2_000_000n") &&
    transactionSource.includes("covenantFinalizeFeeSompi(closedRound.contractVersion)") &&
    transactionSource.includes("sigOpCount: 0") &&
    transactionSource.includes("tx.finalize();\n    await input.wallet.signTransaction(tx, [1])") &&
    contractSource.includes("value - prize - 2000000")
);
assert(
  "Legacy covenant artifacts remain loadable",
    covenantSource.includes("raffle-round-v1.artifact.json") &&
    covenantSource.includes("raffle-round-v2.artifact.json") &&
    covenantSource.includes("raffle-round-v3-beta.artifact.json") &&
    covenantSource.includes("raffle-round-v3.1.artifact.json") &&
    covenantSource.includes("raffle-round-v3.2.artifact.json") &&
    covenantSource.includes("raffle-round-v3.3.artifact.json") &&
    covenantSource.includes("raffle-round-v3.4.artifact.json") &&
    transactionSource.includes("LEGACY_V3_3_FINALIZE_FEE_SOMPI = 40_000_000n") &&
    transactionSource.includes("LEGACY_V3_3_REFUND_FEE_SOMPI = 20_000_000n") &&
    covenantSource.includes("raffleArtifactForRedeemScript")
);
assert(
  "One million independent users use a compact Merkle state",
  v4ContractSource.includes("max_tickets <= 1000000") &&
    metadataSource.includes("maxTickets > 1_000_000") &&
    v4ContractSource.includes("byte[640] frontier") &&
    v4ContractSource.includes("entrypoint function refundNext") &&
    merkleSource.includes("TICKET_MERKLE_DEPTH = 20") &&
    transactionSource.includes("appendTicketLeaf") &&
    transactionSource.includes("Million-user rounds accept exactly one ticket per purchase") &&
    indexerSource.includes("getVirtualChainFromBlockV2") &&
    indexerSource.includes("owners") &&
    packageJson.scripts?.["verify:users:1m"] === "node scripts/verify-million-users.mjs" &&
    packageJson.scripts?.["verify:indexer"] === "node scripts/verify-indexer.mjs"
);
assert(
  "Million-user and V4 fee verifiers are part of npm verify",
  packageJson.scripts?.["verify:fees:1m"] === "node scripts/verify-million-ticket-fees.mjs" &&
    packageJson.scripts?.verify?.includes("verify-million-ticket-fees.mjs") &&
    packageJson.scripts?.verify?.includes("verify-v4-fees.mjs") &&
    packageJson.scripts?.verify?.includes("verify-million-users.mjs") &&
    packageJson.scripts?.verify?.includes("verify-indexer.mjs")
);
assert(
  "Winner owner is enforced on chain",
  contractSource.includes("byte[32] winner_owner = owner_01") &&
    contractSource.includes("require(byte[32](winner_pubkey) == winner_owner)")
);
assert("Timeout refund builder is wired", transactionSource.includes("refundRaffleCovenantRound") && appSource.includes("handleRefundTimedOutRound"));
assert(
  "Refund is walletless and disabled until live DAA timeout",
  contractSource.includes("require(tx.locktime >= refund_after_daa)") &&
    appSource.includes("const refundAvailable =") &&
    appSource.includes("!refundAvailable") &&
    !transactionSource.match(/interface RefundRaffleCovenantRoundInput[\s\S]{0,200}wallet:/)
);
assert(
  "Default test refund timeout is 10 minutes",
  appSource.includes("DEFAULT_REFUND_TIMEOUT_SECONDS = 10n * SECONDS_PER_MINUTE")
);
assert(
  "Refund timeout is configured as human time parts",
  appSource.includes("REFUND_TIMEOUT_FIELDS") && appSource.includes("formatDurationSeconds")
);
assert("Refund covenant entrypoint is compiled", contractSource.includes("entrypoint function refund_all()") && covenantSource.includes("refund_all"));
assert("Ticket owner pubkeys are persisted", appSource.includes("buyerPubkey") && transactionSource.includes("ticketOwnerPubkeys"));
assert("Raffle covenant source exists", contractSource.includes("contract RaffleRound"));
assert("Manifest targets TN12", manifest.network === "testnet-12");
assert("Manifest names RaffleRound", manifest.contract === "RaffleRound");

const covenantCompiled = artifact.contract === "RaffleRound" && Boolean(artifact.script) && Array.isArray(artifact.abi);

if (covenantCompiled) {
  pass("Runtime covenant artifact compiled", "Finalize may build a covenant spend.");
} else if (requireCovenant) {
  fail(
    "Runtime covenant artifact compiled",
    "Compile src/contracts/raffle_round.sil and commit ABI/script bytes before release verification can pass."
  );
} else {
  fail("Runtime covenant artifact compiled", "Runtime covenant artifact is required for automatic payout.");
}

assert(
  "Covenant status helper enables runtime artifact",
  covenantSource.includes('artifact.contract === "RaffleRoundV4"') &&
    v4Artifact.contract === "RaffleRoundV4" &&
    covenantSource.includes("assertRaffleCovenantReady")
);

for (const check of checks) {
  const marker = check.ok ? "PASS" : "FAIL";
  console.log(`${marker} ${check.name}${check.detail ? ` - ${check.detail}` : ""}`);
}

const failed = checks.filter((check) => !check.ok);

if (failed.length) {
  console.error(`\n${failed.length} verification check${failed.length === 1 ? "" : "s"} failed.`);
  process.exit(1);
}

console.log(`\n${checks.length} verification checks passed.`);
