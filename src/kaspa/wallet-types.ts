import type { PendingTransaction, Transaction } from "@onekeyfe/kaspa-wasm";
import { pubkeyHexFromAddress } from "./covenant";
import { requireNetworkProfile } from "./networks";

export type WalletSignableTransaction = PendingTransaction | Transaction;

export interface BrowserTestWallet {
  id: string;
  adapterId: string;
  address: string;
  network: string;
  publicKey: string;
  balanceSompi: bigint;
  providerName: string;
  signTransaction(transaction: WalletSignableTransaction, inputIndexes?: number[]): Promise<void>;
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

export function validateWalletAccount(address: string, publicKey: string, providerName: string, network: string): void {
  if (!address) {
    throw new Error(`No ${providerName} account was selected.`);
  }

  const profile = requireNetworkProfile(network);

  if (!address.startsWith(profile.addressPrefix)) {
    throw new Error(`Switch ${providerName} to ${profile.label} before connecting.`);
  }

  if (pubkeyHexFromAddress(address).toLowerCase() !== publicKey) {
    throw new Error(`${providerName} returned a public key that does not match the selected address.`);
  }
}

function underlyingTransaction(transaction: WalletSignableTransaction): Transaction {
  return "transaction" in transaction ? transaction.transaction : transaction;
}

export function serializeWalletTransaction(transaction: WalletSignableTransaction): string {
  return normalizeWalletTransactionJson(transaction.serializeToSafeJSON());
}

export function normalizeWalletTransactionJson(serialized: string): string {
  const value = JSON.parse(serialized) as {
    inputs?: Array<Record<string, unknown> & { utxo?: Record<string, unknown> }>;
    outputs?: Array<Record<string, unknown>>;
    [key: string]: unknown;
  };

  return JSON.stringify({
    ...value,
    inputs: (value.inputs ?? []).map((input) => {
      if (!input.utxo || typeof input.utxo !== "object" || typeof input.utxo.covenantId === "string") return input;
      const { covenantId: _covenantId, ...utxo } = input.utxo;
      void _covenantId;
      return { ...input, utxo };
    }),
    outputs: (value.outputs ?? []).map((output) => {
      if (output.covenant && typeof output.covenant === "object") return output;
      const { covenant: _covenant, ...plainOutput } = output;
      void _covenant;
      return plainOutput;
    })
  });
}

export function walletTransactionInputCount(transaction: WalletSignableTransaction): number {
  return underlyingTransaction(transaction).inputs.length;
}

export function walletSignatureScriptsFromJson(
  signedTransactionJson: string,
  expectedInputCount: number,
  inputIndexes?: number[]
): Array<{ index: number; signatureScript: string }> {
  let value: { inputs?: Array<{ signatureScript?: unknown }> };
  try {
    value = JSON.parse(signedTransactionJson) as { inputs?: Array<{ signatureScript?: unknown }> };
  } catch {
    throw new Error("The wallet returned invalid signed transaction JSON.");
  }

  if (!Array.isArray(value.inputs) || value.inputs.length !== expectedInputCount) {
    throw new Error("The wallet returned a transaction with a different input count.");
  }

  const indexes = inputIndexes ?? Array.from({ length: expectedInputCount }, (_, index) => index);
  return indexes.map((index) => {
    const signatureScript = value.inputs?.[index]?.signatureScript;
    if (typeof signatureScript !== "string" || !/^(?:[0-9a-fA-F]{2})+$/.test(signatureScript)) {
      throw new Error(`The wallet did not sign transaction input ${index + 1}.`);
    }
    return { index, signatureScript };
  });
}

export function fillSignedTransaction(
  transaction: WalletSignableTransaction,
  signedTransactionJson: string,
  inputIndexes?: number[]
): void {
  const target = underlyingTransaction(transaction);
  const inputCount = target.inputs.length;
  const signatures = walletSignatureScriptsFromJson(signedTransactionJson, inputCount, inputIndexes);
  signatures.forEach(({ index, signatureScript }) => {
    if ("fillInput" in transaction) {
      transaction.fillInput(index, signatureScript);
    } else {
      target.inputs[index].signatureScript = signatureScript;
    }
  });
}

export function createConnectedWallet(input: {
  adapterId: string;
  providerName: string;
  address: string;
  publicKey: string;
  network: string;
  signTransaction(transaction: WalletSignableTransaction, inputIndexes?: number[]): Promise<void>;
}): BrowserTestWallet {
  const address = input.address.trim();
  const publicKey = normalizedXOnlyPublicKey(input.publicKey);
  validateWalletAccount(address, publicKey, input.providerName, input.network);

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
