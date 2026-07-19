import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { initSync, payToScriptHashScript } from "@onekeyfe/kaspa-wasm/kaspa.js";

const root = process.cwd();
const requireFromScript = createRequire(import.meta.url);
const kaspaDirectory = path.dirname(requireFromScript.resolve("@onekeyfe/kaspa-wasm/kaspa.js"));
const roundSource = path.join(root, "src/contracts/raffle_round_vnext.sil");
const refundSource = path.join(root, "src/contracts/raffle_refund_vnext.sil");
const roundArtifact = JSON.parse(fs.readFileSync(path.join(root, "src/contracts/compiled/raffle-round-vnext.artifact.json"), "utf8"));
const refundArtifact = JSON.parse(fs.readFileSync(path.join(root, "src/contracts/compiled/raffle-refund-vnext.artifact.json"), "utf8"));
const debuggerPath = path.join(root, ".tools/silverscript/target/debug", process.platform === "win32" ? "cli-debugger.exe" : "cli-debugger");
const transactionsSource = fs.readFileSync(path.join(root, "src/kaspa/transactions.ts"), "utf8");

function sourceBudget(name) {
  const match = transactionsSource.match(new RegExp(`export const ${name} = (\\d+);`));
  if (!match) throw new Error(`Missing exported compute-budget constant ${name}.`);
  return Number(match[1]);
}
const committedBudgets = {
  buy: sourceBudget("RAFFLE_BUY_COMPUTE_BUDGET"),
  topUp: sourceBudget("RAFFLE_TOP_UP_COMPUTE_BUDGET"),
  startRefund: sourceBudget("GROUPED_REFUND_TRANSITION_COMPUTE_BUDGET"),
  closeEmpty: sourceBudget("RAFFLE_CLOSE_EMPTY_COMPUTE_BUDGET"),
  refundBase: sourceBudget("GROUPED_REFUND_BASE_COMPUTE_BUDGET"),
  refundPerBatch: sourceBudget("GROUPED_REFUND_PER_BATCH_COMPUTE_BUDGET"),
  refundMax: sourceBudget("GROUPED_REFUND_MAX_COMPUTE_BUDGET")
};

initSync({ module: fs.readFileSync(path.join(kaspaDirectory, "kaspa_bg.wasm.bin")) });

const owner = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const nonce = "42".repeat(32);
const covenantId = `0x${"11".repeat(32)}`;
const ticketPrice = 100_000_000;
const carrier = 200_000_000;
const minimumCarrier = 57_300_000;
const deadline = 1_000;
const transitionFee = 1_000_000;
const refundFee = 500_000;
const domain = Buffer.from("KASPA_RAFFLE_BATCH_V2", "ascii");

function hash(bytes) { return createHash("sha256").update(bytes).digest(); }
function pair(left, right) { return hash(Buffer.concat([left, right])); }
function u64(value) { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(value)); return bytes; }
function leaf(batch) { return hash(Buffer.concat([domain, Buffer.from(nonce, "hex"), Buffer.from(owner, "hex"), u64(batch.first), u64(batch.count)])); }
function pushData(bytes) {
  if (bytes.length <= 75) return Buffer.from([bytes.length, ...bytes]);
  if (bytes.length <= 0xff) return Buffer.from([0x4c, bytes.length, ...bytes]);
  return Buffer.from([0x4d, bytes.length & 0xff, bytes.length >> 8, ...bytes]);
}
function scriptI64(value) { return Buffer.concat([Buffer.from([8]), u64(value)]); }

