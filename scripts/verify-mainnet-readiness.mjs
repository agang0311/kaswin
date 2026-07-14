import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import initKaspaWasm, { addressFromScriptPublicKey, payToAddressScript, payToScriptHashScript } from "@onekeyfe/kaspa-wasm/kaspa.js";
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
} finally {
  await vite.close();
}

console.log("Mainnet offline construction checks passed.");
