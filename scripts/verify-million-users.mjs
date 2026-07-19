import { createHash } from "node:crypto";

const DEPTH = 20;
const CAPACITY = 1 << DEPTH;
const ARBITRARY_COUNTS = [2, 37, 999, 12_345, 543_210];
const MAX_REFUND_BATCHES_PER_TX = 13;

function hash(bytes) { return createHash("sha256").update(bytes).digest(); }
function pair(left, right) { return hash(Buffer.concat([left, right])); }
function u64(value) { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(value)); return bytes; }
function owner(batchIndex) { return hash(Buffer.from(`owner-${batchIndex}`)); }
function leaf(batch) { return hash(Buffer.concat([batch.owner, u64(batch.first), u64(batch.count)])); }

const empty = [Buffer.alloc(32)];
for (let level = 1; level <= DEPTH; level += 1) empty.push(pair(empty[level - 1], empty[level - 1]));

function buildTree(batches) {
  let nodes = batches.map(leaf);
  const levels = [nodes];
  for (let level = 0; level < DEPTH; level += 1) {
    const parents = [];
    for (let index = 0; index < nodes.length; index += 2) parents.push(pair(nodes[index], nodes[index + 1] ?? empty[level]));
    nodes = parents;
    levels.push(nodes);
  }
  return { root: nodes[0], levels };
}

function append(frontier, batch, batchIndex) {
  const next = Buffer.from(frontier);
  let node = leaf(batch);
  let path = batchIndex;
  let carrying = true;
  for (let level = 0; level < DEPTH; level += 1) {
    if ((path & 1) === 0) {
      if (carrying) { node.copy(next, level * 32); carrying = false; }
      node = pair(node, empty[level]);
    } else {
      node = pair(frontier.subarray(level * 32, level * 32 + 32), node);
    }
    path >>= 1;
  }
  return { frontier: next, root: node };
}

function proof(tree, batchIndex) {
  const siblings = [];
  let path = batchIndex;
  for (let level = 0; level < DEPTH; level += 1) {
    siblings.push(tree.levels[level][path ^ 1] ?? empty[level]);
    path >>= 1;
  }
  return siblings;
}

function verify(root, batch, batchIndex, siblings) {
  let node = leaf(batch);
  let path = batchIndex;
  for (const sibling of siblings) {
    node = (path & 1) === 0 ? pair(node, sibling) : pair(sibling, node);
    path >>= 1;
  }
  return node.equals(root);
}

const million = Array.from({ length: 10 }, (_, index) => ({
  owner: owner(index),
  first: index * 100_000,
  count: 100_000
}));
const tree = buildTree(million);
let frontier = Buffer.alloc(DEPTH * 32);
let appendRoot = empty[DEPTH];
million.forEach((batch, index) => {
  const result = append(frontier, batch, index);
  frontier = result.frontier;
  appendRoot = result.root;
});
if (!appendRoot.equals(tree.root)) throw new Error("Sequential batch frontier does not match the full Merkle tree.");

for (const batchIndex of [0, 4, 9]) {
  if (!verify(tree.root, million[batchIndex], batchIndex, proof(tree, batchIndex))) {
    throw new Error(`Batch proof ${batchIndex} failed.`);
  }
}
if (verify(tree.root, { ...million[9], count: 10_000 }, 9, proof(tree, 9))) throw new Error("A modified batch range proof was accepted.");

let refundTicketCursor = 0;
let refundBatchCursor = 0;
let refundTransactions = 0;
while (refundBatchCursor < million.length) {
  const grouped = million.slice(refundBatchCursor, refundBatchCursor + MAX_REFUND_BATCHES_PER_TX);
  for (const batch of grouped) {
    if (batch.first !== refundTicketCursor) throw new Error("Refund range skipped or overlapped tickets.");
    refundTicketCursor += batch.count;
  }
  refundBatchCursor += grouped.length;
  refundTransactions += 1;
}
if (refundTicketCursor !== 1_000_000 || refundBatchCursor !== 10 || refundTransactions !== 1) {
  throw new Error("Million-ticket grouped refund cursors did not finish exactly.");
}

const mixed = [];
let first = 0;
for (let index = 0; index < ARBITRARY_COUNTS.length; index += 1) {
  mixed.push({ owner: owner(index + 20), first, count: ARBITRARY_COUNTS[index] });
  first += ARBITRARY_COUNTS[index];
}
const mixedTree = buildTree(mixed);
if (!mixed.every((batch, index) => verify(mixedTree.root, batch, index, proof(mixedTree, index)))) {
  throw new Error("Not every arbitrary purchase count produced a valid proof.");
}
if (CAPACITY < 1_000_000) throw new Error("Depth-20 tree cannot hold one million one-ticket purchase batches.");

console.log(`One million tickets fit in 10 x 100,000-ticket purchase batches; root ${tree.root.toString("hex")}.`);
console.log("The legacy/v16 covenant ABI's 13-proof cap can cover those 10 purchase batches in one transaction.");
console.log(`At that ABI cap, the compute-only lower bound for one million separate purchasers is ${Math.ceil(1_000_000 / MAX_REFUND_BATCHES_PER_TX).toLocaleString()} transactions; runtime storage-mass sizing (including vNext's measured two-batch prefix) may reduce each prefix.`);
console.log("Verified arbitrary purchase-count leaves and depth-20 worst-case batch capacity.");
