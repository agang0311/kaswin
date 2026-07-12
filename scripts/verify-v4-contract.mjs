import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import * as secp from "@noble/secp256k1";

const root = process.cwd();
const sourcePath = path.join(root, "src/contracts/raffle_round_v4.sil");
const testPath = path.join(root, ".tmp/raffle_round_v4.test.json");
const debuggerPath = path.join(root, ".tools/silverscript/target/debug", process.platform === "win32" ? "cli-debugger.exe" : "cli-debugger");
const owner = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const wrongOwner = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
const covenantId = `0x${"11".repeat(32)}`;

function hash(bytes) {
  return createHash("sha256").update(bytes).digest();
}

function pair(left, right) {
  return hash(Buffer.concat([left, right]));
}

const emptyNodes = [Buffer.alloc(32)];
for (let level = 1; level < 20; level += 1) emptyNodes.push(pair(emptyNodes[level - 1], emptyNodes[level - 1]));
const emptyNodeTable = Buffer.concat(emptyNodes);
const emptyRoot = pair(emptyNodes[19], emptyNodes[19]);
const firstLeaf = hash(Buffer.from(owner, "hex"));
const secondLeaf = hash(Buffer.from(wrongOwner, "hex"));
const firstFrontier = Buffer.alloc(640);
firstLeaf.copy(firstFrontier, 0);
let firstRoot = firstLeaf;
for (let level = 0; level < 20; level += 1) firstRoot = pair(firstRoot, emptyNodes[level]);
const secondFrontier = Buffer.from(firstFrontier);
const firstPair = pair(firstLeaf, secondLeaf);
firstPair.copy(secondFrontier, 32);
let secondRoot = firstPair;
for (let level = 1; level < 20; level += 1) secondRoot = pair(secondRoot, emptyNodes[level]);
const firstOfTwoProof = Buffer.concat([secondLeaf, ...emptyNodes.slice(1)]);

