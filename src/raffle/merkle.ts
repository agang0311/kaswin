import { hexToBytes, sha256BytesHex } from "./randomness";

export const TICKET_MERKLE_DEPTH = 20;
export const TICKET_MERKLE_CAPACITY = 1 << TICKET_MERKLE_DEPTH;
export const TICKET_MERKLE_PROOF_BYTES = TICKET_MERKLE_DEPTH * 32;
export const TICKET_REFUND_BATCH_SIZE = 8;
export const TICKET_RANGE_PROOF_BYTES = (TICKET_MERKLE_DEPTH - 3) * 32;

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
export const TICKET_EMPTY_NODE_TABLE_HEX = TICKET_EMPTY_NODES_HEX.join("");
export const TICKET_EMPTY_FRONTIER_HEX = "00".repeat(TICKET_MERKLE_PROOF_BYTES);

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashPair(left: Uint8Array, right: Uint8Array): Promise<Uint8Array> {
  const bytes = new Uint8Array(64);
  bytes.set(left, 0);
  bytes.set(right, 32);
  return hexToBytes(await sha256BytesHex(bytes));
}

export async function ticketLeaf(ownerPubkeyHex: string): Promise<Uint8Array> {
  const owner = hexToBytes(ownerPubkeyHex);
  if (owner.length !== 32) throw new Error("Ticket owner public key must be exactly 32 bytes.");
  return hexToBytes(await sha256BytesHex(owner));
}

