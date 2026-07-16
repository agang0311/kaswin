import fs from "node:fs";
import path from "node:path";
import { createServer } from "vite";

const root = process.cwd();

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`PASS ${message}`);
}

const storage = new Map();
globalThis.localStorage = {
  getItem(key) {
    return storage.has(key) ? storage.get(key) : null;
  },
  setItem(key, value) {
    storage.set(key, String(value));
  },
  removeItem(key) {
    storage.delete(key);
  },
  clear() {
    storage.clear();
  }
};

const vite = await createServer({
  root,
  configFile: path.join(root, "vite.config.ts"),
  logLevel: "silent",
  appType: "custom",
  ssr: { noExternal: ["@onekeyfe/kaspa-wasm"] },
  server: { middlewareMode: true }
});

try {
  const indexer = await vite.ssrLoadModule("/src/kaspa/indexer.ts");
  const metadataModule = await vite.ssrLoadModule("/src/raffle/metadata.ts");
  const localRounds = await vite.ssrLoadModule("/src/raffle/local-rounds.ts");
  const ticketRanges = await vite.ssrLoadModule("/src/raffle/tickets.ts");
  const transactionsModule = await vite.ssrLoadModule("/src/kaspa/transactions.ts");
  const covenantModule = await vite.ssrLoadModule("/src/kaspa/covenant.ts");
  const wasmModule = await vite.ssrLoadModule("/src/kaspa/wasm.ts");
  await wasmModule.ensureKaspaWasmReady();

  assert(!indexer.requiresRaffleIndexer(1_000), "rounds with up to 1,000 tickets never require an indexer");
  assert(indexer.requiresRaffleIndexer(1_001), "rounds above 1,000 tickets may require the standalone indexer");
  assert(indexer.requiresRaffleIndexer(1_000_000), "one-million-ticket rounds are indexer-capable");
  assert(indexer.requiresRaffleIndexerProof(1_001, false), "a large round with incomplete local batches requires an indexer proof");
  assert(!indexer.requiresRaffleIndexerProof(1_000_000, true), "even a million-ticket round skips the indexer when local batches are complete");
  assert(!indexer.requiresRaffleIndexerProof(1_000, false), "a small round never requires an indexer proof");
  const partition = indexer.partitionRaffleRoundsByIndexer([
    { roundId: "small", maxTickets: 1_000 },
    { roundId: "large", maxTickets: 1_001 }
  ]);
  assert(partition.direct[0]?.roundId === "small" && partition.indexed[0]?.roundId === "large", "mixed history keeps small rounds independent from large-round indexing");
  assert(ticketRanges.hasCompleteTicketBatchHistory([
    { ticketId: 1, ticketCount: 1_000 }
  ], 1_000, 1), "a 10,000-ticket round with one complete 1,000-ticket purchase can use local proofs");
  assert(!ticketRanges.hasCompleteTicketBatchHistory([
    { ticketId: 1, ticketCount: 100 }
  ], 1_000, 1), "an incomplete local ticket history still requires indexed proofs");

  const metadata = {
    ...metadataModule.createEmptyMetadata("testnet-10"),
    roundId: "cache-round-current",
    createTxId: "11".repeat(32),
    registryAddress: "kaspatest:qregistry",
    treasuryAddress: "kaspatest:pcovenant",
    maxTickets: 1_000,
    covenant: {
      covenantId: "cache-covenant",
      address: "kaspatest:pcovenant",
      txId: "22".repeat(32),
      outputIndex: 0,
      amountSompi: "620000000",
      redeemScriptHex: "00",
      soldTickets: 100,
      potAmount: "3000000000",
      status: "Open",
      ticketRoot: "33".repeat(32),
      ticketFrontier: "00".repeat(640),
      refundCursor: 0,
      creatorPubkey: "44".repeat(32),
      refundAfterDaaScore: "100000",
      soldBatches: 1,
      ticketBatchEnds: [100],
      ticketOwnerPubkeys: ["55".repeat(32)]
    }
  };
  const ticket = {
    appId: "KASPA_RAFFLE_TICKET_V1",
    roundId: metadata.roundId,
    ticketId: 1,
    ticketCount: 100,
    owner: "kaspatest:qparticipant",
    ownerPubkey: "55".repeat(32),
    paidAmount: 30_000_000n,
    ticketTxId: "66".repeat(32)
  };

  const refundArtifact = covenantModule.getRaffleRefundRuntimeArtifact(metadata.contractVersion);
  const refundState = covenantModule.emptyRaffleCovenantState(refundArtifact);
  refundState.ticket_price = 30_000_000n;
  refundState.creator_pubkey = covenantModule.bytes32FromHex("44".repeat(32), "creator public key");
  refundState.sold_tickets = 13n;
  refundState.sold_batches = 13n;
  refundState.ticket_root = covenantModule.bytes32FromHex("33".repeat(32), "ticket root");
  refundState.refund_cursor = 0n;
  refundState.refund_batch_cursor = 0n;
  const refundRedeemScript = covenantModule.buildRaffleRedeemScript(refundState, refundArtifact);
  const groupedSignatureScript = covenantModule.buildRaffleRefundBatchSignatureScript(
    refundRedeemScript,
    47_000_000n,
    Array.from({ length: 13 }, (_, index) => ({
      ownerPubkeyHex: "55".repeat(32),
      firstTicketId: index,
      ticketCount: 1,
      ownerProofHex: "00".repeat(640)
    }))
  );
  assert(groupedSignatureScript.length / 2 > 13 * 640, "the browser packs 13 owner proofs into one grouped-refund signature script");

  localRounds.cacheParticipatedRound(metadata, [ticket]);
  const restored = localRounds.loadCachedRound("testnet-10", metadata.roundId);
  assert(restored?.tickets.length === 1 && restored.tickets[0].ticketCount === 100, "a decimal-scale purchase round-trips through browser storage");
  assert(restored?.tickets[0].paidAmount === 30_000_000n, "cached ticket amounts restore as exact bigint values");

  const currentHistory = localRounds.loadCachedRaffleHistory("testnet-10");
  assert(currentHistory.length === 1 && currentHistory[0].soldTickets === 100, "cached participated rounds load back into raffle history");
  assert(currentHistory[0].localCachedAt > 0, "cached history identifies rounds saved in this browser");
  assert(localRounds.hasCachedParticipatedRound("testnet-10", metadata.roundId), "participated rounds can be detected without loading network history");
  localRounds.updateCachedParticipatedRoundFromHistory("testnet-10", {
    ...currentHistory[0],
    latestCovenant: undefined,
    payouts: [{
      txId: "77".repeat(32),
      winnerTicketId: 1,
      winnerAddress: ticket.owner,
      amount: 3_000_000_000n
    }]
  });
  const paidHistory = localRounds.loadCachedRaffleHistory("testnet-10")[0];
  assert(paidHistory.payouts[0]?.txId === "77".repeat(32) && !paidHistory.latestCovenant, "network payout results update the participated-round cache");
  assert(!localRounds.loadCachedRound("testnet-10", metadata.roundId)?.metadata.covenant, "a synchronized terminal round cannot restore a stale live covenant");

  const storageKey = "kaspa-raffle-participated-rounds-v12";
  const storedRounds = JSON.parse(storage.get(storageKey));
  storedRounds.push({
    ...storedRounds[0],
    metadata: {
      ...storedRounds[0].metadata,
      roundId: "supported-v14-round",
      contractVersion: "raffle-v14-batch-range"
    }
  });
  storage.set(storageKey, JSON.stringify(storedRounds));
  assert(localRounds.loadCachedRaffleHistory("testnet-10").length === 2, "v14 cached rounds remain loadable after the v15 upgrade");
  assert(
    metadataModule.parseMetadata(JSON.stringify({ ...metadata, covenant: undefined, contractVersion: "raffle-v14-batch-range" })).contractVersion === "raffle-v14-batch-range",
    "v14 imported metadata remains supported"
  );
  storedRounds.push({
    ...storedRounds[0],
    metadata: {
      ...storedRounds[0].metadata,
      roundId: "unsupported-legacy-round",
      contractVersion: "raffle-v10-chain-pow-tn12"
    }
  });
  storage.set(storageKey, JSON.stringify(storedRounds));
  assert(localRounds.loadCachedRaffleHistory("testnet-10").length === 2, "unsupported legacy cached contracts are not loaded");

  let rejectedLegacyMetadata = false;
  try {
    metadataModule.parseMetadata(JSON.stringify({ ...metadata, covenant: undefined, contractVersion: "raffle-v10-chain-pow-tn12" }));
  } catch {
    rejectedLegacyMetadata = true;
  }
  assert(rejectedLegacyMetadata, "legacy imported metadata is rejected");

  const app = fs.readFileSync(path.join(root, "src/app/App.tsx"), "utf8");
  const rpc = fs.readFileSync(path.join(root, "src/kaspa/rpc.ts"), "utf8");
  const networks = fs.readFileSync(path.join(root, "src/kaspa/networks.ts"), "utf8");
  const localWallet = fs.readFileSync(path.join(root, "src/kaspa/wallet-local-test.ts"), "utf8");
  const transactions = fs.readFileSync(path.join(root, "src/kaspa/transactions.ts"), "utf8");
  const history = fs.readFileSync(path.join(root, "src/kaspa/history.ts"), "utf8");
  const roundContract = fs.readFileSync(path.join(root, "src/contracts/raffle_round_v12.sil"), "utf8");
  const refundContract = fs.readFileSync(path.join(root, "src/contracts/raffle_refund_v3.sil"), "utf8");
  const merkle = fs.readFileSync(path.join(root, "src/raffle/merkle.ts"), "utf8");
  const viteConfig = fs.readFileSync(path.join(root, "vite.config.ts"), "utf8");
  assert(app.includes("<input value={indexApiBase}") && app.includes("localStorage.setItem(INDEX_ENDPOINTS_STORAGE_KEY"), "the web app exposes and persists a configurable indexer URL");
  assert(networks.includes('defaultRpcMode: "resolver"') && rpc.includes("new Resolver().getUrl(Encoding.Borsh, network)"), "network connections default to the Kaspa resolver");
  assert(!rpc.includes("resolver: new Resolver()"), "resolver connections resolve a URL before creating the RPC client");
  assert(app.includes('mode: "custom", url: validateRpcUrl(networkEndpointDraft)') && app.includes("endpointSummary(networkEndpoints[profile.id])"), "users can override resolver routing with a custom wRPC node");
  assert(networks.includes('label: "Testnet 10"') && app.includes("TN10") && !app.includes(`TN${12}`), "the browser labels the live test network as Testnet 10");
  assert(app.includes('useState<RaffleHistoryRound[]>(() => loadCachedRaffleHistory("testnet-10"))'), "browser startup immediately restores participated rounds into history");
  assert(app.includes("selectedHistoryRound.latestCovenant || selectedHistoryRound.localCachedAt"), "locally saved rounds remain loadable after finalization or an API outage");
  assert(app.includes('!registryAddresses.size && !byRoundId.size'), "browser history can load local participated rounds without a registry address");
  assert(app.includes("updateCachedParticipatedRoundFromHistory(networkId, historyRound)"), "refreshed network outcomes are written back to participated-round storage");
  assert(app.includes("if (cachedRound.registryAddress) registryAddresses.add(cachedRound.registryAddress)"), "history refresh follows every registry address saved with participated rounds");
  assert(app.includes("needsIndexer") && app.includes("? await Promise.allSettled([loadIndexedRaffleHistory(indexApiBase)])"), "history only contacts the indexer when a loaded round exceeds the threshold");
  assert(!app.includes("byRoundId.delete(historyRound.roundId)"), "an unavailable index never removes a registry-discovered large round from history");
  assert(app.includes("without index proofs") && app.includes("historyRound.latestCovenant ?? cachedRound.latestCovenant"), "large history remains visible and keeps its cached live covenant when index proofs are unavailable");
  assert(app.includes("requiresRaffleIndexerProof(metadata.maxTickets, hasCompleteLocalHistory)"), "large rounds use complete local batch history before contacting an indexer for draw or refund proofs");
  assert(app.includes("selectedHistoryRoundRequiresIndexer ? renderIndexerRequirement") && app.includes("activeRoundNeedsIndexer && metadata.covenant ? renderIndexerRequirement"), "history and payout views show indexer configuration exactly when proof data is missing");
  assert(app.includes("await requireReadyIndexer()") && app.includes("checkRaffleIndexer(indexApiBase)"), "draw and refund verify the configured indexer before changing covenant state");
  assert(app.includes("historyRoundNeedsIndexer") && app.includes("roundsNeedingIndexer"), "history only requests indexed details for rounds with incomplete local batches");
  assert(transactions.includes("nextRound.soldTickets === input.round.maxTickets") && transactions.includes("input.covenant.chainSearchHintHash ?? currentChainHash"), "ticket purchases preserve the creation anchor until a round sells out");
  assert(history.includes("transaction.accepting_block_hash ?? transaction.block_hash?.[0]") && app.includes("loadTransactionChainAnchor(historyApiBase, metadata.createTxId)"), "legacy rounds recover an early selected-chain anchor from their creation transaction");
  assert(history.includes("blueScoreLt=${probe + 1n}") && history.includes("blueScoreGte=${cursor}") && app.includes("anchorHeader.blueScore + targetBoundaryDaa - anchorHeader.daaScore"), "draw lookup calibrates and corrects a bounded target blue-score search from the creation block");
  assert(merkle.includes("MAX_TICKET_BATCH_SIZE = 1_000_000") && app.includes('type="number"') && app.includes("ticketCount: quantity"), "the wallet UI accepts any positive whole-number ticket quantity up to the round remainder");
  assert(app.includes("disabled={isBuying || Boolean(finalized) || !ticketQuantityIsAvailable}"), "the wallet blocks a non-positive, fractional, or oversized quantity before signing");
  assert(localWallet.includes("new URLSearchParams({ wallet: input.wallet, network })") && viteConfig.includes('"experiment-mainnet.json"'), "the development wallet can run the same flow against Mainnet once funded");
  assert(roundContract.includes("require(ticket_count > 0)") && !roundContract.includes("ticket_count == 100000"), "the covenant validates arbitrary positive purchase quantities");
  assert(roundContract.includes("ticket_price * ticket_count"), "the covenant charges the exact multi-ticket amount");
  assert(roundContract.includes("sold_batches: sold_batches + 1"), "one purchase appends one on-chain batch regardless of ticket count");
  assert(refundContract.includes("MAX_BATCHES_PER_TX = 13") && app.includes("MAX_REFUND_PURCHASE_BATCHES_PER_TX"), "refunds automatically group the maximum safe 13 consecutive purchase batches");
  assert(app.includes("shouldShrinkRefundBatch") && app.includes("storage[- ]mass") && app.includes("candidateBatches.slice(0, -1)"), "the browser shrinks a 13-batch candidate until compute and storage mass are standard");
  assert(transactions.includes("refundBatchComputeBudget") && transactions.includes("verifiedBatches.map"), "grouped refunds commit a batch-sized compute budget and build every owner output");
  assert(transactions.includes("calculateTransactionFee") && transactions.includes("minimumV1TransientRelayFeeSompi"), "finalize fees include static and normalized transient mass");
  assert(transactions.includes("requiredFeeFromNodeRejection") && transactions.includes("nodeRequiredFee"), "covenant spends retry with the node's exact compute-mass fee floor");
  assert(
    transactions.includes("const sponsorUtxos: IUtxoEntry[] = []") &&
      transactions.includes("retryRequiredFee") &&
      transactions.includes("sponsorUtxos.map((_, index) => index + 1)"),
    "legacy fixed-fee refunds keep adding signed sponsor inputs until the node fee floor is met"
  );
  assert(transactions.includes("buildRefundTransaction(refundFeeSompi, false)") && transactions.includes("Measure an unbound twin"), "refund mass uses an unbound twin before rebuilding the successor covenant");
  assert(
    transactions.includes("submitTransaction({ transaction: tx, allowOrphan: false })") &&
      transactions.includes('if (output.covenant && typeof output.covenant === "object") return output;') &&
      transactions.includes("typeof covenantId === \"string\""),
    "RPC submissions preserve bound hex ids and omit absent mixed-output bindings"
  );
  const rpcShape = transactionsModule.rpcTransactionObjectForSubmit({
    version: 1,
    inputs: [{
      transactionId: "11".repeat(32),
      index: 0,
      utxo: { covenantId: null, amount: 100n }
    }],
    outputs: [
      { value: 50n, covenant: { authorizingInput: 0, covenantId: "22".repeat(32) } },
      { value: 50n, covenant: null }
    ]
  });
  assert(
    rpcShape.outputs[0].covenant.covenantId === "22".repeat(32) &&
      !("covenant" in rpcShape.outputs[1]) &&
      !("covenantId" in rpcShape.inputs[0].utxo) &&
      rpcShape.inputs[0].previousOutpoint.transactionId === "11".repeat(32),
    "mixed covenant RPC fallback keeps the bound output and strips only absent bindings"
  );
} finally {
  await vite.close();
  delete globalThis.localStorage;
}

console.log("Web requirement checks passed.");
