import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const round = JSON.parse(fs.readFileSync(path.join(root, "src/contracts/compiled/raffle-round-v5.artifact.json"), "utf8"));
const refund = JSON.parse(fs.readFileSync(path.join(root, "src/contracts/compiled/raffle-refund-v1.artifact.json"), "utf8"));

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
assert(JSON.stringify(buy?.inputs.map((input) => input.type_name)) === JSON.stringify(["pubkey", "int"]), "V6 buy ABI supports aligned batch quantity");
assert(round.scriptLength < 7_000, "V6 round script remains below 7 KB");
assert(round.stateFields.some((field) => field.name === "frontier" && field.type === "byte[640]"), "V6 stores the depth-20 append frontier");

console.log("Current-only covenant artifact checks passed.");
