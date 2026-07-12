import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { initSync, payToScriptHashScript } from "../node_modules/@onekeyfe/kaspa-wasm/kaspa.js";

const root = process.cwd();
const roundSource = path.join(root, "src/contracts/raffle_round_v5.sil");
const refundSource = path.join(root, "src/contracts/raffle_refund_v1.sil");
const roundArtifact = JSON.parse(fs.readFileSync(path.join(root, "src/contracts/compiled/raffle-round-v5.artifact.json"), "utf8"));
const refundArtifact = JSON.parse(fs.readFileSync(path.join(root, "src/contracts/compiled/raffle-refund-v1.artifact.json"), "utf8"));
const debuggerPath = path.join(root, ".tools/silverscript/target/debug", process.platform === "win32" ? "cli-debugger.exe" : "cli-debugger");
const wasm = fs.readFileSync(path.join(root, "node_modules/@onekeyfe/kaspa-wasm/kaspa_bg.wasm.bin"));
initSync({ module: wasm });

const owner = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const covenantId = `0x${"11".repeat(32)}`;
const ticketPrice = 30_000_000;
const carrierAfterTransition = 17_800_000;

function hash(bytes) { return createHash("sha256").update(bytes).digest(); }
function pair(left, right) { return hash(Buffer.concat([left, right])); }

const emptyNodes = [Buffer.alloc(32)];
for (let level = 1; level < 20; level += 1) emptyNodes.push(pair(emptyNodes[level - 1], emptyNodes[level - 1]));
const emptyRoot = pair(emptyNodes[19], emptyNodes[19]);
const leaf = hash(Buffer.from(owner, "hex"));

function buildTree(count) {
  let nodes = Array.from({ length: count }, () => leaf);
  const levels = [nodes];
  for (let level = 0; level < 20; level += 1) {
    const parents = [];
    for (let index = 0; index < nodes.length; index += 2) parents.push(pair(nodes[index], nodes[index + 1] ?? emptyNodes[level]));
    nodes = parents;
    levels.push(nodes);
  }
  return { root: nodes[0], levels };
}

function buildAppendState(count) {
  let frontier = Buffer.alloc(640);
  let root = emptyRoot;
  for (let ticketId = 0; ticketId < count; ticketId += 1) {
    const nextFrontier = Buffer.from(frontier);
    let node = leaf;
    let path = ticketId;
    let carrying = true;
    for (let level = 0; level < 20; level += 1) {
      if (path % 2 === 0) {
        if (carrying) {
          node.copy(nextFrontier, level * 32);
          carrying = false;
        }
        node = pair(node, emptyNodes[level]);
      } else {
        node = pair(frontier.subarray(level * 32, level * 32 + 32), node);
      }
      path >>= 1;
    }
    frontier = nextFrontier;
    root = node;
  }
  return { root, frontier };
}

function rangeProof8(tree, firstTicketId) {
  let path = firstTicketId >> 3;
  const proof = [];
  for (let level = 3; level < 20; level += 1) {
    proof.push(tree.levels[level][path ^ 1] ?? emptyNodes[level]);
    path >>= 1;
  }
  return Buffer.concat(proof);
}

function ticketProof(tree, ticketId) {
  let path = ticketId;
  const proof = [];
  for (let level = 0; level < 20; level += 1) {
    proof.push(tree.levels[level][path ^ 1] ?? emptyNodes[level]);
    path >>= 1;
  }
  return Buffer.concat(proof);
}

function refundState(soldTickets, ticketRoot, refundCursor) {
  return {
    ticket_price: ticketPrice,
    creator_pubkey: `0x${owner}`,
    sold_tickets: soldTickets,
    ticket_root: `0x${ticketRoot.toString("hex")}`,
    refund_cursor: refundCursor
  };
}

function roundState(soldTickets, ticketRoot, ticketFrontier = Buffer.alloc(640)) {
  return {
    max_tickets: 1_000_000,
    ticket_price: ticketPrice,
    creator_pubkey: `0x${owner}`,
    oracle_pubkey: `0x${owner}`,
    refund_after_daa: 1000,
    sold_tickets: soldTickets,
    ticket_root: `0x${ticketRoot.toString("hex")}`,
    frontier: `0x${ticketFrontier.toString("hex")}`,
    refund_cursor: 0
  };
}

