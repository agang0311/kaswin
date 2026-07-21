import { Header, type IHeader } from "@onekeyfe/kaspa-wasm";
import { hexToBytes, sha256BytesHex } from "../raffle/randomness";
import type { KaspaRpcConnection } from "./rpc";

export const CHAIN_RANDOM_DELAY_DAA = 30n;
const HEADER_PAGE_SIZE = 1_000n;
const MAX_HEADER_PAGES = 12;
const MAX_ANCHORED_HEADER_PAGES = 80;
const MAX_ANCHORED_HEADER_DISTANCE = HEADER_PAGE_SIZE * BigInt(MAX_ANCHORED_HEADER_PAGES);
const MAX_BLOCK_WALK = 12_000;
const RPC_TIMEOUT_MS = 30_000;
const WITNESS_LOOKUP_TIMEOUT_MS = 45_000;
const ANCHOR_BLOCK_TIMEOUT_MS = 5_000;
const ANCHORED_HEADERS_TIMEOUT_MS = 8_000;
const VIRTUAL_CHAIN_TIMEOUT_MS = 12_000;
const CANDIDATE_BLOCK_TIMEOUT_MS = 4_000;
const CANDIDATE_LOOKUP_BUDGET_MS = 12_000;
const SINK_HEADERS_TIMEOUT_MS = 6_000;
const SINK_HEADERS_LOOKUP_BUDGET_MS = 10_000;
const BLOCK_LOOKUP_RETRIES = 3;
const REST_HEADER_TIMEOUT_MS = 8_000;
const REST_CHAIN_PROBES = 12;
const REST_SELECTED_PARENT_WALK_LIMIT = 256;

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

