import type { RaffleState, VerificationResult } from "./types";

export function verifyRaffleState(state: Pick<RaffleState, "round" | "tickets" | "finalized">): VerificationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { round, tickets, finalized } = state;

  if (tickets.length !== round.soldTickets) {
    errors.push("Ticket count does not match soldTickets.");
  }

  tickets.forEach((ticket, index) => {
    if (ticket.roundId !== round.roundId) {
      errors.push(`Ticket ${ticket.ticketId} has a mismatched roundId.`);
    }

    if (ticket.ticketId !== index) {
      errors.push("Ticket IDs must be continuous from 0.");
    }

    if (ticket.paidAmount !== round.ticketPrice) {
      errors.push(`Ticket ${ticket.ticketId} paid the wrong amount.`);
    }
  });

  if (round.potAmount !== BigInt(round.soldTickets) * round.ticketPrice) {
    errors.push("Pot amount does not equal soldTickets * ticketPrice.");
  }

  if (finalized && round.status !== "Finalized") {
    warnings.push("A finalized marker exists while the round status is not Finalized.");
  }

  if (round.status === "Closed" && round.soldTickets < round.minTickets) {
    warnings.push("Closed round has fewer tickets than the minimum and should allow refunds.");
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings
  };
}

