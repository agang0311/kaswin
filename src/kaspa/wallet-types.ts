import { Transaction, type PendingTransaction } from "@onekeyfe/kaspa-wasm";
import { pubkeyHexFromAddress } from "./covenant";

export interface BrowserTestWallet {
  id: string;
  adapterId: string;
  address: string;
  network: string;
  publicKey: string;
  balanceSompi: bigint;
  providerName: string;
  signTransaction(transaction: PendingTransaction): Promise<void>;
}

export interface WalletAdapterOption {
  id: string;
  name: string;
  installed: boolean;
}

export interface KaspaWalletAdapter {
  id: string;
  name: string;
  isInstalled(): boolean;
  connect(network: string): Promise<BrowserTestWallet>;
  readConnected(network: string): Promise<BrowserTestWallet | null>;
  disconnect(): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export function normalizedXOnlyPublicKey(publicKey: string): string {
  const normalized = publicKey.trim().toLowerCase();

  if (/^(02|03)[0-9a-f]{64}$/.test(normalized)) {
    return normalized.slice(2);
  }

  if (/^[0-9a-f]{64}$/.test(normalized)) {
    return normalized;
  }

  throw new Error("The connected wallet returned an invalid public key.");
}

export function validateWalletAccount(address: string, publicKey: string, providerName: string): void {
  if (!address) {
    throw new Error(`No ${providerName} account was selected.`);
  }

  if (!address.startsWith("kaspatest:")) {
    throw new Error(`Switch ${providerName} to a Kaspa testnet account before connecting.`);
  }

  if (pubkeyHexFromAddress(address).toLowerCase() !== publicKey) {
    throw new Error(`${providerName} returned a public key that does not match the selected address.`);
  }
}

export function fillSignedTransaction(transaction: PendingTransaction, signedTransactionJson: string): void {
  const signed = Transaction.deserializeFromSafeJSON(signedTransactionJson);
  const inputCount = transaction.transaction.inputs.length;

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

export function createConnectedWallet(input: {
  adapterId: string;
  providerName: string;
  address: string;
  publicKey: string;
  network: string;
  signTransaction(transaction: PendingTransaction): Promise<void>;
}): BrowserTestWallet {
  const address = input.address.trim();
  const publicKey = normalizedXOnlyPublicKey(input.publicKey);
  validateWalletAccount(address, publicKey, input.providerName);

  return {
    id: `${input.adapterId}:${publicKey.slice(0, 16)}`,
    adapterId: input.adapterId,
    address,
    network: input.network,
    publicKey,
    balanceSompi: 0n,
    providerName: input.providerName,
    signTransaction: input.signTransaction
  };
}

export function withWalletBalance(wallet: BrowserTestWallet, balanceSompi: bigint): BrowserTestWallet {
  return {
    ...wallet,
    balanceSompi
  };
}