const emptyNodes = [Buffer.alloc(32)];
for (let level = 1; level <= 20; level += 1) emptyNodes.push(pair(emptyNodes[level - 1], emptyNodes[level - 1]));
function tree(records) {
  let nodes = records.map(leaf);
  const levels = [nodes];
  for (let level = 0; level < 20; level += 1) {
    const parents = [];
    for (let index = 0; index < nodes.length; index += 2) parents.push(pair(nodes[index], nodes[index + 1] ?? emptyNodes[level]));
    nodes = parents; levels.push(nodes);
  }
  return { root: nodes[0], levels };
}
function frontierAndRoot(records) {
  const frontier = Buffer.alloc(640);
  let root = emptyNodes[20];
  for (let batchIndex = 0; batchIndex < records.length; batchIndex += 1) {
    let node = leaf(records[batchIndex]);
    let pathIndex = batchIndex;
    let carrying = true;
    let emptyNode = Buffer.alloc(32);
    for (let level = 0; level < 20; level += 1) {
      const start = level * 32;
      if (pathIndex % 2 === 0) {
        if (carrying) {
          node.copy(frontier, start);
          carrying = false;
        }
        node = pair(node, emptyNode);
      } else {
        node = pair(frontier.subarray(start, start + 32), node);
      }
      emptyNode = pair(emptyNode, emptyNode);
      pathIndex >>= 1;
    }
    root = node;
  }
  return { frontier, root };
}
function proof(fullTree, batchIndex) {
  const siblings = [];
  let pathIndex = batchIndex;
  for (let level = 0; level < 20; level += 1) { siblings.push(fullTree.levels[level][pathIndex ^ 1] ?? emptyNodes[level]); pathIndex >>= 1; }
  return Buffer.concat(siblings);
}
function roundState({ maxTickets = 100, minTickets = 4, maxBatches = 2, batches = [], soldTickets = batches.reduce((sum, batch) => sum + batch.count, 0) } = {}) {
  const appendState = batches.length ? frontierAndRoot(batches) : undefined;
  return {
    round_nonce: `0x${nonce}`, max_tickets: maxTickets, min_tickets: minTickets, max_batches: maxBatches,
    ticket_price: ticketPrice, creator_pubkey: `0x${owner}`, sales_deadline_daa: deadline,
    sold_tickets: soldTickets, sold_batches: batches.length, ticket_root: `0x${(appendState?.root ?? emptyNodes[20]).toString("hex")}`,
    frontier: `0x${(appendState?.frontier ?? Buffer.alloc(640)).toString("hex")}`, refund_cursor: 0, refund_batch_cursor: 0
  };
}
function refundState(batches, refundCursor = 0, refundBatchCursor = 0, refundFeeDebt = 0) {
  const fullTree = tree(batches);
  return {
    round_nonce: `0x${nonce}`, ticket_price: ticketPrice, creator_pubkey: `0x${owner}`,
    sold_tickets: batches.reduce((sum, batch) => sum + batch.count, 0), sold_batches: batches.length,
    ticket_root: `0x${fullTree.root.toString("hex")}`, refund_cursor: refundCursor, refund_batch_cursor: refundBatchCursor, refund_fee_debt: refundFeeDebt
  };
}
function materializeRefund(state) {
  const values = {
    round_nonce: pushData(Buffer.from(state.round_nonce.slice(2), "hex")),
    ticket_price: scriptI64(state.ticket_price),
    creator_pubkey: pushData(Buffer.from(state.creator_pubkey.slice(2), "hex")),
    sold_tickets: scriptI64(state.sold_tickets), sold_batches: scriptI64(state.sold_batches),
    ticket_root: pushData(Buffer.from(state.ticket_root.slice(2), "hex")),
    refund_cursor: scriptI64(state.refund_cursor), refund_batch_cursor: scriptI64(state.refund_batch_cursor), refund_fee_debt: scriptI64(state.refund_fee_debt)
  };
  const encoded = Buffer.concat(refundArtifact.stateFields.map((field) => values[field.name]));
  if (encoded.length !== refundArtifact.stateLayout.len) throw new Error("vNext refund state layout mismatch");
  const script = Buffer.from(refundArtifact.script, "hex");
  encoded.copy(script, refundArtifact.stateLayout.start);
  return script;
}
function p2pk(value) { return { value, p2pk_pubkey: `0x${owner}` }; }
function packedArgs(batches, fullTree, offset, fee = refundFee) {
  return [
    fee, batches.length,
    `0x${Buffer.concat(batches.map(() => Buffer.from(owner, "hex"))).toString("hex")}`,
    `0x${Buffer.concat(batches.map((batch) => u64(batch.count))).toString("hex")}`,
    `0x${Buffer.concat(batches.map((_, index) => proof(fullTree, offset + index))).toString("hex")}`
  ];
}
function refundOutputs(selected, hasSuccessor, currentValue, nextState, fee = refundFee, feeDebt = 0) {
  const principals = selected.reduce((sum, batch) => sum + ticketPrice * batch.count, 0);
  const totalBuyerFee = fee + feeDebt;
  const feePerBatch = Math.floor(totalBuyerFee / selected.length);
  const feeRemainder = totalBuyerFee % selected.length;
  const buyers = selected.map((batch, index) => p2pk(ticketPrice * batch.count - feePerBatch - (index === 0 ? feeRemainder : 0)));
  const successor = currentValue - principals + feeDebt;
  return hasSuccessor
    ? [{ value: successor, covenant_id: covenantId, authorizing_input: 0, state: nextState }, ...buyers]
    : [...buyers, p2pk(successor)];
}
function run(source, name, tests) {
  const testPath = path.join(root, `.tmp/${name}.test.json`);
  fs.mkdirSync(path.dirname(testPath), { recursive: true });
  fs.writeFileSync(testPath, `${JSON.stringify({ tests }, null, 2)}\n`);
  const result = spawnSync(debuggerPath, [source, "--run-all", "--test-file", testPath], { cwd: root, encoding: "utf8" });
  process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? "");
  const combinedOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.status !== 0 || /some tests failed/i.test(combinedOutput)) process.exit(result.status || 1);
  for (let index = 0; index < tests.length; index += 1) {
    const test = tests[index];
    if (test.expect !== "pass") continue;
    const start = combinedOutput.indexOf(`RUN   ${test.name}`);
    const next = index + 1 < tests.length ? combinedOutput.indexOf("  RUN   ", start + 1) : combinedOutput.length;
    const segment = start >= 0 ? combinedOutput.slice(start, next >= 0 ? next : combinedOutput.length) : "";
    const unitsMatch = segment.match(/SCRIPT_UNITS (\d+)/);
    if (!unitsMatch) throw new Error(`Missing SCRIPT_UNITS measurement for ${test.name}.`);
    const used = Number(unitsMatch[1]);
    let budget;
    if (test.function === "refundNext") {
      const batchCount = Number(test.args[1]);
      budget = Math.min(committedBudgets.refundMax, committedBudgets.refundBase + batchCount * committedBudgets.refundPerBatch);
    } else {
      budget = committedBudgets[test.function];
    }
    if (!Number.isSafeInteger(budget)) throw new Error(`No committed compute budget for ${test.function}.`);
    // rusty-kaspa grants 9,999 free units per input and 10,000 units per
    // committed compute-budget unit. This compares the debugger's executed
    // path against the exact value placed in the browser transaction input.
    const allowed = budget * 10_000 + 9_999;
    if (used > allowed) throw new Error(`${test.name} used ${used} script units but commits only ${budget} compute-budget units (${allowed} allowed).`);
    console.log(`  BUDGET ${test.name}: used=${used}, committed=${budget}, allowed=${allowed}`);
  }
}
function runSuite(suite) {
  const result = spawnSync(process.execPath, [process.argv[1]], {
    cwd: root,
    env: { ...process.env, VNEXT_VM_SUITE: suite },
    encoding: "utf8"
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (!fs.existsSync(debuggerPath)) throw new Error("SilverScript cli-debugger is unavailable.");

const purchase = { first: 0, count: 37 };
const afterPurchase = roundState({ batches: [purchase], soldTickets: 37 });
const secondPurchase = { first: 37, count: 5 };
const afterSecondPurchase = roundState({ batches: [purchase, secondPurchase], soldTickets: 42 });
const finalizeArgs = [
  "0x", 0, 0, "0x", `0x${"00".repeat(32)}`,
  `0x${"00".repeat(32)}`, "0x", 0, 0, "0x", `0x${"00".repeat(32)}`,
  1, 0, 0, 0, 1, `0x${owner}`, `0x${"00".repeat(640)}`
];
const fullHeader = `0x${"00".repeat(166)}`;
const fullWork = `0x${"00".repeat(8)}`;
const parentRehashArgs = [
  fullHeader, deadline + 30, 0, fullWork, `0x${"00".repeat(32)}`,
  `0x${"00".repeat(32)}`, fullHeader, deadline + 29, 0, fullWork, `0x${"00".repeat(32)}`,
  1, 0, 0, 0, 1, `0x${owner}`, `0x${"00".repeat(640)}`
];
const roundTests = [
  {
    name: "vnext_topup_accepts_1000_batch_protocol_bound",
    function: "topUp", args: [57_300_000], expect: "pass",
    tx: { version: 1, active_input_index: 0,
      inputs: [{ utxo_value: carrier, covenant_id: covenantId, state: roundState({ maxTickets: 1_000, minTickets: 1_000, maxBatches: 1_000 }) }, { utxo_value: 60_000_000 }],
      outputs: [{ value: carrier + 57_300_000, covenant_id: covenantId, authorizing_input: 0, state: roundState({ maxTickets: 1_000, minTickets: 1_000, maxBatches: 1_000 }) }] }
  },
  {
    name: "vnext_rejects_1001_batch_protocol_bound",
    function: "topUp", args: [57_300_000], expect: "fail",
    tx: { version: 1, active_input_index: 0,
      inputs: [{ utxo_value: carrier, covenant_id: covenantId, state: roundState({ maxTickets: 1_001, minTickets: 1_001, maxBatches: 1_001 }) }, { utxo_value: 60_000_000 }],
      outputs: [{ value: carrier + 57_300_000, covenant_id: covenantId, authorizing_input: 0, state: roundState({ maxTickets: 1_001, minTickets: 1_001, maxBatches: 1_001 }) }] }
  },
  {
    name: "vnext_topup_adds_exact_value_without_changing_state",
    function: "topUp", args: [57_300_000], expect: "pass",
    tx: { version: 1, active_input_index: 0,
      inputs: [{ utxo_value: carrier, covenant_id: covenantId, state: roundState() }, { utxo_value: 60_000_000 }],
      outputs: [{ value: carrier + 57_300_000, covenant_id: covenantId, authorizing_input: 0, state: roundState() }] }
  },
  {
    name: "vnext_topup_rejects_declared_value_mismatch",
    function: "topUp", args: [57_300_000], expect: "fail",
    tx: { version: 1, active_input_index: 0,
      inputs: [{ utxo_value: carrier, covenant_id: covenantId, state: roundState() }, { utxo_value: 60_000_000 }],
      outputs: [{ value: carrier + 57_300_000 - 1, covenant_id: covenantId, authorizing_input: 0, state: roundState() }] }
  },
  {
    name: "vnext_topup_rejects_ticket_or_refund_state_mutation",
    function: "topUp", args: [57_300_000], expect: "fail",
    tx: { version: 1, active_input_index: 0,
      inputs: [{ utxo_value: carrier, covenant_id: covenantId, state: roundState() }, { utxo_value: 60_000_000 }],
      outputs: [{ value: carrier + 57_300_000, covenant_id: covenantId, authorizing_input: 0, state: { ...roundState(), sold_tickets: 1 } }] }
  },
  {
    name: "vnext_topup_rejects_inconsistent_input_frontier_and_root",
    function: "topUp", args: [57_300_000], expect: "fail",
    tx: { version: 1, active_input_index: 0,
      inputs: [{ utxo_value: carrier, covenant_id: covenantId, state: { ...roundState(), ticket_root: `0x${"00".repeat(32)}` } }, { utxo_value: 60_000_000 }],
      outputs: [{ value: carrier + 57_300_000, covenant_id: covenantId, authorizing_input: 0, state: { ...roundState(), ticket_root: `0x${"00".repeat(32)}` } }] }
  },
  {
    name: "vnext_topup_rejects_sold_out_boundary_shift",
    function: "topUp", args: [57_300_000], expect: "fail",
    tx: { version: 1, active_input_index: 0,
      inputs: [{ utxo_value: carrier + ticketPrice, covenant_id: covenantId, state: roundState({ maxTickets: 1, minTickets: 1, batches: [{ first: 0, count: 1 }] }) }, { utxo_value: 60_000_000 }],
      outputs: [] }
  },
  {
    name: "vnext_topup_rejects_minimum_met_boundary_shift",
    function: "topUp", args: [57_300_000], expect: "fail",
    tx: { version: 1, active_input_index: 0,
      inputs: [{ utxo_value: carrier + ticketPrice, covenant_id: covenantId, state: roundState({ maxTickets: 10, minTickets: 1, batches: [{ first: 0, count: 1 }] }) }, { utxo_value: 60_000_000 }],
      outputs: [] }
  },
  {
    name: "vnext_buy_commits_nonce_minimum_and_max_batches",
    function: "buy", args: [`0x${owner}`, 37], expect: "pass",
    tx: { version: 1, lock_time: 999, active_input_index: 0, inputs: [{ utxo_value: carrier, covenant_id: covenantId, state: roundState() }],
      outputs: [{ value: carrier + ticketPrice * 37, covenant_id: covenantId, authorizing_input: 0, state: afterPurchase }] }
  },
  {
    name: "vnext_buy_after_deadline_is_rejected",
    function: "buy", args: [`0x${owner}`, 1], expect: "fail",
    tx: { version: 1, lock_time: deadline, active_input_index: 0, inputs: [{ utxo_value: carrier, covenant_id: covenantId, state: roundState() }], outputs: [] }
  },
  {
    name: "vnext_buy_second_batch_updates_frontier_and_merkle_root",
    function: "buy", args: [`0x${owner}`, secondPurchase.count], expect: "pass",
    tx: { version: 1, lock_time: 999, active_input_index: 0,
      inputs: [{ utxo_value: carrier + ticketPrice * purchase.count, covenant_id: covenantId, state: afterPurchase }],
      outputs: [{ value: carrier + ticketPrice * (purchase.count + secondPurchase.count), covenant_id: covenantId, authorizing_input: 0, state: afterSecondPurchase }] }
  },
  {
    name: "vnext_buy_rejects_wrong_successor_frontier_or_root",
    function: "buy", args: [`0x${owner}`, secondPurchase.count], expect: "fail",
    tx: { version: 1, lock_time: 999, active_input_index: 0,
      inputs: [{ utxo_value: carrier + ticketPrice * purchase.count, covenant_id: covenantId, state: afterPurchase }],
      outputs: [{ value: carrier + ticketPrice * (purchase.count + secondPurchase.count), covenant_id: covenantId, authorizing_input: 0,
        state: { ...afterSecondPurchase, ticket_root: `0x${"00".repeat(32)}` } }] }
  },
  {
    name: "vnext_buy_rejects_inconsistent_input_frontier_and_root",
    function: "buy", args: [`0x${owner}`, secondPurchase.count], expect: "fail",
    tx: { version: 1, lock_time: 999, active_input_index: 0,
      inputs: [{ utxo_value: carrier + ticketPrice * purchase.count, covenant_id: covenantId, state: { ...afterPurchase, ticket_root: `0x${"00".repeat(32)}` } }],
      outputs: [{ value: carrier + ticketPrice * (purchase.count + secondPurchase.count), covenant_id: covenantId, authorizing_input: 0, state: afterSecondPurchase }] }
  },
  {
    name: "vnext_buy_rejects_ticket_capacity_overrun",
    function: "buy", args: [`0x${owner}`, 2], expect: "fail",
    tx: { version: 1, lock_time: 999, active_input_index: 0,
      inputs: [{ utxo_value: carrier + ticketPrice * purchase.count, covenant_id: covenantId, state: roundState({ maxTickets: 38, batches: [purchase] }) }], outputs: [] }
  },
  {
    name: "vnext_buy_accepts_exact_settlement_carrier_floor",
    function: "buy", args: [`0x${owner}`, 1], expect: "pass",
    tx: { version: 1, lock_time: 999, active_input_index: 0,
      inputs: [{ utxo_value: minimumCarrier, covenant_id: covenantId, state: roundState() }],
      outputs: [{ value: minimumCarrier + ticketPrice, covenant_id: covenantId, authorizing_input: 0, state: roundState({ batches: [{ first: 0, count: 1 }] }) }] }
  },
  {
    name: "vnext_buy_rejects_carrier_one_sompi_below_settlement_floor",
    function: "buy", args: [`0x${owner}`, 1], expect: "fail",
    tx: { version: 1, lock_time: 999, active_input_index: 0,
      inputs: [{ utxo_value: minimumCarrier - 1, covenant_id: covenantId, state: roundState() }],
      outputs: [{ value: minimumCarrier - 1 + ticketPrice, covenant_id: covenantId, authorizing_input: 0, state: roundState({ batches: [{ first: 0, count: 1 }] }) }] }
  },
  {
    name: "vnext_buy_rejects_ticket_price_below_one_batch_liveness_minimum",
    function: "buy", args: [`0x${owner}`, 1], expect: "fail",
    tx: { version: 1, lock_time: 999, active_input_index: 0,
      inputs: [{ utxo_value: carrier, covenant_id: covenantId, state: { ...roundState(), ticket_price: 99_999_999 } }], outputs: [] }
  },
  {
    name: "vnext_buy_rejects_round_principal_integer_overflow",
    function: "buy", args: [`0x${owner}`, 1], expect: "fail",
    tx: { version: 1, lock_time: 999, active_input_index: 0,
      inputs: [{ utxo_value: carrier, covenant_id: covenantId, state: { ...roundState({ maxTickets: 1_000_000 }), ticket_price: 4_611_686_018_428 } }], outputs: [] }
  },
  {
    name: "vnext_buy_over_max_batches_is_rejected",
    function: "buy", args: [`0x${owner}`, 1], expect: "fail",
    tx: { version: 1, lock_time: 999, active_input_index: 0, inputs: [{ utxo_value: carrier, covenant_id: covenantId, state: roundState({ maxBatches: 1, batches: [{ first: 0, count: 1 }] }) }], outputs: [] }
  },
  {
    name: "vnext_finalize_below_minimum_is_rejected",
    function: "finalize", args: finalizeArgs, expect: "fail",
      tx: { version: 1, lock_time: deadline, active_input_index: 0, inputs: [{ utxo_value: carrier + ticketPrice, covenant_id: covenantId, state: roundState({ minTickets: 2, batches: [{ first: 0, count: 1 }] }) }], outputs: [] }
  },
  {
    name: "vnext_finalize_rejects_extra_input",
    function: "finalize", args: finalizeArgs, expect: "fail",
    tx: { version: 1, lock_time: deadline, active_input_index: 0,
      inputs: [{ utxo_value: carrier + ticketPrice, covenant_id: covenantId, state: roundState({ minTickets: 1, batches: [{ first: 0, count: 1 }] }) }, { utxo_value: 1 }], outputs: [] }
  },
  {
    name: "vnext_finalize_rejects_fee_above_cap",
    function: "finalize", args: [...finalizeArgs.slice(0, 11), 20_000_001, ...finalizeArgs.slice(12)], expect: "fail",
    tx: { version: 1, lock_time: deadline, active_input_index: 0, inputs: [{ utxo_value: carrier + ticketPrice, covenant_id: covenantId, state: roundState({ minTickets: 1, batches: [{ first: 0, count: 1 }] }) }], outputs: [] }
  },
  {
    name: "vnext_finalize_rejects_target_before_random_boundary",
    function: "finalize", args: finalizeArgs, expect: "fail",
    tx: { version: 1, lock_time: deadline, active_input_index: 0, inputs: [{ utxo_value: carrier + ticketPrice, covenant_id: covenantId, state: roundState({ minTickets: 1, batches: [{ first: 0, count: 1 }] }) }], outputs: [] }
  },
  {
    name: "vnext_finalize_rehashes_parent_header_before_chain_commit",
    function: "finalize", args: parentRehashArgs, expect: "fail",
    tx: { version: 1, lock_time: deadline, active_input_index: 0, inputs: [{ utxo_value: carrier + ticketPrice, covenant_id: covenantId, state: roundState({ minTickets: 1, batches: [{ first: 0, count: 1 }] }) }], outputs: [] }
  }
];

const batches = [{ first: 0, count: 1 }, { first: 1, count: 2 }];
const fullTree = tree(batches);
const initialRefund = refundState(batches, 0, 0, transitionFee);
const transitionRound = roundState({ minTickets: 4, batches });
const refundPrefix = Buffer.from(refundArtifact.script, "hex").subarray(0, refundArtifact.stateLayout.start);
const refundSuffix = Buffer.from(refundArtifact.script, "hex").subarray(refundArtifact.stateLayout.start + refundArtifact.stateLayout.len);
const refundScript = payToScriptHashScript(materializeRefund(initialRefund)).toJSON().script;
const totalPrincipal = ticketPrice * 3;
const refundValue = carrier - transitionFee + totalPrincipal;
const afterFirst = refundState(batches, 1, 1, 0);
const firstCurrentValue = refundValue;
const finalState = refundState(batches, 3, 2, 0);
const secondCurrentValue = firstCurrentValue - ticketPrice + transitionFee;
const transitionTests = [
  {
    name: "vnext_start_refund_only_below_minimum_and_preserves_principal",
    function: "startRefund", args: [transitionFee, `0x${refundPrefix.toString("hex")}`, `0x${refundSuffix.toString("hex")}`], expect: "pass",
    tx: { version: 1, lock_time: deadline, active_input_index: 0, inputs: [{ utxo_value: carrier + totalPrincipal, covenant_id: covenantId, state: transitionRound }],
      outputs: [{ value: refundValue, covenant_id: covenantId, authorizing_input: 0, script_hex: refundScript }] }
  },
  {
    name: "vnext_start_refund_at_minimum_is_rejected",
    function: "startRefund", args: [transitionFee, `0x${refundPrefix.toString("hex")}`, `0x${refundSuffix.toString("hex")}`], expect: "fail",
    tx: { version: 1, lock_time: deadline, active_input_index: 0, inputs: [{ utxo_value: carrier + totalPrincipal, covenant_id: covenantId, state: roundState({ minTickets: 3, batches }) }], outputs: [] }
  },
  {
    name: "vnext_start_refund_rejects_transition_that_would_reduce_ticket_principal",
    function: "startRefund", args: [transitionFee, `0x${refundPrefix.toString("hex")}`, `0x${refundSuffix.toString("hex")}`], expect: "fail",
    tx: { version: 1, lock_time: deadline, active_input_index: 0, inputs: [{ utxo_value: totalPrincipal + transitionFee - 1, covenant_id: covenantId, state: transitionRound }], outputs: [] }
  },
  {
    name: "vnext_start_refund_rejects_extra_input",
    function: "startRefund", args: [transitionFee, `0x${refundPrefix.toString("hex")}`, `0x${refundSuffix.toString("hex")}`], expect: "fail",
    tx: { version: 1, lock_time: deadline, active_input_index: 0,
      inputs: [{ utxo_value: carrier + totalPrincipal, covenant_id: covenantId, state: transitionRound }, { utxo_value: 1 }],
      outputs: [{ value: refundValue, covenant_id: covenantId, authorizing_input: 0, script_hex: refundScript }] }
  }
];
const refundTests = [
  {
    name: "vnext_refund_one_ticket_remains_live_at_both_fee_caps",
    function: "refundNext", args: packedArgs(batches.slice(0, 1), fullTree, 0, 20_000_000), expect: "pass",
    tx: { active_input_index: 0,
      inputs: [{ utxo_value: carrier - 20_000_000 + totalPrincipal, covenant_id: covenantId, state: refundState(batches, 0, 0, 20_000_000) }],
      outputs: refundOutputs(batches.slice(0, 1), true, carrier - 20_000_000 + totalPrincipal, afterFirst, 20_000_000, 20_000_000) }
  },
  {
    name: "vnext_refund_deducts_transition_and_network_fee_from_first_purchase",
    function: "refundNext", args: packedArgs(batches.slice(0, 1), fullTree, 0), expect: "pass",
    tx: { active_input_index: 0, inputs: [{ utxo_value: firstCurrentValue, covenant_id: covenantId, state: initialRefund }],
      outputs: refundOutputs(batches.slice(0, 1), true, firstCurrentValue, afterFirst, refundFee, transitionFee) }
  },
  {
    name: "vnext_refund_final_batch_deducts_its_actual_network_fee",
    function: "refundNext", args: packedArgs(batches.slice(1), fullTree, 1), expect: "pass",
    tx: { active_input_index: 0, inputs: [{ utxo_value: secondCurrentValue, covenant_id: covenantId, state: afterFirst }],
      outputs: refundOutputs(batches.slice(1), false, secondCurrentValue, finalState) }
  },
  {
    name: "vnext_refund_rejects_owner_output_that_ignores_fee_deduction",
    function: "refundNext", args: packedArgs(batches.slice(0, 1), fullTree, 0), expect: "fail",
    tx: { active_input_index: 0, inputs: [{ utxo_value: firstCurrentValue, covenant_id: covenantId, state: initialRefund }],
      outputs: [{ value: firstCurrentValue - ticketPrice + transitionFee, covenant_id: covenantId, authorizing_input: 0, state: afterFirst }, p2pk(ticketPrice)] }
  },
  {
    name: "vnext_refund_rejects_wrong_nonce_or_merkle_proof",
    function: "refundNext", args: [refundFee, 1, `0x${owner}`, `0x${u64(1).toString("hex")}`, `0x${Buffer.alloc(640, 0xff).toString("hex")}`], expect: "fail",
    tx: { active_input_index: 0, inputs: [{ utxo_value: firstCurrentValue, covenant_id: covenantId, state: initialRefund }], outputs: [] }
  },
  {
    name: "vnext_refund_rejects_fee_above_covenant_cap",
    function: "refundNext", args: packedArgs(batches.slice(0, 1), fullTree, 0, 20_000_001), expect: "fail",
    tx: { active_input_index: 0, inputs: [{ utxo_value: firstCurrentValue, covenant_id: covenantId, state: initialRefund }], outputs: [] }
  },
  {
    name: "vnext_refund_rejects_state_below_one_batch_liveness_minimum",
    function: "refundNext", args: packedArgs(batches.slice(0, 1), fullTree, 0), expect: "fail",
    tx: { active_input_index: 0, inputs: [{ utxo_value: firstCurrentValue, covenant_id: covenantId, state: { ...initialRefund, ticket_price: 99_999_999 } }], outputs: [] }
  },
  {
    name: "vnext_refund_rejects_principal_integer_overflow",
    function: "refundNext", args: packedArgs(batches.slice(0, 1), fullTree, 0), expect: "fail",
    tx: { active_input_index: 0, inputs: [{ utxo_value: firstCurrentValue, covenant_id: covenantId, state: { ...initialRefund, ticket_price: 4_611_686_018_428, sold_tickets: 1_000_000 } }], outputs: [] }
  },
  {
    name: "vnext_refund_rejects_replayed_cursor_proof",
    function: "refundNext", args: packedArgs(batches.slice(0, 1), fullTree, 0), expect: "fail",
    tx: { active_input_index: 0, inputs: [{ utxo_value: secondCurrentValue, covenant_id: covenantId, state: afterFirst }], outputs: [] }
  },
  {
    name: "vnext_refund_rejects_wrong_successor_cursor_state",
    function: "refundNext", args: packedArgs(batches.slice(0, 1), fullTree, 0), expect: "fail",
    tx: { active_input_index: 0, inputs: [{ utxo_value: firstCurrentValue, covenant_id: covenantId, state: initialRefund }],
      outputs: refundOutputs(batches.slice(0, 1), true, firstCurrentValue, { ...afterFirst, refund_cursor: 0 }, refundFee, transitionFee) }
  },
  {
    name: "vnext_refund_rejects_extra_input_or_output_shape",
    function: "refundNext", args: packedArgs(batches.slice(0, 1), fullTree, 0), expect: "fail",
    tx: { active_input_index: 0,
      inputs: [{ utxo_value: firstCurrentValue, covenant_id: covenantId, state: initialRefund }, { utxo_value: 1 }],
      outputs: [...refundOutputs(batches.slice(0, 1), true, firstCurrentValue, afterFirst, refundFee, transitionFee), p2pk(1)] }
  },
  {
    name: "vnext_refund_rejects_successor_that_loses_remaining_principal",
    function: "refundNext", args: packedArgs(batches.slice(0, 1), fullTree, 0), expect: "fail",
    tx: { active_input_index: 0, inputs: [{ utxo_value: firstCurrentValue, covenant_id: covenantId, state: initialRefund }], outputs: [] }
  },
  {
    name: "vnext_refund_shares_large_actual_fee_across_selected_purchase_batches",
    function: "refundNext", args: packedArgs(batches, fullTree, 0, 19_999_999), expect: "pass",
    tx: { active_input_index: 0, inputs: [{ utxo_value: refundValue, covenant_id: covenantId, state: initialRefund }],
      outputs: refundOutputs(batches, false, refundValue, finalState, 19_999_999, transitionFee) }
  }
];

const closeTests = [
  {
    name: "vnext_close_empty_is_public_but_pays_only_the_creator",
    function: "closeEmpty", args: [1_000_000], expect: "pass",
    tx: { version: 1, lock_time: deadline, active_input_index: 0,
      inputs: [{ utxo_value: carrier, covenant_id: covenantId, state: roundState() }], outputs: [p2pk(carrier - 1_000_000)] }
  },
  {
    name: "vnext_close_empty_rejects_before_deadline",
    function: "closeEmpty", args: [1], expect: "fail",
    tx: { version: 1, lock_time: deadline - 1, active_input_index: 0, inputs: [{ utxo_value: carrier, covenant_id: covenantId, state: roundState() }], outputs: [] }
  },
  {
    name: "vnext_close_empty_rejects_nonempty_round_even_after_deadline",
    function: "closeEmpty", args: [1], expect: "fail",
    tx: { version: 1, lock_time: deadline, active_input_index: 0, inputs: [{ utxo_value: carrier + ticketPrice, covenant_id: covenantId, state: roundState({ batches: [{ first: 0, count: 1 }] }) }], outputs: [] }
  },
  {
    name: "vnext_close_empty_rejects_wrong_creator_output",
    function: "closeEmpty", args: [1_000_000], expect: "fail",
    tx: { version: 1, lock_time: deadline, active_input_index: 0, inputs: [{ utxo_value: carrier, covenant_id: covenantId, state: roundState() }], outputs: [p2pk(carrier)] }
  }
];

const suite = process.env.VNEXT_VM_SUITE;
if (!suite) {
  // The debugger is intentionally isolated per suite. On Windows, running all
  // suites in one process can crash the debugger host; subprocesses also make
  // every suite's exit status part of the default verification gate.
  for (const requiredSuite of ["round", "transition", "refund", "close"]) runSuite(requiredSuite);
  console.log(`PASS vNext VM behavior: ABI ${roundArtifact.abi.map((entry) => entry.name).join(", ")}; round, transition, refund, and public close suites completed. Finalize success remains explicitly unverified because the debugger lacks a selected-chain commitment fixture.`);
} else if (suite === "round") {
  run(roundSource, "raffle_round_vnext", roundTests);
} else if (suite === "transition") {
  run(roundSource, "raffle_round_vnext_transition", transitionTests);
} else if (suite === "refund") {
  run(refundSource, "raffle_refund_vnext", refundTests);
} else if (suite === "close") {
  run(roundSource, "raffle_round_vnext_close", closeTests);
} else if (suite === "topup") {
  run(roundSource, "raffle_round_vnext_topup", roundTests.filter((test) => test.function === "topUp"));
} else {
  throw new Error(`Unknown VNEXT_VM_SUITE: ${suite}`);
}

if (suite) console.log(`PASS vNext VM behavior: ${suite} suite completed.`);
