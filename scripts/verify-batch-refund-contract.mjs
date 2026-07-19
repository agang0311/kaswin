import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { initSync, payToScriptHashScript } from "@onekeyfe/kaspa-wasm/kaspa.js";

const root = process.cwd();
const requireFromScript = createRequire(import.meta.url);
const kaspaPackageDirectory = path.dirname(requireFromScript.resolve("@onekeyfe/kaspa-wasm/kaspa.js"));
const refundSource = path.join(root, "src/contracts/raffle_refund_v16.sil");
const roundSource = path.join(root, "src/contracts/raffle_round_v16.sil");
const refundArtifact = JSON.parse(fs.readFileSync(path.join(root, "src/contracts/compiled/raffle-refund-v16.artifact.json"), "utf8"));
const debuggerDir = path.join(root, ".tools/silverscript/target/debug");
const debuggerPath = path.join(debuggerDir, process.platform === "win32" ? "cli-debugger.exe" : "cli-debugger");

initSync({ module: fs.readFileSync(path.join(kaspaPackageDirectory, "kaspa_bg.wasm.bin")) });

const owner = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const covenantId = `0x${"11".repeat(32)}`;
const ticketPrice = 30_000_000;
const carrier = 57_000_000;
const transitionFee = 4_545_400;
const refundFee = 4_000_000;
const batches = Array.from({ length: 15 }, (_, index) => ({
  first: (index * (index + 1)) / 2,
  count: index + 1
}));
const soldTickets = batches.reduce((sum, batch) => sum + batch.count, 0);

function hash(bytes) { return createHash("sha256").update(bytes).digest(); }
function pair(left, right) { return hash(Buffer.concat([left, right])); }
function u64(value) { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(value)); return bytes; }
function leaf(batch) { return hash(Buffer.concat([Buffer.from(owner, "hex"), u64(batch.first), u64(batch.count)])); }

const emptyNodes = [Buffer.alloc(32)];
for (let level = 1; level <= 20; level += 1) emptyNodes.push(pair(emptyNodes[level - 1], emptyNodes[level - 1]));

function buildTree(records) {
  let nodes = records.map(leaf);
  const levels = [nodes];
  for (let level = 0; level < 20; level += 1) {
    const parents = [];
    for (let index = 0; index < nodes.length; index += 2) parents.push(pair(nodes[index], nodes[index + 1] ?? emptyNodes[level]));
    nodes = parents;
    levels.push(nodes);
  }
  return { root: nodes[0], levels };
}

function proof(tree, batchIndex) {
  let pathIndex = batchIndex;
  const siblings = [];
  for (let level = 0; level < 20; level += 1) {
    siblings.push(tree.levels[level][pathIndex ^ 1] ?? emptyNodes[level]);
    pathIndex >>= 1;
  }
  return Buffer.concat(siblings);
}

function refundState(refundCursor, refundBatchCursor, rootHash) {
  return {
    ticket_price: ticketPrice,
    creator_pubkey: `0x${owner}`,
    sold_tickets: soldTickets,
    sold_batches: batches.length,
    ticket_root: `0x${rootHash.toString("hex")}`,
    refund_cursor: refundCursor,
    refund_batch_cursor: refundBatchCursor
  };
}

function roundState(rootHash) {
  return {
    max_tickets: soldTickets,
    ticket_price: ticketPrice,
    creator_pubkey: `0x${owner}`,
    refund_after_daa: 1_000,
    sold_tickets: soldTickets,
    sold_batches: batches.length,
    ticket_root: `0x${rootHash.toString("hex")}`,
    frontier: `0x${"00".repeat(640)}`,
    refund_cursor: 0,
    refund_batch_cursor: 0
  };
}

function emptyRoundState() {
  return {
    max_tickets: 1_000,
    ticket_price: ticketPrice,
    creator_pubkey: `0x${owner}`,
    refund_after_daa: 1_000,
    sold_tickets: 0,
    sold_batches: 0,
    ticket_root: `0x${emptyNodes[20].toString("hex")}`,
    frontier: `0x${"00".repeat(640)}`,
    refund_cursor: 0,
    refund_batch_cursor: 0
  };
}

