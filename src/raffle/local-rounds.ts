import type { FinalizeState, RaffleMetadata, TicketState } from "./types";
import type { RaffleHistoryRound } from "../kaspa/history";
import { isKnownRaffleContractVersion } from "./metadata";

const STORAGE_KEY = "kaspa-raffle-participated-rounds-v12";
const MAX_CACHED_ROUNDS = 100;

interface StoredTicket extends Omit<TicketState, "paidAmount"> {
  paidAmount: string;
}

interface StoredRoundOutcome {
  status: "Paid" | "Refunded";
  txId?: string;
  winnerTicketId?: number;
  winnerAddress?: string;
  amount?: string;
}

interface StoredRound {
  metadata: RaffleMetadata;
  tickets: StoredTicket[];
  finalized?: FinalizeState;
  outcome?: StoredRoundOutcome;
  updatedAt: number;
}

function readStore(): StoredRound[] {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as StoredRound[];
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function writeStore(rounds: StoredRound[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rounds.slice(0, MAX_CACHED_ROUNDS)));
  } catch {
    // The on-chain state remains authoritative when browser storage is unavailable.
  }
}

export function cacheParticipatedRound(
  metadata: RaffleMetadata,
  tickets: TicketState[],
  finalized?: FinalizeState
): void {
  if (!metadata.roundId || !metadata.covenant && !finalized) return;

  const rounds = readStore();
  const previous = rounds.find((round) => (
    round.metadata.network === metadata.network && round.metadata.roundId === metadata.roundId
  ));
  const outcome: StoredRoundOutcome | undefined = finalized
    ? {
        status: "Paid",
        txId: finalized.payoutTxId,
        winnerTicketId: finalized.winnerTicketId,
        winnerAddress: finalized.winnerAddress,
        amount: (
          BigInt(metadata.ticketPrice || "0") *
          BigInt(metadata.covenant?.soldTickets ?? tickets.reduce(
            (total, ticket) => total + Math.max(1, ticket.ticketCount ?? 1),
            0
          ))
        ).toString()
      }
    : metadata.covenant?.status === "Refunded"
      ? { status: "Refunded", txId: metadata.covenant.txId }
      : previous?.outcome;
  const stored: StoredRound = {
    metadata: outcome ? { ...metadata, covenant: undefined } : metadata,
    tickets: tickets.map((ticket) => ({ ...ticket, paidAmount: ticket.paidAmount.toString() })),
    finalized,
    outcome,
    updatedAt: Date.now()
  };
  const remaining = rounds.filter((round) => !(
    round.metadata.network === metadata.network && round.metadata.roundId === metadata.roundId
  ));
  writeStore([stored, ...remaining]);
}

export function loadCachedRound(network: string, roundId: string): {
  metadata: RaffleMetadata;
  tickets: TicketState[];
  finalized?: FinalizeState;
} | undefined {
  const stored = readStore().find((round) => (
    round.metadata.network === network && round.metadata.roundId === roundId
  ));
  if (!stored) return undefined;
  return {
    metadata: stored.outcome ? { ...stored.metadata, covenant: undefined } : stored.metadata,
    tickets: stored.tickets.map((ticket) => ({ ...ticket, paidAmount: BigInt(ticket.paidAmount) })),
    finalized: stored.finalized
  };
}

export function hasCachedParticipatedRound(network: string, roundId: string): boolean {
  return readStore().some((round) => (
    round.metadata.network === network && round.metadata.roundId === roundId
  ));
}

