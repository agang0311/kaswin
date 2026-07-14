import { createHash } from "node:crypto";

const DEPTH = 20;
const CAPACITY = 1 << DEPTH;
const ALLOWED = [1, 10, 100, 1_000, 10_000, 100_000];

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
for (const batch of million) {
  if (batch.first !== refundTicketCursor) throw new Error("Refund range skipped or overlapped tickets.");
  refundTicketCursor += batch.count;
  refundBatchCursor += 1;
}
if (refundTicketCursor !== 1_000_000 || refundBatchCursor !== 10) throw new Error("Million-ticket refund cursors did not finish exactly.");

const mixed = [];
let first = 0;
for (let index = 0; index < ALLOWED.length; index += 1) {
  mixed.push({ owner: owner(index + 20), first, count: ALLOWED[index] });
  first += ALLOWED[index];
}
const mixedTree = buildTree(mixed);
if (!mixed.every((batch, index) => verify(mixedTree.root, batch, index, proof(mixedTree, index)))) {
  throw new Error("Not every supported decimal batch size produced a valid proof.");
}
if (CAPACITY < 1_000_000) throw new Error("Depth-20 tree cannot hold one million one-ticket purchase batches.");

console.log(`One million tickets fit in 10 x 100,000-ticket purchase batches; root ${tree.root.toString("hex")}.`);
console.log("One refund transaction per original purchase covers all 1,000,000 tickets in 10 transactions.");
console.log("Verified 1/10/100/1,000/10,000/100,000 batch leaves and depth-20 worst-case batch capacity.");
