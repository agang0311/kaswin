import {
  createConnectedWallet,
  fillSignedTransaction,
  serializeWalletTransaction,
  type BrowserTestWallet,
  type KaspaWalletAdapter,
  type WalletSignableTransaction
} from "./wallet-types";

interface KastleAccount {
  address: string;
  publicKey: string;
}

interface KastleProvider {
  connect?(): Promise<boolean>;
  getAccount?(): Promise<KastleAccount>;
  signTx?(networkId: string, txJson: string): Promise<string | { txJson?: string; signedTx?: string }>;
  disconnect?(): Promise<unknown>;
  request?(method: string, args?: unknown): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    kastle?: KastleProvider;
  }
}

function provider(): KastleProvider | undefined {
  return window.kastle;
}

function signingNetworkId(network: string): string {
  return network === "testnet-12" ? "testnet-10" : network;
}

function requiredProvider(): KastleProvider {
  const walletProvider = provider();

  if (!walletProvider) {
    throw new Error("Kastle Wallet was not detected. Install or enable the Kastle browser extension, then refresh the page.");
  }

  return walletProvider;
}

async function requestAccount(walletProvider: KastleProvider): Promise<KastleAccount> {
  if (walletProvider.getAccount) {
    return walletProvider.getAccount();
  }

  if (walletProvider.request) {
    return walletProvider.request("kas:get_account") as Promise<KastleAccount>;
  }

  throw new Error("This Kastle version does not expose an account API.");
}

function signedTransactionJson(result: string | { txJson?: string; signedTx?: string }): string {
  if (typeof result === "string") {
    return result;
  }

  const json = result.txJson ?? result.signedTx;

  if (!json) {
    throw new Error("Kastle did not return a signed transaction.");
  }

  return json;
}

async function signTransaction(
  walletProvider: KastleProvider,
  network: string,
  transaction: WalletSignableTransaction,
  inputIndexes?: number[]
): Promise<void> {
  const txJson = serializeWalletTransaction(transaction);
  const networkId = signingNetworkId(network);
  const result = walletProvider.signTx
    ? await walletProvider.signTx(networkId, txJson)
    : await walletProvider.request?.("kas:sign_tx", { networkId, txJson });

  if (!result) {
    throw new Error("This Kastle version does not expose a transaction signing API.");
  }

  fillSignedTransaction(transaction, signedTransactionJson(result as string | { txJson?: string; signedTx?: string }), inputIndexes);
}

async function walletFromAccount(walletProvider: KastleProvider, account: KastleAccount, network: string): Promise<BrowserTestWallet> {
  return createConnectedWallet({
    adapterId: "kastle",
    providerName: "Kastle",
    address: account.address,
    publicKey: account.publicKey,
    network,
    signTransaction: (transaction, inputIndexes) => signTransaction(walletProvider, network, transaction, inputIndexes)
  });
}

export const kastleWalletAdapter: KaspaWalletAdapter = {
  id: "kastle",
  name: "Kastle",
  isInstalled: () => Boolean(provider()),
  async connect(network) {
    const walletProvider = requiredProvider();
    const connected = walletProvider.connect
      ? await walletProvider.connect()
      : await walletProvider.request?.("kas:connect");

    if (connected === false) {
      throw new Error("Kastle did not approve the wallet connection.");
    }

    return walletFromAccount(walletProvider, await requestAccount(walletProvider), network);
  },
  async readConnected(network) {
    const walletProvider = provider();

    if (!walletProvider) {
      return null;
    }

    try {
      return walletFromAccount(walletProvider, await requestAccount(walletProvider), network);
    } catch {
      return null;
    }
  },
  async disconnect() {
    await provider()?.disconnect?.();
  },
  subscribe(listener) {
    const walletProvider = provider();

    if (!walletProvider?.on) {
      return () => undefined;
    }

    const events = ["accountsChanged", "networkChanged", "balanceChanged", "disconnect", "kas:account_changed", "kas:network_changed"];
    events.forEach((event) => walletProvider.on?.(event, listener));
    return () => events.forEach((event) => walletProvider.removeListener?.(event, listener));
  }
};
