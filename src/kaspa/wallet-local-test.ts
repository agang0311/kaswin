import {
  createInputSignature,
  PrivateKey,
  Transaction,
  type PendingTransaction
} from "@onekeyfe/kaspa-wasm";
import { ensureKaspaWasmReady } from "./wasm";
import {
  createConnectedWallet,
  serializeWalletTransaction,
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
  // The bundled WASM converter rejects a null covenant on a plain output when
  // the same transaction also has a bound successor. Sign an equivalent twin
  // whose absent optional bindings are omitted, then copy only the signature.
  let normalizedJson: string;
  try {
    normalizedJson = serializeWalletTransaction(transaction);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Local validation wallet could not normalize the mixed-output transaction before signing: ${message}`);
  }

  let signingTwin: Transaction;
  try {
    signingTwin = Transaction.deserializeFromSafeJSON(normalizedJson);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Local validation wallet could not deserialize the normalized mixed-output transaction: ${message}`);
  }

  try {
    transaction.inputs[inputIndex].signatureScript = createInputSignature(signingTwin, inputIndex, privateKey);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Local validation wallet could not sign the normalized mixed-output transaction: ${message}`);
  }
}

function createLocalTestWalletAdapter(input: { id: string; name: string; wallet: string }): KaspaWalletAdapter {
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

export const localValidationCreatorWalletAdapter = createLocalTestWalletAdapter({
  id: "local-validation-creator-key",
  name: "Local validation creator",
  wallet: "validation-creator"
});

export const localValidationBuyerAWalletAdapter = createLocalTestWalletAdapter({
  id: "local-validation-buyer-a-key",
  name: "Local validation buyer A",
  wallet: "validation-buyer-a"
});

export const localValidationBuyerBWalletAdapter = createLocalTestWalletAdapter({
  id: "local-validation-buyer-b-key",
  name: "Local validation buyer B",
  wallet: "validation-buyer-b"
});

export const localValidationBuyerCWalletAdapter = createLocalTestWalletAdapter({
  id: "local-validation-buyer-c-key",
  name: "Local validation buyer C",
  wallet: "validation-buyer-c"
});
