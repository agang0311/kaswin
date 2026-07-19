/**
 * Pure page eligibility rules. Keeping these rules independent from React and
 * RPC state makes every enabled action auditable and straightforward to test.
 */
export type RoundSourceTab = "create" | "history";
export type RoundActionTab = "buy" | "payout";

export interface CovenantPageState {
  status: string;
  soldTickets: number;
  minTickets: number;
  creatorPubkey: string;
}

export interface PageStateInput {
  covenant?: CovenantPageState;
  finalized: boolean;
  ticketQuantityIsAvailable: boolean;
  refundAvailable: boolean;
  drawTimeReached: boolean;
  covenantEnabled: boolean;
  walletPublicKey?: string;
  isCreating: boolean;
  isBuying: boolean;
  isFinalizing: boolean;
  isClosingEmpty: boolean;
  isRefunding: boolean;
}

export interface PageEligibility {
  canStartNewRound: boolean;
  canBuy: boolean;
  canDraw: boolean;
  canRefund: boolean;
  canCloseEmpty: boolean;
  canSwitchNetwork: boolean;
}

const terminalStatuses = new Set(["Finalized", "Refunded", "Closed"]);

export function derivePageEligibility(input: PageStateInput): PageEligibility {
  const covenant = input.covenant;
  const busy = input.isCreating || input.isBuying || input.isFinalizing || input.isClosingEmpty || input.isRefunding;
  const hasCovenant = Boolean(covenant);
  const status = covenant?.status;
  const hasSoldTickets = (covenant?.soldTickets ?? 0) > 0;
  const minimumReached = (covenant?.soldTickets ?? 0) >= (covenant?.minTickets ?? 0);
  return {
    canStartNewRound: !hasCovenant || input.finalized || terminalStatuses.has(status ?? ""),
    // The surrounding buy panel also requires a live covenant. This mirrors its
    // existing button policy without making a state transition on render.
    canBuy: Boolean(
      input.covenantEnabled && hasCovenant && !input.finalized && status === "Open" &&
      !input.refundAvailable && input.ticketQuantityIsAvailable && !input.isBuying
    ),
    canDraw: Boolean(
      input.covenantEnabled && hasCovenant && !input.finalized && !input.isFinalizing && input.drawTimeReached &&
      (status === "Open" || status === "Closed") && hasSoldTickets && minimumReached
    ),
    canRefund: Boolean(
      input.covenantEnabled && hasCovenant && !input.finalized && !input.isRefunding && input.refundAvailable && hasSoldTickets &&
      (covenant?.soldTickets ?? 0) < (covenant?.minTickets ?? 0) &&
      status !== "Finalized" && status !== "Refunded"
    ),
    canCloseEmpty: Boolean(
      input.covenantEnabled && hasCovenant && !input.finalized && !input.isClosingEmpty && input.refundAvailable &&
      (status === "Open" || status === "Closed") && !hasSoldTickets
    ),
    canSwitchNetwork: !busy
  };
}