export function updateCachedParticipatedRoundFromHistory(network: string, historyRound: RaffleHistoryRound): void {
  const rounds = readStore();
  const index = rounds.findIndex((round) => (
    round.metadata.network === network && round.metadata.roundId === historyRound.roundId
  ));
  if (index < 0) return;

  const previous = rounds[index];
  const payout = historyRound.payouts[0];
  const nextOutcome: StoredRoundOutcome | undefined = payout
    ? {
        status: "Paid",
        txId: payout.txId,
        winnerTicketId: payout.winnerTicketId,
        winnerAddress: payout.winnerAddress,
        amount: payout.amount.toString()
      }
    : historyRound.refundTxId || historyRound.latestCovenant?.status === "Refunded"
      ? {
          status: "Refunded",
          txId: historyRound.refundTxId ?? historyRound.latestCovenant?.txId
        }
      : previous.outcome;
  const nextMetadata: RaffleMetadata = {
    ...previous.metadata,
    createTxId: historyRound.createTxId ?? previous.metadata.createTxId,
    createdAtDaaScore: historyRound.createdAtDaaScore ?? previous.metadata.createdAtDaaScore,
    refundTimeoutSeconds: historyRound.refundTimeoutSeconds ?? previous.metadata.refundTimeoutSeconds,
    refundTimeoutDaa: historyRound.refundTimeoutDaa ?? previous.metadata.refundTimeoutDaa,
    refundAfterDaaScore: historyRound.refundAfterDaaScore ?? previous.metadata.refundAfterDaaScore,
    registryAddress: historyRound.registryAddress ?? previous.metadata.registryAddress,
    treasuryAddress: historyRound.treasuryAddress ?? previous.metadata.treasuryAddress,
    creatorAddress: historyRound.creator ?? previous.metadata.creatorAddress,
    creatorPubkey: historyRound.creatorPubkey ?? previous.metadata.creatorPubkey,
    ticketPrice: historyRound.ticketPrice?.toString() ?? previous.metadata.ticketPrice,
    maxTickets: historyRound.maxTickets ?? previous.metadata.maxTickets,
    minTickets: historyRound.minTickets ?? previous.metadata.minTickets,
    covenant: nextOutcome ? undefined : historyRound.latestCovenant ?? previous.metadata.covenant
  };
  const nextTickets = historyRound.tickets.length
    ? historyRound.tickets.map((ticket) => ({
        appId: "KASPA_RAFFLE_TICKET_V1" as const,
        roundId: historyRound.roundId,
        ticketId: ticket.ticketId,
        ticketCount: ticket.ticketCount,
        owner: ticket.buyer,
        ownerPubkey: ticket.buyerPubkey,
        paidAmount: ticket.paidAmount.toString(),
        ticketTxId: ticket.txId
      }))
    : previous.tickets;

  rounds[index] = {
    ...previous,
    metadata: nextMetadata,
    tickets: nextTickets,
    outcome: nextOutcome,
    updatedAt: Date.now()
  };
  writeStore(rounds.sort((left, right) => right.updatedAt - left.updatedAt));
}

export function loadCachedRaffleHistory(network: string): RaffleHistoryRound[] {
  return readStore()
    .filter((round) => (
      round.metadata.network === network &&
      isKnownRaffleContractVersion(round.metadata.contractVersion)
    ))
    .map((round) => {
      const ticketPrice = BigInt(round.metadata.ticketPrice || "0");
      const paidOutcome = round.outcome?.status === "Paid" ? round.outcome : undefined;
      const refundedOutcome = round.outcome?.status === "Refunded" ? round.outcome : undefined;
      return {
        roundId: round.metadata.roundId,
        localCachedAt: round.updatedAt,
        registryAddress: round.metadata.registryAddress,
        createTxId: round.metadata.createTxId,
        treasuryAddress: round.metadata.treasuryAddress,
        covenantId: round.metadata.covenant?.covenantId,
        refundTxId: refundedOutcome?.txId,
        latestCovenant: round.outcome || round.finalized ? undefined : round.metadata.covenant,
        creator: round.metadata.creatorAddress,
        creatorPubkey: round.metadata.creatorPubkey,
        createdAtDaaScore: round.metadata.createdAtDaaScore,
        refundTimeoutSeconds: round.metadata.refundTimeoutSeconds,
        refundAfterDaaScore: round.metadata.refundAfterDaaScore,
        refundTimeoutDaa: round.metadata.refundTimeoutDaa,
        ticketPrice,
        maxTickets: round.metadata.maxTickets,
        minTickets: round.metadata.minTickets,
        version: round.metadata.version,
        contractVersion: round.metadata.contractVersion,
        tickets: round.tickets.map((ticket) => ({
          txId: ticket.ticketTxId,
          ticketId: ticket.ticketId,
          ticketCount: ticket.ticketCount,
          buyer: ticket.owner,
          buyerPubkey: ticket.ownerPubkey,
          paidAmount: BigInt(ticket.paidAmount)
        })),
        payouts: paidOutcome || round.finalized ? [{
          txId: paidOutcome?.txId ?? round.finalized?.payoutTxId ?? "",
          winnerTicketId: paidOutcome?.winnerTicketId ?? round.finalized?.winnerTicketId ?? 0,
          winnerAddress: paidOutcome?.winnerAddress ?? round.finalized?.winnerAddress ?? "",
          amount: paidOutcome?.amount
            ? BigInt(paidOutcome.amount)
            : ticketPrice * BigInt(round.metadata.covenant?.soldTickets ?? round.tickets.length)
        }] : [],
        potAmount: BigInt(round.metadata.covenant?.potAmount ?? "0"),
        soldTickets: round.metadata.covenant?.soldTickets ?? round.tickets.reduce(
          (total, ticket) => total + Math.max(1, ticket.ticketCount ?? 1),
          0
        ),
        lastBlockTime: round.updatedAt
      };
    });
}
