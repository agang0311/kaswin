import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const rounds = [
  ["RaffleRoundV8Mainnet", JSON.parse(fs.readFileSync(path.join(root, "src/contracts/compiled/raffle-round-v8-mainnet.artifact.json"), "utf8"))],
  ["RaffleRoundV8Tn12", JSON.parse(fs.readFileSync(path.join(root, "src/contracts/compiled/raffle-round-v8-tn12.artifact.json"), "utf8"))]
];
const refund = JSON.parse(fs.readFileSync(path.join(root, "src/contracts/compiled/raffle-refund-v1.artifact.json"), "utf8"));
const transactionSource = fs.readFileSync(path.join(root, "src/kaspa/transactions.ts"), "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`PASS ${message}`);
}

function verifyArtifact(artifact, contract, entrypoints) {
  const script = Buffer.from(artifact.script, "hex");
  assert(artifact.contract === contract, `${contract} artifact names the expected contract`);
  assert(script.length === artifact.scriptLength, `${contract} script length matches its artifact`);
  assert(artifact.stateLayout.start + artifact.stateLayout.len <= script.length, `${contract} state layout is inside the script`);
  assert(entrypoints.every((name, selector) => artifact.abi.some((entry) => entry.name === name && entry.selector === selector)), `${contract} ABI selectors are stable`);
}

for (const [contract, round] of rounds) verifyArtifact(round, contract, ["buy", "close", "finalize", "startRefund"]);
verifyArtifact(refund, "RaffleRefundV1", ["refundBatch8", "refundNext"]);

for (const [, round] of rounds) {
  const buy = round.abi.find((entry) => entry.name === "buy");
  assert(JSON.stringify(buy?.inputs.map((input) => input.type_name)) === JSON.stringify(["pubkey", "int"]), `${round.contract} buy ABI supports batch quantity`);
  assert(round.scriptLength < 7_500, `${round.contract} script remains below 7.5 KB`);
  const finalize = round.abi.find((entry) => entry.name === "finalize");
  assert(finalize?.inputs.some((input) => input.name === "seal" && input.type_name === "byte[]"), `${round.contract} finalize accepts a succinct RISC Zero seal`);
  assert(!round.stateFields.some((field) => field.name.startsWith("oracle_")), `${round.contract} has no legacy oracle state`);
  assert(round.stateFields.some((field) => field.name === "frontier" && field.type === "byte[640]"), `${round.contract} stores the depth-20 append frontier`);
}
assert(/COVENANT_CREATE_FEE_SOMPI = 300_000n/.test(transactionSource), "create fee covers the observed relay floor");
assert(/REGISTRY_PAYMENT_FEE_SOMPI = 350_000n/.test(transactionSource), "registry marker fee covers the observed relay floor");

console.log("Current-only covenant artifact checks passed.");
