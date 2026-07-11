import { kasWareWalletAdapter } from "./wallet-kasware";
import { kastleWalletAdapter } from "./wallet-kastle";
import type { BrowserTestWallet, KaspaWalletAdapter, WalletAdapterOption } from "./wallet-types";

const adapters: KaspaWalletAdapter[] = [kasWareWalletAdapter, kastleWalletAdapter];

if (import.meta.env.DEV) {
  const { localOutsiderWalletAdapter, localTestWalletAdapter } = await import("./wallet-local-test");
  adapters.push(localTestWalletAdapter, localOutsiderWalletAdapter);
}

function adapterById(adapterId: string): KaspaWalletAdapter {
  const adapter = adapters.find((candidate) => candidate.id === adapterId);

  if (!adapter) {
    throw new Error(`Unsupported wallet adapter: ${adapterId}`);
  }

  return adapter;
}

export function listWalletAdapters(): WalletAdapterOption[] {
  return adapters.map((adapter) => ({
    id: adapter.id,
    name: adapter.name,
    installed: adapter.isInstalled()
  }));
}

export function connectBrowserWallet(adapterId: string, network: string): Promise<BrowserTestWallet> {
  return adapterById(adapterId).connect(network);
}

export function readConnectedBrowserWallet(wallet: Pick<BrowserTestWallet, "adapterId">, network: string): Promise<BrowserTestWallet | null> {
  return adapterById(wallet.adapterId).readConnected(network);
}

export function disconnectBrowserWallet(wallet: Pick<BrowserTestWallet, "adapterId">): Promise<void> {
  return adapterById(wallet.adapterId).disconnect();
}

export function subscribeBrowserWallet(wallet: Pick<BrowserTestWallet, "adapterId">, listener: () => void): () => void {
  return adapterById(wallet.adapterId).subscribe(listener);
}

export { withWalletBalance } from "./wallet-types";
export type { BrowserTestWallet, WalletAdapterOption } from "./wallet-types";