interface RestHeaderBlock {
  header?: {
    version?: number;
    hashMerkleRoot?: string;
    acceptedIdMerkleRoot?: string;
    utxoCommitment?: string;
    timestamp?: string | number;
    bits?: number;
    nonce?: string | number;
    daaScore?: string | number;
    blueScore?: string | number;
    blueWork?: string;
    pruningPoint?: string;
    parents?: Array<{ parentHashes?: string[] }>;
  };
  verboseData?: { hash?: string; isChainBlock?: boolean; selectedParentHash?: string; childrenHashes?: string[] };
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

function restHeaderToRpcHeader(block: RestHeaderBlock): IHeader {
  const header = block.header;
  const hash = block.verboseData?.hash;
  if (!header || !hash || !/^[0-9a-f]{64}$/i.test(hash)) throw new Error("History API returned an incomplete block header.");
  const parentsByLevel = header.parents?.map((level) => level.parentHashes ?? []);
  if (!parentsByLevel?.[0]?.[0]) throw new Error("History API returned a block without a selected parent.");
  const blueWork = (header.blueWork ?? "").replace(/^0x/i, "");
  return {
    version: header.version ?? 0,
    parentsByLevel,
    hashMerkleRoot: header.hashMerkleRoot ?? "",
    acceptedIdMerkleRoot: header.acceptedIdMerkleRoot ?? "",
    utxoCommitment: header.utxoCommitment ?? "",
    timestamp: BigInt(header.timestamp ?? "0"),
    bits: header.bits ?? 0,
    nonce: BigInt(header.nonce ?? "0"),
    daaScore: BigInt(header.daaScore ?? "0"),
    blueScore: BigInt(header.blueScore ?? "0"),
    // Kaspa's REST representation omits a leading nibble for some values,
    // while the WASM header decoder requires a byte-aligned hex string.
    blueWork: blueWork.length % 2 === 0 ? blueWork : `0${blueWork}`,
    pruningPoint: header.pruningPoint ?? "",
    hash
  } as IHeader;
}

async function fetchRestBlock(apiBase: string, path: string): Promise<RestHeaderBlock> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REST_HEADER_TIMEOUT_MS);
  try {
    const response = await fetch(`${apiBase.replace(/\/+$/, "")}${path}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`History API returned ${response.status} while loading a random block header.`);
    return await response.json() as RestHeaderBlock;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchRestBlocks(apiBase: string, path: string): Promise<RestHeaderBlock[]> {
  const loaded = await fetchRestBlock(apiBase, path) as RestHeaderBlock | RestHeaderBlock[];
  return Array.isArray(loaded) ? loaded : [loaded];
}

async function walkRestSelectedParents(
  apiBase: string,
  candidateBlock: RestHeaderBlock,
  targetDaa: bigint
): Promise<{ target: IHeader; parent: IHeader } | undefined> {
  const candidate = restHeaderToRpcHeader(candidateBlock);
  if (candidate.daaScore < targetDaa) return undefined;

  let target = candidate;
  let selectedParentHash = candidateBlock.verboseData?.selectedParentHash ?? target.parentsByLevel[0]?.[0];
  for (let step = 0; step < REST_SELECTED_PARENT_WALK_LIMIT; step += 1) {
    if (!selectedParentHash) return undefined;

    const parentBlock = await fetchRestBlock(apiBase, `/blocks/${selectedParentHash}`);
    const parent = restHeaderToRpcHeader(parentBlock);
    if (parent.daaScore < targetDaa) {
      if (target.parentsByLevel[0]?.[0]?.toLowerCase() !== parent.hash.toLowerCase()) return undefined;
      return { target, parent };
    }
    if (parent.daaScore >= target.daaScore) return undefined;
    target = parent;
    selectedParentHash = parentBlock.verboseData?.selectedParentHash ?? target.parentsByLevel[0]?.[0];
  }

  return undefined;
}

async function loadRestSelectedChainChildren(
  apiBase: string,
  block: RestHeaderBlock,
  targetDaa: bigint
): Promise<RestHeaderBlock[]> {
  const children = block.verboseData?.childrenHashes ?? [];
  const chainChildren: RestHeaderBlock[] = [];
  for (const hash of children.slice(0, 32)) {
    if (!/^[0-9a-f]{64}$/i.test(hash)) continue;
    const child = await fetchRestBlock(apiBase, `/blocks/${hash}`);
    if (child.verboseData?.isChainBlock !== true) continue;
    const header = restHeaderToRpcHeader(child);
    if (header.daaScore >= targetDaa) chainChildren.push(child);
  }
  return chainChildren.sort((left, right) => {
    const leftDaa = BigInt(left.header?.daaScore ?? "0");
    const rightDaa = BigInt(right.header?.daaScore ?? "0");
    return leftDaa === rightDaa ? 0 : leftDaa < rightDaa ? -1 : 1;
  });
}

// The REST response is not trusted for settlement: the covenant rehashes both
// headers, checks the selected parent and chain sequence commitment, and rejects
// any candidate that does not cross the immutable DAA boundary. It is only a
// transport fallback for public wRPC nodes that omit historical block methods.
async function loadFromRestHistory(
  apiBase: string,
  targetDaa: bigint,
  anchorHash?: string,
  headHash?: string
): Promise<{ target: IHeader; parent: IHeader } | undefined> {
  // Prefer the confirmed ticket/create anchor. If a public history service has
  // pruned that older block, the current DAG sink is an equally valid estimate
  // for the *location* of the DAA boundary; the returned headers themselves are
  // still rehashed and checked by the covenant before settlement.
  const referenceHashes = [anchorHash, headHash]
    .filter((hash, index, all): hash is string => Boolean(hash) && all.indexOf(hash) === index);
  let reference: IHeader | undefined;
  for (const hash of referenceHashes) {
    try {
      reference = restHeaderToRpcHeader(await fetchRestBlock(apiBase, `/blocks/${hash}`));
      break;
    } catch {
      // Try the current sink when a historical anchor is no longer indexed.
    }
  }
  if (!reference) return undefined;

  let probeBlue = reference.blueScore + targetDaa - reference.daaScore;
  if (probeBlue < 0n) return undefined;

  for (let attempt = 0; attempt < REST_CHAIN_PROBES; attempt += 1) {
    const listed = await fetchRestBlocks(
      apiBase,
      `/blocks-from-bluescore?blueScoreLt=${probeBlue + 1n}&includeTransactions=false`
    );
    const candidateBlock = listed.find((block) => block.verboseData?.isChainBlock) ?? listed[0];
    if (!candidateBlock) return undefined;
    const candidate = restHeaderToRpcHeader(candidateBlock);
    const chainBlocks = candidateBlock.verboseData?.isChainBlock
      ? [candidateBlock]
      : await loadRestSelectedChainChildren(apiBase, candidateBlock, targetDaa);
    for (const chainBlock of chainBlocks) {
      const pair = await walkRestSelectedParents(apiBase, chainBlock, targetDaa);
      if (pair) return pair;
    }
    probeBlue = candidate.daaScore <= targetDaa
      ? candidate.blueScore + targetDaa - candidate.daaScore + 1n
      : candidate.blueScore > candidate.daaScore - targetDaa
        ? candidate.blueScore - (candidate.daaScore - targetDaa)
        : candidate.blueScore > 0n
          ? candidate.blueScore - 1n
          : 0n;
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

async function withRpcTimeout<T>(operation: Promise<T>, label: string, timeoutMs = RPC_TIMEOUT_MS): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs / 1_000} seconds.`)), timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function loadBlock(
  connection: KaspaRpcConnection,
  hash: string,
  timeoutMs = RPC_TIMEOUT_MS,
  attempts = BLOCK_LOOKUP_RETRIES
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await withRpcTimeout(
        connection.client.getBlock({ hash, includeTransactions: false }),
        `Block header lookup (${hash.slice(0, 12)})`,
        timeoutMs
      );
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 250));
      }
    }
  }
  throw lastError;
}

