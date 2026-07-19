export interface RoundProtocolState {
  maxTickets: number; minTickets: number; maxBatches: number; soldTickets: number; soldBatches: number;
  salesDeadlineDaa: bigint; refundCursor: number; refundBatchCursor: number;
}
export type RoundAction = "buy" | "finalize" | "startRefund" | "closeEmpty";

export function allowedRoundAction(state: RoundProtocolState, currentDaa: bigint, action: RoundAction, ticketCount = 0): boolean {
  const clean = state.refundCursor === 0 && state.refundBatchCursor === 0;
  if (!clean) return false;
  const deadlineReached = currentDaa >= state.salesDeadlineDaa;
  const soldOut = state.soldTickets === state.maxTickets;
  if (action === "buy") return !deadlineReached && !soldOut && Number.isSafeInteger(ticketCount) && ticketCount > 0 && state.soldTickets + ticketCount <= state.maxTickets && state.soldBatches + 1 <= state.maxBatches;
  if (action === "finalize") return state.soldTickets > 0 && (soldOut || (deadlineReached && state.soldTickets >= state.minTickets));
  if (action === "startRefund") return deadlineReached && state.soldTickets > 0 && state.soldTickets < state.minTickets;
  return deadlineReached && state.soldTickets === 0;
}

export function assertRoundState(state: RoundProtocolState): void {
  const integers = [state.maxTickets, state.minTickets, state.maxBatches, state.soldTickets, state.soldBatches, state.refundCursor, state.refundBatchCursor];
  if (!integers.every(Number.isSafeInteger)) throw new Error("Round counters must be safe integers.");
  if (state.maxTickets < 1 || state.maxTickets > 1_000_000 || state.minTickets < 1 || state.minTickets > state.maxTickets) throw new Error("Invalid ticket limits.");
  if (state.maxBatches < 1 || state.maxBatches > 1_000 || state.soldTickets < 0 || state.soldTickets > state.maxTickets || state.soldBatches < 0 || state.soldBatches > state.maxBatches) throw new Error("Invalid batch or sold counters.");
  if (state.salesDeadlineDaa < 0n || state.refundCursor < 0 || state.refundBatchCursor < 0) throw new Error("Invalid deadline or refund cursor.");
}
