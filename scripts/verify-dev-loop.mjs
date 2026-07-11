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
const appSource = readText("src/app/App.tsx");
const covenantSource = readText("src/kaspa/covenant.ts");
const transactionSource = readText("src/kaspa/transactions.ts");
const metadataSource = readText("src/raffle/metadata.ts");
const contractSource = readText("src/contracts/raffle_round.sil");
const viteSource = readText("vite.config.ts");
const wasmSource = readText("src/kaspa/wasm.ts");
const distFiles = fs.existsSync(path.join(root, "dist")) ? fs.readdirSync(path.join(root, "dist")) : [];
const distHtml = distFiles.includes("index.html") ? readText("dist/index.html") : "";

assert("Single-file SPA build exists", packageJson.scripts?.build === "tsc --noEmit && vite build && node scripts/inline-spa.mjs");
assert("Build output is one self-contained HTML file", JSON.stringify(distFiles) === JSON.stringify(["index.html"]));
assert("Kaspa WASM is embedded in the SPA", distHtml.includes("data:application/octet-stream;base64"));
assert(
  "Browser WASM loader bypasses the package CommonJS require",
  viteSource.includes("patchOneKeyBrowserWasmLoader") &&
    wasmSource.includes("kaspa_bg.wasm.bin?url") &&
    wasmSource.includes("module_or_path: bytes")
);
assert("Contract compile script exists", packageJson.scripts?.["compile:contract"] === "node scripts/compile-raffle-contract.mjs");
assert("Default TN12 wRPC is present", appSource.includes("ws://tn12-node.kaspa.com:18210"));
assert("Default ticket price is 0.3 KAS", metadataSource.includes('ticketPrice: "30000000"'));
assert("Default round has 10 tickets", metadataSource.includes("maxTickets: 10"));
assert("Browser covenant ticket path exists", transactionSource.includes("buyRaffleCovenantTicket") && appSource.includes("handleBuyTicket"));
assert("Share-link round import exists", appSource.includes("handleCopyRoundLink") && appSource.includes("loadSharedRoundFromUrl"));
assert(
  "Round source and action workflows use peer tab bars",
  appSource.includes('role="tablist" aria-label="Create or load a round"') &&
    appSource.includes('role="tablist" aria-label="Participate or pay out"') &&
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
  "Visible amount labels use KAS instead of sompi",
  appSource.includes("Carrier reserve (KAS)") &&
    !appSource.includes("Carrier reserve (sompi)") &&
    !appSource.includes("KAS (${value.toString()} sompi)") &&
    transactionSource.includes("formatKasAmount(MIN_COVENANT_CARRIER_SOMPI)")
);
assert("Loaded rounds restore local dev oracle keys", appSource.includes("restoreDevOracleKey") && appSource.includes("Oracle key restored; finalize is ready"));
assert("Treasury private key UI removed", !appSource.includes("Treasury private key"));
assert("Manual Pay prize UI removed", !appSource.includes("Pay prize"));
assert("Close round UI removed", !appSource.includes("Close round") && !appSource.includes("handleCloseRound"));
assert("Finalize is gated by covenant readiness", appSource.includes("assertRaffleCovenantReady()"));
assert("Finalize builder is wired", transactionSource.includes("finalizeRaffleCovenantRound") && !appSource.includes("builder is not wired yet"));
assert(
  "Finalize automatically creates a local oracle attestation",
  appSource.includes("finalizeOracleSeed = randomHex(32)") && appSource.includes("signOracleSeed(oraclePrivateKey, finalizeOracleSeed)")
);
assert(
  "Finalize is allowed only when sold out or timed out",
  contractSource.includes("sold_tickets == max_tickets || tx.locktime >= refund_after_daa") &&
    transactionSource.includes("input.covenant.soldTickets >= input.round.maxTickets")
);
assert(
  "Legacy covenant artifacts remain loadable",
    covenantSource.includes("raffle-round-v1.artifact.json") &&
    covenantSource.includes("raffle-round-v2.artifact.json") &&
    covenantSource.includes("raffle-round-v3-beta.artifact.json") &&
    covenantSource.includes("raffleArtifactForRedeemScript")
);
assert(
  "Batch purchases scale to 1000 tickets",
  contractSource.includes("max_tickets <= 1000") &&
    contractSource.includes("sold_batches < 20") &&
    transactionSource.includes("ticketCount: number") &&
    transactionSource.includes("lowCostFundingAmount(purchaseAmount, COVENANT_BUY_FEE_SOMPI)")
);
assert(
  "Winner owner is enforced on chain",
  contractSource.includes("byte[32] winner_owner = owner_01") &&
    contractSource.includes("require(byte[32](winner_pubkey) == winner_owner)")
);
assert("Timeout refund builder is wired", transactionSource.includes("refundRaffleCovenantRound") && appSource.includes("handleRefundTimedOutRound"));
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
  covenantSource.includes('artifact.contract === "RaffleRound"') && covenantSource.includes("assertRaffleCovenantReady")
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
