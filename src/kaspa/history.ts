import {
  buildNextTicketRootHex,
  buildRaffleRedeemScriptForContractVersion,
  bytesToHex,
  raffleCovenantStateFromRound
} from "./covenant";
import type { RaffleCovenantCursor, RoundState, RoundStatus } from "../raffle/types";

export interface RaffleHistoryTicket {
  txId: string;
  ticketId: number;
  buyer: string;
  buyerPubkey?: string;
  paidAmount: bigint;
  buyerCommitment?: string;
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
  registryTxId?: string;
  registryAddress?: string;
  createTxId?: string;
  closeTxId?: string;
  refundTxId?: string;
  treasuryAddress?: string;
  covenantId?: string;
  latestCovenant?: RaffleCovenantCursor;
  creator?: string;
  creatorPubkey?: string;
  creatorCommitment?: string;
  oraclePublicKey?: string;
  createdAtDaaScore?: string;
  refundTimeoutSeconds?: string;
  refundAfterDaaScore?: string;
  refundTimeoutDaa?: string;
  ticketPrice?: bigint;
  maxTickets?: number;
  minTickets?: number;
  version?: string;
  contractVersion?: string;
  tickets: RaffleHistoryTicket[];
  payouts: RaffleHistoryPayout[];
  potAmount: bigint;
  lastBlockTime?: number;
}

