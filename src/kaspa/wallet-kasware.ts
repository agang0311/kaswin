import {
  createConnectedWallet,
  fillSignedTransaction,
  serializeWalletTransaction,
  walletTransactionInputCount,
  type BrowserTestWallet,
  type KaspaWalletAdapter,
  type WalletSignableTransaction
} from "./wallet-types";

interface KasWareSignInput {
  index: number;
  sighashType: number;
}

interface KasWareProvider {
  requestAccounts(): Promise<string[]>;
  getAccounts(): Promise<string[]>;
  getPublicKey(): Promise<string>;
  signPskt(input: {
    txJsonString: string;
    options: { signInputs: KasWareSignInput[] };
  }): Promise<string | { txJsonString?: string; signedTx?: string }>;
  disconnect?(origin: string): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    kasware?: KasWareProvider;
  }
}

function provider(): KasWareProvider | undefined {
  return window.kasware;
}

function requiredProvider(): KasWareProvider {
  const walletProvider = provider();

  if (!walletProvider) {
    throw new Error("KasWare Wallet was not detected. Install or enable the KasWare browser extension, then refresh the page.");
  }

  return walletProvider;
}

function signedTransactionJson(result: string | { txJsonString?: string; signedTx?: string }): string {
  if (typeof result === "string") {
    return result;
  }

  const json = result.txJsonString ?? result.signedTx;

  if (!json) {
    throw new Error("KasWare did not return a signed transaction.");
  }

  return json;
}

async function signTransaction(
  walletProvider: KasWareProvider,
  transaction: WalletSignableTransaction,
  inputIndexes?: number[]
): Promise<void> {
  const inputCount = walletTransactionInputCount(transaction);
  const indexes = inputIndexes ?? Array.from({ length: inputCount }, (_, index) => index);
  const result = await walletProvider.signPskt({
    txJsonString: serializeWalletTransaction(transaction),
    options: {
      signInputs: indexes.map((index) => ({ index, sighashType: 1 }))
    }
  });
  fillSignedTransaction(transaction, signedTransactionJson(result), indexes);
}

async function walletFromAccounts(walletProvider: KasWareProvider, accounts: string[], network: string): Promise<BrowserTestWallet> {
  return createConnectedWallet({
    adapterId: "kasware",
    providerName: "KasWare",
    address: accounts[0] ?? "",
    publicKey: await walletProvider.getPublicKey(),
    network,
    signTransaction: (transaction, inputIndexes) => signTransaction(walletProvider, transaction, inputIndexes)
  });
}

export const kasWareWalletAdapter: KaspaWalletAdapter = {
  id: "kasware",
  name: "KasWare",
  isInstalled: () => Boolean(provider()),
  async connect(network) {
    const walletProvider = requiredProvider();
    return walletFromAccounts(walletProvider, await walletProvider.requestAccounts(), network);
  },
  async readConnected(network) {
    const walletProvider = provider();

    if (!walletProvider) {
      return null;
    }

    const accounts = await walletProvider.getAccounts();
    return accounts.length ? walletFromAccounts(walletProvider, accounts, network) : null;
  },
  async disconnect() {
    await provider()?.disconnect?.(window.location.origin);
  },
  subscribe(listener) {
    const walletProvider = provider();

    if (!walletProvider?.on) {
      return () => undefined;
    }

    const events = ["accountsChanged", "networkChanged", "balanceChanged", "disconnect"];
    events.forEach((event) => walletProvider.on?.(event, listener));
    return () => events.forEach((event) => walletProvider.removeListener?.(event, listener));
  }
};
