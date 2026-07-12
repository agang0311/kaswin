import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import * as secp from "@noble/secp256k1";

const root = process.cwd();
const fixtureDir = path.join(root, ".tmp", "indexer-fixture");
const roundId = "ab".repeat(32);
const port = 8790;
fs.rmSync(fixtureDir, { recursive: true, force: true });
fs.mkdirSync(fixtureDir, { recursive: true });

const owners = Array.from({ length: 10 }, (_, index) => index + 1).map((value) => Buffer.from(secp.schnorr.getPublicKey(
  Buffer.from(value.toString(16).padStart(64, "0"), "hex")
)));
const oracleFields = {
  oraclePublicKey: owners[2].toString("hex"),
  oraclePublicKey2: owners[3].toString("hex"),
  oraclePublicKey3: owners[4].toString("hex"),
  oracleSeedCommitment: "11".repeat(32),
  oracleSeedCommitment2: "22".repeat(32),
  oracleSeedCommitment3: "33".repeat(32),
  oracleEndpoint: "https://oracle-1.example",
  oracleEndpoint2: "https://oracle-2.example",
  oracleEndpoint3: "https://oracle-3.example"
};
const records = owners.map((owner, index) => Buffer.concat([owner, Buffer.alloc(32, index + 1)]));
fs.writeFileSync(path.join(fixtureDir, `${roundId}.tickets.bin`), Buffer.concat(records));
const blockHashes = Array.from({ length: 13 }, (_, index) => index + 1).map((value) => value.toString(16).padStart(2, "0").repeat(32));
const createPayload = {
  app: "kaspa-raffle-static",
  type: "round-create",
  version: "0.2.0",
  roundId,
  contractVersion: "raffle-v7-three-commitment-oracles",
  creator: "kaspatest:qzrhkehvwlzpzh8dv9ecl8eadayyzhrqlkcldzfzu32mrgv2m9npqq7nx4zen",
  creatorPubkey: owners[0].toString("hex"),
  ...oracleFields,
  ticketPrice: "30000000",
  maxTickets: 1_000_000,
  minTickets: 1,
  refundAfterDaaScore: "999999999"
};
const eventBlocks = [{
  hash: blockHashes[0],
  events: [{ payload: createPayload, transactionId: "00".repeat(32), output: { index: 0, amountSompi: "20000000", address: "kaspatest:pqexample" } }]
}, ...owners.map((owner, index) => ({
  hash: blockHashes[index + 1],
  events: [{
    payload: {
      app: "kaspa-raffle-static",
      type: "ticket",
      roundId,
      ticketId: index + 1,
      ticketCount: 1,
      buyerPubkey: owner.toString("hex")
    },
    transactionId: Buffer.alloc(32, index + 1).toString("hex"),
    output: { index: 0, amountSompi: String(50_000_000 + index * 30_000_000), address: "kaspatest:pqexample" }
  }]
})), {
  hash: blockHashes[11],
  events: [{
    payload: { app: "kaspa-raffle-static", type: "round-refund-start", roundId, refundCursor: 0 },
    transactionId: "fa".repeat(32),
    output: { index: 0, amountSompi: "257800000", address: "kaspatest:pqrefund", covenantId: "cd".repeat(32) }
  }]
}, {
  hash: blockHashes[12],
  events: [{
    payload: { app: "kaspa-raffle-static", type: "round-refund-batch", roundId, refundCursor: 0, ticketCount: 8 },
    transactionId: "fb".repeat(32),
    output: { index: 0, amountSompi: "177800000", address: "kaspatest:pqrefundnext", covenantId: "cd".repeat(32) }
  }]
}];
fs.writeFileSync(path.join(fixtureDir, "events.ndjson"), `${eventBlocks.slice(2).map((block) => JSON.stringify(block)).join("\n")}\n`);
fs.writeFileSync(path.join(fixtureDir, "event-blocks.bin"), Buffer.concat(blockHashes.slice(2).map((hash) => Buffer.from(hash, "hex"))));
fs.writeFileSync(path.join(fixtureDir, "state.json"), JSON.stringify({
  version: 1,
  cursor: "",
  rounds: {
    [roundId]: {
      roundId,
      contractVersion: "raffle-v7-three-commitment-oracles",
      version: "0.2.0",
      creator: "kaspatest:qzrhkehvwlzpzh8dv9ecl8eadayyzhrqlkcldzfzu32mrgv2m9npqq7nx4zen",
      creatorPubkey: owners[0].toString("hex"),
      ...oracleFields,
      ticketPrice: "30000000",
      maxTickets: 1_000_000,
      minTickets: 1,
      refundAfterDaaScore: "999999999",
      status: "Open",
      refundCursor: 0,
      soldTickets: 1,
      covenantId: "cd".repeat(32),
      latest: {
        txId: "01".repeat(32),
        index: 0,
        amountSompi: "50000000",
        address: "kaspatest:pqexample"
      }
    }
  }
}));
fs.mkdirSync(path.join(fixtureDir, "base-tickets"));
fs.writeFileSync(path.join(fixtureDir, "base-tickets", `${roundId}.tickets.bin`), records[0]);
fs.writeFileSync(path.join(fixtureDir, "base-state.json"), JSON.stringify({
  version: 1,
  rounds: {
    [roundId]: {
      roundId,
      contractVersion: "raffle-v7-three-commitment-oracles",
      version: "0.2.0",
      creator: createPayload.creator,
      creatorPubkey: owners[0].toString("hex"),
      ...oracleFields,
      ticketPrice: "30000000",
      maxTickets: 1_000_000,
      minTickets: 1,
      refundAfterDaaScore: "999999999",
      status: "Open",
      refundCursor: 0,
      soldTickets: 1,
      covenantId: "cd".repeat(32),
      latest: eventBlocks[1].events[0].output
    }
  }
}));

