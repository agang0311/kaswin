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
const appSource = readText("src/app/App.tsx");
const covenantSource = readText("src/kaspa/covenant.ts");
const transactionSource = readText("src/kaspa/transactions.ts");
const metadataSource = readText("src/raffle/metadata.ts");
const contractSource = readText("src/contracts/raffle_round.sil");

assert("Build script exists", packageJson.scripts?.build === "tsc --noEmit && vite build");
assert("Default TN12 wRPC is present", appSource.includes("ws://tn12-node.kaspa.com:17210"));
assert("Default ticket price is 0.2 KAS", metadataSource.includes('ticketPrice: "20000000"'));
assert("Browser ticket payment path exists", transactionSource.includes("createTransactions") && appSource.includes("handleBuyTicket"));
assert("Share-link round import exists", appSource.includes("handleCopyRoundLink") && appSource.includes("loadSharedRoundFromUrl"));
assert("Treasury private key UI removed", !appSource.includes("Treasury private key"));
assert("Manual Pay prize UI removed", !appSource.includes("Pay prize"));
assert("Finalize is gated by covenant readiness", appSource.includes("assertRaffleCovenantReady()"));
assert("Raffle covenant source exists", contractSource.includes("contract RaffleRound"));
assert("Manifest targets TN12", manifest.network === "testnet-12");
assert("Manifest names RaffleRound", manifest.contract === "RaffleRound");

const covenantCompiled = manifest.status === "compiled" && Boolean(manifest.script) && Boolean(manifest.abi);

if (covenantCompiled) {
  pass("Covenant artifact compiled", "Finalize may build a covenant spend.");
} else if (requireCovenant) {
  fail(
    "Covenant artifact compiled",
    "Compile src/contracts/raffle_round.sil and commit ABI/script bytes before release verification can pass."
  );
} else {
  pass("Covenant artifact gate is red by design", "Current manifest is source-only, so automatic payout remains disabled.");
}

assert(
  "Covenant status helper blocks source-only manifests",
  covenantSource.includes('manifest.status === "compiled"') && covenantSource.includes("assertRaffleCovenantReady")
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
