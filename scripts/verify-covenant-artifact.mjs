import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const round = JSON.parse(fs.readFileSync(path.join(root, "src/contracts/compiled/raffle-round-v5.artifact.json"), "utf8"));
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

verifyArtifact(round, "RaffleRoundV5", ["buy", "finalize", "startRefund"]);
verifyArtifact(refund, "RaffleRefundV1", ["refundBatch8", "refundNext"]);

const buy = round.abi.find((entry) => entry.name === "buy");
assert(JSON.stringify(buy?.inputs.map((input) => input.type_name)) === JSON.stringify(["pubkey", "int"]), "V7 buy ABI supports aligned batch quantity");
assert(round.scriptLength < 7_500, "V7 round script remains below 7.5 KB");
const finalize = round.abi.find((entry) => entry.name === "finalize");
assert(finalize?.inputs.filter((input) => input.type_name === "datasig").length === 3, "V7 finalize requires three oracle signatures");
assert(round.stateFields.filter((field) => field.name.startsWith("oracle_commitment")).length === 3, "V7 state locks three pre-sale seed commitments");
assert(round.stateFields.some((field) => field.name === "frontier" && field.type === "byte[640]"), "V7 stores the depth-20 append frontier");
assert(/COVENANT_CREATE_FEE_SOMPI = 300_000n/.test(transactionSource), "V7 create fee covers the observed 2,924-gram relay floor");
assert(/REGISTRY_PAYMENT_FEE_SOMPI = 350_000n/.test(transactionSource), "V7 registry marker fee covers the observed 3,474-gram relay floor");

console.log("Current-only covenant artifact checks passed.");
