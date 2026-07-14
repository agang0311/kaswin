import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const BATCHES = 1_000_000;
const RECORD_BYTES = 80;
const DEPTH = 20;
const CAPACITY = 1 << DEPTH;
const root = process.cwd();
const fixtureDir = path.join(root, ".tmp", "indexer-million-fixture");
const roundId = "million-purchase-batch-disk-benchmark";
const port = 8791;
let expectedRoot = "";

function hash(bytes) {
  return createHash("sha256").update(bytes).digest();
}

function u64(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return bytes;
}

function ownerPubkey(batchIndex) {
  const value = Buffer.alloc(8);
  value.writeBigUInt64LE(BigInt(batchIndex));
  return hash(Buffer.concat([Buffer.from("kaspa-raffle-v14-owner"), value]));
}

function leaf(owner, firstTicketId, ticketCount) {
  return hash(Buffer.concat([owner, u64(firstTicketId), u64(ticketCount)]));
}

function rootFromProof(owner, firstTicketId, ticketCount, batchIndex, proofHex) {
  const proof = Buffer.from(proofHex, "hex");
  let node = leaf(owner, firstTicketId, ticketCount);
  let pathIndex = batchIndex;
  for (let level = 0; level < DEPTH; level += 1) {
    const sibling = proof.subarray(level * 32, level * 32 + 32);
    node = (pathIndex & 1) === 0
      ? hash(Buffer.concat([node, sibling]))
      : hash(Buffer.concat([sibling, node]));
    pathIndex >>= 1;
  }
  return node.toString("hex");
}

function writeBatchFixture() {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
  fs.mkdirSync(fixtureDir, { recursive: true });
  const batchPath = path.join(fixtureDir, `${encodeURIComponent(roundId)}.batches.bin`);
  const fd = fs.openSync(batchPath, "w");
  const leaves = Buffer.alloc(CAPACITY * 32);
  const chunkSize = 4096;
  try {
    for (let start = 0; start < BATCHES; start += chunkSize) {
      const count = Math.min(chunkSize, BATCHES - start);
      const chunk = Buffer.alloc(count * RECORD_BYTES);
      for (let offset = 0; offset < count; offset += 1) {
        const batchIndex = start + offset;
        const owner = ownerPubkey(batchIndex);
        const recordOffset = offset * RECORD_BYTES;
        owner.copy(chunk, recordOffset);
        u64(batchIndex).copy(chunk, recordOffset + 64);
        u64(1).copy(chunk, recordOffset + 72);
        leaf(owner, batchIndex, 1).copy(leaves, batchIndex * 32);
      }
      fs.writeSync(fd, chunk);
    }
  } finally {
    fs.closeSync(fd);
  }

  let nodes = leaves;
  for (let level = 0; level < DEPTH; level += 1) {
    const parents = Buffer.alloc(nodes.length / 2);
    for (let offset = 0; offset < nodes.length; offset += 64) {
      hash(nodes.subarray(offset, offset + 64)).copy(parents, offset / 2);
    }
    nodes = parents;
  }
  expectedRoot = nodes.toString("hex");

  const summary = {
    roundId,
    contractVersion: "raffle-v15-arbitrary-batched-refund",
    version: "0.9.0",
    status: "Open",
    refundCursor: 0,
    refundBatchCursor: 0,
    creatorPubkey: ownerPubkey(0).toString("hex"),
    ticketPrice: "30000000",
    maxTickets: BATCHES,
    minTickets: 1,
    refundAfterDaaScore: "999999999",
    soldTickets: BATCHES,
    soldBatches: BATCHES,
    ticketRoot: expectedRoot,
    covenantId: "cd".repeat(32),
    latest: { txId: "ef".repeat(32), index: 0, amountSompi: "30000200000000", address: "kaspatest:pqbenchmark" }
  };
  fs.writeFileSync(path.join(fixtureDir, "state.json"), JSON.stringify({
    version: 2,
    cursor: "",
    eventLogBytes: 0,
    rounds: { [roundId]: summary }
  }));
  fs.writeFileSync(path.join(fixtureDir, "base-state.json"), JSON.stringify({ version: 2, rounds: {} }));
  fs.mkdirSync(path.join(fixtureDir, "base-tickets"));
  fs.writeFileSync(path.join(fixtureDir, "events.ndjson"), "");
  fs.writeFileSync(path.join(fixtureDir, "event-blocks.bin"), "");
}

