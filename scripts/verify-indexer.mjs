import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const DEPTH = 20;
const RECORD_BYTES = 80;
const CONTRACT_VERSION = "raffle-v14-batch-range";
const root = process.cwd();
const fixtureDir = path.join(root, ".tmp", "indexer-fixture");
const roundId = "ab".repeat(32);
const port = Number(process.env.RAFFLE_INDEX_TEST_PORT ?? 28790);
const sizes = [1, 10, 100, 1_000];
const owners = sizes.map((_, index) => createHash("sha256").update(`owner-${index + 1}`).digest());
const txIds = sizes.map((_, index) => Buffer.alloc(32, index + 1));

function hash(bytes) {
  return createHash("sha256").update(bytes).digest();
}

function u64(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return bytes;
}

function batchRecord(owner, transactionId, firstTicketId, ticketCount) {
  return Buffer.concat([owner, transactionId, u64(firstTicketId), u64(ticketCount)]);
}

function rootFromProof(owner, firstTicketId, ticketCount, batchIndex, proofHex) {
  const proof = Buffer.from(proofHex, "hex");
  let node = hash(Buffer.concat([owner, u64(firstTicketId), u64(ticketCount)]));
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

fs.rmSync(fixtureDir, { recursive: true, force: true });
fs.mkdirSync(fixtureDir, { recursive: true });
fs.mkdirSync(path.join(fixtureDir, "base-tickets"));

const firstRecord = batchRecord(owners[0], txIds[0], 0, sizes[0]);
const batchPath = path.join(fixtureDir, `${roundId}.batches.bin`);
fs.writeFileSync(batchPath, firstRecord);
fs.writeFileSync(path.join(fixtureDir, "base-tickets", `${roundId}.batches.bin`), firstRecord);

const blockHashes = Array.from({ length: 7 }, (_, index) => (index + 1).toString(16).padStart(2, "0").repeat(32));
const createPayload = {
  app: "kaspa-raffle-static",
  type: "round-create",
  version: "0.8.0",
  roundId,
  contractVersion: CONTRACT_VERSION,
  creator: "kaspatest:qzrhkehvwlzpzh8dv9ecl8eadayyzhrqlkcldzfzu32mrgv2m9npqq7nx4zen",
  creatorPubkey: owners[0].toString("hex"),
  ticketPrice: "30000000",
  maxTickets: 1_000_000,
  minTickets: 1,
  refundAfterDaaScore: "999999999"
};
const baseSummary = {
  ...createPayload,
  status: "Open",
  refundCursor: 0,
  refundBatchCursor: 0,
  soldTickets: 1,
  soldBatches: 1,
  covenantId: "cd".repeat(32),
  latest: {
    txId: txIds[0].toString("hex"),
    index: 0,
    amountSompi: "50000000",
    address: "kaspatest:pqexample"
  }
};
delete baseSummary.app;
delete baseSummary.type;

let firstTicketId = 1;
const buyBlocks = sizes.slice(1).map((ticketCount, offset) => {
  const index = offset + 1;
  const block = {
    hash: blockHashes[index],
    events: [{
      payload: {
        app: "kaspa-raffle-static",
        type: "ticket",
        roundId,
        ticketId: firstTicketId + 1,
        ticketCount,
        buyerPubkey: owners[index].toString("hex")
      },
      transactionId: txIds[index].toString("hex"),
      output: {
        index: 0,
        amountSompi: String(50_000_000 + (firstTicketId + ticketCount) * 30_000_000),
        address: "kaspatest:pqexample",
        covenantId: "cd".repeat(32)
      }
    }]
  };
  firstTicketId += ticketCount;
  return block;
});

const refundStartBlock = {
  hash: blockHashes[4],
  events: [{
    payload: { app: "kaspa-raffle-static", type: "round-refund-start", roundId, refundCursor: 0, refundBatchCursor: 0 },
    transactionId: "fa".repeat(32),
    output: { index: 0, amountSompi: "3332700000", address: "kaspatest:pqrefund", covenantId: "ef".repeat(32) }
  }]
};
const refundFirstBlock = {
  hash: blockHashes[5],
  events: [{
    payload: {
      app: "kaspa-raffle-static",
      type: "round-refund-batch",
      roundId,
      refundCursor: 0,
      refundBatchCursor: 0,
      ticketCount: 1
    },
    transactionId: "fb".repeat(32),
    output: { index: 0, amountSompi: "3302700000", address: "kaspatest:pqrefundnext", covenantId: "ef".repeat(32) }
  }]
};
const ignoredLegacyBlock = {
  hash: blockHashes[6],
  events: [{
    payload: { app: "kaspa-raffle-static", type: "round-create", roundId: "legacy-round", contractVersion: "raffle-v13-chain-pow" },
    transactionId: "f7".repeat(32),
    output: { index: 0, amountSompi: "57000000", address: "kaspatest:pqlegacy" }
  }]
};
const eventBlocks = [...buyBlocks, refundStartBlock, refundFirstBlock, ignoredLegacyBlock];
const eventText = `${eventBlocks.map((block) => JSON.stringify(block)).join("\n")}\n`;
fs.writeFileSync(path.join(fixtureDir, "events.ndjson"), eventText);
fs.writeFileSync(path.join(fixtureDir, "event-blocks.bin"), Buffer.concat(eventBlocks.map((block) => Buffer.from(block.hash, "hex"))));
fs.writeFileSync(path.join(fixtureDir, "state.json"), JSON.stringify({
  version: 2,
  cursor: "",
  eventLogBytes: 0,
  rounds: { [roundId]: baseSummary }
}));
fs.writeFileSync(path.join(fixtureDir, "base-state.json"), JSON.stringify({ version: 2, rounds: { [roundId]: baseSummary } }));

const child = spawn(process.execPath, [path.join(root, "indexer", "raffle-indexer.mjs")], {
  cwd: root,
  env: {
    ...process.env,
    RAFFLE_INDEX_DATA: fixtureDir,
    RAFFLE_INDEX_HOST: "127.0.0.1",
    RAFFLE_INDEX_PORT: String(port),
    RAFFLE_INDEX_CONFIRMATIONS: "2",
    RAFFLE_INDEX_OFFLINE: "1",
    RAFFLE_INDEX_REMOVE_BLOCKS: buyBlocks[2].hash
  },
  stdio: ["ignore", "pipe", "pipe"]
});
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // The offline fixture is still rebuilding.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Indexer did not start. ${stderr}`);
}

