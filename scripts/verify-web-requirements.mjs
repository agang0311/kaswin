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

  assert(!indexer.requiresRaffleIndexer(1_000), "rounds with up to 1,000 tickets do not require an indexer");
  assert(indexer.requiresRaffleIndexer(1_001), "rounds above 1,000 tickets require the standalone indexer");
  assert(indexer.requiresRaffleIndexer(1_000_000), "one-million-ticket rounds use the standalone indexer");
  const partition = indexer.partitionRaffleRoundsByIndexer([
    { roundId: "small", maxTickets: 1_000 },
    { roundId: "large", maxTickets: 1_001 }
  ]);
  assert(partition.direct[0]?.roundId === "small" && partition.indexed[0]?.roundId === "large", "mixed history keeps small rounds independent from large-round indexing");

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
      soldTickets: 4,
      potAmount: "120000000",
      status: "Open",
      ticketRoot: "33".repeat(32),
      ticketFrontier: "00".repeat(640),
      refundCursor: 0,
      creatorPubkey: "44".repeat(32),
      refundAfterDaaScore: "100000",
      soldBatches: 1,
      ticketBatchEnds: [4],
      ticketOwnerPubkeys: ["55".repeat(32)]
    }
  };
  const ticket = {
    appId: "KASPA_RAFFLE_TICKET_V1",
    roundId: metadata.roundId,
    ticketId: 1,
    ticketCount: 4,
    owner: "kaspatest:qparticipant",
    ownerPubkey: "55".repeat(32),
    paidAmount: 30_000_000n,
    ticketTxId: "66".repeat(32)
  };

  localRounds.cacheParticipatedRound(metadata, [ticket]);
  const restored = localRounds.loadCachedRound("testnet-10", metadata.roundId);
  assert(restored?.tickets.length === 1 && restored.tickets[0].ticketCount === 4, "a multi-ticket purchase round-trips through browser storage");
  assert(restored?.tickets[0].paidAmount === 30_000_000n, "cached ticket amounts restore as exact bigint values");

  const currentHistory = localRounds.loadCachedRaffleHistory("testnet-10");
  assert(currentHistory.length === 1 && currentHistory[0].soldTickets === 4, "cached participated rounds load back into raffle history");

  const storageKey = "kaspa-raffle-participated-rounds-v12";
  const storedRounds = JSON.parse(storage.get(storageKey));
  storedRounds.push({
    ...storedRounds[0],
    metadata: {
      ...storedRounds[0].metadata,
      roundId: "legacy-round",
      contractVersion: "raffle-v10-chain-pow-tn12"
    }
  });
  storage.set(storageKey, JSON.stringify(storedRounds));
  assert(localRounds.loadCachedRaffleHistory("testnet-10").length === 1, "legacy cached contracts are not loaded");

  let rejectedLegacyMetadata = false;
  try {
    metadataModule.parseMetadata(JSON.stringify({ ...metadata, covenant: undefined, contractVersion: "raffle-v10-chain-pow-tn12" }));
  } catch {
    rejectedLegacyMetadata = true;
  }
  assert(rejectedLegacyMetadata, "legacy imported metadata is rejected");

  const app = fs.readFileSync(path.join(root, "src/app/App.tsx"), "utf8");
  const localWallet = fs.readFileSync(path.join(root, "src/kaspa/wallet-local-test.ts"), "utf8");
  const transactions = fs.readFileSync(path.join(root, "src/kaspa/transactions.ts"), "utf8");
  const roundContract = fs.readFileSync(path.join(root, "src/contracts/raffle_round_v10.sil"), "utf8");
  const viteConfig = fs.readFileSync(path.join(root, "vite.config.ts"), "utf8");
  assert(app.includes("<input value={indexApiBase}") && app.includes("localStorage.setItem(INDEX_ENDPOINTS_STORAGE_KEY"), "the web app exposes and persists a configurable indexer URL");
  assert(app.includes("needsIndexer") && app.includes("? await Promise.allSettled([loadIndexedRaffleHistory(indexApiBase)])"), "history only contacts the indexer when a loaded round exceeds the threshold");
  assert(app.includes("for (const historyRound of historyPartition.indexed) byRoundId.delete(historyRound.roundId)"), "an unavailable large-round index cannot block direct small-round history");
  assert(app.includes("const TICKET_BATCH_SIZES = [1, 2, 4, 8] as const") && app.includes("ticketCount: quantity"), "the wallet UI submits 1, 2, 4, or 8 tickets in one purchase");
  assert(app.includes("disabled={isBuying || Boolean(finalized) || !ticketQuantityIsAvailable}"), "the wallet blocks a stale or unaligned batch before signing");
  assert(localWallet.includes("new URLSearchParams({ wallet: input.wallet, network })") && viteConfig.includes('"experiment-mainnet.json"'), "the development wallet can run the same flow against Mainnet once funded");
  assert(roundContract.includes("ticket_count == 1 || ticket_count == 2 || ticket_count == 4 || ticket_count == 8"), "the covenant validates multi-ticket purchase sizes");
  assert(roundContract.includes("ticket_price * ticket_count"), "the covenant charges the exact multi-ticket amount");
  assert(transactions.includes("calculateTransactionFee") && transactions.includes("minimumV1TransientRelayFeeSompi"), "finalize fees include static and normalized transient mass");
} finally {
  await vite.close();
  delete globalThis.localStorage;
}

console.log("Web requirement checks passed.");
