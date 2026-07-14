import { hexToBytes, sha256BytesHex } from "./randomness";
import type { TicketRange } from "./tickets";

export const TICKET_MERKLE_DEPTH = 20;
export const TICKET_MERKLE_CAPACITY = 1 << TICKET_MERKLE_DEPTH;
export const TICKET_MERKLE_PROOF_BYTES = TICKET_MERKLE_DEPTH * 32;
export const TICKET_BATCH_SIZES = [1, 10, 100, 1_000, 10_000, 100_000] as const;

export const TICKET_EMPTY_NODES_HEX = [
  "00".repeat(32),
  "f5a5fd42d16a20302798ef6ed309979b43003d2320d9f0e8ea9831a92759fb4b",
  "db56114e00fdd4c1f85c892bf35ac9a89289aaecb1ebd0a96cde606a748b5d71",
  "c78009fdf07fc56a11f122370658a353aaa542ed63e44c4bc15ff4cd105ab33c",
  "536d98837f2dd165a55d5eeae91485954472d56f246df256bf3cae19352a123c",
  "9efde052aa15429fae05bad4d0b1d7c64da64d03d7a1854a588c2cb8430c0d30",
  "d88ddfeed400a8755596b21942c1497e114c302e6118290f91e6772976041fa1",
  "87eb0ddba57e35f6d286673802a4af5975e22506c7cf4c64bb6be5ee11527f2c",
  "26846476fd5fc54a5d43385167c95144f2643f533cc85bb9d16b782f8d7db193",
  "506d86582d252405b840018792cad2bf1259f1ef5aa5f887e13cb2f0094f51e1",
  "ffff0ad7e659772f9534c195c815efc4014ef1e1daed4404c06385d11192e92b",
  "6cf04127db05441cd833107a52be852868890e4317e6a02ab47683aa75964220",
  "b7d05f875f140027ef5118a2247bbb84ce8f2f0f1123623085daf7960c329f5f",
  "df6af5f5bbdb6be9ef8aa618e4bf8073960867171e29676f8b284dea6a08a85e",
  "b58d900f5e182e3c50ef74969ea16c7726c549757cc23523c369587da7293784",
  "d49a7502ffcfb0340b1d7885688500ca308161a7f96b62df9d083b71fcc8f2bb",
  "8fe6b1689256c0d385f42f5bbe2027a22c1996e110ba97c171d3e5948de92beb",
  "8d0d63c39ebade8509e0ae3c9c3876fb5fa112be18f905ecacfecb92057603ab",
  "95eec8b2e541cad4e91de38385f2e046619f54496c2382cb6cacd5b98c26f5a4",
  "f893e908917775b62bff23294dbbe3a1cd8e6cc1c35b4801887b646a6f81f17f"
] as const;