function assertProof(proof, owner) {
  const firstZeroBased = proof.firstTicketId - 1;
  const rootHex = rootFromProof(owner, firstZeroBased, proof.ticketCount, proof.batchIndex, proof.proofHex);
  if (rootHex !== proof.rootHex) throw new Error(`Batch ${proof.batchIndex} proof is invalid.`);
}

try {
  await waitForServer();
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  if (!health.ok || health.network !== "testnet-10" || "rpcUrl" in health) {
    throw new Error("Indexer health response is invalid or exposes its private RPC endpoint.");
  }

  const rounds = await (await fetch(`http://127.0.0.1:${port}/rounds`)).json();
  if (
    rounds.length !== 1 || rounds[0].soldTickets !== 111 || rounds[0].soldBatches !== 3 ||
    rounds[0].status !== "Refunding" || rounds[0].refundCursor !== 1 || rounds[0].refundBatchCursor !== 1 ||
    rounds[0].latestCovenant?.txId !== "fb".repeat(32) || rounds[0].latestCovenant?.refundBatchCursor !== 1
  ) {
    throw new Error("Indexer did not restore both batch and ticket cursors after rollback.");
  }

  const ticket = await (await fetch(`http://127.0.0.1:${port}/rounds/${roundId}/tickets/11`)).json();
  if (ticket.ownerPubkey !== owners[1].toString("hex") || ticket.firstTicketId !== 2 || ticket.ticketCount !== 10) {
    throw new Error("Ticket lookup did not resolve the containing 10-ticket purchase batch.");
  }
  assertProof(ticket, owners[1]);

  const nextRefund = await (await fetch(`http://127.0.0.1:${port}/rounds/${roundId}/batches/1`)).json();
  if (nextRefund.firstTicketId !== 2 || nextRefund.ticketCount !== 10 || nextRefund.batchIndex !== 1) {
    throw new Error("A loaded client could not obtain the next purchase batch for refund continuation.");
  }
  assertProof(nextRefund, owners[1]);

  const ownerResponse = await fetch(
    `http://127.0.0.1:${port}/rounds/${roundId}/owners/${owners[2].toString("hex")}/proof`
  );
  const ownerProof = await ownerResponse.json();
  if (!ownerResponse.ok || ownerProof.firstTicketId !== 12 || ownerProof.ticketCount !== 100) {
    throw new Error("Owner lookup did not return the 100-ticket purchase batch.");
  }
  assertProof(ownerProof, owners[2]);

  const removed = await fetch(`http://127.0.0.1:${port}/rounds/${roundId}/tickets/112`);
  if (removed.status !== 404) throw new Error("Reorg-removed 1,000-ticket batch is still indexed.");

  console.log(`Indexer restored 111 tickets in 3 purchase batches, resumed refund batch 2 after load, and rejected the reorg-removed batch. Root: ${ticket.rootHex}`);
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  fs.rmSync(fixtureDir, { recursive: true, force: true });
}
