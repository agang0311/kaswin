import { Transaction, type PendingTransaction } from "@onekeyfe/kaspa-wasm";
import { pubkeyHexFromAddress } from "./covenant";

interface KasWareSignInput {
  index: number;
  sighashType: number;
}

export interface KasWareProvider {
  requestAccounts(): Promise<string[]>;
  getAccounts(): Promise<string[]>;
  getPublicKey(): Promise<string>;
  getNetwork?(): Promise<string | number>;
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

export interface BrowserTestWallet {
  id: string;
  address: string;
  network: string;
  publicKey: string;
  balanceSompi: bigint;
  providerName: "KasWare";
  signTransaction(transaction: PendingTransaction): Promise<void>;
}

export function getKasWareProvider(): KasWareProvider | undefined {
  return window.kasware;
}

function normalizedXOnlyPublicKey(publicKey: string): string {
  const normalized = publicKey.trim().toLowerCase();

  if (/^(02|03)[0-9a-f]{64}$/.test(normalized)) {
    return normalized.slice(2);
  }

  if (/^[0-9a-f]{64}$/.test(normalized)) {
    return normalized;
  }

  throw new Error("The connected wallet returned an invalid public key.");
}

function signedTransactionJson(result: string | { txJsonString?: string; signedTx?: string }): string {
  if (typeof result === "string") {
    return result;
  }

  const json = result.txJsonString ?? result.signedTx;

  if (!json) {
    throw new Error("The wallet did not return a signed transaction.");
  }

  return json;
}

async function fillWalletSignatures(provider: KasWareProvider, transaction: PendingTransaction): Promise<void> {
  const inputCount = transaction.transaction.inputs.length;
  const result = await provider.signPskt({
    txJsonString: transaction.serializeToSafeJSON(),
    options: {
      signInputs: Array.from({ length: inputCount }, (_, index) => ({ index, sighashType: 1 }))
    }
  });
  const signed = Transaction.deserializeFromSafeJSON(signedTransactionJson(result));

  if (signed.inputs.length !== inputCount) {
    throw new Error("The wallet returned a transaction with a different input count.");
  }

  signed.inputs.forEach((input, index) => {
    const signatureScript = input.signatureScript;

    if (!signatureScript?.length) {
      throw new Error(`The wallet did not sign transaction input ${index + 1}.`);
    }

    transaction.fillInput(index, signatureScript);
  });
}

async function walletFromAccounts(provider: KasWareProvider, accounts: string[], network: string): Promise<BrowserTestWallet> {
  const address = accounts[0]?.trim() ?? "";

  if (!address) {
    throw new Error("No KasWare account was selected.");
  }

  if (!address.startsWith("kaspatest:")) {
    throw new Error("Switch KasWare to a Kaspa testnet account before connecting.");
  }

  const publicKey = normalizedXOnlyPublicKey(await provider.getPublicKey());

  if (pubkeyHexFromAddress(address).toLowerCase() !== publicKey) {
    throw new Error("The wallet public key does not match the selected address.");
  }

  return {
    id: publicKey.slice(0, 16),
    address,
    network,
    publicKey,
    balanceSompi: 0n,
    providerName: "KasWare",
    signTransaction: (transaction) => fillWalletSignatures(provider, transaction)
  };
}

export async function connectKasWareWallet(network: string): Promise<BrowserTestWallet> {
  const provider = getKasWareProvider();

  if (!provider) {
    throw new Error("KasWare Wallet was not detected. Install or enable the KasWare browser extension, then refresh the page.");
  }

  return walletFromAccounts(provider, await provider.requestAccounts(), network);
}

export async function readConnectedKasWareWallet(network: string): Promise<BrowserTestWallet | null> {
  const provider = getKasWareProvider();

  if (!provider) {
    return null;
  }

  const accounts = await provider.getAccounts();
  return accounts.length ? walletFromAccounts(provider, accounts, network) : null;
}

export async function disconnectKasWareWallet(): Promise<void> {
  const provider = getKasWareProvider();

  if (provider?.disconnect) {
    await provider.disconnect(window.location.origin);
  }
}

export function withWalletBalance(wallet: BrowserTestWallet, balanceSompi: bigint): BrowserTestWallet {
  return {
    ...wallet,
    balanceSompi
  };
}
