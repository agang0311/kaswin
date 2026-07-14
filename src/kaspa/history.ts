import {
  buildRaffleRedeemScriptForContractVersion,
  bytesToHex,
  isCurrentRaffleContractVersion,
  raffleCovenantStateFromRound
} from "./covenant";
import { appendTicketBatch, TICKET_EMPTY_FRONTIER_HEX, TICKET_EMPTY_ROOT_HEX } from "../raffle/merkle";
import type { RaffleCovenantCursor, RoundState, RoundStatus } from "../raffle/types";
import { ticketRangeCount, ticketRangeEnd, totalTicketCount } from "../raffle/tickets";
import { loadIndexedRaffleRounds, requiresRaffleIndexer } from "./indexer";

export interface RaffleHistoryTicket {
  txId: string;
  ticketId: number;
  ticketCount?: number;
  buyer: string;
  buyerPubkey?: string;
  paidAmount: bigint;
  blockTime?: number;
}

export interface RaffleHistoryPayout {
  txId: string;
  winnerTicketId: number;
  winnerAddress: string;
  amount: bigint;
  blockTime?: number;
}

export interface RaffleHistoryRound {
  roundId: string;
  localCachedAt?: number;
  registryTxId?: string;
  registryAddress?: string;
  createTxId?: string;
  refundTxId?: string;
  treasuryAddress?: string;
  covenantId?: string;
  latestCovenant?: RaffleCovenantCursor;
  creator?: string;
  creatorPubkey?: string;
  createdAtDaaScore?: string;
  refundTimeoutSeconds?: string;
  refundAfterDaaScore?: string;
  chainSearchHintHash?: string;
  refundTimeoutDaa?: string;
  ticketPrice?: bigint;
  maxTickets?: number;
  minTickets?: number;
  version?: string;
  contractVersion?: string;
  refundCursor?: number;
  refundBatchCursor?: number;
  tickets: RaffleHistoryTicket[];
  payouts: RaffleHistoryPayout[];
  potAmount: bigint;
  soldTickets?: number;
  lastBlockTime?: number;
}

interface RestTransaction {
  transaction_id?: string;
  block_hash?: string[];
  accepting_block_hash?: string;
  payload?: string;
  block_time?: number;
  accepting_block_time?: number;
  outputs?: RestTransactionOutput[];
}

export async function loadTransactionChainAnchor(apiBaseUrl: string, transactionId: string): Promise<string> {
  if (!/^[0-9a-f]{64}$/i.test(transactionId)) throw new Error("A valid transaction id is required to recover its chain anchor.");
  const apiBase = apiBaseUrl.replace(/\/+$/, "");
  const response = await fetch(`${apiBase}/transactions/${transactionId}`);
  if (!response.ok) throw new Error(`History API returned ${response.status} while recovering the round anchor.`);
  const transaction = await response.json() as RestTransaction;
  const anchor = transaction.accepting_block_hash ?? transaction.block_hash?.[0];
  if (!anchor || !/^[0-9a-f]{64}$/i.test(anchor)) {
    throw new Error("The round creation transaction has no accepted chain block yet.");
  }
  return anchor.toLowerCase();
}

interface RestBlockHint {
  header?: { blueScore?: string; daaScore?: string };
  verboseData?: { hash?: string; isChainBlock?: boolean };
}

async function loadBlocksByBlueScore(apiBaseUrl: string, query: string): Promise<RestBlockHint[]> {
  const apiBase = apiBaseUrl.replace(/\/+$/, "");
  const response = await fetch(`${apiBase}/blocks-from-bluescore?${query}&includeTransactions=false`);
  if (!response.ok) throw new Error(`History API returned ${response.status} while locating the random block.`);
  const blocks = await response.json() as RestBlockHint[];
  return Array.isArray(blocks) ? blocks : [];
}

function blockHintHashes(blocks: RestBlockHint[]): string[] {
  return blocks
    .map((block) => block.verboseData?.hash?.toLowerCase())
    .filter((hash): hash is string => Boolean(hash && /^[0-9a-f]{64}$/.test(hash)))
    .slice(0, 32);
}

