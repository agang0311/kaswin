import {
  Address,
  CovenantBinding,
  createTransactions,
  GenesisCovenantGroup,
  Hash,
  addressFromScriptPublicKey,
  payToAddressScript,
  payToScriptHashScript,
  ScriptBuilder,
  Transaction,
  TransactionOutput,
  type IUtxoEntry
} from "@onekeyfe/kaspa-wasm";
import {
  assertRaffleRedeemScriptMatchesRound,
  buildRaffleAddress,
  buildRaffleBuySignatureScript,
  buildRaffleFinalizeSignatureScript,
  buildRaffleRefundBatch8SignatureScript,
  buildRaffleRefundNextSignatureScript,
  buildRaffleStartRefundSignatureScript,
  buildRaffleRedeemScript,
  buildRaffleScriptPublicKey,
  bytesToHex,
  getRaffleRefundRuntimeArtifact,
  getRaffleRuntimeArtifact,
  pubkeyHexFromAddress,
  raffleCovenantStateFromRound,
  raffleWinnerIndexFromSeed
} from "./covenant";
import type { KaspaRpcConnection } from "./rpc";
import type { ChainRandomnessWitness } from "./chain-randomness";
import { hexToBytes } from "../raffle/randomness";
import type { RaffleCovenantCursor, RoundState, TicketState } from "../raffle/types";
import { appendTicketLeaves, verifyTicketProof, verifyTicketRange8 } from "../raffle/merkle";
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

export interface RefundRaffleRegistryMarkerInput {
  connection: KaspaRpcConnection;
  registryAddress: string;
  markerTxId: string;
  refundAddress: string;
}

export interface CreateRaffleCovenantRoundInput {
  connection: KaspaRpcConnection;
  wallet: BrowserTestWallet;
  round: RoundState;
  carrierAmountSompi?: bigint;
  payload: Uint8Array;
}

export interface BuyRaffleCovenantTicketInput {
  connection: KaspaRpcConnection;
  wallet: BrowserTestWallet;
  round: RoundState;
  covenant: RaffleCovenantCursor;
  ticket: TicketState;
  ticketCount: number;
  payload: Uint8Array;
}

export interface FinalizeRaffleCovenantRoundInput {
  connection: KaspaRpcConnection;
  wallet: BrowserTestWallet;
  round: RoundState;
  covenant: RaffleCovenantCursor;
  randomnessWitness: ChainRandomnessWitness;
  winner: TicketState;
  winnerProofHex?: string;
  callerTicketId?: number;
  callerProofHex?: string;
  payload?: Uint8Array;
}

export interface RefundRaffleCovenantRoundInput {
  connection: KaspaRpcConnection;
  round: RoundState;
  covenant: RaffleCovenantCursor;
  tickets: TicketState[];
  ticket?: TicketState;
  ownerProofHex?: string;
  batchTickets?: TicketState[];
  rangeProofHex?: string;
  payload?: Uint8Array;
}

export interface RaffleCovenantSpendResult {
  txId: string;
  covenant?: RaffleCovenantCursor;
  winnerTicketId?: number;
  randomSeed?: string;
}

export const DEFAULT_RAFFLE_REGISTRY_MARKER_SOMPI = 5_000_000n;
export const REGISTRY_MARKER_REFUND_FEE_SOMPI = 100_000n;
export const REGISTRY_PAYMENT_FEE_SOMPI = 350_000n;
export const COVENANT_CREATE_FEE_SOMPI = 300_000n;
export const V9_COVENANT_BUY_FEE_SOMPI = 1_750_000n;
export const V9_COVENANT_FINALIZE_FEE_SOMPI = 5_000_000n;
export const REFUND_TRANSITION_FEE_SOMPI = 2_400_000n;
export const REFUND_BATCH_FEE_PER_TICKET_SOMPI = 150_000n;
export const REFUND_TAIL_FEE_PER_TICKET_SOMPI = 1_000_000n;
const STANDARD_REFUND_MIN_SOMPI = 5_000_000n;
export const MIN_COVENANT_CARRIER_SOMPI = 56_550_000n;
export const DEFAULT_COVENANT_CARRIER_SOMPI = 57_000_000n;
export const MAINNET_DEFAULT_RAFFLE_REGISTRY_ADDRESS =
  "kaspa:qzrhkehvwlzpzh8dv9ecl8eadayyzhrqlkcldzfzu32mrgv2m9npqpc4a6ugh";
const MANUAL_TX_FEE_SOMPI = COVENANT_CREATE_FEE_SOMPI;
const LOW_COST_FUNDING_MIN_SOMPI = 20_000_000n;
const SAFE_PAYMENT_CHANGE_SOMPI = 200_000_000n;
const RAFFLE_PARTICIPANT_AUTH_COMPUTE_BUDGET = 11;
const V9_RAFFLE_FINALIZE_COMPUTE_BUDGET = 300;
const REFUND_TRANSITION_COMPUTE_BUDGET = 4;
const REFUND_BATCH_COMPUTE_BUDGET = 5;
const REFUND_TAIL_COMPUTE_BUDGET = 4;

export function covenantBuyFeeSompi(_contractVersion: string, _ticketCount = 1): bigint {
  return V9_COVENANT_BUY_FEE_SOMPI;
}

export function covenantFinalizeFeeSompi(_contractVersion: string): bigint {
  return V9_COVENANT_FINALIZE_FEE_SOMPI;
}

export function covenantRefundFeeSompi(_contractVersion: string): bigint {
  return REFUND_BATCH_FEE_PER_TICKET_SOMPI;
}

function raffleBuyComputeBudget(ticketCount = 1): number {
  return 8 + (ticketCount === 8 ? 2 : ticketCount >= 2 ? 1 : 0);
}

