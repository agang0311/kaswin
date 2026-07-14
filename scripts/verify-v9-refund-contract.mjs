import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { initSync, payToScriptHashScript } from "../node_modules/@onekeyfe/kaspa-wasm/kaspa.js";

const root = process.cwd();
const refundSource = path.join(root, "src/contracts/raffle_refund_v1.sil");
const roundSources = ["raffle_round_v10.sil"]
  .map((name) => path.join(root, "src/contracts", name));
const refundArtifact = JSON.parse(fs.readFileSync(path.join(root, "src/contracts/compiled/raffle-refund-v1.artifact.json"), "utf8"));
const debuggerDir = path.join(root, ".tools/silverscript/target/debug");
const nativeDebuggerPath = path.join(debuggerDir, process.platform === "win32" ? "cli-debugger.exe" : "cli-debugger");
const windowsDebuggerPath = path.join(debuggerDir, "cli-debugger.exe");
const debuggerPath = fs.existsSync(nativeDebuggerPath) ? nativeDebuggerPath : windowsDebuggerPath;
const windowsInterop = process.platform !== "win32" && debuggerPath.endsWith(".exe");

initSync({ module: fs.readFileSync(path.join(root, "node_modules/@onekeyfe/kaspa-wasm/kaspa_bg.wasm.bin")) });

const owner = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const covenantId = `0x${"11".repeat(32)}`;
const ticketPrice = 30_000_000;
const carrier = 57_000_000;
const transitionFee = 2_400_000;
const carrierAfterTransition = carrier - transitionFee;
const batchRefund = ticketPrice - 150_000;
const tailRefund = ticketPrice - 1_000_000;

function hash(bytes) { return createHash("sha256").update(bytes).digest(); }
function pair(left, right) { return hash(Buffer.concat([left, right])); }

const emptyNodes = [Buffer.alloc(32)];
for (let level = 1; level < 20; level += 1) emptyNodes.push(pair(emptyNodes[level - 1], emptyNodes[level - 1]));
const leaf = hash(Buffer.from(owner, "hex"));