export async function loadBlockHashesNearDaa(
  apiBaseUrl: string,
  estimatedBlueScore: bigint,
  targetDaa: bigint
): Promise<string[]> {
  if (estimatedBlueScore < 0n || targetDaa < 0n) return [];
  let probe = estimatedBlueScore;

  for (let correction = 0; correction < 4; correction += 1) {
    const blocks = await loadBlocksByBlueScore(apiBaseUrl, `blueScoreLt=${probe + 1n}`);
    const chainBlocks = blocks.filter((block) => block.verboseData?.isChainBlock);
    const atOrAfterTarget = chainBlocks.filter((block) => BigInt(block.header?.daaScore ?? "0") >= targetDaa);
    if (atOrAfterTarget.length) {
      const nearest = atOrAfterTarget.reduce((best, block) => (
        BigInt(block.header?.daaScore ?? "0") < BigInt(best.header?.daaScore ?? "0") ? block : best
      ));
      if (BigInt(nearest.header?.daaScore ?? "0") === targetDaa) return blockHintHashes(blocks);
      probe = BigInt(nearest.header?.blueScore ?? "0") + targetDaa - BigInt(nearest.header?.daaScore ?? "0");
      continue;
    }

    const nearestBefore = chainBlocks.reduce<RestBlockHint | undefined>((best, block) => (
      !best || BigInt(block.header?.daaScore ?? "0") > BigInt(best.header?.daaScore ?? "0") ? block : best
    ), undefined);
    if (!nearestBefore) return blockHintHashes(blocks);

    let cursor = BigInt(nearestBefore.header?.blueScore ?? "0") + 1n;
    let emptyRetries = 0;
    for (let step = 0; step < 64; step += 1) {
      const forward = await loadBlocksByBlueScore(apiBaseUrl, `blueScoreGte=${cursor}`);
      if (!forward.length) {
        if (emptyRetries >= 5) return [];
        emptyRetries += 1;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        step -= 1;
        continue;
      }
      emptyRetries = 0;
      const forwardChain = forward.filter((block) => block.verboseData?.isChainBlock);
      if (forwardChain.some((block) => BigInt(block.header?.daaScore ?? "0") >= targetDaa)) {
        return blockHintHashes(forward);
      }
      cursor = forward.reduce((highest, block) => {
        const score = BigInt(block.header?.blueScore ?? "0");
        return score > highest ? score : highest;
      }, cursor) + 1n;
    }
    return [];
  }
  return [];
}

interface RestTransactionOutput {
  index?: number;
  amount?: number | string;
  script_public_key_address?: string;
  covenant_id?: string;
}

interface RafflePayload {
  app?: string;
  type?: string;
  version?: string;
  roundId?: string;
  ticketId?: number;
  ticketCount?: number;
  buyer?: string;
  paidAmount?: string;
  buyerPubkey?: string;
  winnerTicketId?: number;
  winnerAddress?: string;
  amount?: string;
  treasuryAddress?: string;
  registryAddress?: string;
  covenantAddress?: string;
  covenantId?: string;
  creator?: string;
  creatorPubkey?: string;
  createdAtDaaScore?: string;
  refundTimeoutSeconds?: string;
  refundAfterDaaScore?: string;
  chainSearchHintHash?: string;
  refundTimeoutDaa?: string;
  ticketPrice?: string;
  maxTickets?: number;
  minTickets?: number;
  createTxId?: string;
  contractVersion?: string;
  refundCursor?: number;
  refundBatchCursor?: number;
}

function decodeHexPayload(hex: string): RafflePayload | null {
  if (!hex) {
    return null;
  }

  try {
    const bytes = new Uint8Array(hex.match(/.{1,2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? []);
    const decoded = new TextDecoder().decode(bytes);
    const payload = JSON.parse(decoded) as RafflePayload;

    return payload.app === "kaspa-raffle-static" ? payload : null;
  } catch {
    return null;
  }
}

function toBigInt(value: string | undefined): bigint {
  return BigInt(value || "0");
}

function eventTime(tx: RestTransaction): number | undefined {
  return tx.accepting_block_time ?? tx.block_time;
}

function compareByTimeDesc(left?: number, right?: number) {
  return (right ?? 0) - (left ?? 0);
}

function compareByTimeAsc(left?: number, right?: number) {
  return (left ?? 0) - (right ?? 0);
}

async function loadAddressTransactions(apiBaseUrl: string, address: string, limit: number): Promise<RestTransaction[]> {
  const apiBase = apiBaseUrl.replace(/\/+$/, "");
  const url = `${apiBase}/addresses/${encodeURIComponent(address)}/full-transactions?limit=${limit}&offset=0`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`History API returned ${response.status}.`);
  }

  return (await response.json()) as RestTransaction[];
}