async function startIndexer(label) {
  const startedAt = performance.now();
  const child = spawn(process.execPath, [path.join(root, "indexer", "raffle-indexer.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      RAFFLE_INDEX_DATA: fixtureDir,
      RAFFLE_INDEX_PORT: String(port),
      RAFFLE_INDEX_OFFLINE: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  for (let attempt = 0; attempt < 3600; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`${label} indexer exited early. ${stderr}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return {
        child,
        elapsedMs: performance.now() - startedAt,
        health: await response.json(),
        stderr: () => stderr
      };
    } catch {
      // Initial disk rebuild is still running.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  child.kill("SIGTERM");
  throw new Error(`${label} indexer did not start within 15 minutes. ${stderr}`);
}

async function stopIndexer(run) {
  run.child.kill("SIGTERM");
  await new Promise((resolve) => run.child.once("exit", resolve));
  if (run.stderr()) throw new Error(run.stderr());
}

async function verifyProof(batchIndex) {
  const startedAt = performance.now();
  const response = await fetch(`http://127.0.0.1:${port}/rounds/${roundId}/tickets/${batchIndex + 1}`);
  if (!response.ok) throw new Error(`Ticket ${batchIndex + 1} proof request failed.`);
  const proof = await response.json();
  const owner = ownerPubkey(batchIndex);
  if (
    proof.ownerPubkey !== owner.toString("hex") || proof.batchIndex !== batchIndex || proof.ticketCount !== 1 ||
    rootFromProof(owner, batchIndex, 1, batchIndex, proof.proofHex) !== expectedRoot
  ) {
    throw new Error(`Ticket ${batchIndex + 1} proof is invalid.`);
  }
  return performance.now() - startedAt;
}

const generatedAt = performance.now();
writeBatchFixture();
const fixtureMs = performance.now() - generatedAt;
let first;
let second;

try {
  first = await startIndexer("cold");
  const proofTimes = [];
  for (const batchIndex of [0, 499_999, 999_999]) proofTimes.push(await verifyProof(batchIndex));
  const ownerStartedAt = performance.now();
  const ownerHex = ownerPubkey(999_999).toString("hex");
  const ownerResponse = await fetch(`http://127.0.0.1:${port}/rounds/${roundId}/owners/${ownerHex}/proof`);
  const ownerProof = await ownerResponse.json();
  if (!ownerResponse.ok || ownerProof.batchIndex !== 999_999 || ownerProof.ticketId !== BATCHES) {
    throw new Error("Millionth owner lookup failed.");
  }
  const ownerMs = performance.now() - ownerStartedAt;
  const firstStartupMs = first.elapsedMs;
  await stopIndexer(first);
  first = undefined;

  second = await startIndexer("warm");
  const warmStartupMs = second.elapsedMs;
  await verifyProof(999_999);
  const diskBytes = fs.readdirSync(fixtureDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .reduce((total, entry) => total + fs.statSync(path.join(entry.parentPath, entry.name)).size, 0);

  console.log(`Generated ${BATCHES.toLocaleString()} one-ticket purchase-batch records in ${(fixtureMs / 1000).toFixed(2)}s.`);
  console.log(`Cold disk-index rebuild: ${(firstStartupMs / 1000).toFixed(2)}s; warm checkpoint restart: ${(warmStartupMs / 1000).toFixed(2)}s.`);
  console.log(`Proof latency ms (first/middle/last): ${proofTimes.map((value) => value.toFixed(2)).join(" / ")}; owner lookup: ${ownerMs.toFixed(2)}.`);
  console.log(`Index fixture bytes: ${diskBytes.toLocaleString()}; warm indexer RSS: ${Number(second.health.rssBytes).toLocaleString()}. Root: ${expectedRoot}`);
  await stopIndexer(second);
  second = undefined;
} finally {
  if (first) await stopIndexer(first);
  if (second) await stopIndexer(second);
  fs.rmSync(fixtureDir, { recursive: true, force: true });
}