function isRecoverableHeaderLookupError(error: unknown): boolean {
  return /not implemented|timed out|unexpected selected parent|retention root/i.test(String(error));
}

async function loadForwardHeadersFromAnchor(
  connection: KaspaRpcConnection,
  anchor: IHeader,
  targetDaa: bigint
): Promise<{ target: IHeader; parent: IHeader } | undefined> {
  if (anchor.daaScore >= targetDaa || targetDaa - anchor.daaScore > MAX_ANCHORED_HEADER_DISTANCE) {
    return undefined;
  }

  const pages = Math.min(
    MAX_ANCHORED_HEADER_PAGES,
    Number((targetDaa - anchor.daaScore + HEADER_PAGE_SIZE - 1n) / HEADER_PAGE_SIZE) + 2
  );
  let startHash = anchor.hash;
  let previous = anchor;

  for (let page = 0; page < pages; page += 1) {
    const response = await withRpcTimeout(
      connection.client.getHeaders({ startHash, limit: HEADER_PAGE_SIZE, isAscending: true }),
      "Anchored selected-chain header lookup",
      ANCHORED_HEADERS_TIMEOUT_MS
    );
    const headers = response.headers.filter((header) => header.hash.toLowerCase() !== previous.hash.toLowerCase());
    if (!headers.length) return undefined;

    const pair = crossingPair([previous, ...headers], targetDaa);
    if (pair) return pair;

    const last = headers[headers.length - 1];
    if (last.daaScore <= previous.daaScore || last.daaScore >= targetDaa) return undefined;
    previous = last;
    startHash = last.hash;
  }

  return undefined;
}