function applyHistoryTransactions(rounds: Map<string, RaffleHistoryRound>, transactions: RestTransaction[]): void {
  for (const tx of transactions) {
    const payload = decodeHexPayload(tx.payload ?? "");

    if (!payload?.roundId || !tx.transaction_id) {
      continue;
    }

    const round =
      rounds.get(payload.roundId) ??
      ({
        roundId: payload.roundId,
        tickets: [],
        payouts: [],
        potAmount: 0n
      } satisfies RaffleHistoryRound);

    const blockTime = eventTime(tx);
    round.lastBlockTime = Math.max(round.lastBlockTime ?? 0, blockTime ?? 0) || undefined;

    if (payload.type === "round-register" || payload.type === "round-create") {
      round.registryTxId = payload.type === "round-register" ? tx.transaction_id : round.registryTxId;
      round.registryAddress = payload.registryAddress ?? round.registryAddress;
      round.createTxId = payload.createTxId ?? (payload.type === "round-create" ? tx.transaction_id : round.createTxId);
      round.treasuryAddress =
        payload.treasuryAddress ??
        payload.covenantAddress ??
        (payload.type === "round-create" ? nextCovenantAddressFromTransaction(tx) : undefined) ??
        round.treasuryAddress;
      round.covenantId = payload.covenantId ?? outputZero(tx)?.covenant_id ?? round.covenantId;
      round.creator = payload.creator ?? round.creator;
      round.creatorPubkey = payload.creatorPubkey ?? round.creatorPubkey;
      round.createdAtDaaScore = payload.createdAtDaaScore ?? round.createdAtDaaScore;
      round.refundTimeoutSeconds = payload.refundTimeoutSeconds ?? round.refundTimeoutSeconds;
      round.refundAfterDaaScore = payload.refundAfterDaaScore ?? round.refundAfterDaaScore;
      round.chainSearchHintHash = payload.chainSearchHintHash ?? round.chainSearchHintHash;
      round.refundTimeoutDaa = payload.refundTimeoutDaa ?? round.refundTimeoutDaa;
      round.ticketPrice = payload.ticketPrice ? toBigInt(payload.ticketPrice) : round.ticketPrice;
      round.maxTickets = payload.maxTickets ?? round.maxTickets;
      round.minTickets = payload.minTickets ?? round.minTickets;
      round.version = payload.version ?? round.version;
      round.contractVersion = payload.contractVersion ?? round.contractVersion;
    }

    if (payload.type === "ticket" && payload.buyer && payload.ticketId !== undefined) {
      round.chainSearchHintHash = payload.chainSearchHintHash ?? round.chainSearchHintHash;
      const ticketCount = Math.max(1, payload.ticketCount ?? 1);
      const paidAmount = toBigInt(payload.paidAmount);
      const paidPerTicket = paidAmount / BigInt(ticketCount);

      if (!round.tickets.some((ticket) => ticket.txId === tx.transaction_id)) {
        round.tickets.push({
          txId: tx.transaction_id,
          ticketId: payload.ticketId,
          ticketCount,
          buyer: payload.buyer,
          buyerPubkey: payload.buyerPubkey,
          paidAmount: paidPerTicket,
          blockTime
        });
        round.potAmount += paidAmount;
      }
    }

    if (payload.type === "round-refund" || (payload.type === "round-refund-batch" && !outputZero(tx)?.covenant_id)) {
      round.refundTxId = tx.transaction_id;
    }

    if (
      (payload.type === "payout" || payload.type === "round-finalize") &&
      payload.winnerAddress &&
      payload.winnerTicketId !== undefined
    ) {
      if (!round.payouts.some((payout) => payout.txId === tx.transaction_id)) {
        round.payouts.push({
          txId: tx.transaction_id,
          winnerTicketId: payload.winnerTicketId,
          winnerAddress: payload.winnerAddress,
          amount: toBigInt(payload.amount),
          blockTime
        });
      }
    }

    rounds.set(payload.roundId, round);
  }
}

