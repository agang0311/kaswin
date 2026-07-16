import { Encoding, Resolver, RpcClient } from "@onekeyfe/kaspa-wasm";
import { ensureKaspaWasmReady } from "./wasm";

export type KaspaRpcEndpoint =
  | { mode: "resolver" }
  | { mode: "custom"; url: string };

export interface KaspaNodeStatus {
  connected: boolean;
  network: string;
  endpointMode?: KaspaRpcEndpoint["mode"];
  endpointUrl?: string;
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

export async function connectBrowserRpc(endpoint: KaspaRpcEndpoint, network: string): Promise<KaspaRpcConnection> {
  if (endpoint.mode === "custom" && !endpoint.url.startsWith("ws://") && !endpoint.url.startsWith("wss://")) {
    throw new Error("Kaspa browser RPC endpoints must use ws:// or wss://.");
  }

  await ensureKaspaWasmReady();

  const startedAt = performance.now();
  const client = endpoint.mode === "resolver"
    ? new RpcClient({
        resolver: new Resolver(),
        encoding: Encoding.Borsh,
        networkId: network
      })
    : new RpcClient({
        url: endpoint.url,
        encoding: encodingForUrl(endpoint.url),
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
      endpointMode: endpoint.mode,
      endpointUrl: client.url ?? (endpoint.mode === "custom" ? endpoint.url : undefined),
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
