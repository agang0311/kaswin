import { Encoding, RpcClient } from "@onekeyfe/kaspa-wasm";
import { ensureKaspaWasmReady } from "./wasm";

export interface KaspaNodeStatus {
  connected: boolean;
  network: string;
  syncStatus: "synced" | "syncing" | "unknown";
  daaScore?: string;
  latencyMs?: number;
  serverVersion?: string;
  hasUtxoIndex?: boolean;
}

export interface KaspaRpcConnection {
  client: RpcClient;
  status: KaspaNodeStatus;
}

function encodingForUrl(url: string): Encoding {
  return url.includes(":18110") || url.includes(":18210") ? Encoding.SerdeJson : Encoding.Borsh;
}

export async function connectBrowserRpc(url: string, network: string): Promise<KaspaRpcConnection> {
  if (!url.startsWith("ws://") && !url.startsWith("wss://")) {
    throw new Error("Kaspa browser RPC endpoints must use ws:// or wss://.");
  }

  await ensureKaspaWasmReady();

  const startedAt = performance.now();
  const client = new RpcClient({
    url,
    encoding: encodingForUrl(url),
    networkId: network
  });
  await client.connect();

  const serverInfo = await client.getServerInfo();
  const syncStatus = await client.getSyncStatus();
  return {
    client,
    status: {
      connected: true,
      network: serverInfo.networkId ?? network,
      syncStatus: syncStatus.isSynced ? "synced" : "syncing",
      daaScore: serverInfo.virtualDaaScore?.toString(),
      latencyMs: Math.round(performance.now() - startedAt),
      serverVersion: serverInfo.serverVersion,
      hasUtxoIndex: serverInfo.hasUtxoIndex
    }
  };
}

export async function disconnectBrowserRpc(connection: KaspaRpcConnection | null): Promise<void> {
  if (!connection) {
    return;
  }

  await connection.client.disconnect();
}

export async function getAddressBalanceSompi(connection: KaspaRpcConnection, address: string): Promise<bigint> {
  const response = await connection.client.getBalanceByAddress({ address });
  return BigInt(response.balance ?? "0");
}
