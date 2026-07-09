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
const expectedZeroState = new Uint8Array(artifact.stateFields.length * 9);

for (let offset = 0; offset < expectedZeroState.length; offset += 9) {
  expectedZeroState[offset] = 8;
}

const abiSelectors = Object.fromEntries(artifact.abi.map((entry) => [entry.name, entry.selector]));
const finalize = artifact.abi.find((entry) => entry.name === "__covenant_entrypoint_auth_finalize");

assert("Runtime artifact names RaffleRound", artifact.contract === "RaffleRound");
assert("Runtime artifact script length matches bytes", script.length === artifact.scriptLength, `${script.length} bytes`);
assert("Runtime artifact has 103 int state fields", artifact.stateFields.length === 103);
assert("Runtime artifact state layout length matches int chunks", artifact.stateLayout.len === artifact.stateFields.length * 9);
assert("Compiled default state segment matches zero int encoding", Buffer.compare(Buffer.from(stateSlice), Buffer.from(expectedZeroState)) === 0);
assert("Buy selector is 0", abiSelectors.__covenant_entrypoint_auth_buy === 0);
assert("Close selector is 1", abiSelectors.__covenant_entrypoint_auth_close === 1);
assert("Finalize selector is 2", abiSelectors.__covenant_entrypoint_auth_finalize === 2);
assert("Refund selector is 3", abiSelectors.__covenant_entrypoint_auth_enter_refunding === 3);
assert(
  "Finalize ABI uses empty State array and byte[34] payout script",
  JSON.stringify(finalize?.inputs.map((input) => input.type_name)) === JSON.stringify(["State[]", "byte[32]", "int", "byte[34]"])
);

if (failures > 0) {
  console.error(`\n${failures} covenant artifact check${failures === 1 ? "" : "s"} failed.`);
  process.exit(1);
}

console.log("\nCovenant artifact checks passed.");