export const TICKET_EMPTY_ROOT_HEX = "cddba7b592e3133393c16194fac7431abf2f5485ed711db282183c819e08ebaa";
export const TICKET_EMPTY_FRONTIER_HEX = "00".repeat(TICKET_MERKLE_PROOF_BYTES);

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function uint64Le(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Batch integer must be a non-negative safe integer.");
  const bytes = new Uint8Array(8);
  let remaining = BigInt(value);
  for (let index = 0; index < 8; index += 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

async function hashPair(left: Uint8Array, right: Uint8Array): Promise<Uint8Array> {
  const bytes = new Uint8Array(64);
  bytes.set(left, 0);
  bytes.set(right, 32);
  return hexToBytes(await sha256BytesHex(bytes));
}

export function isTicketBatchSize(value: number): value is (typeof TICKET_BATCH_SIZES)[number] {
  return TICKET_BATCH_SIZES.includes(value as (typeof TICKET_BATCH_SIZES)[number]);
}

export async function ticketBatchLeaf(ownerPubkeyHex: string, firstTicketId: number, ticketCount: number): Promise<Uint8Array> {
  const owner = hexToBytes(ownerPubkeyHex);
  if (owner.length !== 32) throw new Error("Ticket owner public key must be exactly 32 bytes.");
  if (!isTicketBatchSize(ticketCount)) throw new Error("Ticket batch size must be 1, 10, 100, 1000, 10000, or 100000.");
  const bytes = new Uint8Array(48);
  bytes.set(owner, 0);
  bytes.set(uint64Le(firstTicketId), 32);
  bytes.set(uint64Le(ticketCount), 40);
  return hexToBytes(await sha256BytesHex(bytes));
}

export async function appendTicketBatch(
  frontierHex: string,
  batchIndex: number,
  ownerPubkeyHex: string,
  firstTicketId: number,
  ticketCount: number
): Promise<{ frontierHex: string; rootHex: string }> {
  if (!Number.isInteger(batchIndex) || batchIndex < 0 || batchIndex >= TICKET_MERKLE_CAPACITY) {
    throw new Error("Ticket batch index is outside the Merkle tree capacity.");
  }
  const frontier = hexToBytes(frontierHex);
  if (frontier.length !== TICKET_MERKLE_PROOF_BYTES) throw new Error("Ticket frontier must be exactly 640 bytes.");

  const nextFrontier = frontier.slice();
  let node = await ticketBatchLeaf(ownerPubkeyHex, firstTicketId, ticketCount);
  let path = batchIndex;
  let carrying = true;
  for (let level = 0; level < TICKET_MERKLE_DEPTH; level += 1) {
    const start = level * 32;
    if ((path & 1) === 0) {
      if (carrying) {
        nextFrontier.set(node, start);
        carrying = false;
      }
      node = await hashPair(node, hexToBytes(TICKET_EMPTY_NODES_HEX[level]));
    } else {
      node = await hashPair(frontier.slice(start, start + 32), node);
    }
    path = Math.floor(path / 2);
  }
  return { frontierHex: bytesToHex(nextFrontier), rootHex: bytesToHex(node) };
}

export async function merkleRootFromBatchProof(
  ownerPubkeyHex: string,
  firstTicketId: number,
  ticketCount: number,
  batchIndex: number,
  proofHex: string
): Promise<string> {
  const proof = hexToBytes(proofHex);
  if (proof.length !== TICKET_MERKLE_PROOF_BYTES) throw new Error("Ticket batch proof must be exactly 640 bytes.");
  let node = await ticketBatchLeaf(ownerPubkeyHex, firstTicketId, ticketCount);
  let path = batchIndex;
  for (let level = 0; level < TICKET_MERKLE_DEPTH; level += 1) {
    const sibling = proof.slice(level * 32, level * 32 + 32);
    node = (path & 1) === 0 ? await hashPair(node, sibling) : await hashPair(sibling, node);
    path = Math.floor(path / 2);
  }
  return bytesToHex(node);
}

export async function verifyTicketBatchProof(
  expectedRootHex: string,
  ownerPubkeyHex: string,
  firstTicketId: number,
  ticketCount: number,
  batchIndex: number,
  proofHex: string
): Promise<boolean> {
  return (await merkleRootFromBatchProof(ownerPubkeyHex, firstTicketId, ticketCount, batchIndex, proofHex)) === expectedRootHex.toLowerCase();
}

export interface TicketBatchRecord extends TicketRange {
  ownerPubkey?: string;
}

export async function buildTicketBatchProof(
  batches: TicketBatchRecord[],
  batchIndex: number
): Promise<{ proofHex: string; rootHex: string }> {
  if (!Number.isInteger(batchIndex) || batchIndex < 0 || batchIndex >= batches.length) {
    throw new Error("Ticket batch proof index is outside the loaded batch set.");
  }
  if (batches.length > TICKET_MERKLE_CAPACITY) throw new Error("Loaded ticket batches exceed the Merkle tree capacity.");
  let nodes = await Promise.all(batches.map((batch) => {
    if (!batch.ownerPubkey) throw new Error("A ticket batch is missing its owner public key.");
    return ticketBatchLeaf(batch.ownerPubkey, batch.ticketId - 1, Math.max(1, batch.ticketCount ?? 1));
  }));
  const proof: Uint8Array[] = [];
  let path = batchIndex;
  for (let level = 0; level < TICKET_MERKLE_DEPTH; level += 1) {
    proof.push(nodes[path ^ 1] ?? hexToBytes(TICKET_EMPTY_NODES_HEX[level]));
    const parents: Uint8Array[] = [];
    for (let index = 0; index < nodes.length; index += 2) {
      parents.push(await hashPair(nodes[index], nodes[index + 1] ?? hexToBytes(TICKET_EMPTY_NODES_HEX[level])));
    }
    nodes = parents;
    path = Math.floor(path / 2);
  }
  const proofBytes = new Uint8Array(TICKET_MERKLE_PROOF_BYTES);
  proof.forEach((sibling, level) => proofBytes.set(sibling, level * 32));
  return { proofHex: bytesToHex(proofBytes), rootHex: bytesToHex(nodes[0]) };
}