function outputZero(tx: RestTransaction): RestTransactionOutput | undefined {
  return tx.outputs?.find((output) => output.index === 0 || output.index === undefined);
}

function nextCovenantAddressFromTransaction(tx: RestTransaction): string | undefined {
  return outputZero(tx)?.script_public_key_address;
}

async function replayTicketTree(round: RaffleHistoryRound): Promise<{ root: string; frontier?: string }> {
  const orderedTickets = [...round.tickets].sort((left, right) => left.ticketId - right.ticketId);
  let root = TICKET_EMPTY_ROOT_HEX;
  let frontier = TICKET_EMPTY_FRONTIER_HEX;
  let nextTicketId = 1;
  let batchIndex = 0;
  for (const ticket of orderedTickets) {
    if (ticket.ticketId !== nextTicketId || !ticket.buyerPubkey) {
      throw new Error(`Round ${round.roundId} is missing canonical ticket #${nextTicketId}.`);
    }
    const count = ticketRangeCount(ticket);
    const appended = await appendTicketBatch(frontier, batchIndex, ticket.buyerPubkey, nextTicketId - 1, count);
    frontier = appended.frontierHex;
    root = appended.rootHex;
    nextTicketId += count;
    batchIndex += 1;
  }
  return { root, frontier };
}

async function buildLatestCovenantCursor(
  round: RaffleHistoryRound,
  tx: RestTransaction,
  status: Extract<RoundStatus, "Open" | "Refunding">
): Promise<RaffleCovenantCursor | undefined> {
  const output = outputZero(tx);
  const address = output?.script_public_key_address;
  const amountSompi = output?.amount?.toString();
  const covenantId = output?.covenant_id ?? round.covenantId;

  if (
    !tx.transaction_id ||
    !address ||
    !amountSompi ||
    !covenantId ||
    round.ticketPrice === undefined ||
    round.maxTickets === undefined ||
    round.minTickets === undefined ||
    !round.creatorPubkey ||
    !round.refundAfterDaaScore ||
    round.tickets.some((ticket) => !ticket.buyerPubkey)
  ) {
    return undefined;
  }

  const ticketTree = await replayTicketTree(round);
  const ticketRoot = ticketTree.root;
  const orderedTickets = [...round.tickets].sort((left, right) => left.ticketId - right.ticketId);
  const soldTickets = totalTicketCount(orderedTickets);
  const txPayload = decodeHexPayload(tx.payload ?? "");
  const refundCursor = status === "Refunding"
    ? txPayload?.type === "round-refund-batch"
      ? Math.max(0, Number(txPayload.refundCursor || 0) + Number(txPayload.ticketCount || 1))
      : 0
    : 0;
  const refundBatchCursor = status === "Refunding"
    ? txPayload?.type === "round-refund-batch"
      ? Math.max(0, Number(txPayload.refundBatchCursor || 0) + 1)
      : 0
    : 0;
  const stateRound: RoundState = {
    appId: "KASPA_RAFFLE_ROUND_V1",
    contractVersion: round.contractVersion || "",
    roundId: round.roundId,
    creator: round.creator || "no-wallet",
    ticketPrice: round.ticketPrice,
    maxTickets: round.maxTickets,
    minTickets: round.minTickets,
    soldTickets,
    potAmount: round.ticketPrice * BigInt(Math.max(0, soldTickets - refundCursor)),
    feeBps: 0,
    status,
    randomnessMode: "kaspa-chain-pow",
    creatorPubkey: round.creatorPubkey,
    refundAfterDaaScore: round.refundAfterDaaScore,
    ticketRoot,
    ticketFrontier: ticketTree.frontier,
    refundCursor,
    refundBatchCursor,
    soldBatches: orderedTickets.length,
    ticketBatchEnds: orderedTickets.map(ticketRangeEnd),
    ticketOwnerPubkeys: orderedTickets.map((ticket) => ticket.buyerPubkey!)
  };
  const covenantState = await raffleCovenantStateFromRound(stateRound);

  return {
    covenantId,
    address,
    txId: tx.transaction_id,
    outputIndex: output.index ?? 0,
    amountSompi,
    redeemScriptHex: bytesToHex(buildRaffleRedeemScriptForContractVersion(covenantState, round.contractVersion, status)),
    soldTickets: stateRound.soldTickets,
    potAmount: stateRound.potAmount.toString(),
    status,
    ticketRoot,
    ticketFrontier: ticketTree.frontier,
    chainSearchHintHash: round.chainSearchHintHash,
    refundCursor,
    refundBatchCursor,
    creatorPubkey: stateRound.creatorPubkey,
    refundAfterDaaScore: stateRound.refundAfterDaaScore,
    soldBatches: stateRound.soldBatches,
    ticketBatchEnds: stateRound.ticketBatchEnds,
    ticketOwnerPubkeys: stateRound.ticketOwnerPubkeys
  };
}

