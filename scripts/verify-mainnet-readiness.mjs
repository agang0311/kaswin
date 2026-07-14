import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import initKaspaWasm, {
  Transaction,
  TransactionOutput,
  addressFromScriptPublicKey,
  calculateTransactionFee,
  payToAddressScript,
  payToScriptHashScript
} from "@onekeyfe/kaspa-wasm/kaspa.js";
import { createServer } from "vite";

const root = process.cwd();

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`PASS ${message}`);
}

const vite = await createServer({
  root,
  configFile: path.join(root, "vite.config.ts"),
  logLevel: "silent",
  appType: "custom",
  ssr: { noExternal: ["@onekeyfe/kaspa-wasm"] },
  server: { middlewareMode: true }
});

try {
  const covenant = await vite.ssrLoadModule("/src/kaspa/covenant.ts");
  const merkle = await vite.ssrLoadModule("/src/raffle/merkle.ts");
  const metadata = await vite.ssrLoadModule("/src/raffle/metadata.ts");
  const networks = await vite.ssrLoadModule("/src/kaspa/networks.ts");
  const transactions = await vite.ssrLoadModule("/src/kaspa/transactions.ts");
  const wasmModule = await vite.ssrLoadModule("/src/kaspa/wasm.ts");
  await wasmModule.ensureKaspaWasmReady();

  assert(
    transactions.requiredFeeFromNodeRejection(new Error("transaction has 2604600 fees which is under the required amount of 3374300 for compute mass 33743")) === 3_374_300n,
    "node compute-mass rejection exposes the exact retry fee"
  );
  assert(transactions.requiredFeeFromNodeRejection(new Error("unrelated rejection")) === undefined, "unrelated node failures are not retried as fee errors");

  let rejectedBeforeActivation = false;
  try {
    networks.assertToccataActive("mainnet", 474_165_564n);
  } catch {
    rejectedBeforeActivation = true;
  }
  assert(rejectedBeforeActivation, "Mainnet rejects covenant broadcasts before Toccata activation");
  networks.assertToccataActive("mainnet", 474_165_565n);
  assert(true, "Mainnet accepts covenant construction at the Toccata activation DAA");

  const contractVersion = metadata.raffleContractVersionForNetwork("mainnet");
  const artifact = covenant.getRaffleRuntimeArtifact(contractVersion);
  const round = {
    appId: "KASPA_RAFFLE_ROUND_V1",
    contractVersion,
    roundId: "mainnet-readiness",
    creator: "",
    ticketPrice: 30_000_000n,
    maxTickets: 1_000_000,
    minTickets: 1,
    soldTickets: 0,
    potAmount: 0n,
    feeBps: 0,
    status: "Open",
    randomnessMode: "kaspa-chain-pow",
    creatorPubkey: "11".repeat(32),
    refundAfterDaaScore: "474175565",
    ticketRoot: merkle.TICKET_EMPTY_ROOT_HEX,
    ticketFrontier: merkle.TICKET_EMPTY_FRONTIER_HEX,
    refundCursor: 0,
    soldBatches: 0,
    ticketBatchEnds: [],
    ticketOwnerPubkeys: []
  };
  const state = await covenant.raffleCovenantStateFromRound(round);
  const redeemScript = covenant.buildRaffleRedeemScriptForContractVersion(state, contractVersion, "Open");
  assert(redeemScript.length === artifact.scriptLength, "Mainnet round state builds the compiled covenant script");

  const wasmBytes = fs.readFileSync(path.join(root, "node_modules", "@onekeyfe", "kaspa-wasm", "kaspa_bg.wasm.bin"));
  globalThis.require = createRequire(pathToFileURL(path.join(root, "node_modules", "@onekeyfe", "kaspa-wasm", "kaspa.js")));
  await initKaspaWasm({ module_or_path: wasmBytes });
  const scriptPublicKey = payToScriptHashScript(redeemScript);
  const mainnetAddress = addressFromScriptPublicKey(scriptPublicKey, "mainnet")?.toString() ?? "";
  const testnetAddress = addressFromScriptPublicKey(scriptPublicKey, "testnet-10")?.toString() ?? "";
  assert(mainnetAddress.startsWith("kaspa:p"), "Mainnet covenant derives a Kaspa P2SH address");
  assert(testnetAddress.startsWith("kaspatest:p"), "Identical covenant bytes derive the expected testnet P2SH address");
  const mainnetRoundTrip = payToAddressScript(mainnetAddress);
  const testnetRoundTrip = payToAddressScript(testnetAddress);
  assert(
    mainnetRoundTrip.version === scriptPublicKey.version &&
      testnetRoundTrip.version === scriptPublicKey.version &&
      mainnetRoundTrip.script === scriptPublicKey.script &&
      testnetRoundTrip.script === scriptPublicKey.script,
    "Mainnet and testnet addresses decode to the same covenant ScriptPublicKey"
  );

  const refundArtifact = covenant.getRaffleRefundRuntimeArtifact(contractVersion);
  const refundRound = {
    ...round,
    status: "Refunding",
    soldTickets: 13,
    soldBatches: 13,
    potAmount: 390_000_000n,
    ticketRoot: "22".repeat(32),
    refundCursor: 0,
    refundBatchCursor: 0
  };
  const refundState = await covenant.raffleCovenantStateFromRound(refundRound);
  const refundRedeemScript = covenant.buildRaffleRedeemScript(refundState, refundArtifact);
  const refundScriptPublicKey = payToScriptHashScript(refundRedeemScript);
  const feasibleBatchCounts = [];
  for (let batchCount = 1; batchCount <= 13; batchCount += 1) {
    let refundFee = 0n;
    let converged = false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const feePerBatch = refundFee / BigInt(batchCount);
      const feeRemainder = refundFee % BigInt(batchCount);
      const witnesses = Array.from({ length: batchCount }, (_, index) => ({
        ownerPubkeyHex: "11".repeat(32),
        firstTicketId: index,
        ticketCount: 1,
        ownerProofHex: "00".repeat(640)
      }));
      const refundSignatureScript = covenant.buildRaffleRefundBatchSignatureScript(refundRedeemScript, refundFee, witnesses);
      const inputAmount = 57_000_000n + 30_000_000n * BigInt(batchCount);
      const groupedRefund = new Transaction({
        version: 1,
        inputs: [{
          previousOutpoint: { transactionId: "33".repeat(32), index: 0 },
          signatureScript: refundSignatureScript,
          sequence: 0n,
          sigOpCount: 0,
          computeBudget: Math.min(470, 15 + batchCount * 35),
          utxo: {
            address: mainnetAddress,
            outpoint: { transactionId: "33".repeat(32), index: 0 },
            amount: inputAmount,
            scriptPublicKey: refundScriptPublicKey,
            blockDaaScore: 474_175_565n,
            isCoinbase: false
          }
        }],
        outputs: [
          new TransactionOutput(57_000_000n, refundScriptPublicKey),
          ...Array.from({ length: batchCount }, (_, index) => new TransactionOutput(
            30_000_000n - feePerBatch - (index === 0 ? feeRemainder : 0n),
            mainnetRoundTrip
          ))
        ],
        lockTime: 474_175_565n,
        subnetworkId: "00".repeat(20),
        gas: 0n,
        payload: "",
        mass: 0n,
        storageMass: 0n
      });
      const requiredFee = calculateTransactionFee("mainnet", groupedRefund, 0);
      if (requiredFee === undefined || requiredFee > 60_000_000n) break;
      if (requiredFee <= refundFee) {
        converged = true;
        break;
      }
      refundFee = requiredFee;
    }
    if (converged) feasibleBatchCounts.push(batchCount);
  }
  assert(feasibleBatchCounts.length > 0, "grouped refunds retain at least one standard transaction for 0.3 KAS tickets");
  assert(feasibleBatchCounts.at(-1) < 13, "storage mass lowers the practical batch maximum for many small refund outputs");
  console.log(`0.3 KAS one-ticket outputs fit ${feasibleBatchCounts.at(-1)} purchase batches in one standard refund transaction.`);
} finally {
  await vite.close();
}

console.log("Mainnet offline construction checks passed.");
