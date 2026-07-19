import type { RaffleState, VerificationResult } from "./types";
import { ticketRangeCount, totalTicketCount } from "./tickets";

export function verifyRaffleState(state: Pick<RaffleState, "round" | "tickets" | "finalized">): VerificationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { round, tickets, finalized } = state;

  if (totalTicketCount(tickets) !== round.soldTickets) {
    errors.push("Ticket count does not match soldTickets.");
  }

  let expectedTicketId = 1;

  [...tickets].sort((left, right) => left.ticketId - right.ticketId).forEach((ticket) => {
    if (ticket.roundId !== round.roundId) {
      errors.push(`Ticket ${ticket.ticketId} has a mismatched roundId.`);
    }

    if (ticket.ticketId !== expectedTicketId) {
      errors.push("Ticket IDs must be continuous from 1.");
    }

    if (ticket.paidAmount !== round.ticketPrice) {
      errors.push(`Ticket ${ticket.ticketId} paid the wrong amount.`);
    }

    expectedTicketId = ticket.ticketId + ticketRangeCount(ticket);
  });

  const refundCursor = round.refundCursor ?? 0;
  if (!Number.isSafeInteger(refundCursor) || refundCursor < 0 || refundCursor > round.soldTickets) {
    errors.push("Refund cursor must be between zero and soldTickets.");
  }

  const refundedTickets = round.status === "Refunding" || round.status === "Refunded"
    ? Math.min(Math.max(refundCursor, 0), round.soldTickets)
    : 0;
  if (round.status === "Refunded" && refundCursor !== round.soldTickets) {
    errors.push("Refunded round must have refunded every sold ticket.");
  }

  if (round.potAmount !== BigInt(round.soldTickets - refundedTickets) * round.ticketPrice) {
    errors.push("Pot amount does not equal soldTickets * ticketPrice.");
  }

  if (finalized && round.status !== "Finalized") {
    warnings.push("A finalized marker exists while the round status is not Finalized.");
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings
  };
}
