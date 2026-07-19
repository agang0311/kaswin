import { PROTOCOL_MANIFEST } from "./manifest";
import { bytesToHex, concatBytes, hexToBytes, sha256, uint64Le } from "./encoding";

export const MERKLE_DEPTH = PROTOCOL_MANIFEST.ticketMerkleDepth;
export const MERKLE_CAPACITY = 2 ** MERKLE_DEPTH;
const DOMAIN = new TextEncoder().encode(PROTOCOL_MANIFEST.batchLeafDomain);

async function pair(left: Uint8Array<ArrayBufferLike>, right: Uint8Array<ArrayBufferLike>): Promise<Uint8Array<ArrayBuffer>> { return sha256(concatBytes(left, right)); }
async function buildEmptyNodes(): Promise<Uint8Array<ArrayBuffer>[]> {
  const nodes = [new Uint8Array(32)];
  for (let level = 1; level <= MERKLE_DEPTH; level += 1) nodes.push(await pair(nodes[level - 1], nodes[level - 1]));
  return nodes;
}
const EMPTY_NODES_PROMISE = buildEmptyNodes();
function emptyNodes(): Promise<Uint8Array<ArrayBuffer>[]> { return EMPTY_NODES_PROMISE; }

export async function batchLeaf(roundNonceHex: string, ownerPubkeyHex: string, firstTicketId: number, ticketCount: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(firstTicketId) || firstTicketId < 0) throw new Error("firstTicketId must be a non-negative safe integer.");
  if (!Number.isSafeInteger(ticketCount) || ticketCount < 1 || ticketCount > PROTOCOL_MANIFEST.maxTickets) throw new Error("ticketCount is outside the protocol limit.");
  return sha256(concatBytes(DOMAIN, hexToBytes(roundNonceHex, 32), hexToBytes(ownerPubkeyHex, 32), uint64Le(firstTicketId), uint64Le(ticketCount)));
}

export interface BatchCommitment { roundNonceHex: string; ownerPubkeyHex: string; firstTicketId: number; ticketCount: number }

export async function buildBatchProof(records: readonly BatchCommitment[], batchIndex: number): Promise<{ rootHex: string; proofHex: string }> {
  if (!Number.isSafeInteger(batchIndex) || batchIndex < 0 || batchIndex >= records.length) throw new Error("Invalid batch proof index.");
  if (records.length > PROTOCOL_MANIFEST.maxRelaySafePurchaseBatches) throw new Error("Too many purchase batches for the current protocol.");
  const empty = await emptyNodes();
  let nodes = await Promise.all(records.map((record) => batchLeaf(record.roundNonceHex, record.ownerPubkeyHex, record.firstTicketId, record.ticketCount)));
  let path = batchIndex;
  const proof: Uint8Array<ArrayBufferLike>[] = [];
  for (let level = 0; level < MERKLE_DEPTH; level += 1) {
    proof.push(nodes[path ^ 1] ?? empty[level]);
    const parents: Uint8Array<ArrayBuffer>[] = [];
    for (let index = 0; index < nodes.length; index += 2) parents.push(await pair(nodes[index], nodes[index + 1] ?? empty[level]));
    nodes = parents;
    path = Math.floor(path / 2);
  }
  return { rootHex: bytesToHex(nodes[0]), proofHex: bytesToHex(concatBytes(...proof)) };
}

export async function rootFromBatchProof(record: BatchCommitment, batchIndex: number, proofHex: string): Promise<string> {
  if (!Number.isSafeInteger(batchIndex) || batchIndex < 0 || batchIndex >= PROTOCOL_MANIFEST.maxRelaySafePurchaseBatches) throw new Error("Invalid batch proof index.");
  const proof = hexToBytes(proofHex, MERKLE_DEPTH * 32);
  let node = await batchLeaf(record.roundNonceHex, record.ownerPubkeyHex, record.firstTicketId, record.ticketCount);
  let path = batchIndex;
  for (let level = 0; level < MERKLE_DEPTH; level += 1) {
    const sibling = proof.slice(level * 32, (level + 1) * 32);
    node = (path & 1) === 0 ? await pair(node, sibling) : await pair(sibling, node);
    path = Math.floor(path / 2);
  }
  return bytesToHex(node);
}

export async function verifyBatchProof(expectedRootHex: string, record: BatchCommitment, batchIndex: number, proofHex: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(expectedRootHex)) return false;
  return (await rootFromBatchProof(record, batchIndex, proofHex)) === expectedRootHex;
}

export async function appendBatch(frontierHex: string, batchIndex: number, record: BatchCommitment): Promise<{ frontierHex: string; rootHex: string }> {
  if (!Number.isSafeInteger(batchIndex) || batchIndex < 0 || batchIndex >= PROTOCOL_MANIFEST.maxRelaySafePurchaseBatches) throw new Error("Invalid batch index.");
  const frontier = hexToBytes(frontierHex, MERKLE_DEPTH * 32);
  const next = frontier.slice();
  const empty = await emptyNodes();
  let node = await batchLeaf(record.roundNonceHex, record.ownerPubkeyHex, record.firstTicketId, record.ticketCount);
  let path = batchIndex;
  let carrying = true;
  for (let level = 0; level < MERKLE_DEPTH; level += 1) {
    const start = level * 32;
    if ((path & 1) === 0) {
      if (carrying) { next.set(node, start); carrying = false; }
      node = await pair(node, empty[level]);
    } else node = await pair(frontier.slice(start, start + 32), node);
    path = Math.floor(path / 2);
  }
  return { frontierHex: bytesToHex(next), rootHex: bytesToHex(node) };
}

export async function rootFromFrontier(frontierHex: string, batchCount: number): Promise<string> {
  if (!Number.isSafeInteger(batchCount) || batchCount < 0 || batchCount > PROTOCOL_MANIFEST.maxRelaySafePurchaseBatches) {
    throw new Error("Ticket batch count is outside the current round limit.");
  }
  const frontier = hexToBytes(frontierHex, MERKLE_DEPTH * 32);
  const empty = await emptyNodes();
  let node = empty[0];
  let path = batchCount;
  for (let level = 0; level < MERKLE_DEPTH; level += 1) {
    const start = level * 32;
    node = (path & 1) === 1
      ? await pair(frontier.slice(start, start + 32), node)
      : await pair(node, empty[level]);
    path = Math.floor(path / 2);
  }
  if (path !== 0) throw new Error("Ticket batch count exceeds the Merkle frontier capacity.");
  return bytesToHex(node);
}
