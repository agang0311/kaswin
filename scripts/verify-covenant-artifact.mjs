import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const round = JSON.parse(fs.readFileSync(path.join(root, "src/contracts/compiled/raffle-round-v10.artifact.json"), "utf8"));
const refund = JSON.parse(fs.readFileSync(path.join(root, "src/contracts/compiled/raffle-refund-v1.artifact.json"), "utf8"));
const transactionSource = fs.readFileSync(path.join(root, "src/kaspa/transactions.ts"), "utf8");
const networkSource = fs.readFileSync(path.join(root, "src/kaspa/networks.ts"), "utf8");

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

verifyArtifact(round, "RaffleRoundV10", ["buy", "finalize", "startRefund"]);
verifyArtifact(refund, "RaffleRefundV1", ["refundBatch8", "refundNext"]);
const buy = round.abi.find((entry) => entry.name === "buy");
assert(JSON.stringify(buy?.inputs.map((input) => input.type_name)) === JSON.stringify(["pubkey", "int"]), `${round.contract} buy ABI supports batch quantity`);
assert(round.scriptLength < 7_500, `${round.contract} script remains below 7.5 KB`);
const finalize = round.abi.find((entry) => entry.name === "finalize");
assert(finalize?.inputs[0]?.name === "target_before_daa" && finalize.inputs[0].type_name === "byte[]", `${round.contract} finalize accepts the selected-chain header witness`);
assert(finalize?.inputs.length === 15 && finalize.inputs[11]?.name === "finalize_fee", `${round.contract} finalize exposes one chain witness, its actual fee, and one winner proof`);
assert(!round.abi.some((entry) => entry.name === "close"), `${round.contract} has no separate close transition`);
assert(!round.stateFields.some((field) => field.name.startsWith("oracle_") || field.name.startsWith("random_anchor_")), `${round.contract} has no oracle or close-anchor state`);
assert(round.stateFields.some((field) => field.name === "frontier" && field.type === "byte[640]"), `${round.contract} stores the depth-20 append frontier`);
assert(/COVENANT_CREATE_FEE_SOMPI = 300_000n/.test(transactionSource), "create fee covers the observed relay floor");
assert(/REGISTRY_PAYMENT_FEE_SOMPI = 350_000n/.test(transactionSource), "registry marker fee covers the observed relay floor");
assert(/toccataActivationDaaScore: "474165565"/.test(networkSource), "Mainnet broadcasts are gated by the official Toccata activation DAA");

console.log("Current-only covenant artifact checks passed.");