async function loadFromAnchor(
  connection: KaspaRpcConnection,
  anchorHash: string,
  targetDaa: bigint,
  includeVirtualChain = true
): Promise<{ target: IHeader; parent: IHeader } | undefined> {
  const anchorResponse = await loadBlock(connection, anchorHash, ANCHOR_BLOCK_TIMEOUT_MS, 1);
  if (anchorResponse.block.header.daaScore >= targetDaa) {
    return walkSelectedChain(connection, anchorHash, targetDaa);
  }

  try {
    const anchoredHeaders = await loadForwardHeadersFromAnchor(connection, anchorResponse.block.header, targetDaa);
    if (anchoredHeaders) return anchoredHeaders;
  } catch (error) {
    if (!isRecoverableHeaderLookupError(error)) throw error;
  }

  if (!includeVirtualChain) return undefined;

  const chain = await withRpcTimeout(
    connection.client.getVirtualChainFromBlock({
      startHash: anchorHash,
      includeAcceptedTransactionIds: false
    }),
    "Selected-chain lookup",
    VIRTUAL_CHAIN_TIMEOUT_MS
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
  const deadline = Date.now() + CANDIDATE_LOOKUP_BUDGET_MS;
  for (const hash of candidateHashes.slice(0, 32)) {
    if (Date.now() >= deadline) break;
    if (!/^[0-9a-f]{64}$/i.test(hash)) continue;
    let targetResponse: Awaited<ReturnType<typeof loadBlock>>;
    try {
      targetResponse = await loadBlock(connection, hash, CANDIDATE_BLOCK_TIMEOUT_MS, 1);
    } catch (error) {
      if (isRecoverableHeaderLookupError(error)) continue;
      throw error;
    }
    if (targetResponse.block.verboseData?.isChainBlock !== true) continue;
    const target = targetResponse.block.header;
    if (target.daaScore < targetDaa) continue;
    const parentHash = targetResponse.block.verboseData?.selectedParentHash ?? target.parentsByLevel[0]?.[0];
    if (!parentHash) continue;
    let parentResponse: Awaited<ReturnType<typeof loadBlock>>;
    try {
      parentResponse = await loadBlock(connection, parentHash, CANDIDATE_BLOCK_TIMEOUT_MS, 1);
    } catch (error) {
      if (isRecoverableHeaderLookupError(error)) continue;
      throw error;
    }
    if (parentResponse.block.verboseData?.isChainBlock !== true) continue;
    const parent = parentResponse.block.header;
    if (parent.daaScore >= targetDaa) continue;
    if (target.parentsByLevel[0]?.[0]?.toLowerCase() !== parent.hash.toLowerCase()) continue;
    return { target, parent };
  }
  return undefined;
}

async function loadFromSinkHeaders(
  connection: KaspaRpcConnection,
  sinkHash: string,
  targetDaa: bigint
): Promise<{ target: IHeader; parent: IHeader } | undefined> {
  const deadline = Date.now() + SINK_HEADERS_LOOKUP_BUDGET_MS;
  let startHash = sinkHash;
  let carry: IHeader | undefined;

  for (let page = 0; page < MAX_HEADER_PAGES && Date.now() < deadline; page += 1) {
    const response = await withRpcTimeout(
      connection.client.getHeaders({ startHash, limit: HEADER_PAGE_SIZE, isAscending: false }),
      "Selected-chain header lookup",
      Math.min(SINK_HEADERS_TIMEOUT_MS, Math.max(1_000, deadline - Date.now()))
    );
    const headers = carry ? [carry, ...response.headers] : response.headers;
    const pair = crossingPair(headers, targetDaa);
    if (pair) return pair;
    if (!response.headers.length) return undefined;
    carry = response.headers[response.headers.length - 1];
    startHash = carry.hash;
    if (carry.daaScore < targetDaa) return undefined;
  }

  return undefined;
}

async function loadChainRandomnessWitnessFromRpc(
  connection: KaspaRpcConnection,
  randomnessBaseDaaScore: bigint,
  ticketRootHex: string,
  anchorHash?: string,
  candidateHashes: string[] = [],
  historyApiBase?: string
): Promise<ChainRandomnessWitness> {
  const targetBoundaryDaa = randomnessBaseDaaScore + CHAIN_RANDOM_DELAY_DAA;
  const info = await withRpcTimeout(connection.client.getBlockDagInfo(), "DAG information lookup");
  if (info.virtualDaaScore < targetBoundaryDaa) {
    throw new Error(`The on-chain random block becomes available at DAA ${targetBoundaryDaa}. Current DAA is ${info.virtualDaaScore}.`);
  }

  let pair: { target: IHeader; parent: IHeader } | undefined;
  if (historyApiBase) {
    try {
      pair = await loadFromRestHistory(historyApiBase, targetBoundaryDaa, anchorHash, info.sink);
    } catch {
      // The configured RPC path remains available when a history endpoint is
      // offline or intentionally changed by the user.
    }
  }
  // A confirmed round/ticket anchor is authoritative and normally reaches the
  // boundary in one RPC header walk. Public-history candidates are only hints;
  // checking a stale hint first can exhaust the shared lookup deadline.
  if (!pair && anchorHash) {
    try {
      pair = await loadFromAnchor(connection, anchorHash, targetBoundaryDaa, false);
    } catch (error) {
      if (!isRecoverableHeaderLookupError(error)) throw error;
    }
  }
  if (!pair && candidateHashes.length) {
    pair = await loadFromCandidates(connection, candidateHashes, targetBoundaryDaa);
  }

  if (!pair && anchorHash) {
    try {
      pair = await loadFromAnchor(connection, anchorHash, targetBoundaryDaa);
    } catch (error) {
      if (!isRecoverableHeaderLookupError(error)) throw error;
    }
  }

  if (!pair) {
    try {
      const deadline = Date.now() + SINK_HEADERS_LOOKUP_BUDGET_MS;
      let startHash = info.sink;
      let carry: IHeader | undefined;
      for (let page = 0; page < MAX_HEADER_PAGES && Date.now() < deadline; page += 1) {
        const response = await withRpcTimeout(
          connection.client.getHeaders({ startHash, limit: HEADER_PAGE_SIZE, isAscending: false }),
          "Selected-chain header lookup",
          Math.min(SINK_HEADERS_TIMEOUT_MS, Math.max(1_000, deadline - Date.now()))
        );
        const headers = carry ? [carry, ...response.headers] : response.headers;
        pair = crossingPair(headers, targetBoundaryDaa);
        if (pair) break;
        if (!response.headers.length) break;
        carry = response.headers[response.headers.length - 1];
        startHash = carry.hash;
        if (carry.daaScore < targetBoundaryDaa) break;
      }
    } catch (error) {
      if (!isRecoverableHeaderLookupError(error)) throw error;
    }
  }

  // Header paging is much faster than walking one parent at a time on public
  // nodes. Retain the latter only as a fallback when paging is unavailable.
  const sinkDistance = info.virtualDaaScore - targetBoundaryDaa;
  if (!pair && sinkDistance >= 0n && sinkDistance <= BigInt(MAX_BLOCK_WALK)) {
    try {
      pair = await walkSelectedChain(connection, info.sink, targetBoundaryDaa);
    } catch (error) {
      if (!isRecoverableHeaderLookupError(error)) throw error;
    }
  }

  if (pair) {
    const target = headerWitness(pair.target);
    const parent = headerWitness(pair.parent);
    const seedBytes = concatBytes([hexToBytes(ticketRootHex), hexToBytes(target.hash), hexToBytes(target.seqcommit)]);
    return { target, parent, randomSeedHex: await sha256BytesHex(seedBytes) };
  }

  throw new Error(`Unable to locate the selected-chain headers crossing DAA ${targetBoundaryDaa}. Use a node retaining recent headers.`);
}

export async function loadChainRandomnessWitness(
  connection: KaspaRpcConnection,
  randomnessBaseDaaScore: bigint,
  ticketRootHex: string,
  anchorHash?: string,
  candidateHashes: string[] = [],
  historyApiBase?: string
): Promise<ChainRandomnessWitness> {
  return withRpcTimeout(
    loadChainRandomnessWitnessFromRpc(connection, randomnessBaseDaaScore, ticketRootHex, anchorHash, candidateHashes, historyApiBase),
    "Randomness witness lookup",
    WITNESS_LOOKUP_TIMEOUT_MS
  );
}