interface RestTransaction {
  transaction_id?: string;
  payload?: string;
  block_time?: number;
  accepting_block_time?: number;
  outputs?: RestTransactionOutput[];
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
  buyerCommitment?: string;
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
  creatorCommitment?: string;
  oraclePublicKey?: string;
  createdAtDaaScore?: string;
  refundTimeoutSeconds?: string;
  refundAfterDaaScore?: string;
  refundTimeoutDaa?: string;
  ticketPrice?: string;
  maxTickets?: number;
  minTickets?: number;
  createTxId?: string;
  contractVersion?: string;
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
      round.creatorCommitment = payload.creatorCommitment ?? round.creatorCommitment;
      round.oraclePublicKey = payload.oraclePublicKey ?? round.oraclePublicKey;
      round.createdAtDaaScore = payload.createdAtDaaScore ?? round.createdAtDaaScore;
      round.refundTimeoutSeconds = payload.refundTimeoutSeconds ?? round.refundTimeoutSeconds;
      round.refundAfterDaaScore = payload.refundAfterDaaScore ?? round.refundAfterDaaScore;
      round.refundTimeoutDaa = payload.refundTimeoutDaa ?? round.refundTimeoutDaa;
      round.ticketPrice = payload.ticketPrice ? toBigInt(payload.ticketPrice) : round.ticketPrice;
      round.maxTickets = payload.maxTickets ?? round.maxTickets;
      round.minTickets = payload.minTickets ?? round.minTickets;
      round.version = payload.version ?? round.version;
      round.contractVersion = payload.contractVersion ?? round.contractVersion;
    }

    if (payload.type === "round-close") {
      round.closeTxId = tx.transaction_id;
    }

    if (payload.type === "ticket" && payload.buyer && payload.ticketId !== undefined) {
      const ticketCount = Math.max(1, payload.ticketCount ?? 1);
      const paidAmount = toBigInt(payload.paidAmount);
      const paidPerTicket = paidAmount / BigInt(ticketCount);

      if (!round.tickets.some((ticket) => ticket.txId === tx.transaction_id)) {
        for (let offset = 0; offset < ticketCount; offset += 1) {
          round.tickets.push({
            txId: tx.transaction_id,
            ticketId: payload.ticketId + offset,
            buyer: payload.buyer,
            buyerPubkey: payload.buyerPubkey,
            paidAmount: paidPerTicket,
            buyerCommitment: payload.buyerCommitment,
            blockTime
          });
        }
        round.potAmount += paidAmount;
      }
    }

    if (payload.type === "round-refund") {
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

async function replayTicketRoot(round: RaffleHistoryRound): Promise<string> {
  const orderedTickets = [...round.tickets].sort((left, right) => left.ticketId - right.ticketId);
  let root = "";

  if (round.contractVersion?.startsWith("raffle-v3")) {
    const batches = orderedTickets.filter(
      (ticket, index) => index === 0 || ticket.txId !== orderedTickets[index - 1]?.txId
    );

    for (const batch of batches) {
      const ticketCount = orderedTickets.filter((ticket) => ticket.txId === batch.txId).length;

      if (!batch.buyerCommitment) {
        throw new Error(`Round ${round.roundId} is missing ticket batch commitment ${batch.txId}.`);
      }

      root = await buildNextTicketRootHex(round.roundId, root, {
        ticketId: batch.ticketId,
        ticketCount,
        owner: batch.buyer,
        buyerCommitment: batch.buyerCommitment
      });
    }

    return root;
  }

  for (let ticketId = 1; ticketId <= orderedTickets.length; ticketId += 1) {
    const ticket = orderedTickets[ticketId - 1];

    if (!ticket || ticket.ticketId !== ticketId || !ticket.buyerCommitment) {
      throw new Error(`Round ${round.roundId} is missing ticket #${ticketId} commitment.`);
    }

    root = await buildNextTicketRootHex(round.roundId, root, {
      ticketId: ticket.ticketId,
      owner: ticket.buyer,
      buyerCommitment: ticket.buyerCommitment
    });
  }

  return root;
}

async function buildLatestCovenantCursor(
  round: RaffleHistoryRound,
  tx: RestTransaction,
  status: Extract<RoundStatus, "Open" | "Closed">
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
    !round.oraclePublicKey ||
    round.ticketPrice === undefined ||
    round.maxTickets === undefined ||
    round.minTickets === undefined ||
    !round.creatorPubkey ||
    !round.refundAfterDaaScore ||
    round.tickets.some((ticket) => !ticket.buyerPubkey)
  ) {
    return undefined;
  }

  const ticketRoot = await replayTicketRoot(round);
  const orderedTickets = [...round.tickets].sort((left, right) => left.ticketId - right.ticketId);
  const batchTickets = round.contractVersion?.startsWith("raffle-v3")
    ? orderedTickets.filter((ticket, index) => index === 0 || ticket.txId !== orderedTickets[index - 1]?.txId)
    : orderedTickets;
  const ticketBatchEnds = batchTickets.map((batchTicket) => {
    const lastTicket = [...orderedTickets].reverse().find((ticket) => ticket.txId === batchTicket.txId);
    return lastTicket?.ticketId ?? batchTicket.ticketId;
  });
  const stateRound: RoundState = {
    appId: "KASPA_RAFFLE_ROUND_V1",
    roundId: round.roundId,
    creator: round.creator || "no-wallet",
    ticketPrice: round.ticketPrice,
    maxTickets: round.maxTickets,
    minTickets: round.minTickets,
    soldTickets: round.tickets.length,
    potAmount: round.potAmount,
    feeBps: 0,
    status,
    randomnessMode: "oracle",
    creatorPubkey: round.creatorPubkey,
    oraclePublicKey: round.oraclePublicKey,
    refundAfterDaaScore: round.refundAfterDaaScore,
    ticketRoot,
    soldBatches: batchTickets.length,
    ticketBatchEnds,
    ticketOwnerPubkeys: batchTickets.map((ticket) => ticket.buyerPubkey ?? "")
  };
  const covenantState = await raffleCovenantStateFromRound(stateRound);

  return {
    covenantId,
    address,
    txId: tx.transaction_id,
    outputIndex: output.index ?? 0,
    amountSompi,
    redeemScriptHex: bytesToHex(buildRaffleRedeemScriptForContractVersion(covenantState, round.contractVersion)),
    soldTickets: stateRound.soldTickets,
    potAmount: stateRound.potAmount.toString(),
    status,
    ticketRoot,
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
  let latestStatus: Extract<RoundStatus, "Open" | "Closed"> | undefined = "Open";
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
          (payload.type === "ticket" || payload.type === "round-close" || payload.type === "round-finalize" || payload.type === "round-refund")
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

    latestCovenantTransaction = nextSpend;
    latestStatus = payload?.type === "round-close" ? "Closed" : "Open";
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
