import {
  createInputSignature,
  PrivateKey,
  type PendingTransaction,
  type Transaction
} from "@onekeyfe/kaspa-wasm";
import { ensureKaspaWasmReady } from "./wasm";
import {
  createConnectedWallet,
  type BrowserTestWallet,
  type KaspaWalletAdapter,
  type WalletSignableTransaction
} from "./wallet-types";

let connectedWallet: BrowserTestWallet | null = null;
let connectedPrivateKey = "";

function isPendingTransaction(transaction: WalletSignableTransaction): transaction is PendingTransaction {
  return "transaction" in transaction;
}

function signLocalTransaction(
  transaction: WalletSignableTransaction,
  privateKeyHex: string,
  inputIndexes?: number[]
): void {
  if (isPendingTransaction(transaction)) {
    if (!inputIndexes) {
      transaction.sign([privateKeyHex], true);
      return;
    }

    const privateKey = new PrivateKey(privateKeyHex);
    inputIndexes.forEach((index) => transaction.signInput(index, privateKey));
    return;
  }

  const privateKey = new PrivateKey(privateKeyHex);
  const inputIndex = inputIndexes?.[0] ?? 0;
  transaction.inputs[inputIndex].signatureScript = createInputSignature(transaction, inputIndex, privateKey);
}

export const localTestWalletAdapter: KaspaWalletAdapter = {
  id: "local-test-key",
  name: "Local test key",
  isInstalled: () => true,
  async connect(network) {
    await ensureKaspaWasmReady();
    const response = await fetch("/__kaspa_raffle_local_test_wallet", { cache: "no-store" });

    if (!response.ok) {
      throw new Error("The local test wallet is unavailable from this development server.");
    }

    const privateKeyHex = (await response.text()).trim();

    const privateKey = new PrivateKey(privateKeyHex);
    const keypair = privateKey.toKeypair();
    connectedPrivateKey = privateKeyHex;
    connectedWallet = createConnectedWallet({
      adapterId: "local-test-key",
      providerName: "Local test key",
      address: keypair.toAddress(network).toString(),
      publicKey: keypair.publicKey,
      network,
      signTransaction: async (transaction, inputIndexes) => {
        if (!connectedPrivateKey) {
          throw new Error("The local test wallet is no longer connected.");
        }

        signLocalTransaction(transaction, connectedPrivateKey, inputIndexes);
      }
    });
    return connectedWallet;
  },
  async readConnected() {
    return connectedWallet;
  },
  async disconnect() {
    connectedPrivateKey = "";
    connectedWallet = null;
  },
  subscribe() {
    return () => undefined;
  }
};
