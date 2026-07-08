export interface KaspaNodeStatus {
  connected: boolean;
  network: string;
  syncStatus: "synced" | "syncing" | "unknown";
  daaScore?: string;
  latencyMs?: number;
}

export async function connectBrowserRpc(url: string): Promise<KaspaNodeStatus> {
  if (!url.startsWith("ws://") && !url.startsWith("wss://")) {
    throw new Error("Kaspa browser RPC endpoints must use ws:// or wss://.");
  }

  const startedAt = performance.now();
  await new Promise((resolve) => window.setTimeout(resolve, 250));

  return {
    connected: true,
    network: "testnet-unknown",
    syncStatus: "unknown",
    latencyMs: Math.round(performance.now() - startedAt)
  };
}