function i64(value) {
  const encoded = Buffer.alloc(8);
  let remaining = BigInt(value);
  for (let index = 0; index < 8; index += 1) {
    encoded[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return encoded;
}

function pushData(bytes) {
  if (bytes.length <= 75) return Buffer.from([bytes.length, ...bytes]);
  if (bytes.length <= 0xff) return Buffer.from([0x4c, bytes.length, ...bytes]);
  return Buffer.from([0x4d, bytes.length & 0xff, bytes.length >> 8, ...bytes]);
}

function materializeRefund(state) {
  const values = {
    ticket_price: i64(state.ticket_price),
    creator_pubkey: Buffer.from(state.creator_pubkey.slice(2), "hex"),
    sold_tickets: i64(state.sold_tickets),
    ticket_root: Buffer.from(state.ticket_root.slice(2), "hex"),
    refund_cursor: i64(state.refund_cursor)
  };
  const serialized = Buffer.concat(refundArtifact.stateFields.map((field) => pushData(values[field.name])));
  if (serialized.length !== refundArtifact.stateLayout.len) throw new Error("Refund state layout mismatch.");
  const script = Buffer.from(refundArtifact.script, "hex");
  serialized.copy(script, refundArtifact.stateLayout.start);
  return script;
}

const tree10 = buildTree(10);
const tree16 = buildTree(16);
const owners8 = Buffer.concat(Array.from({ length: 8 }, () => Buffer.from(owner, "hex")));
const refundPrefix = Buffer.from(refundArtifact.script, "hex").subarray(0, refundArtifact.stateLayout.start);
const refundSuffix = Buffer.from(refundArtifact.script, "hex").subarray(refundArtifact.stateLayout.start + refundArtifact.stateLayout.len);
const first16 = refundState(16, tree16.root, 0);
const second16 = refundState(16, tree16.root, 8);
const first10 = refundState(10, tree10.root, 0);
const afterBatch10 = refundState(10, tree10.root, 8);
const afterOne10 = refundState(10, tree10.root, 9);

const buyTests = { tests: [1, 2, 4, 8].map((ticketCount) => {
  const next = buildAppendState(ticketCount);
  return {
    name: `buy_${ticketCount}_tickets`,
    function: "buy",
    args: [`0x${owner}`, ticketCount],
    expect: "pass",
    tx: {
      active_input_index: 0,
      inputs: [{ utxo_value: 20_000_000, covenant_id: covenantId, state: roundState(0, emptyRoot) }],
      outputs: [{
        value: 20_000_000 + ticketPrice * ticketCount,
        covenant_id: covenantId,
        authorizing_input: 0,
        state: roundState(ticketCount, next.root, next.frontier)
      }]
    }
  };
}).concat([{
  name: "buy_2_tickets_unaligned_rejected",
  function: "buy",
  args: [`0x${owner}`, 2],
  expect: "fail",
  tx: {
    active_input_index: 0,
    inputs: [{
      utxo_value: 20_000_000 + ticketPrice,
      covenant_id: covenantId,
      state: roundState(1, buildAppendState(1).root, buildAppendState(1).frontier)
    }],
    outputs: []
  }
}]) };

function ownerOutput(value = ticketPrice - 150_000) { return { value, p2pk_pubkey: `0x${owner}` }; }

const batchTests = {
  tests: [
    {
      name: "batch8_continuing",
      function: "refundBatch8",
      args: [`0x${owners8.toString("hex")}`, `0x${rangeProof8(tree16, 0).toString("hex")}`],
      expect: "pass",
      tx: {
        active_input_index: 0,
        inputs: [{ utxo_value: carrierAfterTransition + ticketPrice * 16, covenant_id: covenantId, state: first16 }],
        outputs: [
          { value: carrierAfterTransition + ticketPrice * 8, covenant_id: covenantId, authorizing_input: 0, state: second16 },
          ...Array.from({ length: 8 }, () => ownerOutput())
        ]
      }
    },
    {
      name: "batch8_final",
      function: "refundBatch8",
      args: [`0x${owners8.toString("hex")}`, `0x${rangeProof8(tree16, 8).toString("hex")}`],
      expect: "pass",
      tx: {
        active_input_index: 0,
        inputs: [{ utxo_value: carrierAfterTransition + ticketPrice * 8, covenant_id: covenantId, state: second16 }],
        outputs: [...Array.from({ length: 8 }, () => ownerOutput()), ownerOutput(carrierAfterTransition)]
      }
    },
    {
      name: "batch8_wrong_proof_rejected",
      function: "refundBatch8",
      args: [`0x${owners8.toString("hex")}`, `0x${Buffer.alloc(544, 0x55).toString("hex")}`],
      expect: "fail",
      tx: {
        active_input_index: 0,
        inputs: [{ utxo_value: carrierAfterTransition + ticketPrice * 16, covenant_id: covenantId, state: first16 }],
        outputs: [
          { value: carrierAfterTransition + ticketPrice * 8, covenant_id: covenantId, authorizing_input: 0, state: second16 },
          ...Array.from({ length: 8 }, () => ownerOutput())
        ]
      }
    },
    {
      name: "batch8_then_single_tail",
      function: "refundBatch8",
      args: [`0x${owners8.toString("hex")}`, `0x${rangeProof8(tree10, 0).toString("hex")}`],
      expect: "pass",
      tx: {
        active_input_index: 0,
        inputs: [{ utxo_value: carrierAfterTransition + ticketPrice * 10, covenant_id: covenantId, state: first10 }],
        outputs: [
          { value: carrierAfterTransition + ticketPrice * 2, covenant_id: covenantId, authorizing_input: 0, state: afterBatch10 },
          ...Array.from({ length: 8 }, () => ownerOutput())
        ]
      }
    },
    {
      name: "single_tail_continuing",
      function: "refundNext",
      args: [8, `0x${owner}`, `0x${ticketProof(tree10, 8).toString("hex")}`],
      expect: "pass",
      tx: {
        active_input_index: 0,
        inputs: [{ utxo_value: carrierAfterTransition + ticketPrice * 2, covenant_id: covenantId, state: afterBatch10 }],
        outputs: [
          { value: carrierAfterTransition + ticketPrice, covenant_id: covenantId, authorizing_input: 0, state: afterOne10 },
          ownerOutput(ticketPrice - 1_900_000)
        ]
      }
    },
    {
      name: "single_tail_final",
      function: "refundNext",
      args: [9, `0x${owner}`, `0x${ticketProof(tree10, 9).toString("hex")}`],
      expect: "pass",
      tx: {
        active_input_index: 0,
        inputs: [{ utxo_value: carrierAfterTransition + ticketPrice, covenant_id: covenantId, state: afterOne10 }],
        outputs: [ownerOutput(ticketPrice - 1_900_000), ownerOutput(carrierAfterTransition)]
      }
    }
  ]
};

const refundOutputScript = payToScriptHashScript(materializeRefund(first10)).toJSON().script;
const transitionTests = {
  tests: [
    {
      name: "round_to_refund_contract",
      function: "startRefund",
      args: [`0x${refundPrefix.toString("hex")}`, `0x${refundSuffix.toString("hex")}`],
      expect: "pass",
      tx: {
        version: 1,
        lock_time: 1000,
        active_input_index: 0,
        inputs: [{ utxo_value: 20_000_000 + ticketPrice * 10, covenant_id: covenantId, state: roundState(10, tree10.root) }],
        outputs: [{
          value: carrierAfterTransition + ticketPrice * 10,
          covenant_id: covenantId,
          authorizing_input: 0,
          script_hex: refundOutputScript
        }]
      }
    },
    {
      name: "round_to_wrong_refund_template_rejected",
      function: "startRefund",
      args: [`0x${refundPrefix.toString("hex")}`, `0x${refundSuffix.toString("hex")}`],
      expect: "fail",
      tx: {
        version: 1,
        lock_time: 1000,
        active_input_index: 0,
        inputs: [{ utxo_value: 20_000_000 + ticketPrice * 10, covenant_id: covenantId, state: roundState(10, tree10.root) }],
        outputs: [{
          value: carrierAfterTransition + ticketPrice * 10,
          covenant_id: covenantId,
          authorizing_input: 0,
          script_hex: payToScriptHashScript(Buffer.from([0x51])).toJSON().script
        }]
      }
    }
  ]
};

function run(source, name, tests) {
  const testPath = path.join(root, `.tmp/${name}.test.json`);
  fs.mkdirSync(path.dirname(testPath), { recursive: true });
  fs.writeFileSync(testPath, `${JSON.stringify(tests, null, 2)}\n`);
  const result = spawnSync(debuggerPath, [source, "--run-all", "--test-file", testPath], { cwd: root, encoding: "utf8" });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!fs.existsSync(debuggerPath)) throw new Error("Build the SilverScript cli-debugger before running V5 tests.");
run(roundSource, "raffle_round_v5_buy", buyTests);
run(refundSource, "raffle_refund_v1", batchTests);
run(roundSource, "raffle_round_v5_transition", transitionTests);
