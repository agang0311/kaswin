import {
  createInputSignature,
  PrivateKey,
  type PendingTransaction
} from "@onekeyfe/kaspa-wasm";
import { ensureKaspaWasmReady } from "./wasm";
import {
  createConnectedWallet,
  type BrowserTestWallet,
  type KaspaWalletAdapter,
  type WalletSignableTransaction
} from "./wallet-types";

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

function createLocalTestWalletAdapter(input: { id: string; name: string; wallet: "participant" | "outsider" }): KaspaWalletAdapter {
  let connectedWallet: BrowserTestWallet | null = null;
  let connectedPrivateKey = "";

  return {
    id: input.id,
    name: input.name,
    isInstalled: () => true,
    async connect(network) {
      await ensureKaspaWasmReady();
      const params = new URLSearchParams({ wallet: input.wallet, network });
      const response = await fetch(`/__kaspa_raffle_local_test_wallet?${params.toString()}`, { cache: "no-store" });

      if (!response.ok) {
        throw new Error("The local test wallet is unavailable from this development server.");
      }

      const privateKeyHex = (await response.text()).trim();

      const privateKey = new PrivateKey(privateKeyHex);
      const keypair = privateKey.toKeypair();
      connectedPrivateKey = privateKeyHex;
      connectedWallet = createConnectedWallet({
        adapterId: input.id,
        providerName: input.name,
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
}

export const localTestWalletAdapter = createLocalTestWalletAdapter({
  id: "local-test-key",
  name: "Local participant key",
  wallet: "participant"
});

export const localOutsiderWalletAdapter = createLocalTestWalletAdapter({
  id: "local-outsider-key",
  name: "Local outsider key",
  wallet: "outsider"
});
