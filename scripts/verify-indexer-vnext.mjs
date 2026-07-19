import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DEPTH = 20;
const DOMAIN = Buffer.from("KASPA_RAFFLE_BATCH_V2", "ascii");
const CONTRACT_VERSION = "raffle-vnext-liveness-guard-b1000";
const root = process.cwd();
const fixtureDir = path.join(root, ".tmp", "indexer-vnext-fixture");
const roundId = "a1".repeat(32);
const nonce = "7c".repeat(32);
const port = Number(process.env.RAFFLE_INDEX_VNEXT_TEST_PORT ?? 28791);
const owners = ["11".repeat(32), "22".repeat(32)].map((hex) => Buffer.from(hex, "hex"));

function hash(bytes) { return createHash("sha256").update(bytes).digest(); }
function u64(value) { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(value)); return bytes; }
function rootFromProof(owner, firstTicketId, ticketCount, batchIndex, proofHex) {
  let node = hash(Buffer.concat([DOMAIN, Buffer.from(nonce, "hex"), owner, u64(firstTicketId), u64(ticketCount)]));
  const proof = Buffer.from(proofHex, "hex");
  for (let level = 0; level < DEPTH; level += 1) {
    const sibling = proof.subarray(level * 32, level * 32 + 32);
    node = (batchIndex & 1) === 0 ? hash(Buffer.concat([node, sibling])) : hash(Buffer.concat([sibling, node]));
    batchIndex >>= 1;
  }
  return node.toString("hex");
}

fs.rmSync(fixtureDir, { recursive: true, force: true });
fs.mkdirSync(path.join(fixtureDir, "base-tickets"), { recursive: true });
const hashes = ["c1", "c2", "c3"].map((value) => value.repeat(32));
const events = [
  {
    hash: hashes[0], events: [{
      payload: {
        app: "kaspa-raffle-static", type: "round-create", version: "0.9.13", metadataSchema: 2,
        roundId, contractVersion: CONTRACT_VERSION, roundNonce: nonce, creatorPubkey: owners[0].toString("hex"),
        ticketPrice: "100000000", maxTickets: 100, minTickets: 5, maxBatches: 10, salesDeadlineDaa: "999999999"
      }, transactionId: "d1".repeat(32), output: { index: 0, amountSompi: "0", covenantId: "ee".repeat(32) }
    }]
  },
  {
    hash: hashes[1], events: [{
      payload: { app: "kaspa-raffle-static", type: "ticket", roundId, ticketId: 1, ticketCount: 3, buyerPubkey: owners[0].toString("hex") },
      transactionId: "d2".repeat(32), output: { index: 0, amountSompi: "300000000", covenantId: "ee".repeat(32) }
    }, {
      payload: { app: "kaspa-raffle-static", type: "round-carrier-topup", roundId, amountSompi: "57300000" },
      transactionId: "e2".repeat(32), output: { index: 0, amountSompi: "357300000", covenantId: "ee".repeat(32) }
    }]
  },
  {
    hash: hashes[2], events: [{
      payload: { app: "kaspa-raffle-static", type: "ticket", roundId, ticketId: 4, ticketCount: 7, buyerPubkey: owners[1].toString("hex") },
      transactionId: "d3".repeat(32), output: { index: 0, amountSompi: "1000000000", covenantId: "ee".repeat(32) }
    }]
  }
];
fs.writeFileSync(path.join(fixtureDir, "events.ndjson"), `${events.map(JSON.stringify).join("\n")}\n`);
fs.writeFileSync(path.join(fixtureDir, "event-blocks.bin"), Buffer.concat(hashes.map((value) => Buffer.from(value, "hex"))));
fs.writeFileSync(path.join(fixtureDir, "base-state.json"), JSON.stringify({ version: 3, rounds: {} }));
fs.writeFileSync(path.join(fixtureDir, "state.json"), JSON.stringify({ version: 3, cursor: "", eventLogBytes: 0, rounds: {} }));

const child = spawn(process.execPath, [path.join(root, "indexer", "raffle-indexer.mjs")], {
  cwd: root,
  env: { ...process.env, RAFFLE_INDEX_DATA: fixtureDir, RAFFLE_INDEX_HOST: "127.0.0.1", RAFFLE_INDEX_PORT: String(port), RAFFLE_INDEX_OFFLINE: "1", RAFFLE_INDEX_REMOVE_BLOCKS: hashes[2] },
  stdio: ["ignore", "pipe", "pipe"]
});
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch { /* still rebuilding */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`vNext indexer did not start. ${stderr}`);
}

try {
  await waitForServer();
  const round = await (await fetch(`http://127.0.0.1:${port}/rounds/${roundId}`)).json();
  assert.equal(round.contractVersion, CONTRACT_VERSION);
  assert.equal(round.roundNonce, nonce);
  assert.equal(round.metadataSchema, 2);
  assert.equal(round.soldTickets, 3, "reorg must remove the second vNext purchase");
  assert.equal(round.soldBatches, 1, "reorg must rebuild vNext derived indexes");
  assert.equal(round.latestCovenant.txId, "e2".repeat(32), "carrier top-up must become the latest covenant cursor");
  assert.equal(round.latestCovenant.amountSompi, "357300000", "carrier top-up amount must survive index rebuild");
  const proof = await (await fetch(`http://127.0.0.1:${port}/rounds/${roundId}/tickets/2`)).json();
  assert.equal(proof.rootHex, rootFromProof(owners[0], 0, 3, 0, proof.proofHex), "vNext proof must use the nonce-domain leaf");
  const legacyRoot = hash(Buffer.concat([owners[0], u64(0), u64(3)])).toString("hex");
  assert.notEqual(proof.rootHex, legacyRoot, "vNext proof must not fall back to the legacy leaf format");
  assert.equal((await fetch(`http://127.0.0.1:${port}/rounds/${roundId}/tickets/4`)).status, 404);
  const checkpoint = JSON.parse(fs.readFileSync(path.join(fixtureDir, `${encodeURIComponent(roundId)}.tree`, "checkpoint.json"), "utf8"));
  assert.deepEqual({ treeEncoding: checkpoint.treeEncoding, roundNonce: checkpoint.roundNonce, metadataSchema: checkpoint.metadataSchema }, { treeEncoding: "vnext-batch-v2", roundNonce: nonce, metadataSchema: 2 });
  console.log("vNext indexer nonce-domain proof, persistence checkpoint, recovery, and reorg rebuild checks passed.");
} finally {
  if (child.exitCode === null) { child.kill("SIGTERM"); await new Promise((resolve) => child.once("exit", resolve)); }
  fs.rmSync(fixtureDir, { recursive: true, force: true });
}
