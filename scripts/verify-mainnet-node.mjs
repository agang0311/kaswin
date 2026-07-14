import fs from "node:fs";
import path from "node:path";
import { Encoding, RpcClient, initSync } from "@onekeyfe/kaspa-wasm/kaspa.js";

const rpcUrl = process.env.KASPA_MAINNET_RPC_URL || "ws://127.0.0.1:18110";
const walletAddress = process.env.KASPA_MAINNET_ADDRESS?.trim();
const activationDaa = 474_165_565n;

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`PASS ${message}`);
}

initSync({ module: fs.readFileSync(path.resolve("node_modules/@onekeyfe/kaspa-wasm/kaspa_bg.wasm.bin")) });

const client = new RpcClient({
  url: rpcUrl,
  encoding: Encoding.SerdeJson,
  networkId: "mainnet"
});

try {
  await client.connect();
  const [server, dag] = await Promise.all([client.getServerInfo(), client.getBlockDagInfo()]);
  assert(server.networkId === "mainnet", "node reports Mainnet");
  assert(server.isSynced, "Mainnet node is synced");
  assert(server.hasUtxoIndex, "Mainnet node has the UTXO index required by wallets");
  assert(dag.virtualDaaScore >= activationDaa, "Mainnet node is past Toccata activation");
  const walletBalance = walletAddress
    ? await client.getBalanceByAddress({ address: walletAddress })
    : undefined;
  console.log(JSON.stringify({
    rpc: rpcUrl,
    serverVersion: server.serverVersion,
    networkId: server.networkId,
    virtualDaaScore: dag.virtualDaaScore.toString(),
    sink: dag.sink,
    walletAddress,
    walletBalanceSompi: walletBalance?.balance.toString()
  }, null, 2));
} finally {
  await client.disconnect().catch(() => undefined);
}