function sha(bytes) {
  return createHash("sha256").update(bytes).digest();
}

function rootFromProof(owner, ticketId, proofHex) {
  const proof = Buffer.from(proofHex, "hex");
  let node = sha(owner);
  let pathIndex = ticketId;
  for (let level = 0; level < 20; level += 1) {
    const sibling = proof.subarray(level * 32, level * 32 + 32);
    node = (pathIndex & 1) === 0 ? sha(Buffer.concat([node, sibling])) : sha(Buffer.concat([sibling, node]));
    pathIndex >>= 1;
  }
  return node.toString("hex");
}

const child = spawn(process.execPath, [path.join(root, "indexer", "raffle-indexer.mjs")], {
  cwd: root,
  env: {
    ...process.env,
    RAFFLE_INDEX_DATA: fixtureDir,
    RAFFLE_INDEX_PORT: String(port),
    RAFFLE_INDEX_CONFIRMATIONS: "2",
    RAFFLE_INDEX_OFFLINE: "1",
    RAFFLE_INDEX_REMOVE_BLOCKS: blockHashes[10]
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
      // Process may still be connecting to RPC.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Indexer did not start. ${stderr}`);
}

try {
  await waitForServer();
  const baseState = JSON.parse(fs.readFileSync(path.join(fixtureDir, "base-state.json"), "utf8"));
  if (baseState.rounds?.[roundId]?.soldTickets !== 1) {
    throw new Error("Indexer migration baseline was not preserved.");
  }
  const rounds = await (await fetch(`http://127.0.0.1:${port}/rounds`)).json();
  if (
    rounds.length !== 1 ||
    rounds[0].soldTickets !== 9 ||
    rounds[0].status !== "Refunding" ||
    rounds[0].refundCursor !== 8 ||
    rounds[0].refundTxId ||
    rounds[0].oracleEndpoint !== createPayload.oracleEndpoint ||
    rounds[0].latestCovenant?.txId !== "fb".repeat(32) ||
    rounds[0].latestCovenant?.refundCursor !== 8
  ) {
    throw new Error("Indexer did not restore the round cursor and ticket count.");
  }
  const ticket = await (await fetch(`http://127.0.0.1:${port}/rounds/${roundId}/tickets/2`)).json();
  if (ticket.ownerPubkey !== owners[1].toString("hex") || rootFromProof(owners[1], 1, ticket.proofHex) !== ticket.rootHex) {
    throw new Error("Ticket-number proof is invalid.");
  }
  const owner = await (await fetch(
    `http://127.0.0.1:${port}/rounds/${roundId}/owners/${owners[1].toString("hex")}/proof`
  )).json();
  if (owner.ticketId !== 2 || rootFromProof(owners[1], 1, owner.proofHex) !== owner.rootHex) {
    throw new Error("Owner lookup proof is invalid.");
  }
  const resumedTail = await (await fetch(`http://127.0.0.1:${port}/rounds/${roundId}/tickets/9`)).json();
  if (
    resumedTail.ticketId !== 9 ||
    resumedTail.ownerPubkey !== owners[8].toString("hex") ||
    rootFromProof(owners[8], 8, resumedTail.proofHex) !== resumedTail.rootHex
  ) {
    throw new Error("A second client could not load the on-chain refund cursor and obtain the next tail proof.");
  }
  const range = await (await fetch(`http://127.0.0.1:${port}/rounds/${roundId}/ranges/1/8`)).json();
  let rangeNode = range.ownerPubkeys.map((ownerPubkey) => sha(Buffer.from(ownerPubkey, "hex")));
  while (rangeNode.length > 1) {
    const parents = [];
    for (let index = 0; index < rangeNode.length; index += 2) parents.push(sha(Buffer.concat([rangeNode[index], rangeNode[index + 1]])));
    rangeNode = parents;
  }
  let root = rangeNode[0];
  const rangeProof = Buffer.from(range.proofHex, "hex");
  for (let level = 0; level < 17; level += 1) root = sha(Buffer.concat([root, rangeProof.subarray(level * 32, level * 32 + 32)]));
  if (range.firstTicketId !== 1 || range.ticketCount !== 8 || range.ownerPubkeys.length !== 8 || root.toString("hex") !== range.rootHex) {
    throw new Error("Eight-ticket range proof is invalid.");
  }
  console.log(`Indexer rolled back ticket #10, restored 9 users, loaded refund cursor 8 in a second client, and returned ticket #9 plus range proofs for continuation. Root: ${ticket.rootHex}`);
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
}
