import type { RaffleHistoryTicket } from "../kaspa/history";
import type { RaffleCovenantCursor } from "./types";
import { ticketRangeCount } from "./tickets";

function sortedContinuousCoverage(tickets: RaffleHistoryTicket[]): {
  coverage: number;
  sorted: RaffleHistoryTicket[];
} {
  const sorted = [...tickets].sort((left, right) => left.ticketId - right.ticketId);
  let expectedTicketId = 1;
  for (const ticket of sorted) {
    const count = ticketRangeCount(ticket);
    if (!Number.isSafeInteger(ticket.ticketId) || ticket.ticketId !== expectedTicketId || count <= 0) {
      return { coverage: -1, sorted };
    }
    expectedTicketId += count;
  }
  return { coverage: expectedTicketId - 1, sorted };
}

function sameCommittedTicket(left: RaffleHistoryTicket, right: RaffleHistoryTicket): boolean {
  if (
    left.ticketId !== right.ticketId ||
    ticketRangeCount(left) !== ticketRangeCount(right) ||
    left.paidAmount !== right.paidAmount
  ) {
    return false;
  }
  if (left.txId && right.txId && left.txId !== right.txId) return false;
  if (left.buyer && right.buyer && left.buyer !== right.buyer) return false;
  if (left.buyerPubkey && right.buyerPubkey && left.buyerPubkey !== right.buyerPubkey) return false;
  return true;
}

/**
 * History and index services are discovery aids, not state authorities. A
 * partial response must never erase locally observed purchase batches. A
 * longer response is accepted only when it contains the existing continuous
 * history as an identical prefix.
 */
export function preferMoreCompleteRaffleHistoryTickets(
  current: RaffleHistoryTicket[],
  incoming: RaffleHistoryTicket[]
): RaffleHistoryTicket[] {
  const currentState = sortedContinuousCoverage(current);
  const incomingState = sortedContinuousCoverage(incoming);
  if (incomingState.coverage <= currentState.coverage) return current;
  if (incomingState.coverage < 0) return current;
  if (currentState.coverage < 0) return incomingState.sorted;
  for (let index = 0; index < currentState.sorted.length; index += 1) {
    if (!sameCommittedTicket(currentState.sorted[index], incomingState.sorted[index])) return current;
  }
  return incomingState.sorted;
}

const STATUS_RANK: Record<string, number> = {
  Open: 0,
  Closed: 1,
  Refunding: 2,
  Refunded: 3,
  Finalized: 3
};

function safeCounter(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? value! : -1;
}

/** Keep the latest covenant cursor monotonic even when an API replica is stale. */
export function preferAdvancedRaffleCovenant(
  current: RaffleCovenantCursor | undefined,
  incoming: RaffleCovenantCursor | undefined
): RaffleCovenantCursor | undefined {
  if (!incoming) return current;
  if (!current) return incoming;

  const currentSold = safeCounter(current.soldTickets);
  const incomingSold = safeCounter(incoming.soldTickets);
  if (incomingSold !== currentSold) return incomingSold > currentSold ? incoming : current;

  const currentRefund = safeCounter(current.refundCursor);
  const incomingRefund = safeCounter(incoming.refundCursor);
  if (incomingRefund !== currentRefund) return incomingRefund > currentRefund ? incoming : current;

  const currentBatch = safeCounter(current.refundBatchCursor);
  const incomingBatch = safeCounter(incoming.refundBatchCursor);
  if (incomingBatch !== currentBatch) return incomingBatch > currentBatch ? incoming : current;

  const currentRank = STATUS_RANK[current.status] ?? -1;
  const incomingRank = STATUS_RANK[incoming.status] ?? -1;
  if (incomingRank !== currentRank) return incomingRank > currentRank ? incoming : current;

  try {
    const currentAmount = BigInt(current.amountSompi);
    const incomingAmount = BigInt(incoming.amountSompi);
    if (incomingAmount > currentAmount) return incoming;
  } catch {
    // Retain the already observed cursor when an API returns malformed value data.
  }
  return current;
}