function formatKasAmount(value: bigint): string {
  const whole = value / 100_000_000n;
  const fraction = (value % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${whole.toLocaleString()}${fraction ? `.${fraction}` : ""} KAS`;
}

const ZERO_SUBNETWORK_ID = "0000000000000000000000000000000000000000";
const LOW_COST_REDEEM_SCRIPT = new Uint8Array([0x51]);

export function transactionNetworkId(network: string): string {
  return network === "testnet-12" ? "testnet-10" : network;
}

function selectPaymentEntries(entries: IUtxoEntry[], amountSompi: bigint, minimumChangeSompi = SAFE_PAYMENT_CHANGE_SOMPI): IUtxoEntry[] {
  const sorted = [...entries].sort((left, right) => {
    if (left.amount === right.amount) {
      return 0;
    }

    return left.amount < right.amount ? -1 : 1;
  });
  const requiredAmount = amountSompi + MANUAL_TX_FEE_SOMPI;
  const singleEntry = sorted.find((entry) => {
    if (entry.amount < requiredAmount) {
      return false;
    }

    const remainder = entry.amount - requiredAmount;
    return remainder === 0n || remainder >= minimumChangeSompi;
  });

  if (singleEntry) {
    return [singleEntry];
  }

  const selected: IUtxoEntry[] = [];
  let total = 0n;

  for (const entry of sorted) {
    selected.push(entry);
    total += entry.amount;

    if (total >= requiredAmount + minimumChangeSompi) {
      return selected;
    }
  }

  throw new Error("Not enough spendable balance for this ticket.");
}

function normalizeTransactionError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("Storage mass exceeds maximum")) {
    return new Error(
      `A covenant or temporary funding output is below the current Toccata storage-mass minimum. Refresh the page and retry with the current build. The carrier reserve must be at least ${formatKasAmount(MIN_COVENANT_CARRIER_SOMPI)}.`
    );
  }

  if (message.includes("script units exceeded")) {
    const match = message.match(/used=(\d+), limit=(\d+)/);
    const detail = match ? ` Used ${match[1]}, committed ${match[2]}.` : "";

    return new Error(
      `The covenant input did not commit enough compute budget.${detail} Refresh the page and retry with the current build.`
    );
  }

  return new Error(message || "Unable to submit Kaspa transaction.");
}

function payloadHex(payload?: Uint8Array): string {
  return payload ? bytesToHex(payload) : "";
}

function asInputUtxo(entry: IUtxoEntry): IUtxoEntry {
  const looseEntry = entry as IUtxoEntry & {
    entry?: { covenantId?: { toString?: () => string } | string | null };
    covenantId?: { toString?: () => string } | string | null;
  };
  const covenantId = normalizeCovenantId(looseEntry.covenantId ?? looseEntry.entry?.covenantId);

  return {
    address: entry.address,
    outpoint: entry.outpoint,
    amount: entry.amount,
    scriptPublicKey: entry.scriptPublicKey,
    blockDaaScore: entry.blockDaaScore,
    isCoinbase: entry.isCoinbase,
    ...(covenantId ? { covenantId: new Hash(covenantId) } : {})
  } as IUtxoEntry;
}

function normalizeCovenantId(value: { toString?: () => string } | string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const text = typeof value === "string" ? value : value.toString?.();
  return text && /^[0-9a-fA-F]{64}$/.test(text) ? text : undefined;
}

function sameOutpoint(entry: IUtxoEntry, txId: string, outputIndex: number): boolean {
  return entry.outpoint.transactionId === txId && entry.outpoint.index === outputIndex;
}

function covenantOutpoint(covenant: RaffleCovenantCursor) {
  return { transactionId: covenant.txId, index: covenant.outputIndex };
}

function lowCostFundingSignatureScript(): string {
  const builder = new ScriptBuilder();

  builder.addData(LOW_COST_REDEEM_SCRIPT);
  return builder.drain();
}

function lowCostFundingAddress(network: string): string {
  const scriptPublicKey = payToScriptHashScript(LOW_COST_REDEEM_SCRIPT);
  const address = addressFromScriptPublicKey(scriptPublicKey, transactionNetworkId(network));

  if (!address) {
    throw new Error("Unable to derive low-cost covenant funding address.");
  }

  return address.toString();
}

export interface RaffleRegistryConfig {
  address: string;
  autoRefund: boolean;
}

export async function getRaffleRegistryConfig(network: string): Promise<RaffleRegistryConfig> {
  await ensureKaspaWasmReady();

  if (transactionNetworkId(network) === "mainnet") {
    return { address: MAINNET_DEFAULT_RAFFLE_REGISTRY_ADDRESS, autoRefund: false };
  }

  return { address: lowCostFundingAddress(network), autoRefund: true };
}

export async function getRaffleRegistryAddress(network: string): Promise<string> {
  return (await getRaffleRegistryConfig(network)).address;
}

export async function assertValidKaspaAddress(address: string, label = "Kaspa address"): Promise<void> {
  await ensureKaspaWasmReady();

  if (!Address.validate(address.trim())) {
    throw new Error(`${label} is not a valid Kaspa address.`);
  }
}

function lowCostFundingAmount(requiredAmount: bigint, feeReserve = MANUAL_TX_FEE_SOMPI): bigint {
  const amountWithFee = requiredAmount + feeReserve;
  return amountWithFee > LOW_COST_FUNDING_MIN_SOMPI ? amountWithFee : LOW_COST_FUNDING_MIN_SOMPI;
}

function requireAtLeastSompi(value: bigint, minimum: bigint, label: string): void {
  if (value < minimum) {
    throw new Error(`${label} is below the current safe Toccata storage-mass floor. Use at least ${formatKasAmount(minimum)}.`);
  }
}

async function refundLowCostFundingUtxo(
  connection: KaspaRpcConnection,
  stagingUtxo: IUtxoEntry,
  refundAddress: string,
  feeSompi = MANUAL_TX_FEE_SOMPI
): Promise<string> {
  const refundAmount = stagingUtxo.amount - feeSompi;

  if (refundAmount <= 0n) {
    throw new Error("Temporary funding UTXO is too small to refund.");
  }

  const tx = buildManualTransaction({
    inputs: [
      {
        previousOutpoint: stagingUtxo.outpoint,
        signatureScript: lowCostFundingSignatureScript(),
        sequence: 0n,
        sigOpCount: 0,
        utxo: asInputUtxo(stagingUtxo)
      }
    ],
    outputs: [new TransactionOutput(refundAmount, payToAddressScript(refundAddress))]
  });

  return submitTransaction(connection, tx);
}

async function getCurrentCovenantUtxo(connection: KaspaRpcConnection, covenant: RaffleCovenantCursor): Promise<IUtxoEntry> {
  return waitForAddressUtxo(connection, covenant.address, covenant.txId, covenant.outputIndex);
}

export async function currentRaffleCovenantDaaScore(
  connection: KaspaRpcConnection,
  covenant: RaffleCovenantCursor
): Promise<bigint> {
  const utxo = await getCurrentCovenantUtxo(connection, covenant);
  return BigInt(utxo.blockDaaScore);
}

async function waitForAddressUtxo(
  connection: KaspaRpcConnection,
  address: string,
  txId: string,
  outputIndex: number,
  timeoutMs = 60_000
): Promise<IUtxoEntry> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const utxos = await connection.client.getUtxosByAddresses({ addresses: [address] });
    const entry = (utxos.entries ?? []).find((candidate) => sameOutpoint(candidate, txId, outputIndex));

    if (entry) {
      return entry;
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error("Transaction output was not indexed in time. Wait a few seconds and retry.");
}

async function submitTransaction(connection: KaspaRpcConnection, tx: Transaction): Promise<string> {
  tx.finalize();
  const submitReadyTransaction = rpcTransactionObject(JSON.parse(tx.serializeToSafeJSON(), reviveTransactionBigInts));

  try {
    const result = await connection.client.submitTransaction({ transaction: submitReadyTransaction, allowOrphan: false } as never);
    return result.transactionId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (!message.includes("Slice must have the length of Hash")) {
      throw error;
    }

    const result = await connection.client.submitTransaction({ transaction: tx, allowOrphan: false });
    return result.transactionId;
  }
}

function rpcTransactionObject(serialized: {
  inputs?: Array<Record<string, unknown> & { transactionId?: string; index?: number }>;
  outputs?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}) {
  return {
    ...serialized,
    outputs: (serialized.outputs ?? []).map((output) => {
      const covenant = output.covenant;

      if (!covenant || typeof covenant !== "object") {
        const { covenant: _covenant, ...plainOutput } = output;
        void _covenant;
        return plainOutput;
      }

      return output;
    }),
    inputs: (serialized.inputs ?? []).map(({ transactionId, index, ...input }) => ({
      ...input,
      utxo:
        input.utxo && typeof input.utxo === "object"
          ? {
              ...(input.utxo as Record<string, unknown>),
              covenantId:
                typeof (input.utxo as { covenantId?: unknown }).covenantId === "string" &&
                /^[0-9a-fA-F]{64}$/.test((input.utxo as { covenantId: string }).covenantId)
                  ? new Hash((input.utxo as { covenantId: string }).covenantId)
                  : (input.utxo as { covenantId?: unknown }).covenantId,
              outpoint: { transactionId, index }
            }
          : input.utxo,
      previousOutpoint: { transactionId, index }
    }))
  };
}

function reviveTransactionBigInts(key: string, value: unknown): unknown {
  if (
    typeof value === "string" &&
    /^(amount|blockDaaScore|gas|lockTime|sequence|storageMass|value)$/.test(key) &&
    /^\d+$/.test(value)
  ) {
    return BigInt(value);
  }

  return value;
}

function buildManualTransaction(input: {
  inputs: unknown[];
  outputs: TransactionOutput[];
  payload?: Uint8Array;
  lockTime?: bigint;
}): Transaction {
  return new Transaction({
    version: 1,
    inputs: input.inputs,
    outputs: input.outputs,
    lockTime: input.lockTime ?? 0n,
    subnetworkId: ZERO_SUBNETWORK_ID,
    gas: 0n,
    payload: payloadHex(input.payload)
  } as never);
}

function bindSuccessorCovenant(tx: Transaction, covenantId: string): void {
  tx.outputs[0].covenant = new CovenantBinding(0, new Hash(covenantId));
}

function nextCovenantCursor(input: {
  previous: RaffleCovenantCursor;
  address: string;
  txId: string;
  amountSompi: bigint;
  redeemScript: Uint8Array;
  soldTickets: number;
  potAmount: bigint;
  status: RoundState["status"];
  ticketRoot: string;
  ticketFrontier?: string;
  chainSearchHintHash?: string;
  refundCursor?: number;
  creatorPubkey: string;
  refundAfterDaaScore: string;
  soldBatches: number;
  ticketBatchEnds: number[];
  ticketOwnerPubkeys: string[];
}): RaffleCovenantCursor {
  return {
    covenantId: input.previous.covenantId,
    address: input.address,
    txId: input.txId,
    outputIndex: 0,
    amountSompi: input.amountSompi.toString(),
    redeemScriptHex: bytesToHex(input.redeemScript),
    soldTickets: input.soldTickets,
    potAmount: input.potAmount.toString(),
    status: input.status,
    ticketRoot: input.ticketRoot,
    ticketFrontier: input.ticketFrontier,
    chainSearchHintHash: input.chainSearchHintHash ?? input.previous.chainSearchHintHash,
    refundCursor: input.refundCursor,
    creatorPubkey: input.creatorPubkey,
    refundAfterDaaScore: input.refundAfterDaaScore,
    soldBatches: input.soldBatches,
    ticketBatchEnds: input.ticketBatchEnds,
    ticketOwnerPubkeys: input.ticketOwnerPubkeys
  };
}

function covenantSoldBatches(covenant: RaffleCovenantCursor): number {
  return covenant.soldBatches ?? covenant.ticketOwnerPubkeys.length;
}

function covenantBatchEnds(covenant: RaffleCovenantCursor): number[] {
  return covenant.ticketBatchEnds ?? covenant.ticketOwnerPubkeys.map((_, index) => index + 1);
}

export async function sendKaspaPayment(input: SendKaspaPaymentInput): Promise<SendKaspaPaymentResult> {
  await ensureKaspaWasmReady();

  try {
    const stagingAmount = lowCostFundingAmount(input.amountSompi, REGISTRY_PAYMENT_FEE_SOMPI);
    const stagingAddress = lowCostFundingAddress(input.wallet.network);
    const utxos = await input.connection.client.getUtxosByAddresses({ addresses: [input.wallet.address] });
    const selectedEntries = selectPaymentEntries(utxos.entries ?? [], stagingAmount);
    const { transactions } = await createTransactions({
      entries: selectedEntries,
      outputs: [{ address: stagingAddress, amount: stagingAmount }],
      changeAddress: input.wallet.address,
      priorityFee: 0n,
      networkId: transactionNetworkId(input.wallet.network)
    });
    const stagingTransaction = transactions[0];

    if (!stagingTransaction) {
      throw new Error("Unable to build registry funding transaction.");
    }

    await input.wallet.signTransaction(stagingTransaction);
    const stagingTxId = await stagingTransaction.submit(input.connection.client);
    const stagingUtxo = await waitForAddressUtxo(input.connection, stagingAddress, stagingTxId, 0);
    const changeAmount = stagingAmount - input.amountSompi - REGISTRY_PAYMENT_FEE_SOMPI;
    const outputs = [new TransactionOutput(input.amountSompi, payToAddressScript(input.toAddress))];

    if (changeAmount >= STANDARD_REFUND_MIN_SOMPI) {
      outputs.push(new TransactionOutput(changeAmount, payToAddressScript(input.wallet.address)));
    }

    const markerTx = buildManualTransaction({
      inputs: [
        {
          previousOutpoint: stagingUtxo.outpoint,
          signatureScript: lowCostFundingSignatureScript(),
          sequence: 0n,
          sigOpCount: 0,
          utxo: asInputUtxo(stagingUtxo)
        }
      ],
      outputs,
      payload: input.payload
    });
    let markerTxId: string;

    try {
      markerTxId = await submitTransaction(input.connection, markerTx);
    } catch (error) {
      let refundTxId = "";

      try {
        refundTxId = await refundLowCostFundingUtxo(input.connection, stagingUtxo, input.wallet.address);
      } catch {
        // Preserve the marker error; the staging output remains spendable by the low-cost script.
      }

      const normalized = normalizeTransactionError(error);
      throw new Error(refundTxId ? `${normalized.message} Temporary funding was refunded in ${refundTxId}.` : normalized.message);
    }

    return {
      txIds: [stagingTxId, markerTxId],
      feeSompi: stagingTransaction.feeAmount + REGISTRY_PAYMENT_FEE_SOMPI,
      selectedUtxoCount: selectedEntries.length
    };
  } catch (error) {
    throw normalizeTransactionError(error);
  }
}

export async function refundRaffleRegistryMarker(input: RefundRaffleRegistryMarkerInput): Promise<string> {
  await ensureKaspaWasmReady();

  try {
    const markerUtxo = await waitForAddressUtxo(input.connection, input.registryAddress, input.markerTxId, 0);

    return refundLowCostFundingUtxo(
      input.connection,
      markerUtxo,
      input.refundAddress,
      REGISTRY_MARKER_REFUND_FEE_SOMPI
    );
  } catch (error) {
    throw normalizeTransactionError(error);
  }
}

export async function createRaffleCovenantRound(input: CreateRaffleCovenantRoundInput): Promise<RaffleCovenantSpendResult> {
  await ensureKaspaWasmReady();

  try {
    const state = await raffleCovenantStateFromRound(input.round);
    const runtimeArtifact = getRaffleRuntimeArtifact(input.round.contractVersion);
    const redeemScript = buildRaffleRedeemScript(state, runtimeArtifact);
    const covenantAddress = await buildRaffleAddress(state, input.wallet.network, runtimeArtifact);
    const covenantScriptPublicKey = await buildRaffleScriptPublicKey(state, runtimeArtifact);
    const carrierAmount = input.carrierAmountSompi ?? DEFAULT_COVENANT_CARRIER_SOMPI;

    requireAtLeastSompi(carrierAmount, MIN_COVENANT_CARRIER_SOMPI, "Covenant carrier");

    const stagingAmount = lowCostFundingAmount(carrierAmount);
    const stagingAddress = lowCostFundingAddress(input.wallet.network);
    const utxos = await input.connection.client.getUtxosByAddresses({ addresses: [input.wallet.address] });
    const selectedEntries = selectPaymentEntries(utxos.entries ?? [], stagingAmount);
    const { transactions } = await createTransactions({
      entries: selectedEntries,
      outputs: [{ address: stagingAddress, amount: stagingAmount }],
      changeAddress: input.wallet.address,
      priorityFee: 0n,
      networkId: transactionNetworkId(input.wallet.network)
    });
    const stagingTransaction = transactions[0];

    if (!stagingTransaction) {
      throw new Error("Unable to build covenant funding transaction.");
    }

    await input.wallet.signTransaction(stagingTransaction);
    const stagingTxId = await stagingTransaction.submit(input.connection.client);
    const stagingUtxo = await waitForAddressUtxo(input.connection, stagingAddress, stagingTxId, 0);

    const tx = buildManualTransaction({
      inputs: [
        {
          previousOutpoint: stagingUtxo.outpoint,
          signatureScript: lowCostFundingSignatureScript(),
          sequence: 0n,
          sigOpCount: 0,
          utxo: asInputUtxo(stagingUtxo)
        }
      ],
      outputs: [new TransactionOutput(carrierAmount, covenantScriptPublicKey)],
      payload: input.payload
    });

    tx.populateGenesisCovenants([new GenesisCovenantGroup(0, [0])]);

    const covenantId = (tx.serializeToObject() as {
      outputs?: Array<{ covenant?: { covenantId?: string } }>;
    }).outputs?.[0]?.covenant?.covenantId;

    if (!covenantId) {
      throw new Error("Unable to derive genesis covenant id.");
    }

    let txId: string;

    try {
      txId = await submitTransaction(input.connection, tx);
    } catch (error) {
      let refundTxId = "";

      try {
        refundTxId = await refundLowCostFundingUtxo(input.connection, stagingUtxo, input.wallet.address);
      } catch {
        // Keep the original covenant error visible; the staging UTXO remains spendable by the low-cost script.
      }

      const normalized = normalizeTransactionError(error);
      throw new Error(refundTxId ? `${normalized.message} Temporary funding was refunded in ${refundTxId}.` : normalized.message);
    }

    return {
      txId,
      covenant: {
        covenantId,
        address: covenantAddress,
        txId,
        outputIndex: 0,
        amountSompi: carrierAmount.toString(),
        redeemScriptHex: bytesToHex(redeemScript),
        soldTickets: 0,
        potAmount: "0",
        status: "Open",
        ticketRoot: input.round.ticketRoot,
        ticketFrontier: input.round.ticketFrontier,
        refundCursor: input.round.refundCursor ?? 0,
        creatorPubkey: input.round.creatorPubkey,
        refundAfterDaaScore: input.round.refundAfterDaaScore,
        soldBatches: 0,
        ticketBatchEnds: [],
        ticketOwnerPubkeys: []
      }
    };
  } catch (error) {
    throw normalizeTransactionError(error);
  }
}
export async function buyRaffleCovenantTicket(input: BuyRaffleCovenantTicketInput): Promise<RaffleCovenantSpendResult> {
  await ensureKaspaWasmReady();

  try {
    const currentRound: RoundState = {
      ...input.round,
      soldTickets: input.covenant.soldTickets,
      potAmount: BigInt(input.covenant.potAmount),
      status: "Open",
      ticketRoot: input.covenant.ticketRoot,
      ticketFrontier: input.covenant.ticketFrontier,
      refundCursor: input.covenant.refundCursor ?? 0,
      creatorPubkey: input.covenant.creatorPubkey,
      refundAfterDaaScore: input.covenant.refundAfterDaaScore,
      soldBatches: covenantSoldBatches(input.covenant),
      ticketBatchEnds: covenantBatchEnds(input.covenant),
      ticketOwnerPubkeys: input.covenant.ticketOwnerPubkeys
    };

    await assertRaffleRedeemScriptMatchesRound(currentRound, input.covenant.redeemScriptHex, "Buy");

    if (!Number.isInteger(input.ticketCount) || input.ticketCount < 1) {
      throw new Error("Ticket quantity must be a positive integer.");
    }

    if (input.ticketCount > 8) {
      throw new Error("A single purchase can contain at most 8 tickets.");
    }

    if (input.covenant.soldTickets + input.ticketCount > input.round.maxTickets) {
      throw new Error("Ticket quantity exceeds the remaining tickets in this round.");
    }

    const currentAmount = BigInt(input.covenant.amountSompi);
    const purchaseAmount = input.round.ticketPrice * BigInt(input.ticketCount);
    const successorAmount = currentAmount + purchaseAmount;

    requireAtLeastSompi(
      successorAmount,
      MIN_COVENANT_CARRIER_SOMPI,
      "Next covenant output"
    );

    const covenantUtxo = await getCurrentCovenantUtxo(input.connection, input.covenant);
    const chainSearchHintHash = (await input.connection.client.getBlockDagInfo()).sink;
    const walletUtxos = await input.connection.client.getUtxosByAddresses({ addresses: [input.wallet.address] });
    const buyFee = covenantBuyFeeSompi(input.round.contractVersion, input.ticketCount);
    const stagingAmount = lowCostFundingAmount(purchaseAmount, buyFee);
    const stagingAddress = lowCostFundingAddress(input.wallet.network);
    const walletEntries = selectPaymentEntries(walletUtxos.entries ?? [], stagingAmount);
    const { transactions } = await createTransactions({
      entries: walletEntries,
      outputs: [{ address: stagingAddress, amount: stagingAmount }],
      changeAddress: input.wallet.address,
      priorityFee: 0n,
      networkId: transactionNetworkId(input.wallet.network)
    });
    const stagingTransaction = transactions[0];

    if (!stagingTransaction) {
      throw new Error("Unable to build ticket funding transaction.");
    }

    await input.wallet.signTransaction(stagingTransaction);
    const stagingTxId = await stagingTransaction.submit(input.connection.client);
    const stagingUtxo = await waitForAddressUtxo(input.connection, stagingAddress, stagingTxId, 0);
    const buyerPubkey = pubkeyHexFromAddress(input.wallet.address);
    const merkleAppend = await appendTicketLeaves(
      input.covenant.ticketFrontier || "",
      input.covenant.soldTickets,
      buyerPubkey,
      input.ticketCount
    );
    const nextTicketRoot = merkleAppend.rootHex;
    const ticketOwnerPubkeys: string[] = [];
    const ticketBatchEnds: number[] = [];
    const nextRound: RoundState = {
      ...input.round,
      soldTickets: input.covenant.soldTickets + input.ticketCount,
      soldBatches: 0,
      ticketBatchEnds,
      potAmount: input.round.potAmount + purchaseAmount,
      status: "Open",
      ticketRoot: nextTicketRoot,
      ticketFrontier: merkleAppend.frontierHex,
      refundCursor: input.covenant.refundCursor ?? 0,
      ticketOwnerPubkeys
    };
    const nextState = await raffleCovenantStateFromRound(nextRound);
    const runtimeArtifact = getRaffleRuntimeArtifact(nextRound.contractVersion);
    const nextRedeemScript = buildRaffleRedeemScript(nextState, runtimeArtifact);
    const nextScriptPublicKey = await buildRaffleScriptPublicKey(nextState, runtimeArtifact);
    const nextAddress = await buildRaffleAddress(nextState, input.wallet.network, runtimeArtifact);
    const outputs = [
      new TransactionOutput(successorAmount, nextScriptPublicKey)
    ];
    const fundingRefundAmount = stagingAmount - purchaseAmount - buyFee;

    if (fundingRefundAmount >= STANDARD_REFUND_MIN_SOMPI) {
      outputs.push(new TransactionOutput(fundingRefundAmount, payToAddressScript(input.wallet.address)));
    }

    const tx = buildManualTransaction({
      inputs: [
        {
          previousOutpoint: covenantOutpoint(input.covenant),
          signatureScript: buildRaffleBuySignatureScript(
            hexToBytes(input.covenant.redeemScriptHex),
            buyerPubkey,
            input.ticketCount
          ),
          sequence: 0n,
          sigOpCount: 0,
          computeBudget: raffleBuyComputeBudget(input.ticketCount),
          utxo: asInputUtxo(covenantUtxo)
        },
        {
          previousOutpoint: stagingUtxo.outpoint,
          signatureScript: lowCostFundingSignatureScript(),
          sequence: 0n,
          sigOpCount: 0,
          utxo: asInputUtxo(stagingUtxo)
        }
      ],
      outputs,
      payload: input.payload
    });
    bindSuccessorCovenant(tx, input.covenant.covenantId);

    let txId: string;

    try {
      txId = await submitTransaction(input.connection, tx);
    } catch (error) {
      let refundTxId = "";

      try {
        refundTxId = await refundLowCostFundingUtxo(input.connection, stagingUtxo, input.wallet.address);
      } catch {
        // Keep the original covenant error visible; the staging UTXO remains spendable by the low-cost script.
      }

      const normalized = normalizeTransactionError(error);
      throw new Error(refundTxId ? `${normalized.message} Temporary funding was refunded in ${refundTxId}.` : normalized.message);
    }

    return {
      txId,
      covenant: nextCovenantCursor({
        previous: input.covenant,
        address: nextAddress,
        txId,
        amountSompi: successorAmount,
        redeemScript: nextRedeemScript,
        soldTickets: nextRound.soldTickets,
        potAmount: nextRound.potAmount,
        status: "Open",
        ticketRoot: nextTicketRoot,
        ticketFrontier: nextRound.ticketFrontier,
        chainSearchHintHash,
        refundCursor: nextRound.refundCursor,
        creatorPubkey: input.covenant.creatorPubkey,
        refundAfterDaaScore: input.covenant.refundAfterDaaScore,
        soldBatches: nextRound.soldBatches,
        ticketBatchEnds,
        ticketOwnerPubkeys
      })
    };
  } catch (error) {
    throw normalizeTransactionError(error);
  }
}

export async function finalizeRaffleCovenantRound(input: FinalizeRaffleCovenantRoundInput): Promise<RaffleCovenantSpendResult> {
  await ensureKaspaWasmReady();

  try {
    const activeRound: RoundState = {
      ...input.round,
      soldTickets: input.covenant.soldTickets,
      potAmount: BigInt(input.covenant.potAmount),
      status: "Open",
      ticketRoot: input.covenant.ticketRoot,
      ticketFrontier: input.covenant.ticketFrontier,
      refundCursor: input.covenant.refundCursor ?? 0,
      creatorPubkey: input.covenant.creatorPubkey,
      refundAfterDaaScore: input.covenant.refundAfterDaaScore,
      soldBatches: covenantSoldBatches(input.covenant),
      ticketBatchEnds: covenantBatchEnds(input.covenant),
      ticketOwnerPubkeys: input.covenant.ticketOwnerPubkeys
    };

    await assertRaffleRedeemScriptMatchesRound(activeRound, input.covenant.redeemScriptHex, "Finalize");

    const covenantUtxo = await getCurrentCovenantUtxo(input.connection, input.covenant);
    const callerPubkey = pubkeyHexFromAddress(input.wallet.address);

    if (input.callerTicketId === undefined || !input.callerProofHex) {
      throw new Error("A participant ticket proof is required to draw this round.");
    }
    if (!await verifyTicketProof(activeRound.ticketRoot, callerPubkey, input.callerTicketId, input.callerProofHex)) {
      throw new Error("The caller ticket proof does not belong to the connected wallet.");
    }

    const walletUtxos = await input.connection.client.getUtxosByAddresses({ addresses: [input.wallet.address] });
    const authorizationUtxo = [...(walletUtxos.entries ?? [])]
      .filter((entry) => entry.amount >= STANDARD_REFUND_MIN_SOMPI)
      .sort((left, right) => left.amount === right.amount ? 0 : left.amount > right.amount ? -1 : 1)[0];

    if (!authorizationUtxo) {
      throw new Error(`The participant wallet needs a spendable UTXO of at least ${formatKasAmount(STANDARD_REFUND_MIN_SOMPI)} to authorize the draw. It is returned unchanged.`);
    }

    const randomSeed = input.randomnessWitness.randomSeedHex;
    const winnerIndex = raffleWinnerIndexFromSeed(randomSeed, input.covenant.soldTickets);

    if (winnerIndex + 1 !== input.winner.ticketId) {
      throw new Error("Selected winner does not match the covenant random seed.");
    }

    const winnerPubkey = input.winner.ownerPubkey || pubkeyHexFromAddress(input.winner.owner);
    if (!input.winnerProofHex || !await verifyTicketProof(activeRound.ticketRoot, winnerPubkey, winnerIndex, input.winnerProofHex)) {
      throw new Error("The winner ticket proof does not match the covenant ticket root.");
    }

    const currentAmount = BigInt(input.covenant.amountSompi);

    if (currentAmount < activeRound.potAmount) {
      throw new Error("Covenant UTXO does not contain enough funds for the prize.");
    }

    const winnerScriptPublicKey = payToAddressScript(input.winner.owner);
    const outputs = [new TransactionOutput(activeRound.potAmount, winnerScriptPublicKey)];
    const creatorRefundAmount = currentAmount - activeRound.potAmount - covenantFinalizeFeeSompi(activeRound.contractVersion);

    if (creatorRefundAmount < STANDARD_REFUND_MIN_SOMPI || !activeRound.creator || activeRound.creator === "no-wallet") {
      throw new Error("Covenant carrier refund is too small or the creator address is missing.");
    }

    outputs.push(new TransactionOutput(creatorRefundAmount, payToAddressScript(activeRound.creator)));
    const callerScriptPublicKey = payToAddressScript(input.wallet.address);
    outputs.push(new TransactionOutput(authorizationUtxo.amount, callerScriptPublicKey));

    const tx = buildManualTransaction({
      inputs: [
        {
          previousOutpoint: covenantOutpoint(input.covenant),
          signatureScript: buildRaffleFinalizeSignatureScript(
            hexToBytes(input.covenant.redeemScriptHex),
            input.randomnessWitness,
            winnerIndex,
            winnerScriptPublicKey,
            callerScriptPublicKey,
            input.winnerProofHex,
            input.callerTicketId,
            input.callerProofHex
          ),
          sequence: 0n,
          sigOpCount: 0,
          computeBudget: V9_RAFFLE_FINALIZE_COMPUTE_BUDGET,
          utxo: asInputUtxo(covenantUtxo)
        },
        {
          previousOutpoint: authorizationUtxo.outpoint,
          signatureScript: "",
          sequence: 0n,
          sigOpCount: 0,
          computeBudget: RAFFLE_PARTICIPANT_AUTH_COMPUTE_BUDGET,
          utxo: asInputUtxo(authorizationUtxo)
        }
      ],
      outputs,
      payload: input.payload,
      lockTime: input.covenant.soldTickets >= input.round.maxTickets
        ? 0n
        : BigInt(input.covenant.refundAfterDaaScore)
    });
    tx.finalize();
    await input.wallet.signTransaction(tx, [1]);
    const txId = await submitTransaction(input.connection, tx);

    return {
      txId,
      winnerTicketId: input.winner.ticketId,
      randomSeed
    };
  } catch (error) {
    throw normalizeTransactionError(error);
  }
}

export async function refundRaffleCovenantRound(input: RefundRaffleCovenantRoundInput): Promise<RaffleCovenantSpendResult> {
  await ensureKaspaWasmReady();

  try {
    const currentRound: RoundState = {
      ...input.round,
      soldTickets: input.covenant.soldTickets,
      potAmount: BigInt(input.covenant.potAmount),
      status: input.covenant.status,
      ticketRoot: input.covenant.ticketRoot,
      ticketFrontier: input.covenant.ticketFrontier,
      refundCursor: input.covenant.refundCursor ?? 0,
      creatorPubkey: input.covenant.creatorPubkey,
      refundAfterDaaScore: input.covenant.refundAfterDaaScore,
      soldBatches: covenantSoldBatches(input.covenant),
      ticketBatchEnds: covenantBatchEnds(input.covenant),
      ticketOwnerPubkeys: input.covenant.ticketOwnerPubkeys
    };

    await assertRaffleRedeemScriptMatchesRound(currentRound, input.covenant.redeemScriptHex, "Refund");

    const covenantUtxo = await getCurrentCovenantUtxo(input.connection, input.covenant);
    const currentAmount = BigInt(input.covenant.amountSompi);
    const refundArtifact = getRaffleRefundRuntimeArtifact();

      if (input.covenant.status !== "Refunding") {
        const nextRound: RoundState = { ...currentRound, status: "Refunding", refundCursor: 0 };
        const nextState = await raffleCovenantStateFromRound(nextRound);
        const nextRedeemScript = buildRaffleRedeemScript(nextState, refundArtifact);
        const nextScriptPublicKey = await buildRaffleScriptPublicKey(nextState, refundArtifact);
        const nextAddress = await buildRaffleAddress(nextState, input.connection.status.network, refundArtifact);
        const nextAmount = currentAmount - REFUND_TRANSITION_FEE_SOMPI;
        if (nextAmount <= 0n) throw new Error("The covenant carrier is too small to start batch refunds.");
        const tx = buildManualTransaction({
          inputs: [{
            previousOutpoint: covenantOutpoint(input.covenant),
            signatureScript: buildRaffleStartRefundSignatureScript(hexToBytes(input.covenant.redeemScriptHex)),
            sequence: 0n,
            sigOpCount: 0,
            computeBudget: REFUND_TRANSITION_COMPUTE_BUDGET,
            utxo: asInputUtxo(covenantUtxo)
          }],
          outputs: [new TransactionOutput(nextAmount, nextScriptPublicKey)],
          payload: input.payload,
          lockTime: BigInt(input.covenant.refundAfterDaaScore)
        });
        bindSuccessorCovenant(tx, input.covenant.covenantId);
        const txId = await submitTransaction(input.connection, tx);
        return {
          txId,
          covenant: nextCovenantCursor({
            previous: input.covenant,
            address: nextAddress,
            txId,
            amountSompi: nextAmount,
            redeemScript: nextRedeemScript,
            soldTickets: input.covenant.soldTickets,
            potAmount: BigInt(input.covenant.potAmount),
            status: "Refunding",
            ticketRoot: currentRound.ticketRoot,
            ticketFrontier: currentRound.ticketFrontier,
            refundCursor: 0,
            creatorPubkey: currentRound.creatorPubkey,
            refundAfterDaaScore: currentRound.refundAfterDaaScore,
            soldBatches: 0,
            ticketBatchEnds: [],
            ticketOwnerPubkeys: []
          })
        };
      }

      const refundCursor = input.covenant.refundCursor ?? 0;
      const remaining = input.covenant.soldTickets - refundCursor;
      if (remaining <= 0) throw new Error("There are no tickets left to refund.");

      if (remaining >= 8) {
        if (refundCursor % 8 !== 0) throw new Error("Batch refund cursor must be aligned to 8 tickets.");
        const batch = input.batchTickets;
        if (!batch || batch.length !== 8 || !input.rangeProofHex) {
          throw new Error(`Tickets #${refundCursor + 1}-${refundCursor + 8} and their range proof are required for the next refund batch.`);
        }
        const ownerPubkeys = batch.map((ticket, index) => {
          if (ticket.ticketId !== refundCursor + index + 1) throw new Error("Refund batch tickets are not contiguous.");
          return ticket.ownerPubkey || pubkeyHexFromAddress(ticket.owner);
        });
        if (!await verifyTicketRange8(currentRound.ticketRoot, ownerPubkeys, refundCursor, input.rangeProofHex)) {
          throw new Error("The 8-ticket refund batch does not match the covenant ticket root.");
        }
        const refundAmount = currentRound.ticketPrice - REFUND_BATCH_FEE_PER_TICKET_SOMPI;
        if (refundAmount < STANDARD_REFUND_MIN_SOMPI) throw new Error("Ticket price is too small for batch refund outputs.");
        const nextCursorValue = refundCursor + 8;
        const hasSuccessor = nextCursorValue < input.covenant.soldTickets;
        const outputs: TransactionOutput[] = [];
        let nextRedeemScript: Uint8Array | undefined;
        let nextAddress = "";
        if (hasSuccessor) {
          const nextRound: RoundState = { ...currentRound, status: "Refunding", refundCursor: nextCursorValue };
          const nextState = await raffleCovenantStateFromRound(nextRound);
          nextRedeemScript = buildRaffleRedeemScript(nextState, refundArtifact);
          nextAddress = await buildRaffleAddress(nextState, input.connection.status.network, refundArtifact);
          outputs.push(new TransactionOutput(currentAmount - currentRound.ticketPrice * 8n, await buildRaffleScriptPublicKey(nextState, refundArtifact)));
        }
        for (const ticket of batch) outputs.push(new TransactionOutput(refundAmount, payToAddressScript(ticket.owner)));
        if (!hasSuccessor) outputs.push(new TransactionOutput(currentAmount - currentRound.ticketPrice * 8n, payToAddressScript(currentRound.creator)));
        const tx = buildManualTransaction({
          inputs: [{
            previousOutpoint: covenantOutpoint(input.covenant),
            signatureScript: buildRaffleRefundBatch8SignatureScript(hexToBytes(input.covenant.redeemScriptHex), ownerPubkeys, input.rangeProofHex),
            sequence: 0n,
            sigOpCount: 0,
            computeBudget: REFUND_BATCH_COMPUTE_BUDGET,
            utxo: asInputUtxo(covenantUtxo)
          }],
          outputs,
          payload: input.payload,
          lockTime: BigInt(input.covenant.refundAfterDaaScore)
        });
        if (hasSuccessor) bindSuccessorCovenant(tx, input.covenant.covenantId);
        const txId = await submitTransaction(input.connection, tx);
        return {
          txId,
          covenant: hasSuccessor && nextRedeemScript ? nextCovenantCursor({
            previous: input.covenant,
            address: nextAddress,
            txId,
            amountSompi: currentAmount - currentRound.ticketPrice * 8n,
            redeemScript: nextRedeemScript,
            soldTickets: input.covenant.soldTickets,
            potAmount: BigInt(input.covenant.potAmount) - currentRound.ticketPrice * 8n,
            status: "Refunding",
            ticketRoot: currentRound.ticketRoot,
            ticketFrontier: currentRound.ticketFrontier,
            refundCursor: nextCursorValue,
            creatorPubkey: currentRound.creatorPubkey,
            refundAfterDaaScore: currentRound.refundAfterDaaScore,
            soldBatches: 0,
            ticketBatchEnds: [],
            ticketOwnerPubkeys: []
          }) : undefined
        };
      }

      const ticket = input.ticket;
      if (!ticket || !input.ownerProofHex || ticket.ticketId !== refundCursor + 1) {
        throw new Error(`Ticket #${refundCursor + 1} and its Merkle proof are required for the next tail refund.`);
      }
      const ownerPubkey = ticket.ownerPubkey || pubkeyHexFromAddress(ticket.owner);
      if (!await verifyTicketProof(currentRound.ticketRoot, ownerPubkey, refundCursor, input.ownerProofHex)) {
        throw new Error(`Ticket #${ticket.ticketId} does not match the covenant ticket root.`);
      }
      const refundAmount = currentRound.ticketPrice - REFUND_TAIL_FEE_PER_TICKET_SOMPI;
      const hasSuccessor = refundCursor + 1 < input.covenant.soldTickets;
      const outputs: TransactionOutput[] = [];
      let nextRedeemScript: Uint8Array | undefined;
      let nextAddress = "";
      if (hasSuccessor) {
        const nextRound: RoundState = { ...currentRound, status: "Refunding", refundCursor: refundCursor + 1 };
        const nextState = await raffleCovenantStateFromRound(nextRound);
        nextRedeemScript = buildRaffleRedeemScript(nextState, refundArtifact);
        nextAddress = await buildRaffleAddress(nextState, input.connection.status.network, refundArtifact);
        outputs.push(new TransactionOutput(currentAmount - currentRound.ticketPrice, await buildRaffleScriptPublicKey(nextState, refundArtifact)));
        outputs.push(new TransactionOutput(refundAmount, payToAddressScript(ticket.owner)));
      } else {
        outputs.push(new TransactionOutput(refundAmount, payToAddressScript(ticket.owner)));
        outputs.push(new TransactionOutput(currentAmount - currentRound.ticketPrice, payToAddressScript(currentRound.creator)));
      }
      const tx = buildManualTransaction({
        inputs: [{
          previousOutpoint: covenantOutpoint(input.covenant),
          signatureScript: buildRaffleRefundNextSignatureScript(hexToBytes(input.covenant.redeemScriptHex), refundCursor, ownerPubkey, input.ownerProofHex),
          sequence: 0n,
          sigOpCount: 0,
          computeBudget: REFUND_TAIL_COMPUTE_BUDGET,
          utxo: asInputUtxo(covenantUtxo)
        }],
        outputs,
        payload: input.payload,
        lockTime: BigInt(input.covenant.refundAfterDaaScore)
      });
      if (hasSuccessor) bindSuccessorCovenant(tx, input.covenant.covenantId);
      const txId = await submitTransaction(input.connection, tx);
      return {
        txId,
        covenant: hasSuccessor && nextRedeemScript ? nextCovenantCursor({
          previous: input.covenant,
          address: nextAddress,
          txId,
          amountSompi: currentAmount - currentRound.ticketPrice,
          redeemScript: nextRedeemScript,
          soldTickets: input.covenant.soldTickets,
          potAmount: BigInt(input.covenant.potAmount) - currentRound.ticketPrice,
          status: "Refunding",
          ticketRoot: currentRound.ticketRoot,
          ticketFrontier: currentRound.ticketFrontier,
          refundCursor: refundCursor + 1,
          creatorPubkey: currentRound.creatorPubkey,
          refundAfterDaaScore: currentRound.refundAfterDaaScore,
          soldBatches: 0,
          ticketBatchEnds: [],
          ticketOwnerPubkeys: []
        }) : undefined
      };
  } catch (error) {
    throw normalizeTransactionError(error);
  }
}
