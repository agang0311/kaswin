import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const USERS = 1_000_000;
const RECORD_BYTES = 64;
const DEPTH = 20;
const EXPECTED_ROOT = "8b5aedb02306c1dedef54f80f1667cbf30494b533e42705dafed16094cced900";
const root = process.cwd();
const fixtureDir = path.join(root, ".tmp", "indexer-million-fixture");
const roundId = "million-user-disk-benchmark";
const port = 8791;

function hash(bytes) {
  return createHash("sha256").update(bytes).digest();
}

function ownerPubkey(ticketId) {
  const value = Buffer.alloc(32);
  value.writeUInt32LE(ticketId, 0);
  return hash(Buffer.concat([Buffer.from("kaspa-raffle-v4-owner"), value]));
}

function rootFromProof(owner, ticketId, proofHex) {
  const proof = Buffer.from(proofHex, "hex");
  let node = hash(owner);
  let pathIndex = ticketId;
  for (let level = 0; level < DEPTH; level += 1) {
    const sibling = proof.subarray(level * 32, level * 32 + 32);
    node = (pathIndex & 1) === 0
      ? hash(Buffer.concat([node, sibling]))
      : hash(Buffer.concat([sibling, node]));
    pathIndex >>= 1;
  }
  return node.toString("hex");
}

function writeTicketFixture() {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
  fs.mkdirSync(fixtureDir, { recursive: true });
  const ticketPath = path.join(fixtureDir, `${encodeURIComponent(roundId)}.tickets.bin`);
  const fd = fs.openSync(ticketPath, "w");
  const batchSize = 4096;
  try {
    for (let start = 0; start < USERS; start += batchSize) {
      const count = Math.min(batchSize, USERS - start);
      const batch = Buffer.alloc(count * RECORD_BYTES);
      for (let offset = 0; offset < count; offset += 1) {
        const ticketId = start + offset;
        ownerPubkey(ticketId).copy(batch, offset * RECORD_BYTES);
        batch.writeUInt32LE(ticketId, offset * RECORD_BYTES + 32);
      }
      fs.writeSync(fd, batch);
    }
  } finally {
    fs.closeSync(fd);
  }

  const summary = {
    roundId,
    contractVersion: "raffle-v13-chain-pow",
    version: "0.6.0",
    status: "Open",
    refundCursor: 0,
    creatorPubkey: ownerPubkey(0).toString("hex"),
    ticketPrice: "30000000",
    maxTickets: USERS,
    minTickets: 1,
    refundAfterDaaScore: "999999999",
    soldTickets: USERS,
    ticketRoot: EXPECTED_ROOT,
    ticketFrontier: "00".repeat(640),
    covenantId: "cd".repeat(32),
    latest: { txId: "ef".repeat(32), index: 0, amountSompi: "30000200000000", address: "kaspatest:pqbenchmark" }
  };
  fs.writeFileSync(path.join(fixtureDir, "state.json"), JSON.stringify({
    version: 1,
    cursor: "",
    eventLogBytes: 0,
    rounds: { [roundId]: summary }
  }));
  fs.writeFileSync(path.join(fixtureDir, "base-state.json"), JSON.stringify({ version: 1, rounds: {} }));
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

async function verifyProof(ticketId) {
  const startedAt = performance.now();
  const response = await fetch(`http://127.0.0.1:${port}/rounds/${roundId}/tickets/${ticketId + 1}`);
  if (!response.ok) throw new Error(`Ticket ${ticketId + 1} proof request failed.`);
  const proof = await response.json();
  const owner = ownerPubkey(ticketId);
  if (proof.ownerPubkey !== owner.toString("hex") || rootFromProof(owner, ticketId, proof.proofHex) !== EXPECTED_ROOT) {
    throw new Error(`Ticket ${ticketId + 1} proof is invalid.`);
  }
  return performance.now() - startedAt;
}

const generatedAt = performance.now();
writeTicketFixture();
const fixtureMs = performance.now() - generatedAt;
let first;
let second;

try {
  first = await startIndexer("cold");
  const proofTimes = [];
  for (const ticketId of [0, 499_999, 999_999]) proofTimes.push(await verifyProof(ticketId));
  const ownerStartedAt = performance.now();
  const ownerHex = ownerPubkey(999_999).toString("hex");
  const ownerResponse = await fetch(`http://127.0.0.1:${port}/rounds/${roundId}/owners/${ownerHex}/proof`);
  const ownerProof = await ownerResponse.json();
  if (!ownerResponse.ok || ownerProof.ticketId !== USERS) throw new Error("Millionth owner lookup failed.");
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

  console.log(`Generated ${USERS.toLocaleString()} fixed-size ticket records in ${(fixtureMs / 1000).toFixed(2)}s.`);
  console.log(`Cold disk-index rebuild: ${(firstStartupMs / 1000).toFixed(2)}s; warm checkpoint restart: ${(warmStartupMs / 1000).toFixed(2)}s.`);
  console.log(`Proof latency ms (first/middle/last): ${proofTimes.map((value) => value.toFixed(2)).join(" / ")}; owner lookup: ${ownerMs.toFixed(2)}.`);
  console.log(`Index fixture bytes: ${diskBytes.toLocaleString()}; warm indexer RSS: ${Number(second.health.rssBytes).toLocaleString()}. Root: ${EXPECTED_ROOT}`);
  await stopIndexer(second);
  second = undefined;
} finally {
  if (first) await stopIndexer(first);
  if (second) await stopIndexer(second);
  fs.rmSync(fixtureDir, { recursive: true, force: true });
}
