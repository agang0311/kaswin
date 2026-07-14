export interface TicketRange {
  ticketId: number;
  ticketCount?: number;
}

export function ticketRangeCount(ticket: TicketRange): number {
  return Math.max(1, ticket.ticketCount ?? 1);
}

export function ticketRangeEnd(ticket: TicketRange): number {
  return ticket.ticketId + ticketRangeCount(ticket) - 1;
}

export function totalTicketCount(tickets: TicketRange[]): number {
  return tickets.reduce((total, ticket) => total + ticketRangeCount(ticket), 0);
}

export function findTicketRange<T extends TicketRange>(tickets: T[], ticketId: number): T | undefined {
  return tickets.find((ticket) => ticketId >= ticket.ticketId && ticketId <= ticketRangeEnd(ticket));
}

export function hasCompleteTicketBatchHistory(
  tickets: TicketRange[],
  soldTickets: number,
  soldBatches: number
): boolean {
  if (soldTickets < 0 || soldBatches < 0 || tickets.length !== soldBatches) return false;
  const ordered = [...tickets].sort((left, right) => left.ticketId - right.ticketId);
  let nextTicketId = 1;
  for (const ticket of ordered) {
    if (ticket.ticketId !== nextTicketId) return false;
    nextTicketId = ticketRangeEnd(ticket) + 1;
  }
  return nextTicketId - 1 === soldTickets;
}
