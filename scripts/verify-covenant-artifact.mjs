import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const artifactPath = path.join(root, "src", "contracts", "compiled", "raffle-round.artifact.json");
const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

let failures = 0;

function pass(name, detail = "") {
  console.log(`PASS ${name}${detail ? ` - ${detail}` : ""}`);
}

function fail(name, detail = "") {
  failures += 1;
  console.error(`FAIL ${name}${detail ? ` - ${detail}` : ""}`);
}

function assert(name, condition, detail = "") {
  if (condition) {
    pass(name, detail);
  } else {
    fail(name, detail);
  }
}

function hexToBytes(hex) {
  if (!/^[0-9a-f]*$/i.test(hex) || hex.length % 2 !== 0) {
    throw new Error("invalid hex");
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

const script = hexToBytes(artifact.script);
const stateStart = artifact.stateLayout.start;
const stateEnd = stateStart + artifact.stateLayout.len;
const stateSlice = script.slice(stateStart, stateEnd);
const expectedZeroState = new Uint8Array(
  artifact.stateFields.reduce((total, field) => {
    if (field.type === "int") {
      return total + 9;
    }

    if (field.type === "byte[32]") {
      return total + 33;
    }

    return total;
  }, 0)
);

let expectedOffset = 0;
for (const field of artifact.stateFields) {
  if (field.type === "int") {
    expectedZeroState[expectedOffset] = 8;
    expectedOffset += 9;
  } else if (field.type === "byte[32]") {
    expectedZeroState[expectedOffset] = 32;
    expectedOffset += 33;
  }
}

const abiSelectors = Object.fromEntries(artifact.abi.map((entry) => [entry.name, entry.selector]));
const buy = artifact.abi.find((entry) => entry.name === "buy");
const finalize = artifact.abi.find((entry) => entry.name === "finalize");
const refundAll = artifact.abi.find((entry) => entry.name === "refund_all");
const expectedStateFields = [
  "max_tickets:int",
  "ticket_price:int",
  "creator_pubkey:byte[32]",
  "oracle_pubkey:byte[32]",
  "refund_after_daa:int",
  "sold_tickets:int",
  "sold_batches:int",
  "ticket_root:byte[32]",
  ...Array.from({ length: 20 }, (_, index) => `batch_end_${String(index + 1).padStart(2, "0")}:int`),
  ...Array.from({ length: 20 }, (_, index) => `owner_${String(index + 1).padStart(2, "0")}:byte[32]`)
];

assert("Runtime artifact names RaffleRound", artifact.contract === "RaffleRound");
assert("Runtime artifact script length matches bytes", script.length === artifact.scriptLength, `${script.length} bytes`);
assert(
  "Runtime artifact has timeout refund state fields",
  JSON.stringify(artifact.stateFields.map((field) => `${field.name}:${field.type}`)) === JSON.stringify(expectedStateFields)
);
assert("Runtime artifact state layout length matches field encoding", artifact.stateLayout.len === expectedZeroState.length);
assert("Compiled default state segment matches zero state encoding", Buffer.compare(Buffer.from(stateSlice), Buffer.from(expectedZeroState)) === 0);
assert("Buy selector is 0", abiSelectors.buy === 0);
assert("Close selector is 1", abiSelectors.close === 1);
assert("Finalize selector is 2", abiSelectors.finalize === 2);
assert("Refund-all selector is 3", abiSelectors.refund_all === 3);
assert(
  "Buy ABI uses ticket root, owner pubkey, and batch quantity",
  JSON.stringify(buy?.inputs.map((input) => input.type_name)) === JSON.stringify(["byte[32]", "pubkey", "int"])
);
assert(
  "Finalize ABI uses oracle signature, seed, winner id, payout pubkey, and participant pubkey",
  JSON.stringify(finalize?.inputs.map((input) => input.type_name)) === JSON.stringify(["datasig", "byte[32]", "int", "pubkey", "pubkey"])
);
assert("Refund-all ABI takes no arguments", JSON.stringify(refundAll?.inputs.map((input) => input.type_name)) === JSON.stringify([]));

if (failures > 0) {
  console.error(`\n${failures} covenant artifact check${failures === 1 ? "" : "s"} failed.`);
  process.exit(1);
}

console.log("\nCovenant artifact checks passed.");
