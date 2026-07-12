import { createHash } from "node:crypto";
import process from "node:process";

const DEPTH = 20;
const CAPACITY = 1 << DEPTH;
const USERS = 1_000_000;
const HASH_BYTES = 32;

function hash(bytes) {
  return createHash("sha256").update(bytes).digest();
}

function hashPair(left, right) {
  return hash(Buffer.concat([left, right]));
}

function ownerPubkey(ticketId) {
  const value = Buffer.alloc(HASH_BYTES);
  value.writeUInt32LE(ticketId, 0);
  return hash(Buffer.concat([Buffer.from("kaspa-raffle-v4-owner"), value]));
}

function ticketLeaf(ticketId) {
  return hash(ownerPubkey(ticketId));
}

const levels = [Buffer.alloc(CAPACITY * HASH_BYTES)];
for (let ticketId = 0; ticketId < USERS; ticketId += 1) {
  ticketLeaf(ticketId).copy(levels[0], ticketId * HASH_BYTES);
}

for (let level = 0; level < DEPTH; level += 1) {
  const current = levels[level];
  const parent = Buffer.alloc(current.length / 2);
  for (let offset = 0; offset < current.length; offset += HASH_BYTES * 2) {
    hashPair(current.subarray(offset, offset + HASH_BYTES), current.subarray(offset + HASH_BYTES, offset + HASH_BYTES * 2))
      .copy(parent, offset / 2);
  }
  levels.push(parent);
}

const root = levels[DEPTH].toString("hex");

const emptyNodes = [Buffer.alloc(HASH_BYTES)];
for (let level = 1; level < DEPTH; level += 1) {
  emptyNodes.push(hashPair(emptyNodes[level - 1], emptyNodes[level - 1]));
}
const frontier = Buffer.alloc(DEPTH * HASH_BYTES);
let frontierRoot = Buffer.alloc(HASH_BYTES);
for (let ticketId = 0; ticketId < USERS; ticketId += 1) {
  let node = ticketLeaf(ticketId);
  let index = ticketId;
  let carrying = true;
  for (let level = 0; level < DEPTH; level += 1) {
    const start = level * HASH_BYTES;
    if ((index & 1) === 0) {
      if (carrying) {
        node.copy(frontier, start);
        carrying = false;
      }
      node = hashPair(node, emptyNodes[level]);
    } else {
      node = hashPair(frontier.subarray(start, start + HASH_BYTES), node);
    }
    index = Math.floor(index / 2);
  }
  frontierRoot = node;
}
if (frontierRoot.toString("hex") !== root) {
  throw new Error("The compact on-chain frontier root does not match the full million-user tree.");
}

function proof(ticketId) {
  const chunks = [];
  let index = ticketId;
  for (let level = 0; level < DEPTH; level += 1) {
    const siblingIndex = index ^ 1;
    chunks.push(levels[level].subarray(siblingIndex * HASH_BYTES, siblingIndex * HASH_BYTES + HASH_BYTES));
    index = Math.floor(index / 2);
  }
  return Buffer.concat(chunks);
}

function verify(ticketId, owner, merkleProof) {
  let node = hash(owner);
  let index = ticketId;
  for (let level = 0; level < DEPTH; level += 1) {
    const sibling = merkleProof.subarray(level * HASH_BYTES, level * HASH_BYTES + HASH_BYTES);
    node = (index & 1) === 0 ? hashPair(node, sibling) : hashPair(sibling, node);
    index = Math.floor(index / 2);
  }
  return node.toString("hex") === root;
}

for (const ticketId of [0, 1, 499_999, 999_999]) {
  const merkleProof = proof(ticketId);
  if (merkleProof.length !== DEPTH * HASH_BYTES || !verify(ticketId, ownerPubkey(ticketId), merkleProof)) {
    throw new Error(`Merkle proof failed for ticket ${ticketId}.`);
  }
}

if (verify(999_999, ownerPubkey(999_998), proof(999_999))) {
  throw new Error("A wrong owner was accepted for ticket 999999.");
}

function rangeProof8(firstTicketId) {
  const chunks = [];
  let index = firstTicketId >> 3;
  for (let level = 3; level < DEPTH; level += 1) {
    const siblingIndex = index ^ 1;
    chunks.push(levels[level].subarray(siblingIndex * HASH_BYTES, siblingIndex * HASH_BYTES + HASH_BYTES));
    index >>= 1;
  }
  return Buffer.concat(chunks);
}

function verifyRange8(firstTicketId, owners, rangeProof) {
  let nodes = owners.map((owner) => hash(owner));
  while (nodes.length > 1) {
    const parents = [];
    for (let index = 0; index < nodes.length; index += 2) parents.push(hashPair(nodes[index], nodes[index + 1]));
    nodes = parents;
  }
  let node = nodes[0];
  let index = firstTicketId >> 3;
  for (let level = 0; level < DEPTH - 3; level += 1) {
    const sibling = rangeProof.subarray(level * HASH_BYTES, level * HASH_BYTES + HASH_BYTES);
    node = (index & 1) === 0 ? hashPair(node, sibling) : hashPair(sibling, node);
    index >>= 1;
  }
  return node.toString("hex") === root;
}

for (const firstTicketId of [0, 500_000, 999_992]) {
  const owners = Array.from({ length: 8 }, (_, offset) => ownerPubkey(firstTicketId + offset));
  const range = rangeProof8(firstTicketId);
  if (range.length !== (DEPTH - 3) * HASH_BYTES || !verifyRange8(firstTicketId, owners, range)) {
    throw new Error(`Merkle range proof failed for tickets ${firstTicketId}-${firstTicketId + 7}.`);
  }
}

let refundCursor = 0;
let refundTransactions = 0;
while (USERS - refundCursor >= 8) {
  refundCursor += 8;
  refundTransactions += 1;
}
while (refundCursor < USERS) {
  refundCursor += 1;
  refundTransactions += 1;
}
if (refundCursor !== USERS) throw new Error("Refund cursor did not cover every ticket exactly once.");
if (refundTransactions !== 125_000) throw new Error(`Expected 125,000 refund transactions, got ${refundTransactions}.`);

console.log(`Built a depth-${DEPTH} tree with ${USERS.toLocaleString()} distinct ticket owners.`);
console.log(`Capacity: ${CAPACITY.toLocaleString()}, root: ${root}`);
console.log("Replayed 1,000,000 sequential on-chain frontier transitions and matched the full tree root.");
console.log("Verified first, second, middle, and last ticket proofs plus first/middle/last 8-ticket range proofs; rejected a wrong owner proof.");
console.log(`Batch refund cursor covered tickets 0-${(USERS - 1).toLocaleString()} exactly once in ${refundTransactions.toLocaleString()} transactions.`);
console.log(`Resident tree bytes: ${levels.reduce((total, level) => total + level.length, 0).toLocaleString()}.`);
process.exitCode = 0;