async function traceRoundCovenantHistory(
  apiBaseUrl: string,
  rounds: Map<string, RaffleHistoryRound>,
  round: RaffleHistoryRound,
  limit: number
): Promise<void> {
  let currentAddress = round.treasuryAddress;
  let previousTxId = round.createTxId;
  let latestCovenantTransaction: RestTransaction | undefined;
  let latestStatus: Extract<RoundStatus, "Open" | "Refunding"> | undefined = "Open";
  let finalized = false;
  const visitedAddresses = new Set<string>();
  const visitedTransactions = new Set<string>();

  while (currentAddress && !visitedAddresses.has(currentAddress)) {
    visitedAddresses.add(currentAddress);

    const transactions = await loadAddressTransactions(apiBaseUrl, currentAddress, limit);
    applyHistoryTransactions(rounds, transactions);

    const currentProducer = transactions.find((tx) => tx.transaction_id === previousTxId);

    if (currentProducer && !latestCovenantTransaction) {
      latestCovenantTransaction = currentProducer;
    }

    const nextSpend = transactions
      .filter((tx) => {
        const payload = decodeHexPayload(tx.payload ?? "");

        return (
          payload?.roundId === round.roundId &&
          tx.transaction_id &&
          tx.transaction_id !== previousTxId &&
          !visitedTransactions.has(tx.transaction_id) &&
          (payload.type === "ticket" || payload.type === "round-finalize" || payload.type === "round-refund" || payload.type === "round-refund-start" || payload.type === "round-refund-batch")
        );
      })
      .sort((left, right) => compareByTimeAsc(eventTime(left), eventTime(right)))[0];

    if (!nextSpend?.transaction_id) {
      break;
    }

    visitedTransactions.add(nextSpend.transaction_id);
    previousTxId = nextSpend.transaction_id;

    const payload = decodeHexPayload(nextSpend.payload ?? "");

    if (payload?.type === "round-finalize" || payload?.type === "round-refund") {
      finalized = true;
      break;
    }

    if (payload?.type === "round-refund-batch" && !outputZero(nextSpend)?.covenant_id) {
      finalized = true;
      break;
    }

    latestCovenantTransaction = nextSpend;
    latestStatus = payload?.type === "round-refund-start" || payload?.type === "round-refund-batch"
      ? "Refunding"
      : "Open";
    currentAddress = nextCovenantAddressFromTransaction(nextSpend);
  }

  if (!finalized && latestCovenantTransaction && latestStatus) {
    const updatedRound = rounds.get(round.roundId);
    const latestCovenant = updatedRound
      ? await buildLatestCovenantCursor(updatedRound, latestCovenantTransaction, latestStatus)
      : undefined;

    if (updatedRound && latestCovenant) {
      updatedRound.latestCovenant = latestCovenant;
      updatedRound.treasuryAddress = latestCovenant.address;
      rounds.set(updatedRound.roundId, updatedRound);
    }
  }
}

