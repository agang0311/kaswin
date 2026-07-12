import type { FinalizeState, RaffleMetadata, TicketState } from "./types";
import type { RaffleHistoryRound } from "../kaspa/history";

const STORAGE_KEY = "kaspa-raffle-participated-rounds-v1";
const MAX_CACHED_ROUNDS = 100;

interface StoredTicket extends Omit<TicketState, "paidAmount"> {
  paidAmount: string;
}

interface StoredRound {
  metadata: RaffleMetadata;
  tickets: StoredTicket[];
  finalized?: FinalizeState;
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
  if (!metadata.roundId || !metadata.covenant) return;

  const stored: StoredRound = {
    metadata,
    tickets: tickets.map((ticket) => ({ ...ticket, paidAmount: ticket.paidAmount.toString() })),
    finalized,
    updatedAt: Date.now()
  };
  const remaining = readStore().filter((round) => !(
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
    metadata: stored.metadata,
    tickets: stored.tickets.map((ticket) => ({ ...ticket, paidAmount: BigInt(ticket.paidAmount) })),
    finalized: stored.finalized
  };
}

export function loadCachedRaffleHistory(network: string): RaffleHistoryRound[] {
  return readStore()
    .filter((round) => round.metadata.network === network)
    .map((round) => {
      const ticketPrice = BigInt(round.metadata.ticketPrice || "0");
      return {
        roundId: round.metadata.roundId,
        registryAddress: round.metadata.registryAddress,
        createTxId: round.metadata.createTxId,
        treasuryAddress: round.metadata.treasuryAddress,
        covenantId: round.metadata.covenant?.covenantId,
        latestCovenant: round.finalized ? undefined : round.metadata.covenant,
        creator: round.metadata.creatorAddress,
        creatorPubkey: round.metadata.creatorPubkey,
        creatorCommitment: round.metadata.creatorCommitment,
        oraclePublicKey: round.metadata.oraclePublicKey,
        oracleEndpoint: round.metadata.oracleEndpoint,
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
          paidAmount: BigInt(ticket.paidAmount),
          buyerCommitment: ticket.buyerCommitment
        })),
        payouts: round.finalized ? [{
          txId: round.finalized.payoutTxId,
          winnerTicketId: round.finalized.winnerTicketId,
          winnerAddress: round.finalized.winnerAddress,
          amount: ticketPrice * BigInt(round.metadata.covenant?.soldTickets ?? round.tickets.length)
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
