import { Header, type IHeader } from "@onekeyfe/kaspa-wasm";
import { hexToBytes, sha256BytesHex } from "../raffle/randomness";
import type { KaspaRpcConnection } from "./rpc";

export const CHAIN_RANDOM_DELAY_DAA = 30n;
const HEADER_PAGE_SIZE = 1_000n;
const MAX_HEADER_PAGES = 12;
const MAX_BLOCK_WALK = 12_000;
const RPC_TIMEOUT_MS = 30_000;
const BLOCK_LOOKUP_RETRIES = 3;

export interface ChainHeaderWitness {
  hash: string;
  beforeDaaHex: string;
  daaScore: bigint;
  blueScore: bigint;
  encodedBlueWorkHex: string;
  pruningPoint: string;
  seqcommit: string;
}

export interface ChainRandomnessWitness {
  target: ChainHeaderWitness;
  parent: ChainHeaderWitness;
  randomSeedHex: string;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function unsignedLe(value: bigint, bytes: number): Uint8Array {
  if (value < 0n || value >= 1n << BigInt(bytes * 8)) throw new Error(`Value does not fit in ${bytes} unsigned bytes.`);
  const result = new Uint8Array(bytes);
  let remaining = value;
  for (let index = 0; index < bytes; index += 1) {
    result[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return result;
}

function blueWorkBigInt(value: bigint | string): bigint {
  if (typeof value === "bigint") return value;
  const normalized = value.trim();
  if (!normalized) return 0n;
  return /^0x/i.test(normalized) ? BigInt(normalized) : BigInt(`0x${normalized}`);
}

function encodeBlueWork(value: bigint | string): Uint8Array {
  let work = blueWorkBigInt(value);
  if (work < 0n) throw new Error("Block blue work cannot be negative.");
  const bytes: number[] = [];
  while (work > 0n) {
    bytes.push(Number(work & 0xffn));
    work >>= 8n;
  }
  bytes.reverse();
  return concatBytes([unsignedLe(BigInt(bytes.length), 8), Uint8Array.from(bytes)]);
}

function serializeHeaderBeforeDaa(header: IHeader): Uint8Array {
  const parentParts: Uint8Array[] = [unsignedLe(BigInt(header.parentsByLevel.length), 8)];
  for (const level of header.parentsByLevel) {
    parentParts.push(unsignedLe(BigInt(level.length), 8));
    for (const parent of level) parentParts.push(hexToBytes(parent));
  }

  return concatBytes([
    unsignedLe(BigInt(header.version), 2),
    ...parentParts,
    hexToBytes(header.hashMerkleRoot),
    hexToBytes(header.acceptedIdMerkleRoot),
    hexToBytes(header.utxoCommitment),
    unsignedLe(header.timestamp, 8),
    unsignedLe(BigInt(header.bits), 4),
    unsignedLe(header.nonce, 8)
  ]);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function headerWitness(header: IHeader): ChainHeaderWitness {
  const candidate = new Header(header);
  const computedHash = candidate.finalize().toLowerCase();
  candidate.free();
  if (computedHash !== header.hash.toLowerCase()) {
    throw new Error(`The node returned an inconsistent block header (${computedHash} != ${header.hash.toLowerCase()}).`);
  }

  return {
    hash: header.hash.toLowerCase(),
    beforeDaaHex: toHex(serializeHeaderBeforeDaa(header)),
    daaScore: header.daaScore,
    blueScore: header.blueScore,
    encodedBlueWorkHex: toHex(encodeBlueWork(header.blueWork)),
    pruningPoint: header.pruningPoint.toLowerCase(),
    seqcommit: header.acceptedIdMerkleRoot.toLowerCase()
  };
}

function crossingPair(headers: IHeader[], targetDaa: bigint): { target: IHeader; parent: IHeader } | undefined {
  const descending = [...headers].sort((left, right) => left.daaScore === right.daaScore ? 0 : left.daaScore > right.daaScore ? -1 : 1);
  for (let index = 0; index + 1 < descending.length; index += 1) {
    const target = descending[index];
    const parent = descending[index + 1];
    if (target.daaScore >= targetDaa && parent.daaScore < targetDaa) {
      if (target.parentsByLevel[0]?.[0]?.toLowerCase() !== parent.hash.toLowerCase()) {
        throw new Error("The node returned a selected-chain header with an unexpected selected parent.");
      }
      return { target, parent };
    }
  }
  return undefined;
}

async function walkSelectedChain(
  connection: KaspaRpcConnection,
  startHash: string,
  targetDaa: bigint
): Promise<{ target: IHeader; parent: IHeader } | undefined> {
  let targetResponse = await loadBlock(connection, startHash);
  let target = targetResponse.block.header;
  if (target.daaScore < targetDaa) return undefined;

  for (let index = 0; index < MAX_BLOCK_WALK; index += 1) {
    const parentHash = targetResponse.block.verboseData?.selectedParentHash ?? target.parentsByLevel[0]?.[0];
    if (!parentHash) break;
    const parentResponse = await loadBlock(connection, parentHash);
    const parent = parentResponse.block.header;
    if (parent.daaScore < targetDaa) return { target, parent };
    targetResponse = parentResponse;
    target = parent;
  }
  return undefined;
}

async function withRpcTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${RPC_TIMEOUT_MS / 1_000} seconds.`)), RPC_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function loadBlock(connection: KaspaRpcConnection, hash: string) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= BLOCK_LOOKUP_RETRIES; attempt += 1) {
    try {
      return await withRpcTimeout(
        connection.client.getBlock({ hash, includeTransactions: false }),
        `Block header lookup (${hash.slice(0, 12)})`
      );
    } catch (error) {
      lastError = error;
      if (attempt < BLOCK_LOOKUP_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 250));
      }
    }
  }
  throw lastError;
}

async function loadFromAnchor(
  connection: KaspaRpcConnection,
  anchorHash: string,
  targetDaa: bigint
): Promise<{ target: IHeader; parent: IHeader } | undefined> {
  const anchorResponse = await loadBlock(connection, anchorHash);
  if (anchorResponse.block.header.daaScore >= targetDaa) {
    return walkSelectedChain(connection, anchorHash, targetDaa);
  }

  const chain = await withRpcTimeout(
    connection.client.getVirtualChainFromBlock({
      startHash: anchorHash,
      includeAcceptedTransactionIds: false
    }),
    "Selected-chain lookup"
  );
  const hashes = [...chain.addedChainBlockHashes];
  if (!hashes.length) return undefined;

  const cache = new Map<string, Awaited<ReturnType<typeof loadBlock>>>();
  cache.set(anchorHash.toLowerCase(), anchorResponse);
  const responseAt = async (index: number) => {
    const hash = hashes[index];
    const key = hash.toLowerCase();
    const cached = cache.get(key);
    if (cached) return cached;
    const loaded = await loadBlock(connection, hash);
    cache.set(key, loaded);
    return loaded;
  };

  const first = await responseAt(0);
  const last = await responseAt(hashes.length - 1);
  if (first.block.header.daaScore > last.block.header.daaScore) {
    hashes.reverse();
    cache.clear();
    cache.set(anchorHash.toLowerCase(), anchorResponse);
  }
  if ((await responseAt(hashes.length - 1)).block.header.daaScore < targetDaa) return undefined;

  let low = 0;
  let high = hashes.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const response = await responseAt(middle);
    if (response.block.header.daaScore >= targetDaa) high = middle;
    else low = middle + 1;
  }

  const targetResponse = await responseAt(low);
  const target = targetResponse.block.header;
  const parentHash = targetResponse.block.verboseData?.selectedParentHash ?? target.parentsByLevel[0]?.[0];
  if (!parentHash) return undefined;
  const parent = (await loadBlock(connection, parentHash)).block.header;
  if (target.daaScore < targetDaa || parent.daaScore >= targetDaa) return undefined;
  if (target.parentsByLevel[0]?.[0]?.toLowerCase() !== parent.hash.toLowerCase()) {
    throw new Error("The node returned a selected-chain header with an unexpected selected parent.");
  }
  return { target, parent };
}

async function loadFromCandidates(
  connection: KaspaRpcConnection,
  candidateHashes: string[],
  targetDaa: bigint
): Promise<{ target: IHeader; parent: IHeader } | undefined> {
  for (const hash of candidateHashes.slice(0, 32)) {
    if (!/^[0-9a-f]{64}$/i.test(hash)) continue;
    const targetResponse = await loadBlock(connection, hash);
    if (targetResponse.block.verboseData?.isChainBlock !== true) continue;
    const target = targetResponse.block.header;
    if (target.daaScore < targetDaa) continue;
    const parentHash = targetResponse.block.verboseData?.selectedParentHash ?? target.parentsByLevel[0]?.[0];
    if (!parentHash) continue;
    const parentResponse = await loadBlock(connection, parentHash);
    if (parentResponse.block.verboseData?.isChainBlock !== true) continue;
    const parent = parentResponse.block.header;
    if (parent.daaScore >= targetDaa) continue;
    if (target.parentsByLevel[0]?.[0]?.toLowerCase() !== parent.hash.toLowerCase()) continue;
    return { target, parent };
  }
  return undefined;
}

export async function loadChainRandomnessWitness(
  connection: KaspaRpcConnection,
  randomnessBaseDaaScore: bigint,
  ticketRootHex: string,
  anchorHash?: string,
  candidateHashes: string[] = []
): Promise<ChainRandomnessWitness> {
  const targetBoundaryDaa = randomnessBaseDaaScore + CHAIN_RANDOM_DELAY_DAA;
  const info = await connection.client.getBlockDagInfo();
  if (info.virtualDaaScore < targetBoundaryDaa) {
    throw new Error(`The on-chain random block becomes available at DAA ${targetBoundaryDaa}. Current DAA is ${info.virtualDaaScore}.`);
  }

  let pair: { target: IHeader; parent: IHeader } | undefined;
  if (candidateHashes.length) {
    pair = await loadFromCandidates(connection, candidateHashes, targetBoundaryDaa);
  }
  if (anchorHash) {
    pair ??= await loadFromAnchor(connection, anchorHash, targetBoundaryDaa);
  }

  if (!pair) {
    try {
      let startHash = info.sink;
      let carry: IHeader | undefined;
      for (let page = 0; page < MAX_HEADER_PAGES; page += 1) {
        const response = await connection.client.getHeaders({ startHash, limit: HEADER_PAGE_SIZE, isAscending: false });
        const headers = carry ? [carry, ...response.headers] : response.headers;
        pair = crossingPair(headers, targetBoundaryDaa);
        if (pair) break;
        if (!response.headers.length) break;
        carry = response.headers[response.headers.length - 1];
        startHash = carry.hash;
        if (carry.daaScore < targetBoundaryDaa) break;
      }
    } catch (error) {
      if (!String(error).includes("Not implemented")) throw error;
    }
  }

  pair ??= await walkSelectedChain(connection, info.sink, targetBoundaryDaa);
  if (pair) {
    const target = headerWitness(pair.target);
    const parent = headerWitness(pair.parent);
    const seedBytes = concatBytes([hexToBytes(ticketRootHex), hexToBytes(target.hash), hexToBytes(target.seqcommit)]);
    return { target, parent, randomSeedHex: await sha256BytesHex(seedBytes) };
  }

  throw new Error(`Unable to locate the selected-chain headers crossing DAA ${targetBoundaryDaa}. Use a node retaining recent headers.`);
}