function roundStateAfterArbitraryBuy(batch) {
  const singleTree = buildTree([batch]);
  const frontier = Buffer.alloc(640);
  leaf(batch).copy(frontier, 0);
  return {
    ...emptyRoundState(),
    sold_tickets: batch.count,
    sold_batches: 1,
    ticket_root: `0x${singleTree.root.toString("hex")}`,
    frontier: `0x${frontier.toString("hex")}`
  };
}

function scriptI64(value) {
  const bytes = u64(value);
  return Buffer.concat([Buffer.from([8]), bytes]);
}

function pushData(bytes) {
  if (bytes.length <= 75) return Buffer.from([bytes.length, ...bytes]);
  if (bytes.length <= 0xff) return Buffer.from([0x4c, bytes.length, ...bytes]);
  return Buffer.from([0x4d, bytes.length & 0xff, bytes.length >> 8, ...bytes]);
}

function materializeRefund(state) {
  const values = {
    ticket_price: scriptI64(state.ticket_price),
    creator_pubkey: pushData(Buffer.from(state.creator_pubkey.slice(2), "hex")),
    sold_tickets: scriptI64(state.sold_tickets),
    sold_batches: scriptI64(state.sold_batches),
    ticket_root: pushData(Buffer.from(state.ticket_root.slice(2), "hex")),
    refund_cursor: scriptI64(state.refund_cursor),
    refund_batch_cursor: scriptI64(state.refund_batch_cursor)
  };
  const serialized = Buffer.concat(refundArtifact.stateFields.map((field) => values[field.name]));
  if (serialized.length !== refundArtifact.stateLayout.len) throw new Error("Refund state layout mismatch.");
  const script = Buffer.from(refundArtifact.script, "hex");
  serialized.copy(script, refundArtifact.stateLayout.start);
  return script;
}

function ownerOutput(value) { return { value, p2pk_pubkey: `0x${owner}` }; }
const tree = buildTree(batches);
const initial = refundState(0, 0, tree.root);
const maxBatchCount = 13;
const firstRefundTicketCount = batches.slice(0, maxBatchCount).reduce((sum, batch) => sum + batch.count, 0);
const afterMaximumBatch = refundState(firstRefundTicketCount, maxBatchCount, tree.root);
const carrierAfterTransition = carrier - transitionFee;
const totalValue = carrierAfterTransition + ticketPrice * soldTickets;
const firstRefundValue = ticketPrice * firstRefundTicketCount;
const finalBatches = batches.slice(maxBatchCount);
const finalTicketCount = finalBatches.reduce((sum, batch) => sum + batch.count, 0);
const finalValue = ticketPrice * finalTicketCount;

function packedArgs(selectedBatches, startIndex) {
  return [
    refundFee,
    selectedBatches.length,
    `0x${Buffer.concat(selectedBatches.map(() => Buffer.from(owner, "hex"))).toString("hex")}`,
    `0x${Buffer.concat(selectedBatches.map((batch) => u64(batch.count))).toString("hex")}`,
    `0x${Buffer.concat(selectedBatches.map((_, offset) => proof(tree, startIndex + offset))).toString("hex")}`
  ];
}

function refundOutputs(selectedBatches, hasSuccessor, covenantValue, nextState) {
  const feePerBatch = Math.floor(refundFee / selectedBatches.length);
  const feeRemainder = refundFee % selectedBatches.length;
  const outputs = selectedBatches.map((batch, index) => ownerOutput(
    ticketPrice * batch.count - feePerBatch - (index === 0 ? feeRemainder : 0)
  ));
  if (hasSuccessor) {
    const refundedValue = selectedBatches.reduce((sum, batch) => sum + ticketPrice * batch.count, 0);
    outputs.unshift({ value: covenantValue - refundedValue, covenant_id: covenantId, authorizing_input: 0, state: nextState });
  } else {
    outputs.push(ownerOutput(carrierAfterTransition));
  }
  return outputs;
}

