import assert from "node:assert/strict";
import { createServer } from "vite";

const vite = await createServer({ server: { middlewareMode: true }, appType: "custom" });
try {
  const { derivePageEligibility } = await vite.ssrLoadModule("/src/app/state-machine.ts");
  const base = {
    finalized: false,
    ticketQuantityIsAvailable: true,
    refundAvailable: false,
    drawTimeReached: false,
    covenantEnabled: true,
    walletPublicKey: "creator",
    isCreating: false,
    isBuying: false,
    isFinalizing: false,
    isClosingEmpty: false,
    isRefunding: false
  };

  const active = derivePageEligibility({ ...base, covenant: { status: "Open", soldTickets: 1, minTickets: 5, creatorPubkey: "creator" } });
  assert.equal(active.canStartNewRound, false);
  assert.equal(active.canBuy, true);
  assert.equal(active.canDraw, false);

  const closed = derivePageEligibility({ ...base, covenant: { status: "Closed", soldTickets: 1, minTickets: 5, creatorPubkey: "creator" } });
  assert.equal(closed.canStartNewRound, true);
  assert.equal(closed.canDraw, false);
  assert.equal(closed.canRefund, false);

  const emptyCreator = derivePageEligibility({ ...base, refundAvailable: true, covenant: { status: "Open", soldTickets: 0, minTickets: 5, creatorPubkey: "creator" } });
  assert.equal(emptyCreator.canCloseEmpty, true);
  assert.equal(emptyCreator.canBuy, false);
  assert.equal(emptyCreator.canDraw, false);
  assert.equal(emptyCreator.canRefund, false);

  const emptyOther = derivePageEligibility({ ...base, refundAvailable: true, walletPublicKey: "other", covenant: { status: "Open", soldTickets: 0, minTickets: 5, creatorPubkey: "creator" } });
  assert.equal(emptyOther.canCloseEmpty, true);
  const closedEmpty = derivePageEligibility({ ...base, refundAvailable: true, covenant: { status: "Closed", soldTickets: 0, minTickets: 5, creatorPubkey: "creator" } });
  assert.equal(closedEmpty.canCloseEmpty, true);
  const settledEmpty = derivePageEligibility({ ...base, finalized: true, refundAvailable: true, covenant: { status: "Closed", soldTickets: 0, minTickets: 5, creatorPubkey: "creator" } });
  assert.equal(settledEmpty.canCloseEmpty, false);

  const timedOutSold = derivePageEligibility({ ...base, refundAvailable: true, drawTimeReached: true, covenant: { status: "Open", soldTickets: 1, minTickets: 5, creatorPubkey: "creator" } });
  assert.equal(timedOutSold.canDraw, false);
  assert.equal(timedOutSold.canRefund, true);
  assert.equal(timedOutSold.canBuy, false);
  const timedOutMinimumMet = derivePageEligibility({ ...base, refundAvailable: true, drawTimeReached: true, covenant: { status: "Open", soldTickets: 5, minTickets: 5, creatorPubkey: "creator" } });
  assert.equal(timedOutMinimumMet.canDraw, true);
  assert.equal(timedOutMinimumMet.canRefund, false);
  assert.equal(derivePageEligibility({ ...base, isRefunding: true }).canSwitchNetwork, false);
  console.log("PASS page state machine eligibility");
} finally {
  await vite.close();
}