export async function appendTicketLeaf(
  frontierHex: string,
  ticketId: number,
  ownerPubkeyHex: string
): Promise<{ frontierHex: string; rootHex: string }> {
  if (!Number.isInteger(ticketId) || ticketId < 0 || ticketId >= TICKET_MERKLE_CAPACITY) {
    throw new Error("Ticket id is outside the Merkle tree capacity.");
  }
  const frontier = hexToBytes(frontierHex);
  if (frontier.length !== TICKET_MERKLE_PROOF_BYTES) throw new Error("Ticket frontier must be exactly 640 bytes.");

  const nextFrontier = frontier.slice();
  let node = await ticketLeaf(ownerPubkeyHex);
  let path = ticketId;
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

export async function appendTicketLeaves(
  frontierHex: string,
  firstTicketId: number,
  ownerPubkeyHex: string,
  ticketCount: number
): Promise<{ frontierHex: string; rootHex: string }> {
  if (!Number.isInteger(ticketCount) || ticketCount < 1 || ticketCount > 8) {
    throw new Error("A purchase must contain between 1 and 8 tickets.");
  }
  let next = { frontierHex, rootHex: TICKET_EMPTY_ROOT_HEX };
  for (let offset = 0; offset < ticketCount; offset += 1) {
    next = await appendTicketLeaf(next.frontierHex, firstTicketId + offset, ownerPubkeyHex);
  }
  return next;
}

export async function merkleRootFromProof(
  ownerPubkeyHex: string,
  ticketId: number,
  proofHex: string
): Promise<string> {
  const proof = hexToBytes(proofHex);
  if (proof.length !== TICKET_MERKLE_PROOF_BYTES) throw new Error("Ticket proof must be exactly 640 bytes.");
  let node = await ticketLeaf(ownerPubkeyHex);
  let path = ticketId;

  for (let level = 0; level < TICKET_MERKLE_DEPTH; level += 1) {
    const sibling = proof.slice(level * 32, level * 32 + 32);
    node = (path & 1) === 0 ? await hashPair(node, sibling) : await hashPair(sibling, node);
    path = Math.floor(path / 2);
  }

  return bytesToHex(node);
}

export async function verifyTicketProof(
  expectedRootHex: string,
  ownerPubkeyHex: string,
  ticketId: number,
  proofHex: string
): Promise<boolean> {
  return (await merkleRootFromProof(ownerPubkeyHex, ticketId, proofHex)) === expectedRootHex.toLowerCase();
}

export async function verifyTicketRange8(
  expectedRootHex: string,
  ownerPubkeysHex: string[],
  firstTicketId: number,
  proofHex: string
): Promise<boolean> {
  if (ownerPubkeysHex.length !== TICKET_REFUND_BATCH_SIZE || firstTicketId % TICKET_REFUND_BATCH_SIZE !== 0) return false;
  const proof = hexToBytes(proofHex);
  if (proof.length !== TICKET_RANGE_PROOF_BYTES) return false;
  let nodes = await Promise.all(ownerPubkeysHex.map(ticketLeaf));
  for (let width = 8; width > 1; width /= 2) {
    const parents: Uint8Array[] = [];
    for (let index = 0; index < nodes.length; index += 2) parents.push(await hashPair(nodes[index], nodes[index + 1]));
    nodes = parents;
  }
  let node = nodes[0];
  let path = firstTicketId / TICKET_REFUND_BATCH_SIZE;
  for (let level = 0; level < TICKET_MERKLE_DEPTH - 3; level += 1) {
    const sibling = proof.slice(level * 32, level * 32 + 32);
    node = (path & 1) === 0 ? await hashPair(node, sibling) : await hashPair(sibling, node);
    path = Math.floor(path / 2);
  }
  return bytesToHex(node) === expectedRootHex.toLowerCase();
}

export async function buildTicketProof(
  ownerPubkeys: string[],
  ticketId: number
): Promise<{ proofHex: string; rootHex: string }> {
  if (!Number.isInteger(ticketId) || ticketId < 0 || ticketId >= ownerPubkeys.length) {
    throw new Error("Ticket proof index is outside the loaded ticket set.");
  }
  if (ownerPubkeys.length > TICKET_MERKLE_CAPACITY) {
    throw new Error("Loaded tickets exceed the Merkle tree capacity.");
  }

  let nodes = await Promise.all(ownerPubkeys.map(ticketLeaf));
  const proof: Uint8Array[] = [];
  let path = ticketId;

  for (let level = 0; level < TICKET_MERKLE_DEPTH; level += 1) {
    const siblingIndex = path ^ 1;
    proof.push(nodes[siblingIndex] ?? hexToBytes(TICKET_EMPTY_NODES_HEX[level]));

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

export async function buildTicketRange8Proof(
  ownerPubkeys: string[],
  firstTicketId: number
): Promise<{ proofHex: string; rootHex: string }> {
  if (!Number.isInteger(firstTicketId) || firstTicketId < 0 || firstTicketId % TICKET_REFUND_BATCH_SIZE !== 0) {
    throw new Error("The first ticket in an 8-ticket proof must be zero-based and aligned to 8.");
  }
  if (firstTicketId + TICKET_REFUND_BATCH_SIZE > ownerPubkeys.length) {
    throw new Error("The loaded ticket set does not contain this 8-ticket range.");
  }

  let nodes = await Promise.all(ownerPubkeys.map(ticketLeaf));
  let path = firstTicketId;

  for (let level = 0; level < 3; level += 1) {
    const parents: Uint8Array[] = [];
    for (let index = 0; index < nodes.length; index += 2) {
      parents.push(await hashPair(nodes[index], nodes[index + 1] ?? hexToBytes(TICKET_EMPTY_NODES_HEX[level])));
    }
    nodes = parents;
    path = Math.floor(path / 2);
  }

  const proof: Uint8Array[] = [];
  for (let level = 3; level < TICKET_MERKLE_DEPTH; level += 1) {
    proof.push(nodes[path ^ 1] ?? hexToBytes(TICKET_EMPTY_NODES_HEX[level]));
    const parents: Uint8Array[] = [];
    for (let index = 0; index < nodes.length; index += 2) {
      parents.push(await hashPair(nodes[index], nodes[index + 1] ?? hexToBytes(TICKET_EMPTY_NODES_HEX[level])));
    }
    nodes = parents;
    path = Math.floor(path / 2);
  }

  const proofBytes = new Uint8Array(TICKET_RANGE_PROOF_BYTES);
  proof.forEach((sibling, level) => proofBytes.set(sibling, level * 32));
  return { proofHex: bytesToHex(proofBytes), rootHex: bytesToHex(nodes[0]) };
}
