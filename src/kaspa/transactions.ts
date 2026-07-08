import { createTransactions, type IUtxoEntry } from "@onekeyfe/kaspa-wasm";
import type { KaspaRpcConnection } from "./rpc";
import type { BrowserTestWallet } from "./wallet";
import { ensureKaspaWasmReady } from "./wasm";

export interface SendKaspaPaymentInput {
  connection: KaspaRpcConnection;
  wallet: BrowserTestWallet;
  toAddress: string;
  amountSompi: bigint;
  payload: Uint8Array;
}

export interface SendKaspaPaymentResult {
  txIds: string[];
  feeSompi: bigint;
  selectedUtxoCount: number;
}

function transactionNetworkId(network: string): string {
  return network === "testnet-12" ? "testnet-10" : network;
}

function selectPaymentEntries(entries: IUtxoEntry[], amountSompi: bigint): IUtxoEntry[] {
  const sorted = [...entries].sort((left, right) => {
    if (left.amount === right.amount) {
      return 0;
    }

    return left.amount < right.amount ? -1 : 1;
  });
  const selected: IUtxoEntry[] = [];
  let total = 0n;

  for (const entry of sorted) {
    selected.push(entry);
    total += entry.amount;

    if (total >= amountSompi + 1_000_000n) {
      return selected;
    }
  }

  throw new Error("Not enough spendable balance for this ticket.");
}

function normalizeTransactionError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("Storage mass exceeds maximum")) {
    return new Error("Ticket amount is below the current Toccata storage-mass minimum. Try 0.2 KAS or higher.");
  }

  return new Error(message || "Unable to submit Kaspa transaction.");
}

export async function sendKaspaPayment(input: SendKaspaPaymentInput): Promise<SendKaspaPaymentResult> {
  await ensureKaspaWasmReady();

  try {
    const utxos = await input.connection.client.getUtxosByAddresses({ addresses: [input.wallet.address] });
    const selectedEntries = selectPaymentEntries(utxos.entries ?? [], input.amountSompi);
    const { transactions } = await createTransactions({
      entries: selectedEntries,
      outputs: [{ address: input.toAddress, amount: input.amountSompi }],
      changeAddress: input.wallet.address,
      priorityFee: 0n,
      payload: input.payload,
      networkId: transactionNetworkId(input.wallet.network)
    });
    const txIds: string[] = [];
    let feeSompi = 0n;

    for (const transaction of transactions) {
      transaction.sign([input.wallet.privateKey], true);
      txIds.push(await transaction.submit(input.connection.client));
      feeSompi += transaction.feeAmount;
    }

    return {
      txIds,
      feeSompi,
      selectedUtxoCount: selectedEntries.length
    };
  } catch (error) {
    throw normalizeTransactionError(error);
  }
}
