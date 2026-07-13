import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const debuggerPath = path.join(root, ".tools/silverscript/target/debug", process.platform === "win32" ? "cli-debugger.exe" : "cli-debugger");
const sources = ["raffle_round_v8_tn12.sil", "raffle_round_v8_mainnet.sil"];
const owner = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const covenantId = `0x${"11".repeat(32)}`;
const emptyRoot = `0x${"00".repeat(32)}`;
const emptyFrontier = `0x${"00".repeat(640)}`;

function state(soldTickets, refundCursor, maxTickets = 10) {
  return {
    max_tickets: maxTickets,
    ticket_price: 30_000_000,
    creator_pubkey: `0x${owner}`,
    refund_after_daa: 1_000,
    sold_tickets: soldTickets,
    ticket_root: emptyRoot,
    frontier: emptyFrontier,
    refund_cursor: refundCursor
  };
}

const dummyFinalizeArgs = [
  `0x${"00".repeat(32)}`,
  `0x${"00".repeat(4)}`,
  `0x${"00".repeat(256)}`,
  "0x00",
  `0x${"00".repeat(32)}`,
  1,
  `0x${"00".repeat(32)}`,
  0,
  `0x${owner}`,
  `0x${"00".repeat(640)}`,
  0,
  `0x${owner}`,
  `0x${"00".repeat(640)}`
];

const tests = {
  tests: [
    {
      name: "sold_out_round_closes",
      function: "close",
      args: [],
      expect: "pass",
      tx: {
        version: 1,
        active_input_index: 0,
        inputs: [{ utxo_value: 360_000_000, covenant_id: covenantId, state: state(10, 0) }],
        outputs: [{
          value: 357_000_000,
          covenant_id: covenantId,
          authorizing_input: 0,
          state: state(10, -1)
        }]
      }
    },
    {
      name: "closed_round_rejects_more_tickets",
      function: "buy",
      args: [`0x${owner}`, 1],
      expect: "fail",
      tx: {
        version: 1,
        active_input_index: 0,
        inputs: [{ utxo_value: 300_000_000, covenant_id: covenantId, state: state(8, -1, 10) }],
        outputs: []
      }
    },
    {
      name: "open_round_cannot_finalize",
      function: "finalize",
      args: dummyFinalizeArgs,
      expect: "fail",
      tx: {
        version: 1,
        active_input_index: 0,
        inputs: [
          { utxo_value: 90_000_000, covenant_id: covenantId, state: state(1, 0, 1) },
          { utxo_value: 5_000_000, utxo_script_hex: `20${owner}ac` }
        ],
        outputs: []
      }
    }
  ]
};

if (!fs.existsSync(debuggerPath)) throw new Error("Build the SilverScript cli-debugger before running V8 VM tests.");
for (const sourceName of sources) {
  const source = path.join(root, "src/contracts", sourceName);
  const testPath = path.join(root, `.tmp/${sourceName}.close.test.json`);
  fs.mkdirSync(path.dirname(testPath), { recursive: true });
  fs.writeFileSync(testPath, `${JSON.stringify(tests, null, 2)}\n`);
  const result = spawnSync(debuggerPath, [source, "--run-all", "--test-file", testPath], { cwd: root, encoding: "utf8" });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.status !== 0) process.exit(result.status ?? 1);
}
