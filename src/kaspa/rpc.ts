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

const RESOLVER_LOOKUP_TIMEOUT_MS = 8_000;
const RPC_CONNECT_TIMEOUT_MS = 12_000;
const RPC_STATUS_TIMEOUT_MS = 8_000;

function encodingForUrl(url: string): Encoding {
  return url.includes(":18110") || url.includes(":18210") ? Encoding.SerdeJson : Encoding.Borsh;
}

async function withTimeout<T>(operation: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${Math.ceil(timeoutMs / 1_000)} seconds.`)), timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

export async function connectBrowserRpc(endpoint: KaspaRpcEndpoint, network: string): Promise<KaspaRpcConnection> {
  if (endpoint.mode === "custom" && !endpoint.url.startsWith("ws://") && !endpoint.url.startsWith("wss://")) {
    throw new Error("Kaspa browser RPC endpoints must use ws:// or wss://.");
  }

  await ensureKaspaWasmReady();

  const startedAt = performance.now();
  const resolvedUrl = endpoint.mode === "resolver"
    ? await withTimeout(new Resolver().getUrl(Encoding.Borsh, network), "Kaspa resolver lookup", RESOLVER_LOOKUP_TIMEOUT_MS)
    : endpoint.url;
  const client = new RpcClient({
    url: resolvedUrl,
    encoding: encodingForUrl(resolvedUrl),
    networkId: network
  });
  try {
    await withTimeout(client.connect(), "Kaspa RPC connection", RPC_CONNECT_TIMEOUT_MS);

    const serverInfo = await withTimeout(client.getServerInfo(), "Kaspa node information lookup", RPC_STATUS_TIMEOUT_MS);
    const syncStatus = await withTimeout(client.getSyncStatus(), "Kaspa sync-status lookup", RPC_STATUS_TIMEOUT_MS);
    return {
      client,
      status: {
        connected: true,
        network: serverInfo.networkId ?? network,
        endpointMode: endpoint.mode,
        endpointUrl: client.url ?? resolvedUrl,
        syncStatus: syncStatus.isSynced ? "synced" : "syncing",
        daaScore: serverInfo.virtualDaaScore?.toString(),
        latencyMs: Math.round(performance.now() - startedAt),
        serverVersion: serverInfo.serverVersion,
        hasUtxoIndex: serverInfo.hasUtxoIndex
      }
    };
  } catch (error) {
    await client.disconnect().catch(() => undefined);
    throw error;
  }
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