function appendLeaf(frontier, ticketId, leaf) {
  const nextFrontier = Buffer.from(frontier);
  let node = Buffer.from(leaf);
  let path = ticketId;
  let carrying = true;
  for (let level = 0; level < 20; level += 1) {
    if ((path & 1) === 0) {
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
  return { frontier: nextFrontier, root: node };
}

function proofForLeaves(leaves, ticketId) {
  let nodes = leaves.map((leaf) => Buffer.from(leaf));
  let path = ticketId;
  const proof = [];
  for (let level = 0; level < 20; level += 1) {
    proof.push(nodes[path ^ 1] ?? emptyNodes[level]);
    const parents = [];
    for (let index = 0; index < nodes.length; index += 2) {
      parents.push(pair(nodes[index], nodes[index + 1] ?? emptyNodes[level]));
    }
    nodes = parents;
    path >>= 1;
  }
  return Buffer.concat(proof);
}

let tenFrontier = Buffer.alloc(640);
let tenRoot = emptyRoot;
for (let ticketId = 0; ticketId < 10; ticketId += 1) {
  const appended = appendLeaf(tenFrontier, ticketId, firstLeaf);
  tenFrontier = appended.frontier;
  tenRoot = appended.root;
}
const tenLeaves = Array.from({ length: 10 }, () => firstLeaf);
const secondOfTenProof = proofForLeaves(tenLeaves, 1);
const firstOfTenProof = proofForLeaves(tenLeaves, 0);

const baseState = {
  max_tickets: 1_000_000,
  ticket_price: 30_000_000,
  creator_pubkey: `0x${owner}`,
  oracle_pubkey: `0x${owner}`,
  refund_after_daa: 1_000,
  sold_tickets: 0,
  ticket_root: `0x${emptyRoot.toString("hex")}`,
  frontier: `0x${"00".repeat(640)}`,
  refund_cursor: 0
};
const firstState = {
  ...baseState,
  sold_tickets: 1,
  ticket_root: `0x${firstRoot.toString("hex")}`,
  frontier: `0x${firstFrontier.toString("hex")}`
};
const secondState = {
  ...baseState,
  sold_tickets: 2,
  ticket_root: `0x${secondRoot.toString("hex")}`,
  frontier: `0x${secondFrontier.toString("hex")}`
};
const tenState = {
  ...baseState,
  sold_tickets: 10,
  ticket_root: `0x${tenRoot.toString("hex")}`,
  frontier: `0x${tenFrontier.toString("hex")}`
};
const oracleSeed = Buffer.alloc(32, 0x44);
const oracleSignature = Buffer.from(
  await secp.schnorr.signAsync(hash(Buffer.concat([firstRoot, oracleSeed])), Buffer.from("01".padStart(64, "0"), "hex"))
).toString("hex");
let tenOracleSeed = Buffer.alloc(32);
for (let candidate = 0; ; candidate += 1) {
  tenOracleSeed.writeUInt32LE(candidate, 0);
  const seed = hash(Buffer.concat([tenRoot, tenOracleSeed]));
  const winner = ((seed[0] & 0x7f) + (seed[1] & 0x7f) * 128 + (seed[2] & 0x7f) * 16384 + (seed[3] & 0x7f) * 2097152) % 10;
  if (winner === 1) break;
}
const tenOracleSignature = Buffer.from(
  await secp.schnorr.signAsync(hash(Buffer.concat([tenRoot, tenOracleSeed])), Buffer.from("01".padStart(64, "0"), "hex"))
).toString("hex");

function buyTest(name, state, expect) {
  return {
    name,
    function: "buy",
    args: [`0x${owner}`],
    expect,
    tx: {
      active_input_index: 0,
      inputs: [{ utxo_value: 20_000_000, covenant_id: covenantId, state: baseState }],
      outputs: [{ value: 50_000_000, covenant_id: covenantId, authorizing_input: 0, state }]
    }
  };
}

function refundTest(name, refundOwner, expect) {
  return {
    name,
    function: "refundNext",
    args: [0, `0x${refundOwner}`, `0x${emptyNodeTable.toString("hex")}`],
    expect,
    tx: {
      version: 1,
      lock_time: 1_000,
      active_input_index: 0,
      inputs: [{ utxo_value: 50_000_000, covenant_id: covenantId, state: firstState }],
      outputs: [
        { value: 28_100_000, p2pk_pubkey: `0x${owner}` },
        { value: 20_000_000, p2pk_pubkey: `0x${owner}` }
      ]
    }
  };
}

function continuingRefundTest(name, refundOwner, proof, successorCursor, expect) {
  return {
    name,
    function: "refundNext",
    args: [0, `0x${refundOwner}`, `0x${proof.toString("hex")}`],
    expect,
    tx: {
      version: 1,
      lock_time: 1_000,
      active_input_index: 0,
      inputs: [{ utxo_value: 80_000_000, covenant_id: covenantId, state: secondState }],
      outputs: [
        {
          value: 50_000_000,
          covenant_id: covenantId,
          authorizing_input: 0,
          state: { ...secondState, refund_cursor: successorCursor }
        },
        { value: 28_100_000, p2pk_pubkey: `0x${owner}` }
      ]
    }
  };
}

function finalizeTest(name, winnerOwner, expect) {
  return {
    name,
    function: "finalize",
    args: [
      `0x${oracleSignature}`,
      `0x${oracleSeed.toString("hex")}`,
      0,
      `0x${winnerOwner}`,
      `0x${emptyNodeTable.toString("hex")}`,
      0,
      `0x${owner}`,
      `0x${emptyNodeTable.toString("hex")}`
    ],
    expect,
    tx: {
      version: 1,
      lock_time: 1_000,
      active_input_index: 0,
      inputs: [
        { utxo_value: 50_000_000, covenant_id: covenantId, state: firstState },
        { utxo_value: 5_000_000, utxo_script_hex: `20${owner}ac` }
      ],
      outputs: [
        { value: 30_000_000, p2pk_pubkey: `0x${owner}` },
        { value: 17_800_000, p2pk_pubkey: `0x${owner}` },
        { value: 5_000_000, p2pk_pubkey: `0x${owner}` }
      ]
    }
  };
}

function tenTicketFinalizeTest() {
  return {
    name: "different_winner_path_finalize",
    function: "finalize",
    args: [
      `0x${tenOracleSignature}`,
      `0x${tenOracleSeed.toString("hex")}`,
      1,
      `0x${owner}`,
      `0x${secondOfTenProof.toString("hex")}`,
      0,
      `0x${owner}`,
      `0x${firstOfTenProof.toString("hex")}`
    ],
    expect: "pass",
    tx: {
      version: 1,
      lock_time: 1_000,
      active_input_index: 0,
      inputs: [
        { utxo_value: 320_000_000, covenant_id: covenantId, state: tenState },
        { utxo_value: 5_000_000, utxo_script_hex: `20${owner}ac` }
      ],
      outputs: [
        { value: 300_000_000, p2pk_pubkey: `0x${owner}` },
        { value: 17_800_000, p2pk_pubkey: `0x${owner}` },
        { value: 5_000_000, p2pk_pubkey: `0x${owner}` }
      ]
    }
  };
}

const tests = {
  tests: [
    buyTest("first_user_buy", firstState, "pass"),
    buyTest("wrong_successor_root_rejected", { ...firstState, ticket_root: baseState.ticket_root }, "fail"),
    finalizeTest("participant_finalize", owner, "pass"),
    tenTicketFinalizeTest(),
    finalizeTest("wrong_winner_proof_rejected", wrongOwner, "fail"),
    continuingRefundTest("first_of_two_refund", owner, firstOfTwoProof, 1, "pass"),
    continuingRefundTest("refund_cursor_not_advanced_rejected", owner, firstOfTwoProof, 0, "fail"),
    refundTest("last_ticket_refund", owner, "pass"),
    refundTest("wrong_owner_proof_rejected", wrongOwner, "fail")
  ]
};

fs.mkdirSync(path.dirname(testPath), { recursive: true });
fs.writeFileSync(testPath, `${JSON.stringify(tests, null, 2)}\n`, "utf8");
if (!fs.existsSync(debuggerPath)) throw new Error("Build the SilverScript cli-debugger before running the v4 contract tests.");

const result = spawnSync(debuggerPath, [sourcePath, "--run-all", "--test-file", testPath], {
  cwd: root,
  stdio: "inherit",
  shell: false
});
if (result.status !== 0) process.exitCode = result.status ?? 1;
