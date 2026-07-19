import type { SigningConfirmationPreview, SigningOperation } from "./components/SigningConfirmationDialog";

export type SigningConfirmationStatus = "idle" | "review" | "stale";

export interface SigningConfirmationState {
  status: SigningConfirmationStatus;
  preview: SigningConfirmationPreview | null;
}

export type SigningConfirmationDecision =
  | { kind: "none"; state: SigningConfirmationState }
  | { kind: "execute"; operation: SigningOperation; state: SigningConfirmationState }
  | { kind: "stale"; state: SigningConfirmationState };

const requiredPreviewFields: Array<keyof Omit<SigningConfirmationPreview, "operation" | "snapshot">> = [
  "network", "address", "inputCount", "payment", "fee", "carrier", "change", "covenant", "registry", "ticketRange"
];

export const idleSigningConfirmationState: SigningConfirmationState = Object.freeze({ status: "idle", preview: null });

export function buySnapshot(input: { roundId: string; covenantTxId: string; soldTickets: number; ticketCount: number; ticketPriceSompi: string; refundAfterDaaScore: string }): string {
  return [input.roundId, input.covenantTxId, input.soldTickets, input.ticketCount, input.ticketPriceSompi, input.refundAfterDaaScore].join(":");
}

export function carrierTopUpSnapshot(input: { roundId: string; covenantTxId: string; amountSompi: string }): string {
  return [input.roundId, input.covenantTxId, input.amountSompi].join(":");
}

export function registrySnapshot(input: { roundId: string; createTxId: string; registryAddress: string }): string {
  return [input.roundId, input.createTxId, input.registryAddress].join(":");
}

export function buildSigningPreview(input: Omit<SigningConfirmationPreview, "operation"> & { operation: SigningOperation }): SigningConfirmationPreview {
  // Copy every field so later UI state mutations cannot silently alter the
  // details that the user reviewed.
  return Object.freeze({ ...input });
}

export function openSigningConfirmation(preview: SigningConfirmationPreview): SigningConfirmationState {
  for (const field of requiredPreviewFields) {
    if (!preview[field]?.trim()) throw new Error(`Signing confirmation preview is missing ${field}.`);
  }
  return Object.freeze({ status: "review", preview: buildSigningPreview(preview) });
}

export function cancelSigningConfirmation(): SigningConfirmationState {
  return idleSigningConfirmationState;
}

/**
 * A stale state-changing preview is terminal: it returns no executable operation, so a
 * caller cannot silently recreate a wallet request with changed state.
 */
export function decideSigningConfirmation(
  state: SigningConfirmationState,
  currentSnapshot?: string
): SigningConfirmationDecision {
  const preview = state.preview;
  if (state.status !== "review" || !preview) return { kind: "none", state };
  if (
    (preview.operation === "buy" || preview.operation === "top-up-carrier" || preview.operation === "publish-registry") &&
    (!preview.snapshot || preview.snapshot !== currentSnapshot)
  ) {
    return { kind: "stale", state: Object.freeze({ status: "stale", preview: null }) };
  }
  return { kind: "execute", operation: preview.operation, state };
}
