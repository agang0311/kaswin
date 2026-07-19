import assert from "node:assert/strict";
import { createServer } from "vite";

const vite = await createServer({ root: process.cwd(), configFile: "vite.config.ts", logLevel: "silent", appType: "custom", server: { middlewareMode: true } });
function pass(message) { console.log(`PASS ${message}`); }

try {
  const manifestModule = await vite.ssrLoadModule("/src/protocol/manifest.ts");
  const metadata = await vite.ssrLoadModule("/src/protocol/metadata.ts");
  const state = await vite.ssrLoadModule("/src/protocol/state.ts");
  const fees = await vite.ssrLoadModule("/src/protocol/fees.ts");
  const merkle = await vite.ssrLoadModule("/src/protocol/merkle.ts");
  const randomness = await vite.ssrLoadModule("/src/protocol/randomness.ts");

  assert.equal(manifestModule.PROTOCOL_MANIFEST.protocolVersion, "raffle-vnext-liveness-guard-b1000");
  assert.equal(manifestModule.PROTOCOL_MANIFEST.artifactStatus, "compiled");
  assert.match(manifestModule.PROTOCOL_MANIFEST.roundArtifactSha256, /^[0-9a-f]{64}$/);
  assert.match(manifestModule.PROTOCOL_MANIFEST.refundArtifactSha256, /^[0-9a-f]{64}$/);
  assert.equal(manifestModule.PROTOCOL_MANIFEST.defaultMaxBatches, 100);
  assert.equal(manifestModule.PROTOCOL_MANIFEST.maxRelaySafePurchaseBatches, 1_000);
  assert.equal(manifestModule.PROTOCOL_MANIFEST.recommendedSecondsPerPurchaseBatch, 6);
  assert.equal(manifestModule.PROTOCOL_MANIFEST.minimumTicketPriceSompi, "100000000");
  pass("manifest validates the frozen Phase 0 constants and compiled Phase 2 artifact commitments");

  const base = { maxTickets: 100, minTickets: 10, maxBatches: 20, soldTickets: 9, soldBatches: 2, salesDeadlineDaa: 1000n, refundCursor: 0, refundBatchCursor: 0 };
  state.assertRoundState(base);
  state.assertRoundState({ ...base, maxTickets: 1_000, maxBatches: 1_000, soldTickets: 1_000, soldBatches: 1_000 });
  assert.throws(() => state.assertRoundState({ ...base, maxTickets: 1_001, maxBatches: 1_001 }));
  assert.equal(state.allowedRoundAction(base, 999n, "buy", 37), true);
  assert.equal(state.allowedRoundAction(base, 999n, "finalize"), false);
  assert.equal(state.allowedRoundAction(base, 1000n, "startRefund"), true);
  assert.equal(state.allowedRoundAction({ ...base, soldTickets: 10 }, 1000n, "finalize"), true);
  assert.equal(state.allowedRoundAction({ ...base, soldTickets: 10 }, 1000n, "startRefund"), false);
  assert.equal(state.allowedRoundAction({ ...base, soldTickets: 100 }, 900n, "finalize"), true);
  assert.equal(state.allowedRoundAction({ ...base, soldTickets: 0, soldBatches: 0 }, 1000n, "closeEmpty"), true);
  assert.equal(state.allowedRoundAction({ ...base, refundCursor: 1 }, 1000n, "finalize"), false);
  pass("state transition behavior makes finalize, refund, buy, and empty close mutually exclusive");

  const nonce = "11".repeat(32);
  const records = Array.from({ length: 24 }, (_, index) => ({ roundNonceHex: nonce, ownerPubkeyHex: (index + 1).toString(16).padStart(2, "0").repeat(32), firstTicketId: index * (index + 1) / 2, ticketCount: index + 1 }));
  let frontier = "00".repeat(640);
  for (let count = 1; count <= records.length; count += 1) {
    const appended = await merkle.appendBatch(frontier, count - 1, records[count - 1]);
    frontier = appended.frontierHex;
    const complete = await merkle.buildBatchProof(records.slice(0, count), count - 1);
    assert.equal(appended.rootHex, complete.rootHex);
    assert.equal(await merkle.rootFromBatchProof(records[count - 1], count - 1, complete.proofHex), complete.rootHex);
  }
  const proof = await merkle.buildBatchProof(records, 7);
  const changed = `${proof.proofHex[0] === "0" ? "1" : "0"}${proof.proofHex.slice(1)}`;
  assert.equal(await merkle.verifyBatchProof(proof.rootHex, records[7], 7, changed), false);
  const otherRound = { ...records[7], roundNonceHex: "22".repeat(32) };
  assert.notEqual(Buffer.from(await merkle.batchLeaf(records[7].roundNonceHex, records[7].ownerPubkeyHex, records[7].firstTicketId, records[7].ticketCount)).toString("hex"), Buffer.from(await merkle.batchLeaf(otherRound.roundNonceHex, otherRound.ownerPubkeyHex, otherRound.firstTicketId, otherRound.ticketCount)).toString("hex"));
  const hardLimitRecords = Array.from({ length: 1_000 }, (_, index) => ({
    roundNonceHex: nonce,
    ownerPubkeyHex: (index + 1).toString(16).padStart(64, "0"),
    firstTicketId: index,
    ticketCount: 1
  }));
  const hardLimitProof = await merkle.buildBatchProof(hardLimitRecords, 999);
  assert.equal(await merkle.rootFromBatchProof(hardLimitRecords[999], 999, hardLimitProof.proofHex), hardLimitProof.rootHex);
  await merkle.appendBatch("00".repeat(640), 999, hardLimitRecords[999]);
  await assert.rejects(() => merkle.appendBatch("00".repeat(640), 1_000, {
    roundNonceHex: nonce,
    ownerPubkeyHex: "ff".repeat(32),
    firstTicketId: 1_000,
    ticketCount: 1
  }));
  pass("domain-separated Merkle append reaches the 1,000-batch hard limit, rejects batch 1,001, and one-bit proof changes fail");

  for (let sold = 1; sold <= 1_000_000; sold = sold < 10 ? sold + 1 : sold * 10) {
    const winner = await randomness.deriveWinner(nonce, proof.rootHex, "33".repeat(32), "44".repeat(32), sold);
    assert.ok(winner.winnerTicketId >= 0 && winner.winnerTicketId < sold);
  }
  const seedA = await randomness.deriveDrawSeed(nonce, proof.rootHex, "33".repeat(32), "44".repeat(32));
  const seedB = await randomness.deriveDrawSeed("12".repeat(32), proof.rootHex, "33".repeat(32), "44".repeat(32));
  assert.notDeepEqual(seedA, seedB);
  assert.equal(randomness.drawRandomnessBaseDaaScore({ covenantDaaScore: 900n, salesDeadlineDaaScore: 1000n, soldTickets: 9, maxTickets: 100 }), 1000n);
  assert.equal(randomness.drawRandomnessBaseDaaScore({ covenantDaaScore: 900n, salesDeadlineDaaScore: 1000n, soldTickets: 100, maxTickets: 100 }), 900n);
  assert.equal(randomness.drawRandomnessBaseDaaScore({ covenantDaaScore: 1001n, salesDeadlineDaaScore: 1000n, soldTickets: 10, maxTickets: 100 }), 1001n);
  pass("56-bit rejection sampling is bounded and draw seeds are round-domain separated");

  // Keep this deterministic and broad enough to meet the validation spec's
  // randomized-conservation target without relying on a UI or RPC fixture.
  // The varying price, batch sizes, carried principal and fee cover 10,000
  // distinct integer conservation shapes.
  for (let iteration = 1; iteration <= 10_000; iteration += 1) {
    const price = 100_000_000n + BigInt(iteration * 997);
    const counts = [iteration % 13 + 1, iteration % 7 + 1];
    const principals = counts.map((count) => fees.buyerRefundPrincipal(price, count));
    const remaining = price * BigInt(iteration % 101);
    const fee = BigInt(iteration % 20_000_000 + 1);
    const debt = BigInt(iteration % 20_000_001);
    const carrier = 57_300_000n;
    const current = principals.reduce((sum, value) => sum + value, 0n) + remaining + carrier - debt;
    const owners = fees.vNextRefundOwnerValues(principals, fee, debt, 20_000_000n);
    const successor = fees.vNextSuccessorRefundValue(current, principals, debt, remaining);
    assert.equal(successor, remaining + carrier);
    assert.equal(owners.reduce((sum, value) => sum + value, 0n) + successor + fee, current);
  }
  assert.throws(() => fees.vNextRefundOwnerValues([39_999_999n], 20_000_000n, 20_000_000n, 20_000_000n));
  assert.equal(fees.estimateWorstCaseRefundReserve({ maxBatches: 500, transitionFeeSompi: 10n, refundFeePerTransactionSompi: 20n, finalizationFeeSompi: 30n, safetyMarginSompi: 40n }), 860n);
  pass("10,000 deterministic buyer-funded refund cases conserve value, restore transition debt, and preserve carrier");

  const validMetadata = { app: "kaspa-raffle-static", metadataSchema: 2, createdByAppVersion: "0.9.13", network: "testnet-10", protocolVersion: "raffle-vnext-liveness-guard-b1000", roundContract: "RaffleRoundVNext", refundContract: "RaffleRefundVNext", roundArtifactSha256: manifestModule.PROTOCOL_MANIFEST.roundArtifactSha256, refundArtifactSha256: manifestModule.PROTOCOL_MANIFEST.refundArtifactSha256, roundNonce: nonce, roundId: "55".repeat(32), createTxId: "66".repeat(32), covenantId: "77".repeat(32), creatorAddress: "kaspatest:q", creatorPubkey: "88".repeat(32), ticketPriceSompi: "100000000", maxTickets: 10000, minTickets: 1000, maxBatches: 100, salesDeadlineDaa: "123456789", randomDelayDaa: "30", registryAddress: "kaspatest:r", feePolicy: { refundNetworkFees: "deduct-from-ticket-payments", carrierSompi: "57300000" } };
  const parsed = metadata.parseMetadataV2(JSON.stringify(validMetadata));
  assert.equal(metadata.metadataCompatibility(parsed), "native");
  assert.deepEqual(metadata.parseMetadataV2(JSON.stringify(parsed)), parsed);
  assert.equal(metadata.parseMetadataV2(JSON.stringify({ ...validMetadata, maxBatches: 1_000 })).maxBatches, 1_000);
  const malformed = [null, [], {}, { ...validMetadata, metadataSchema: 3 }, { ...validMetadata, ticketPriceSompi: 1 }, { ...validMetadata, ticketPriceSompi: "99999999" }, { ...validMetadata, ticketPriceSompi: "4611686018427388", maxTickets: 1000 }, { ...validMetadata, salesDeadlineDaa: "01" }, { ...validMetadata, minTickets: 10001 }, { ...validMetadata, maxBatches: 1_001 }, { ...validMetadata, feePolicy: { refundNetworkFees: "carrier-paid", carrierSompi: "1" } }, { ...validMetadata, feePolicy: { refundNetworkFees: "deduct-from-ticket-payments", carrierSompi: "19999999" } }];
  for (const value of malformed) assert.throws(() => metadata.parseMetadataV2(value));
  pass("Metadata V2 round-trips BigInt strings and rejects malformed or unknown schemas");
} finally {
  await vite.close();
}

console.log("vNext Phase 0/1 behavior and property checks passed.");