export async function loadRaffleHistory(apiBaseUrl: string, registryAddress: string, limit = 100): Promise<RaffleHistoryRound[]> {
  const rounds = new Map<string, RaffleHistoryRound>();
  const registryTransactions = await loadAddressTransactions(apiBaseUrl, registryAddress, limit);

  applyHistoryTransactions(rounds, registryTransactions);

  for (const round of [...rounds.values()]) {
    if (!round.contractVersion || !isCurrentRaffleContractVersion(round.contractVersion)) {
      rounds.delete(round.roundId);
      continue;
    }
    if (requiresRaffleIndexer(round.maxTickets ?? 1_000_000)) continue;
    await traceRoundCovenantHistory(apiBaseUrl, rounds, round, limit);
  }

  return [...rounds.values()]
    .map((round) => ({
      ...round,
      tickets: round.tickets.sort((left, right) => left.ticketId - right.ticketId),
      payouts: round.payouts.sort((left, right) => compareByTimeDesc(left.blockTime, right.blockTime))
    }))
    .sort((left, right) => compareByTimeDesc(left.lastBlockTime, right.lastBlockTime));
}

export async function loadIndexedRaffleHistory(apiBaseUrl: string): Promise<RaffleHistoryRound[]> {
  const indexedRounds = (await loadIndexedRaffleRounds(apiBaseUrl)).filter((round) => (
    isCurrentRaffleContractVersion(round.contractVersion)
  ));
  return Promise.all(indexedRounds.map(async (indexed): Promise<RaffleHistoryRound> => {
    const ticketPrice = BigInt(indexed.ticketPrice || "0");
    let latestCovenant: RaffleCovenantCursor | undefined;

    if (
      indexed.latestCovenant &&
      indexed.creator &&
      indexed.creatorPubkey &&
      indexed.maxTickets !== undefined &&
      indexed.minTickets !== undefined
    ) {
      const stateRound: RoundState = {
        appId: "KASPA_RAFFLE_ROUND_V1",
        contractVersion: indexed.contractVersion,
        roundId: indexed.roundId,
        creator: indexed.creator,
        ticketPrice,
        maxTickets: indexed.maxTickets,
        minTickets: indexed.minTickets,
        soldTickets: indexed.soldTickets,
        potAmount: BigInt(indexed.latestCovenant.potAmount),
        feeBps: 0,
        status: indexed.latestCovenant.status,
        randomnessMode: "kaspa-chain-pow",
        creatorPubkey: indexed.creatorPubkey,
        refundAfterDaaScore: indexed.refundAfterDaaScore || "0",
        ticketRoot: indexed.ticketRoot,
        ticketFrontier: indexed.ticketFrontier,
        refundCursor: indexed.refundCursor,
        refundBatchCursor: indexed.refundBatchCursor,
        soldBatches: indexed.soldBatches,
        ticketBatchEnds: [],
        ticketOwnerPubkeys: []
      };
      const state = await raffleCovenantStateFromRound(stateRound);
      latestCovenant = {
        ...indexed.latestCovenant,
        covenantId: indexed.covenantId || indexed.latestCovenant.covenantId,
        redeemScriptHex: bytesToHex(buildRaffleRedeemScriptForContractVersion(state, indexed.contractVersion, indexed.latestCovenant.status)),
        creatorPubkey: indexed.creatorPubkey,
        refundAfterDaaScore: indexed.refundAfterDaaScore || "0",
        refundBatchCursor: indexed.refundBatchCursor,
        soldBatches: indexed.soldBatches,
        ticketOwnerPubkeys: []
      };
    }

    return {
      roundId: indexed.roundId,
      registryAddress: indexed.registryAddress,
      createTxId: indexed.createTxId,
      refundTxId: indexed.refundTxId,
      covenantId: indexed.covenantId,
      latestCovenant,
      creator: indexed.creator,
      creatorPubkey: indexed.creatorPubkey,
      refundTimeoutSeconds: indexed.refundTimeoutSeconds,
      createdAtDaaScore: indexed.createdAtDaaScore,
      refundAfterDaaScore: indexed.refundAfterDaaScore,
      ticketPrice,
      maxTickets: indexed.maxTickets,
      minTickets: indexed.minTickets,
      version: indexed.version,
      contractVersion: indexed.contractVersion,
      tickets: [],
      payouts: indexed.finalized ? [{
        txId: indexed.finalized.txId,
        winnerTicketId: indexed.finalized.winnerTicketId,
        winnerAddress: indexed.finalized.winnerAddress,
        amount: BigInt(indexed.finalized.amount)
      }] : [],
      potAmount: ticketPrice * BigInt(indexed.soldTickets),
      soldTickets: indexed.soldTickets
    };
  }));
}
