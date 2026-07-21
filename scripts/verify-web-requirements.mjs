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
  const i18nModule = await vite.ssrLoadModule("/src/app/i18n.ts");
  const historyMergeModule = await vite.ssrLoadModule("/src/raffle/history-merge.ts");
  const historyModule = await vite.ssrLoadModule("/src/kaspa/history.ts");
  const metadataModule = await vite.ssrLoadModule("/src/raffle/metadata.ts");
  const localRounds = await vite.ssrLoadModule("/src/raffle/local-rounds.ts");
  const raffleState = await vite.ssrLoadModule("/src/raffle/state.ts");
  const ticketRanges = await vite.ssrLoadModule("/src/raffle/tickets.ts");
  const transactionsModule = await vite.ssrLoadModule("/src/kaspa/transactions.ts");
  const protocolMerkle = await vite.ssrLoadModule("/src/protocol/merkle.ts");
  const protocolManifest = await vite.ssrLoadModule("/src/protocol/manifest.ts");
  const walletTypesModule = await vite.ssrLoadModule("/src/kaspa/wallet-types.ts");
  const covenantModule = await vite.ssrLoadModule("/src/kaspa/covenant.ts");
  const wasmModule = await vite.ssrLoadModule("/src/kaspa/wasm.ts");
  await wasmModule.ensureKaspaWasmReady();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify([
    {
      transaction_id: "91".repeat(32),
      is_accepted: true,
      inputs: [{ previous_outpoint_hash: "71".repeat(32), previous_outpoint_index: "0" }],
      outputs: [{ index: 0, amount: "19000000", script_public_key_address: "kaspatest:qcreator" }]
    },
    {
      transaction_id: "92".repeat(32),
      is_accepted: false,
      inputs: [{ previous_outpoint_hash: "72".repeat(32), previous_outpoint_index: "0" }],
      outputs: []
    }
  ]), { status: 200, headers: { "content-type": "application/json" } });
  const recoveredMarkerSpend = await historyModule.loadAcceptedOutpointSpend(
    "https://history.example",
    "kaspatest:pregistry",
    "71".repeat(32),
    0
  );
  const rejectedMarkerSpend = await historyModule.loadAcceptedOutpointSpend(
    "https://history.example",
    "kaspatest:pregistry",
    "72".repeat(32),
    0
  );
  globalThis.fetch = originalFetch;
  assert(
    recoveredMarkerSpend?.transactionId === "91".repeat(32) &&
      recoveredMarkerSpend.outputs[0]?.amount === 19_000_000n &&
      recoveredMarkerSpend.outputs[0]?.address === "kaspatest:qcreator" &&
      rejectedMarkerSpend === undefined,
    "Registry marker recovery finds only an accepted exact outpoint spend and preserves bigint output values"
  );

  const isolatedRegistry = await transactionsModule.getRaffleRegistryConfig("testnet-10");
  const mainnetRegistry = await transactionsModule.getRaffleRegistryConfig("mainnet");
  assert(
    isolatedRegistry.autoRefund &&
      mainnetRegistry.autoRefund &&
      isolatedRegistry.address.startsWith("kaspatest:") &&
      mainnetRegistry.address.startsWith("kaspa:") &&
      isolatedRegistry.address !== "kaspatest:pr89wgtzs5f9qphvrqvhhkqcggsua7j4nwc8npqsmxd9hwjmqlx36gz5l6t4g",
    "Mainnet and Testnet use network-specific Kaswin registries with the same automatic 0.19 KAS return policy"
  );

  const createSpentOutpoint = { transactionId: "a1".repeat(32), index: 1 };
  const independentOutpoint = { transactionId: "b2".repeat(32), index: 0 };
  const registryCandidates = transactionsModule.excludeUtxoEntries([
    { outpoint: createSpentOutpoint },
    { outpoint: independentOutpoint }
  ], [{ transactionId: createSpentOutpoint.transactionId.toUpperCase(), index: 1 }]);
  assert(
    registryCandidates.length === 1 &&
      registryCandidates[0].outpoint.transactionId === independentOutpoint.transactionId,
    "Registry wallet selection excludes every Create input even when a stale RPC UTXO view still reports it as confirmed"
  );

  assert(!indexer.requiresRaffleIndexer(1_000), "rounds with up to 1,000 tickets never require an indexer");
  assert(
    i18nModule.translateRuntimeText("zh", "Loaded 6 raffle rounds. No raffle index was needed.") ===
      "已加载 6 轮抽奖。 本次无需抽奖索引服务。",
    "compound history success messages follow the selected page language"
  );
  assert(
    i18nModule.translateRuntimeText("zh", "Restored round-example from this browser.") ===
      "已从本浏览器恢复 round-example。",
    "browser-restore messages follow the selected page language"
  );
  assert(
    i18nModule.translateRuntimeText(
      "zh",
      "The Kaspa node rejected the transaction. Rejected transaction: policy failure No retry or replacement signing request was opened automatically; verify the locally computed transaction id and refresh chain state before retrying."
    ).includes("页面没有自动重试或发起替代签名"),
    "node-rejection recovery messages follow the selected page language"
  );
  const completeHistoryTickets = [
    { txId: "01".repeat(32), ticketId: 1, ticketCount: 2, buyer: "buyer-a", buyerPubkey: "11".repeat(32), paidAmount: 200_000_000n },
    { txId: "02".repeat(32), ticketId: 3, ticketCount: 1, buyer: "buyer-b", buyerPubkey: "22".repeat(32), paidAmount: 100_000_000n },
    { txId: "03".repeat(32), ticketId: 4, ticketCount: 1, buyer: "buyer-c", buyerPubkey: "33".repeat(32), paidAmount: 100_000_000n }
  ];
  assert(
    historyMergeModule.preferMoreCompleteRaffleHistoryTickets(
      completeHistoryTickets,
      completeHistoryTickets.slice(0, 2)
    ).length === 3,
    "a partial History response cannot erase a locally observed purchase batch"
  );
  assert(
    historyMergeModule.preferMoreCompleteRaffleHistoryTickets(
      completeHistoryTickets.slice(0, 2),
      completeHistoryTickets
    ).length === 3,
    "a longer History response can extend an identical committed prefix"
  );
  const currentCursor = {
    covenantId: "cursor",
    address: "kaspatest:pcursor",
    txId: "44".repeat(32),
    outputIndex: 0,
    amountSompi: "457300000",
    redeemScriptHex: "00",
    soldTickets: 4,
    potAmount: "400000000",
    status: "Open",
    ticketRoot: "55".repeat(32),
    ticketFrontier: "00".repeat(640),
    refundCursor: 0,
    refundBatchCursor: 0,
    creatorPubkey: "66".repeat(32),
    refundAfterDaaScore: "1000",
    soldBatches: 3,
    ticketBatchEnds: [2, 3, 4],
    ticketOwnerPubkeys: ["11".repeat(32), "22".repeat(32), "33".repeat(32)]
  };
  assert(
    historyMergeModule.preferAdvancedRaffleCovenant(
      currentCursor,
      { ...currentCursor, txId: "77".repeat(32), soldTickets: 3, potAmount: "300000000" }
    )?.txId === currentCursor.txId,
    "a stale service cursor cannot roll back the locally observed covenant state"
  );
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
      amountSompi: "10057300000",
      redeemScriptHex: "00",
      soldTickets: 100,
      potAmount: "10000000000",
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
    paidAmount: 100_000_000n,
    ticketTxId: "66".repeat(32)
  };

  const refundedRound = {
    appId: "KASPA_RAFFLE_ROUND_V1",
    contractVersion: metadata.contractVersion,
    roundId: metadata.roundId,
    creator: "kaspatest:qcreator",
    ticketPrice: 100_000_000n,
    maxTickets: 1_000,
    minTickets: 200,
    soldTickets: 100,
    potAmount: 0n,
    feeBps: 0,
    status: "Refunded",
    randomnessMode: "kaspa-chain-pow",
    creatorPubkey: "44".repeat(32),
    refundAfterDaaScore: "100000",
    ticketRoot: "33".repeat(32),
    refundCursor: 100,
    refundBatchCursor: 1,
    soldBatches: 1,
    ticketBatchEnds: [100],
    ticketOwnerPubkeys: ["55".repeat(32)]
  };
  assert(
    raffleState.verifyRaffleState({ round: refundedRound, tickets: [ticket] }).ok,
    "a fully refunded terminal round validates with zero remaining prize principal"
  );
  assert(
    !raffleState.verifyRaffleState({ round: { ...refundedRound, refundCursor: 99 }, tickets: [ticket] }).ok,
    "a refunded terminal round cannot claim completion with an unfinished cursor"
  );
  const closedEmptyRound = {
    ...refundedRound,
    soldTickets: 0,
    minTickets: 1,
    potAmount: 0n,
    status: "Closed",
    refundCursor: 0,
    refundBatchCursor: 0,
    soldBatches: 0,
    ticketBatchEnds: [],
    ticketOwnerPubkeys: []
  };
  const closedEmptyVerification = raffleState.verifyRaffleState({
    round: closedEmptyRound,
    tickets: []
  });
  assert(
    closedEmptyVerification.ok && closedEmptyVerification.warnings.length === 0,
    "a publicly closed empty round validates as a terminal zero-principal state without a false refund warning"
  );

  const refundArtifact = covenantModule.getRaffleRefundRuntimeArtifact(metadata.contractVersion);
  const refundState = covenantModule.emptyRaffleCovenantState(refundArtifact);
  refundState.ticket_price = 100_000_000n;
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

  const archivedArtifact = covenantModule.getRaffleRuntimeArtifact("raffle-vnext-buyer-funded-refund");
  const archivedRedeemScript = covenantModule.buildRaffleRedeemScript(
    covenantModule.emptyRaffleCovenantState(archivedArtifact),
    archivedArtifact
  );
  let rejectedArtifactMasquerade = false;
  try {
    await covenantModule.assertRaffleRedeemScriptMatchesRound(
      { contractVersion: metadata.contractVersion, status: "Open" },
      covenantModule.bytesToHex(archivedRedeemScript),
      "Version masquerade test"
    );
  } catch {
    rejectedArtifactMasquerade = true;
  }
  assert(rejectedArtifactMasquerade, "an archived artifact cannot masquerade under the current protocol id");

  localRounds.cacheParticipatedRound(metadata, [ticket]);
  const restored = localRounds.loadCachedRound("testnet-10", metadata.roundId);
  assert(restored?.tickets.length === 1 && restored.tickets[0].ticketCount === 100, "a decimal-scale purchase round-trips through browser storage");
  assert(restored?.tickets[0].paidAmount === 100_000_000n, "cached ticket amounts restore as exact bigint values");

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
      amount: 10_000_000_000n
    }]
  });
  const paidHistory = localRounds.loadCachedRaffleHistory("testnet-10")[0];
  assert(paidHistory.payouts[0]?.txId === "77".repeat(32) && !paidHistory.latestCovenant, "network payout results update the participated-round cache");
  assert(!localRounds.loadCachedRound("testnet-10", metadata.roundId)?.metadata.covenant, "a synchronized terminal round cannot restore a stale live covenant");

  assert(
    transactionsModule.assertRaffleCarrierLiveness({ ticketPrice: 100_000_000n }, metadata.covenant, "Boundary test") === 57_300_000n,
    "the browser accepts the exact settlement-carrier floor"
  );
  let rejectedUnderCarriedRound = false;
  try {
    transactionsModule.assertRaffleCarrierLiveness(
      { ticketPrice: 100_000_000n },
      { ...metadata.covenant, amountSompi: "10057299999" },
      "Adversarial low-carrier purchase"
    );
  } catch (error) {
    rejectedUnderCarriedRound = /No wallet signing request was opened/.test(String(error));
  }
  assert(rejectedUnderCarriedRound, "the browser rejects an untrusted round one sompi below the settlement-carrier floor before signing");
  let rejectedInconsistentAppendState = false;
  try {
    await transactionsModule.assertRaffleAppendState(metadata, metadata.covenant);
  } catch (error) {
    rejectedInconsistentAppendState = /ticket root does not match its append frontier/.test(String(error));
  }
  assert(rejectedInconsistentAppendState, "the browser rejects a root/frontier-inconsistent round before signing");

  const readableRoundNonce = "round-173e69711db5f634";
  const readableRoundNonceHex = covenantModule.bytesToHex(await covenantModule.roundIdToBytes32(readableRoundNonce));
  const firstReadableNonceBatch = await protocolMerkle.appendBatch("00".repeat(640), 0, {
    roundNonceHex: readableRoundNonceHex,
    ownerPubkeyHex: "91".repeat(32),
    firstTicketId: 0,
    ticketCount: 1
  });
  await transactionsModule.assertRaffleAppendState(
    { roundId: readableRoundNonce, roundNonce: readableRoundNonce },
    {
      soldTickets: 1,
      soldBatches: 1,
      ticketOwnerPubkeys: ["91".repeat(32)],
      ticketBatchEnds: [1],
      ticketFrontier: firstReadableNonceBatch.frontierHex,
      ticketRoot: firstReadableNonceBatch.rootHex
    }
  );
  assert(true, "a readable round nonce survives the second-purchase append-state preflight");

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
  assert(localRounds.loadCachedRaffleHistory("testnet-10").length === 2, "archived v14 cached rounds remain visible in history");
  assert(
    metadataModule.parseMetadata(JSON.stringify({ ...metadata, covenant: undefined, contractVersion: "raffle-v14-batch-range" })).contractVersion === "raffle-v14-batch-range",
    "v14 imported metadata retains its protocol version"
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
  const stateMachine = fs.readFileSync(path.join(root, "src/app/state-machine.ts"), "utf8");
  const i18n = fs.readFileSync(path.join(root, "src/app/i18n.ts"), "utf8");
  const actionWorkspace = fs.readFileSync(path.join(root, "src/app/components/ActionWorkspace.tsx"), "utf8");
  const createRoundPanel = fs.readFileSync(path.join(root, "src/app/components/CreateRoundPanel.tsx"), "utf8");
  const sourceWorkspace = fs.readFileSync(path.join(root, "src/app/components/SourceWorkspace.tsx"), "utf8");
  const explorerLink = fs.readFileSync(path.join(root, "src/app/components/ExplorerLink.tsx"), "utf8");
  const rpc = fs.readFileSync(path.join(root, "src/kaspa/rpc.ts"), "utf8");
  const networks = fs.readFileSync(path.join(root, "src/kaspa/networks.ts"), "utf8");
  const walletTypes = fs.readFileSync(path.join(root, "src/kaspa/wallet-types.ts"), "utf8");
  const localWallet = fs.readFileSync(path.join(root, "src/kaspa/wallet-local-test.ts"), "utf8");
  const transactions = fs.readFileSync(path.join(root, "src/kaspa/transactions.ts"), "utf8");
  const history = fs.readFileSync(path.join(root, "src/kaspa/history.ts"), "utf8");
  const roundContract = fs.readFileSync(path.join(root, "src/contracts/raffle_round_v16.sil"), "utf8");
  const refundContract = fs.readFileSync(path.join(root, "src/contracts/raffle_refund_v16.sil"), "utf8");
  const merkle = fs.readFileSync(path.join(root, "src/raffle/merkle.ts"), "utf8");
  const styles = fs.readFileSync(path.join(root, "src/styles.css"), "utf8");
  const viteConfig = fs.readFileSync(path.join(root, "vite.config.ts"), "utf8");
  assert(app.includes("getting-started") && app.includes("openRoundWorkspace(\"history\")"), "new visitors receive a direct participant-first onboarding flow");
  assert(
    app.includes('INTRO_GUIDES_STORAGE_KEY = "kaspa-raffle-intro-guides-seen-v1"') &&
      app.includes("localStorage.setItem(INTRO_GUIDES_STORAGE_KEY, \"1\")") &&
      app.includes("const showIntroGuides = !introGuidesSeen") &&
      app.includes("{showIntroGuides && !metadata.roundId && !metadata.covenant ?"),
    "gameplay and onboarding guide panels are shown only once per browser user"
  );
  assert(
    app.includes('networkId === "testnet-10" ? "TKAS" : "KAS"') &&
      app.includes("formatKasAmount(value, currencyUnit)") &&
      app.includes("formatKasCompactAmount(value, currencyUnit)") &&
      app.includes('value.replace(/\\bTKAS\\b/g, "KAS")'),
    "testnet UI amounts use TKAS while runtime translation can still match KAS-based templates"
  );
  assert(styles.includes(".getting-started") && styles.includes(".getting-started-steps") && styles.includes(".onboarding-progress"), "onboarding is styled for desktop and mobile layouts");
  assert(
    app.includes('className="kaspa-brand-mark"') && !app.includes("lottery-ball") &&
      app.includes('className="gameplay-guide"') && app.includes('t("gameplay.step.settle.detail")') &&
      styles.includes(".gameplay-flow") && styles.includes(".gameplay-trust-strip"),
    "the header uses a Kaspa-specific identity and the page explains play, draw/refund, and trust advantages"
  );
  assert(
    app.includes('useState<RoundSourceTab>("history")') &&
      sourceWorkspace.indexOf('id="round-history-tab"') < sourceWorkspace.indexOf('id="round-create-tab"') &&
      app.indexOf("{gameplayGuide}") < app.indexOf('className="setup-strip header-connectivity"') &&
      app.includes("metadata.covenant.soldTickets >= metadata.maxTickets") && app.includes('setRoundActionTab("payout")') &&
      styles.includes("--lotto-blue-bright: #49eacb") &&
      styles.includes(".source-workspace .workspace-tab.active") &&
      styles.includes(".source-workspace .organizer-source-tab:not(.active)") &&
      app.includes("const [isRoundSourceOpen, setIsRoundSourceOpen] = useState(false)") &&
      app.includes('className="round-primary-workspace"') && app.includes('className={`round-overview${hasCurrentRound ? "" : " empty"}`}') &&
      app.includes('className={`round-source-menu-button${isRoundSourceOpen ? " active" : ""}`}') &&
      app.includes("<ActionWorkspace") && !app.includes("{metadata.roundId || metadata.covenant ? (\n        <ActionWorkspace") &&
      app.includes("<SourceWorkspace\n        embedded") &&
      sourceWorkspace.includes("if (props.embedded && !props.expanded) return null") && sourceWorkspace.includes("props.expanded ?") &&
      styles.includes(".round-primary-workspace > .round-source-anchor") && styles.includes(".round-primary-workspace > .action-workspace") &&
      styles.includes(".source-workspace.collapsed"),
    "the empty and loaded states keep current-round actions visible while discovery and creation expand from the current-round header"
  );
  assert(
    app.includes("const [createParameters, setCreateParameters]") &&
      app.includes("metadata={createParameters}") &&
      app.includes("onUpdateMetadata={updateCreateParameters}") &&
      app.includes("...createParameters,") &&
      !app.includes("onUpdateMetadata={updateMetadata}"),
    "next-round form edits stay in an isolated draft and cannot mutate the displayed or cached current round"
  );
  assert(
    createRoundPanel.includes('onUpdateMetadata("minTickets"') &&
      createRoundPanel.includes('className="form-grid create-parameters-grid"') &&
      createRoundPanel.includes("max={props.maxPurchaseBatches}") &&
      createRoundPanel.includes("props.recommendedMaxBatches") &&
      createRoundPanel.includes('t("useRecommendedBatches")') &&
      protocolManifest.PROTOCOL_MANIFEST.defaultMaxBatches === 100 &&
      protocolManifest.PROTOCOL_MANIFEST.maxRelaySafePurchaseBatches === 1_000 &&
      protocolManifest.PROTOCOL_MANIFEST.recommendedSecondsPerPurchaseBatch === 6 &&
      app.includes("refundTimeoutSeconds / interval") &&
      app.includes("PROTOCOL_MANIFEST.maxRelaySafePurchaseBatches") &&
      styles.includes(".batch-recommendation.warning") &&
      styles.includes("grid-template-columns: repeat(4, minmax(118px, 168px))") &&
      !actionWorkspace.includes("data-cost=") && !createRoundPanel.includes("data-cost=") &&
      !styles.includes(".kas-cost-button::after"),
    "creation exposes four compact numeric parameters, a 1000-batch hard cap, and a six-second-per-batch duration recommendation"
  );
  assert(
    actionWorkspace.includes('className="fee-disclosure"') &&
      actionWorkspace.includes('className="safety-exit-disclosure"') &&
      createRoundPanel.includes("REGISTRY_PAYMENT_FEE_SOMPI") &&
      createRoundPanel.includes('registryPaymentFeeDetail", { fee:') &&
      transactions.includes("DEFAULT_RAFFLE_REGISTRY_MARKER_SOMPI = 20_000_000n") &&
      transactions.includes("REGISTRY_MARKER_REFUND_FEE_SOMPI = 1_000_000n") &&
      transactions.includes("return { address: lowCostFundingAddress(network), autoRefund: true }") &&
      i18n.includes("每笔硬上限 {maxFee}") && i18n.includes("触发者钱包支付 0 KAS"),
    "visible fee copy separates wallet network fees from the common Mainnet/Testnet 0.01 KAS net Registry cost"
  );
  assert(
    app.includes('const [terminalRoundStatus, setTerminalRoundStatus]') &&
      app.includes('selectedRefunded ? "Refunded" : selectedFinalized ? "Finalized"') &&
      app.includes('terminalRoundStatus === "Refunded"') &&
      app.includes('amountSompi: "0"'),
    "terminal history outcomes override stale browser cursors before rendering any spend action"
  );
  assert(app.includes('document.addEventListener("pointerdown", handleOutsidePointerDown, true)') && app.includes('event.key !== "Escape"'), "header menus dismiss on outside click and Escape");
  assert(styles.includes("--panel: #fff") && styles.includes(".signing-confirmation .signing-preview") && styles.includes("z-index: 100"), "signing confirmation uses an opaque, high-contrast modal surface");
  assert(app.includes("formatKasCompact(wallet.balanceSompi)") && styles.includes(".wallet-balance-full"), "wallet balances are compact by default and reveal full precision on hover");
  assert(app.includes("network-menu-connection") && !app.includes('className="setup-primary"'), "node controls stay inside the network menu instead of the header");
  assert(app.includes("const reconnectDelay = rpcError ? 5_000 : 0") && app.includes("network-connection-state"), "the node connects automatically and reports status beside the network");
  assert(actionWorkspace.includes('className="action-status-note" role="status"') && !app.includes('onClick={handleConnect}'), "refund blockers are prominent and node connection has no manual button");
  assert(
    actionWorkspace.includes('className="action-feedback inline-action-feedback"') &&
      createRoundPanel.indexOf('className="wide secondary organizer-create-button"') < createRoundPanel.indexOf('props.feedback ? <div className="action-feedback inline-action-feedback"') &&
      actionWorkspace.includes('actionFeedback("buy")') && actionWorkspace.includes('actionFeedback("carrier")') &&
      actionWorkspace.includes('actionFeedback("refund")') && actionWorkspace.includes('? "close" : "draw"') &&
      app.includes('setChainFeedbackTarget("create")') && app.includes('setChainFeedbackTarget("buy")') &&
      app.includes('setChainFeedbackTarget("draw")') && app.includes('setChainFeedbackTarget("refund")'),
    "create, buy, draw, refund, close, and carrier feedback renders directly below its own action"
  );
  assert(
    app.includes('className="history-round-picker"') &&
      app.indexOf('className="history-round-picker"') < app.indexOf('className="history-detail"') &&
      (app.match(/onClick=\{handleJoinSelectedHistoryRound\}/g) ?? []).length === 1 &&
      styles.includes(".history-round-picker") && styles.includes("grid-template-columns: minmax(0, 760px) auto"),
    "the selected-round action sits immediately after the round dropdown instead of below the round metrics"
  );
  assert(
    stateMachine.includes("&& hasSoldTickets && minimumReached") &&
      actionWorkspace.includes('t("timeoutMustRefund"') && app.includes('t("finalizeBlocked.minimum"'),
    "below-minimum timed-out rounds disable draw, explain the threshold, and expose only the refund path"
  );
  assert(
    stateMachine.includes('!input.refundAvailable && input.ticketQuantityIsAvailable') &&
      stateMachine.includes('(status === "Open" || status === "Closed") && !hasSoldTickets') &&
      actionWorkspace.includes('t("emptyRoundClosed")') && actionWorkspace.includes('props.emptyCloseCostTooltip') &&
      actionWorkspace.includes('!isEmptyRound ? <details className="safety-exit-disclosure"') &&
      app.includes('setTerminalRoundStatus("Closed")') && app.includes("covenant: undefined"),
    "expired zero-sale rounds disable Buy and Refund, expose one close-empty action, and become terminal after returning carrier"
  );
  assert(app.includes("language={language}") && app.includes('signing.payment.create') && app.includes('signing.fee.refund'), "signing previews follow the page language");
  assert(app.includes("topUpRaffleCovenantCarrier") && app.includes('operation: "top-up-carrier"') && actionWorkspace.includes("carrier-top-up-panel"), "active vNext rounds expose a reviewed carrier top-up action");
  assert(transactions.includes("buildRaffleTopUpSignatureScript") && history.includes('payload.type === "round-carrier-topup"'), "carrier top-ups preserve the covenant state and remain discoverable after reload");
  const createResultCheck = app.indexOf('if (!result.covenant)');
  const createRecoveryCache = app.indexOf("cacheParticipatedRound(createdMetadata, [])", createResultCheck);
  const createRegistryPayment = app.indexOf("const registryResult = await sendKaspaPayment", createResultCheck);
  const createBalanceRefresh = app.indexOf("const balanceSompi = await getAddressBalanceSompi", createResultCheck);
  assert(
    createResultCheck >= 0 && createRecoveryCache > createResultCheck && createRegistryPayment > createRecoveryCache && createBalanceRefresh > createRecoveryCache &&
      app.includes("createdRecoveryNotice"),
    "a created covenant cursor is cached before Registry publication or balance refresh can fail"
  );
  const buyBuilderStart = transactions.indexOf("export async function buyRaffleCovenantTicket");
  const buyAppendGuard = transactions.indexOf("await assertRaffleAppendState(currentRound, input.covenant)", buyBuilderStart);
  const buyCarrierGuard = transactions.indexOf("assertRaffleCarrierLiveness(input.round, input.covenant", buyBuilderStart);
  const buyNodeUtxoCheck = transactions.indexOf("getCurrentCovenantUtxo(input.connection, input.covenant)", buyBuilderStart);
  const buyWalletSelection = transactions.indexOf('failureStage = "wallet input selection"', buyBuilderStart);
  const buyWalletSigning = transactions.indexOf("await input.wallet.signTransaction(converged.tx, walletInputIndexes)", buyBuilderStart);
  assert(
    buyBuilderStart >= 0 && buyAppendGuard > buyBuilderStart && buyCarrierGuard > buyAppendGuard && buyNodeUtxoCheck > buyCarrierGuard &&
      buyWalletSelection > buyNodeUtxoCheck && buyWalletSigning > buyWalletSelection &&
      app.includes("buyBlockedReason") && actionWorkspace.includes("props.buyBlockedReason"),
    "malformed, stale, or low-carrier rounds are blocked before the single wallet signing request"
  );
  const topUpBuilderStart = transactions.indexOf("export async function topUpRaffleCovenantCarrier");
  const topUpAppendGuard = transactions.indexOf("await assertRaffleAppendState(currentRound, input.covenant)", topUpBuilderStart);
  const topUpNodeUtxoCheck = transactions.indexOf("getCurrentCovenantUtxo(input.connection, input.covenant)", topUpBuilderStart);
  const topUpWalletFunding = transactions.indexOf("const walletUtxos = await input.connection.client.getUtxosByAddresses", topUpBuilderStart);
  assert(
    topUpBuilderStart >= 0 && topUpAppendGuard > topUpBuilderStart && topUpNodeUtxoCheck > topUpAppendGuard && topUpWalletFunding > topUpNodeUtxoCheck,
    "malformed rounds are blocked before carrier top-up wallet staging"
  );
  assert(
    transactions.includes("MAX_COVENANT_TOP_UP_FEE_SOMPI = 10_000_000n") &&
      transactions.includes("MAX_COVENANT_TOP_UP_FEE_SOMPI + SAFE_PAYMENT_CHANGE_SOMPI") &&
      transactions.includes("convergeTopUpTransaction") &&
      transactions.includes("buildTopUpTransaction(feeSompi, false)") &&
      transactions.includes("buildTopUpTransaction(feeSompi, true)") &&
      transactions.includes("Carrier top-up failed during ${failureStage}") &&
      i18n.includes("广播前按节点精确最低费收敛"),
    "carrier top-up uses bounded exact-fee convergence, safe wallet change, a final bound successor, and stage-specific recovery"
  );
  assert(
    (transactions.match(/selectedEntries\.map\(walletInputFromEntry\)/g) ?? []).length >= 2 &&
      transactions.includes("await input.wallet.signTransaction(built.tx, walletInputIndexes)") &&
      transactions.includes("await input.wallet.signTransaction(tx, selectedEntries.map((_, index) => index))") &&
      transactions.includes("await input.wallet.signTransaction(converged.tx, walletInputIndexes)") &&
      i18n.includes("2 次：创建 covenant + 发布 Registry 记录") &&
      i18n.includes("1 次：票款和 covenant successor 合并在同一交易"),
    "Create and Registry each use one direct wallet transaction, while Buy combines payment and covenant successor into one approval"
  );
  assert(
    !transactions.includes("sigOpCount: 1") &&
      transactions.includes("export const P2PK_WALLET_COMPUTE_BUDGET = 10") &&
      transactions.includes("function walletInputFromEntry") &&
      transactions.includes("computeBudget: P2PK_WALLET_COMPUTE_BUDGET"),
    "every manually constructed version-1 wallet input clears legacy sig-op-count and commits the measured P2PK budget"
  );
  const normalizedWalletShape = JSON.parse(walletTypesModule.normalizeWalletTransactionJson(JSON.stringify({
    inputs: [{ utxo: { amount: "100", covenantId: null } }],
    outputs: [
      { value: "50", covenant: { authorizingInput: 0, covenantId: "22".repeat(32) } },
      { value: "50", covenant: null }
    ]
  })));
  const walletSignatures = walletTypesModule.walletSignatureScriptsFromJson(JSON.stringify({
    inputs: [{ signatureScript: "41".repeat(65) }],
    outputs: [{ covenant: { authorizingInput: 0, covenantId: [1, 2, 3] } }]
  }), 1, [0]);
  assert(
    normalizedWalletShape.outputs[0].covenant.covenantId === "22".repeat(32) &&
      !("covenant" in normalizedWalletShape.outputs[1]) &&
      !("covenantId" in normalizedWalletShape.inputs[0].utxo) &&
      walletSignatures[0].signatureScript === "41".repeat(65) &&
      transactions.includes("deriveCovenantId(selectedEntries[0].outpoint") &&
      transactions.includes("transaction.outputs[0].covenant = new CovenantBinding(0, genesisCovenantHash)") &&
      transactions.includes("builtCreate.measurementTransaction") &&
      !transactions.includes("transaction.populateGenesisCovenants") &&
      localWallet.includes("normalizedJson = serializeWalletTransaction(transaction)") &&
      localWallet.includes("Transaction.deserializeFromSafeJSON(normalizedJson)"),
    "Genesis creation derives and installs its binding directly while wallet replies contribute only signatures, independent of covenant JSON conversion"
  );
  assert(
    app.includes("function prepareRoundForCreate(forceNew = false)") &&
      app.includes('roundId: ""') && app.includes('createTxId: ""') && app.includes('treasuryAddress: ""'),
    "failed creation does not leave an unbacked current-round id in the page"
  );
  assert(
    (app.match(/salesDeadlineDaa: refundAfterDaaScore\.toString\(\)/g) ?? []).length >= 5 &&
      app.includes("salesDeadlineDaa: metadata.salesDeadlineDaa ?? covenant.refundAfterDaaScore") &&
      app.includes("roundNonce: roundId") && app.includes("maxBatches: metadata.maxBatches ?? 100"),
    "creating a next round replaces every prior round-domain and sales-deadline field in metadata and local history"
  );
  assert(
    i18n.includes("任何人都可触发关闭，但 covenant 只能把 carrier 退回创建者") &&
      i18n.includes("Anyone can close this round, but the covenant can return the carrier only to the creator"),
    "empty-round guidance matches the public trigger and creator-only covenant payout"
  );
  assert(
    transactions.includes("const expectedTxId = tx.id") && transactions.includes("Locally computed transaction id: ${expectedTxId}") &&
      transactions.includes("await waitForAddressUtxo(input.connection, covenantAddress, preparedTxId, 0, 10_000)") &&
      transactions.includes("Candidate covenant transaction: ${preparedTxId}; covenant id: ${covenantId}; address: ${covenantAddress}"),
    "lost RPC responses preserve the deterministic transaction id and recover an already-indexed Genesis covenant"
  );
  assert(
    transactions.includes("MAX_COVENANT_CREATE_PAYLOAD_BYTES = 1_536") &&
      transactions.includes("MAX_REGISTRY_PAYLOAD_BYTES = 1_536") &&
      transactions.includes("MAX_COVENANT_BUY_PAYLOAD_BYTES = 768") &&
      transactions.includes("MAX_COVENANT_TOP_UP_PAYLOAD_BYTES = 768") &&
      (transactions.match(/requirePayloadLimit\(input\.payload/g) ?? []).length === 4,
    "fixed-fee transaction payloads are bounded before wallet signing"
  );
  assert(
    transactions.includes("input.round.ticketPrice * BigInt(input.round.maxTickets) > MAX_ROUND_PRINCIPAL_SOMPI") &&
      app.includes("BigInt(createParameters.ticketPrice) * BigInt(createParameters.maxTickets) > MAX_ROUND_PRINCIPAL_SOMPI"),
    "the browser and transaction builder reject round principal arithmetic overflow before signing"
  );
  assert(
    transactions.includes("input.round.contractVersion !== RAFFLE_CONTRACT_VERSION") &&
      fs.readFileSync(path.join(root, "src/kaspa/covenant.ts"), "utf8").includes("runtimeArtifact !== expectedArtifact"),
    "every spend requires the exact current protocol and state-specific compiled artifact"
  );
  assert(
    explorerLink.includes('"https://kaspa.stream"') &&
      explorerLink.includes('"https://tn10.kaspa.stream"') &&
      explorerLink.includes('kind === "transaction" ? "transactions" : "addresses"') &&
      explorerLink.includes("export function ExplorerText") &&
      app.includes("<ExplorerLink") &&
      app.includes("<ExplorerText") &&
      actionWorkspace.includes("<ExplorerLink"),
    "addresses, covenant cursors, and transaction ids link to the network-matched kaspa.stream explorer"
  );
  assert(app.includes("<input value={indexApiBase}") && app.includes("localStorage.setItem(INDEX_ENDPOINTS_STORAGE_KEY"), "the web app exposes and persists a configurable indexer URL");
  assert(networks.includes('defaultRpcMode: "resolver"') && rpc.includes("new Resolver().getUrl(Encoding.Borsh, network)"), "network connections default to the Kaspa resolver");
  assert(!rpc.includes("resolver: new Resolver()"), "resolver connections resolve a URL before creating the RPC client");
  assert(app.includes('mode: "custom", url: validateRpcUrl(networkEndpointDraft)') && app.includes("endpointSummary(networkEndpoints[profile.id])"), "users can override resolver routing with a custom wRPC node");
  assert(networks.includes('label: "Testnet 10"') && app.includes("TN10") && !app.includes(`TN${12}`), "the browser labels the live test network as Testnet 10");
  assert(app.includes('useState<RaffleHistoryRound[]>(() => loadCachedRaffleHistory("testnet-10"))'), "browser startup immediately restores participated rounds into history");
  assert(app.includes("selectedHistoryRound.latestCovenant || selectedHistoryRound.localCachedAt"), "locally saved rounds remain loadable after finalization or an API outage");
  assert(
    app.includes("archivedReleaseForRaffleContractVersion") &&
      app.includes("isQuarantinedRaffleContractVersion") &&
      app.includes("selectedHistoryRoundQuarantined") &&
      app.includes("legacyRoundRequiresRelease") &&
      app.includes("downloadCompatibleRelease") &&
      app.includes("github.com/agang0311/kaswin/releases/tag/${selectedHistoryRoundArchivedRelease}"),
    "published archived protocols point to matching releases while unpublished unsafe artifacts are quarantined"
  );
  assert(app.includes('!registryAddresses.size && !byRoundId.size'), "browser history can load local participated rounds without a registry address");
  assert(app.includes("updateCachedParticipatedRoundFromHistory(networkId, historyRound)"), "refreshed network outcomes are written back to participated-round storage");
  assert(app.includes("if (cachedRound.registryAddress) registryAddresses.add(cachedRound.registryAddress)"), "history refresh follows every registry address saved with participated rounds");
  assert(app.includes("needsIndexer") && app.includes("? await Promise.allSettled([loadIndexedRaffleHistory(indexApiBase)])"), "history only contacts the indexer when a loaded round exceeds the threshold");
  assert(!app.includes("byRoundId.delete(historyRound.roundId)"), "an unavailable index never removes a registry-discovered large round from history");
  assert(
    app.includes("without index proofs") &&
      app.includes("preferAdvancedRaffleCovenant(cachedRound?.latestCovenant, historyRound.latestCovenant)"),
    "large history remains visible and keeps a monotonic cached live covenant when index proofs are unavailable"
  );
  assert(app.includes("requiresRaffleIndexerProof(metadata.maxTickets, hasCompleteLocalHistory)"), "large rounds use complete local batch history before contacting an indexer for draw or refund proofs");
  assert(app.includes("selectedHistoryRoundRequiresIndexer ? renderIndexerRequirement") && app.includes("activeRoundNeedsIndexer && metadata.covenant ? renderIndexerRequirement"), "history and payout views show indexer configuration exactly when proof data is missing");
  assert(app.includes("await requireReadyIndexer()") && app.includes("checkRaffleIndexer(indexApiBase)"), "draw and refund verify the configured indexer before changing covenant state");
  assert(app.includes("historyRoundNeedsIndexer") && app.includes("roundsNeedingIndexer"), "history only requests indexed details for rounds with incomplete local batches");
  assert(transactions.includes("const chainSearchHintHash = currentChainHash"), "ticket purchases refresh the selected-chain lookup anchor");
  assert(
    history.includes("bytesToHex(await roundIdToBytes32(round.roundNonce || round.roundId))") &&
      (transactions.match(/bytesToHex\(await roundIdToBytes32\(round\.roundNonce \|\| round\.roundId\)\)/g) ?? []).length >= 2 &&
      app.includes("roundNonce: roundId") &&
      app.includes("salesDeadlineDaa: refundAfterDaaScore.toString()"),
    "network-only history and purchase proofs normalize readable round nonces to the covenant's exact bytes32 commitment"
  );
  assert(
    transactions.includes("KASWIN_REGISTRY_V1") &&
      transactions.includes("LEGACY_LOW_COST_REDEEM_SCRIPT") &&
      transactions.includes("Registry marker address is not an auto-refundable Kaswin registry."),
    "the isolated registry retains an explicit legacy-marker recovery path and rejects arbitrary refund scripts"
  );
  assert(app.includes("withWalletConnectionTimeout") && app.includes("Wallet connection timed out after 20 seconds."), "wallet connections recover instead of leaving the page stuck in a pending state");
  assert(history.includes("transaction.accepting_block_hash ?? transaction.block_hash?.[0]") && app.includes("loadTransactionChainAnchor(historyApiBase, metadata.createTxId)"), "legacy rounds recover an early selected-chain anchor from their creation transaction");
  assert(history.includes("blueScoreLt=${probe + 1n}") && history.includes("blueScoreGte=${cursor}") && app.includes("anchorHeader.blueScore + targetBoundaryDaa - anchorHeader.daaScore"), "draw lookup calibrates and corrects a bounded target blue-score search from the creation block");
  assert(merkle.includes("MAX_TICKET_BATCH_SIZE = 1_000_000") && actionWorkspace.includes('type="number"') && app.includes("ticketCount: quantity"), "the wallet UI accepts any positive whole-number ticket quantity up to the round remainder");
  assert(actionWorkspace.includes("disabled={!props.canBuy}") && stateMachine.includes("input.ticketQuantityIsAvailable"), "the wallet blocks an unavailable, expired, non-positive, fractional, or oversized quantity before signing");
  assert(
      app.includes("ticketSalesClosedMessage(covenant)") &&
      i18n.includes('"salesClosed.empty"') &&
      i18n.includes("没有可退的购票款") &&
      app.includes("currentDaaScore >= refundAfterDaaScore") &&
      transactions.includes("dagInfo.virtualDaaScore >= salesDeadline") &&
      transactions.includes("No wallet signing request was opened"),
    "expired rounds are blocked before wallet signing and route zero-sale, below-minimum, and drawable states to the correct settlement action"
  );
  assert(app.includes("drawRandomnessBaseDaaScore") && app.includes("covenantDaaScore"), "the browser moves a deadline-race successor's draw beacon to its confirmed covenant DAA");
  assert(localWallet.includes("new URLSearchParams({ wallet: input.wallet, network })") && viteConfig.includes('"experiment-mainnet.json"'), "the development wallet can run the same flow against Mainnet once funded");
  assert(roundContract.includes("require(ticket_count > 0)") && !roundContract.includes("ticket_count == 100000"), "the covenant validates arbitrary positive purchase quantities");
  assert(roundContract.includes("ticket_price * ticket_count"), "the covenant charges the exact multi-ticket amount");
  assert(roundContract.includes("sold_batches: sold_batches + 1"), "one purchase appends one on-chain batch regardless of ticket count");
  assert(refundContract.includes("MAX_BATCHES_PER_TX = 13") && app.includes("MAX_REFUND_PURCHASE_BATCHES_PER_TX"), "the legacy/v16 covenant ABI retains its 13-proof upper bound");
  assert(app.includes("shouldShrinkRefundBatch") && app.includes("storage[- ]mass") && app.includes("candidateBatches.slice(0, -1)"), "the browser dynamically shrinks an ABI-cap candidate to the relay-standard prefix measured for the current compiled artifact");
  assert(transactions.includes("refundBatchComputeBudget") && transactions.includes("verifiedBatches.map"), "grouped refunds commit a batch-sized compute budget and build every owner output");
  assert(transactions.includes("calculateTransactionFee") && transactions.includes("minimumV1TransientRelayFeeSompi"), "finalize fees include static and normalized transient mass");
  assert(
    transactions.includes("MAX_COVENANT_BUY_FEE_SOMPI = 10_000_000n") &&
      transactions.includes("purchaseAmount + MAX_COVENANT_BUY_FEE_SOMPI") &&
      transactions.includes("fundingRefundAmount < SAFE_PAYMENT_CHANGE_SOMPI") &&
      transactions.includes("additionalInputSignatureScriptLengths: walletEntries.map(() => P2PK_SIGNATURE_SCRIPT_BYTES)") &&
      transactions.includes("const convergeBuyTransaction") &&
      transactions.includes("buildBuyTransaction(feeSompi, false)") &&
      transactions.includes("buildBuyTransaction(feeSompi, true)") &&
      transactions.includes("No automatic second wallet request was opened") &&
      i18n.includes("在唯一一次钱包请求前完成收敛"),
    "ticket purchases pay from direct wallet inputs, converge before the sole approval, and never silently request a second signature"
  );
  assert(
    transactions.includes("requiredFeeFromNodeRejection") && transactions.includes("nodeRequiredFee") &&
      transactions.includes("if (finalizeFeeSompi > MAX_COVENANT_FINALIZE_FEE_SOMPI)") &&
      transactions.includes("if (refundFeeSompi > maximumRefundFee)"),
    "covenant spends retry with the node's exact compute-mass fee floor without crossing covenant fee caps"
  );
  assert(
    transactions.includes("CURRENT_COVENANT_LOOKUP_TIMEOUT_MS = 15_000") &&
      transactions.includes("Another transaction may have advanced the round; reload the latest round state before trying again."),
    "stale covenant preflight fails within a bounded wait and tells the user to reload instead of implying an endless indexing delay"
  );
  assert(
    transactionsModule.transactionRejectionRequiresStateRefresh(new Error("Rejected transaction: input is already spent")) &&
      transactionsModule.transactionRejectionRequiresStateRefresh(new Error("The loaded covenant UTXO is no longer available.")) &&
      /new review and signature/.test(transactionsModule.normalizeTransactionError(new Error("Rejected transaction: conflicting transaction already spent the outpoint")).message) &&
      /parent/.test(transactionsModule.normalizeTransactionError(new Error("transaction is an orphan where orphan is disallowed")).message) &&
      /No retry or replacement signing request/.test(transactionsModule.normalizeTransactionError(new Error("Rejected transaction: policy failure")).message) &&
      app.includes("void handleLoadHistory()") &&
      app.includes("inspect and reload the newest covenant before opening another wallet request"),
    "node rejections are classified, stale-input failures trigger a read-only history refresh, and no replacement signature is requested silently"
  );
  assert(transactions.includes("input.refundStartPayload?.(transitionFeeSompi) ?? input.payload)?.length"), "refund-transition transient mass uses the actual fee-bound payload length");
  assert(
    transactions.includes("function covenantRemainingPrincipal") &&
      transactions.includes("utxo.amount !== expectedAmount") &&
      app.includes("ticketPrice * BigInt(Math.max(0, soldTickets - refundedTickets))"),
    "prize/refund principal is derived from covenant counters and the node UTXO must match the loaded cursor amount"
  );
  assert(
    app.includes("recoverTicketStatesFromCovenantBatches") &&
      app.includes("addressFromPubkeyHex(ownerPubkey, input.network)") &&
      app.includes("ticketBatchEnds") &&
      app.includes("setTickets(loadedTickets)"),
    "small rounds can recover complete local ticket batches from covenant commitments when history omits ticket payloads"
  );
  assert(
    rpc.includes("RESOLVER_LOOKUP_TIMEOUT_MS") &&
      rpc.includes("RPC_CONNECT_TIMEOUT_MS") &&
      rpc.includes("RPC_STATUS_TIMEOUT_MS") &&
      rpc.includes("await client.disconnect().catch"),
    "node resolver and wRPC connection attempts are bounded and release failed clients"
  );
  assert(
    app.includes("const networkChanged = profile.id !== networkId || rpcConnectionRef.current?.status.network !== profile.id") &&
      app.includes("void disconnectBrowserRpc(rpcConnectionRef.current).catch(() => undefined);") &&
      app.includes("setNodeStatus({ connected: false, network: \"unknown\", syncStatus: \"unknown\" });"),
    "imported or shared mainnet rounds force a node reconnect instead of reusing a stale testnet RPC connection"
  );
  assert(
    !app.includes("RESCUE_ROUND_METADATA") &&
      app.includes("const rescueBuyCandidate = Boolean") &&
      app.includes("const rescueBuyQuantityOk = Number.isInteger(parsedTicketQuantity) && parsedTicketQuantity === 1") &&
      app.includes("rescueBuyAvailable") &&
      app.includes("allowDeadlineRescueBuy: rescueBuyAvailable") &&
      transactions.includes("allowDeadlineRescueBuy?: boolean") &&
      transactions.includes("input.ticketCount === 1") &&
      transactions.includes("covenantInputDaa < salesDeadline") &&
      transactions.includes("canRescueStuckDrawableRound"),
    "deadline rescue buying is a general guarded release feature limited to one ticket and still requires the covenant input DAA to precede the sales deadline"
  );
  assert(
    app.includes("function requireConnectedPageNetworkForWallet()") &&
      app.includes("Connect a Kaspa node before connecting a wallet.") &&
      app.includes("const connectedNetwork = normalizeNetworkId(connection.status.network)") &&
      app.includes("if (connectedNetwork !== networkId)") &&
      app.includes("let connectedWallet = await withWalletConnectionTimeout(connectBrowserWallet(adapterId, walletNetwork))") &&
      app.includes("const nextWallet = await readConnectedBrowserWallet(wallet, connectedNetwork)") &&
      app.includes("setWallet(null);") &&
      walletTypes.includes("if (!address.startsWith(profile.addressPrefix))"),
    "wallet connection and account refresh are pinned to the actually connected page node network"
  );
  assert(
    transactions.includes("const sponsorUtxos: IUtxoEntry[] = []") &&
      transactions.includes("retryRequiredFee") &&
      transactions.includes("sponsorUtxos.map((_, index) => index + 1)"),
    "legacy fixed-fee refunds keep adding signed sponsor inputs until the node fee floor is met"
  );
  assert(transactions.includes("buildRefundTransaction(refundFeeSompi, false)") && transactions.includes("Measure an unbound twin"), "refund mass uses an unbound twin before rebuilding the successor covenant");
  assert(
    transactions.includes("REGISTRY_CONFIRMED_INPUT_TIMEOUT_MS = 120_000") &&
      transactions.includes("waitForConfirmedDirectPaymentEntries") &&
      transactions.includes("BigInt(entry.blockDaaScore) > 0n") &&
      transactions.includes("confirmedParentOutpoint") &&
      transactions.includes("excludeUtxoEntries") &&
      app.includes("excludedOutpoints: result.spentWalletOutpoints") &&
      transactions.includes("async function submitTransaction(connection: KaspaRpcConnection, tx: Transaction)") &&
      (transactions.match(/allowOrphan: false/g) ?? []).length >= 3 &&
      !transactions.includes("parentTransactionId") &&
      app.includes("Waiting for confirmed wallet inputs before the separate Registry signing request") &&
      app.includes('operation: "publish-registry"') &&
      app.includes("executeRegistryPublication") &&
      app.includes("Registry history could not be checked, so no duplicate publication") &&
      app.includes("registryPublicationPending") &&
      app.includes("registryMarkerRefundPending") &&
      app.includes("executeRegistryMarkerRecovery") &&
      app.includes("loadAcceptedOutpointSpend") &&
      app.includes("did not return the exact") &&
      history.includes("transaction.is_accepted !== false") &&
      history.includes("previous_outpoint_hash") &&
      transactions.includes("hasBoundOutput && hasUnboundOutput") &&
      transactions.includes("Transaction.deserializeFromSafeJSON(normalizeWalletTransactionJson(safeJson))") &&
      transactions.includes('if (output.covenant && typeof output.covenant === "object") return output;') &&
      transactions.includes("typeof covenantId === \"string\""),
    "RPC submissions never allow orphans, Registry publication and marker return are recoverable without blind duplication, and mixed covenant outputs are normalized"
  );
  assert(
    localWallet.includes("could not normalize the mixed-output transaction before signing") &&
      localWallet.includes("could not deserialize the normalized mixed-output transaction") &&
      localWallet.includes("could not sign the normalized mixed-output transaction") &&
      transactions.includes("Unable to deserialize the normalized mixed-output transaction before submission") &&
      transactions.includes("Unable to finalize the normalized mixed-output transaction before submission") &&
      transactions.includes("Unable to build the normalized mixed-output RPC request"),
    "mixed-output failures identify the exact signing or submission stage"
  );
  assert(
    transactions.includes('failureStage = "successor covenant construction"') &&
      transactions.includes('failureStage = "transaction fee convergence"') &&
      transactions.includes('failureStage = "single wallet signing and RPC submission"') &&
      transactions.includes("Ticket purchase failed during ${failureStage}") &&
      transactions.includes("No preliminary funding transaction was broadcast"),
    "every direct Buy failure identifies its stage and confirms that no preliminary funding transaction was left behind"
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