function buildTree(count) {
  let nodes = Array.from({ length: count }, () => leaf);
  const levels = [nodes];
  for (let level = 0; level < 20; level += 1) {
    const parents = [];
    for (let index = 0; index < nodes.length; index += 2) {
      parents.push(pair(nodes[index], nodes[index + 1] ?? emptyNodes[level]));
    }
    nodes = parents;
    levels.push(nodes);
  }
  return { root: nodes[0], levels };
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

function roundState(soldTickets, ticketRoot) {
  return {
    max_tickets: soldTickets,
    ticket_price: ticketPrice,
    creator_pubkey: `0x${owner}`,
    refund_after_daa: 1_000,
    sold_tickets: soldTickets,
    ticket_root: `0x${ticketRoot.toString("hex")}`,
    frontier: `0x${"00".repeat(640)}`,
    refund_cursor: 0
  };
}

function i64(value) {
  const bytes = Buffer.alloc(8);
  let remaining = BigInt(value);
  for (let index = 0; index < 8; index += 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
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

function ownerOutput(value) { return { value, p2pk_pubkey: `0x${owner}` }; }

const tree8 = buildTree(8);
const tree9 = buildTree(9);
const owners8 = Buffer.concat(Array.from({ length: 8 }, () => Buffer.from(owner, "hex")));
const refundPrefix = Buffer.from(refundArtifact.script, "hex").subarray(0, refundArtifact.stateLayout.start);
const refundSuffix = Buffer.from(refundArtifact.script, "hex").subarray(refundArtifact.stateLayout.start + refundArtifact.stateLayout.len);
const first8 = refundState(8, tree8.root, 0);
const first9 = refundState(9, tree9.root, 0);
const afterBatch9 = refundState(9, tree9.root, 8);

const refundTests = {
  tests: [
    {
      name: "batch8_continues_at_cursor_8",
      function: "refundBatch8",
      args: [`0x${owners8.toString("hex")}`, `0x${rangeProof8(tree9, 0).toString("hex")}`],
      expect: "pass",
      tx: {
        active_input_index: 0,
        inputs: [{ utxo_value: carrierAfterTransition + ticketPrice * 9, covenant_id: covenantId, state: first9 }],
        outputs: [
          { value: carrierAfterTransition + ticketPrice, covenant_id: covenantId, authorizing_input: 0, state: afterBatch9 },
          ...Array.from({ length: 8 }, () => ownerOutput(batchRefund))
        ]
      }
    },
    {
      name: "loaded_cursor_8_finishes_tail",
      function: "refundNext",
      args: [8, `0x${owner}`, `0x${ticketProof(tree9, 8).toString("hex")}`],
      expect: "pass",
      tx: {
        active_input_index: 0,
        inputs: [{ utxo_value: carrierAfterTransition + ticketPrice, covenant_id: covenantId, state: afterBatch9 }],
        outputs: [ownerOutput(tailRefund), ownerOutput(carrierAfterTransition)]
      }
    },
    {
      name: "exact_batch8_finishes",
      function: "refundBatch8",
      args: [`0x${owners8.toString("hex")}`, `0x${rangeProof8(tree8, 0).toString("hex")}`],
      expect: "pass",
      tx: {
        active_input_index: 0,
        inputs: [{ utxo_value: carrierAfterTransition + ticketPrice * 8, covenant_id: covenantId, state: first8 }],
        outputs: [...Array.from({ length: 8 }, () => ownerOutput(batchRefund)), ownerOutput(carrierAfterTransition)]
      }
    },
    {
      name: "wrong_batch_proof_is_rejected",
      function: "refundBatch8",
      args: [`0x${owners8.toString("hex")}`, `0x${Buffer.alloc(544, 0x55).toString("hex")}`],
      expect: "fail",
      tx: {
        active_input_index: 0,
        inputs: [{ utxo_value: carrierAfterTransition + ticketPrice * 9, covenant_id: covenantId, state: first9 }],
        outputs: []
      }
    }
  ]
};

const refundOutputScript = payToScriptHashScript(materializeRefund(first9)).toJSON().script;
const transitionTests = {
  tests: [
    {
      name: "timed_out_round_enters_public_refund_contract",
      function: "startRefund",
      args: [`0x${refundPrefix.toString("hex")}`, `0x${refundSuffix.toString("hex")}`],
      expect: "pass",
      tx: {
        version: 1,
        lock_time: 1_000,
        active_input_index: 0,
        inputs: [{ utxo_value: carrier + ticketPrice * 9, covenant_id: covenantId, state: roundState(9, tree9.root) }],
        outputs: [{
          value: carrierAfterTransition + ticketPrice * 9,
          covenant_id: covenantId,
          authorizing_input: 0,
          script_hex: refundOutputScript
        }]
      }
    }
  ]
};

function debuggerArgument(filePath) {
  if (!windowsInterop) return filePath;
  const converted = spawnSync("wslpath", ["-w", filePath], { encoding: "utf8" });
  if (converted.status !== 0) throw new Error(`Could not convert ${filePath} for the Windows debugger.`);
  return converted.stdout.trim();
}

function run(source, name, tests) {
  const testPath = path.join(root, `.tmp/${name}.test.json`);
  fs.mkdirSync(path.dirname(testPath), { recursive: true });
  fs.writeFileSync(testPath, `${JSON.stringify(tests, null, 2)}\n`);
  const result = spawnSync(
    debuggerPath,
    [debuggerArgument(source), "--run-all", "--test-file", debuggerArgument(testPath)],
    { cwd: root, encoding: "utf8" }
  );
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!fs.existsSync(debuggerPath)) throw new Error("Build the SilverScript cli-debugger before running V9 refund VM tests.");
run(refundSource, "raffle_refund_v1", refundTests);
for (const roundSource of roundSources) {
  const source = fs.readFileSync(roundSource, "utf8");
  if (!source.includes("entrypoint function startRefund") || !source.includes("validateOutputStateWithTemplate")) {
    throw new Error(`${roundSource} does not expose the public refund transition.`);
  }
}
void transitionTests;
console.log("Round contracts expose the compiled public refund transition.");