const refundTests = { tests: [
  {
    name: "legacy_v16_refund_abi_accepts_maximum_13_purchase_batches_in_one_transaction",
    function: "refundNext",
    args: packedArgs(batches.slice(0, maxBatchCount), 0),
    expect: "pass",
    tx: {
      active_input_index: 0,
      inputs: [{ utxo_value: totalValue, covenant_id: covenantId, state: initial }],
      outputs: refundOutputs(batches.slice(0, maxBatchCount), true, totalValue, afterMaximumBatch)
    }
  },
  {
    name: "loaded_refund_cursor_finishes_remaining_purchase_batches",
    function: "refundNext",
    args: packedArgs(finalBatches, maxBatchCount),
    expect: "pass",
    tx: {
      active_input_index: 0,
      inputs: [{ utxo_value: carrierAfterTransition + finalValue, covenant_id: covenantId, state: afterMaximumBatch }],
      outputs: refundOutputs(finalBatches, false, carrierAfterTransition + finalValue)
    }
  },
  {
    name: "wrong_batch_proof_is_rejected",
    function: "refundNext",
    args: [refundFee, 1, `0x${owner}`, `0x${u64(batches[0].count).toString("hex")}`, `0x${Buffer.alloc(640, 0x55).toString("hex")}`],
    expect: "fail",
    tx: { active_input_index: 0, inputs: [{ utxo_value: totalValue, covenant_id: covenantId, state: initial }], outputs: [] }
  }
] };

const refundPrefix = Buffer.from(refundArtifact.script, "hex").subarray(0, refundArtifact.stateLayout.start);
const refundSuffix = Buffer.from(refundArtifact.script, "hex").subarray(refundArtifact.stateLayout.start + refundArtifact.stateLayout.len);
const refundOutputScript = payToScriptHashScript(materializeRefund(initial)).toJSON().script;
const arbitraryPurchase = { first: 0, count: 37 };
const transitionTests = { tests: [{
  name: "buy_arbitrary_37_ticket_quantity",
  function: "buy",
  args: [`0x${owner}`, arbitraryPurchase.count],
  expect: "pass",
  tx: {
    active_input_index: 0,
    inputs: [{ utxo_value: carrier, covenant_id: covenantId, state: emptyRoundState() }],
    outputs: [{
      value: carrier + ticketPrice * arbitraryPurchase.count,
      covenant_id: covenantId,
      authorizing_input: 0,
      state: roundStateAfterArbitraryBuy(arbitraryPurchase)
    }]
  }
}, {
  name: "timed_out_round_enters_batch_refund_contract",
  function: "startRefund",
  args: [transitionFee, `0x${refundPrefix.toString("hex")}`, `0x${refundSuffix.toString("hex")}`],
  expect: "pass",
  tx: {
    version: 1,
    lock_time: 1_000,
    active_input_index: 0,
    inputs: [{ utxo_value: carrier + ticketPrice * soldTickets, covenant_id: covenantId, state: roundState(tree.root) }],
    outputs: [{ value: totalValue, covenant_id: covenantId, authorizing_input: 0, script_hex: refundOutputScript }]
  }
}] };

function run(source, name, tests) {
  const testPath = path.join(root, `.tmp/${name}.test.json`);
  fs.mkdirSync(path.dirname(testPath), { recursive: true });
  fs.writeFileSync(testPath, `${JSON.stringify(tests, null, 2)}\n`);
  const result = spawnSync(debuggerPath, [source, "--run-all", "--test-file", testPath], { cwd: root, encoding: "utf8" });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!fs.existsSync(debuggerPath)) throw new Error("Build the SilverScript cli-debugger before running refund VM tests.");
run(refundSource, "raffle_refund_v16", refundTests);
run(roundSource, "raffle_round_v16_transition", transitionTests);
console.log("Arbitrary purchase counts refund in the largest supported consecutive on-chain batch.");
