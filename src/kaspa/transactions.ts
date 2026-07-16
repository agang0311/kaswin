import {
  Address,
  calculateTransactionFee,
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
  buildRaffleRefundBatchSignatureScript,
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
import { appendTicketBatch, isTicketBatchSize, verifyTicketBatchProof } from "../raffle/merkle";
import { ticketRangeCount } from "../raffle/tickets";
import {
  LEGACY_RAFFLE_CONTRACT_VERSION,
  PREVIOUS_RAFFLE_CONTRACT_VERSION,
  RAFFLE_CONTRACT_VERSION
} from "../raffle/metadata";
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
  chainSearchHintHash?: string;
  payload: Uint8Array;
}

export interface FinalizeRaffleCovenantRoundInput {
  connection: KaspaRpcConnection;
  round: RoundState;
  covenant: RaffleCovenantCursor;
  randomnessWitness: ChainRandomnessWitness;
  winner: TicketState;
  winnerTicketId: number;
  winnerBatchIndex: number;
  winnerProofHex?: string;
  payload?: Uint8Array;
}

export interface RefundRaffleCovenantRoundInput {
  connection: KaspaRpcConnection;
  sponsorWallet?: BrowserTestWallet;
  round: RoundState;
  covenant: RaffleCovenantCursor;
  tickets: TicketState[];
  ticket?: TicketState;
  batchIndex?: number;
  ownerProofHex?: string;
  refundBatches?: Array<{
    ticket: TicketState;
    batchIndex: number;
    ownerProofHex: string;
  }>;
  payload?: Uint8Array;
}

export interface RaffleCovenantSpendResult {
  txId: string;
  feeSompi?: bigint;
  covenant?: RaffleCovenantCursor;
  winnerTicketId?: number;
  randomSeed?: string;
  refundedTicketCount?: number;
  refundedBatchCount?: number;
}

export const DEFAULT_RAFFLE_REGISTRY_MARKER_SOMPI = 5_000_000n;
export const REGISTRY_MARKER_REFUND_FEE_SOMPI = 100_000n;
export const REGISTRY_PAYMENT_FEE_SOMPI = 350_000n;
export const COVENANT_CREATE_FEE_SOMPI = 300_000n;
export const COVENANT_BUY_FEE_SOMPI = 1_750_000n;
export const ESTIMATED_COVENANT_FINALIZE_FEE_SOMPI = 6_000_000n;
export const MAX_COVENANT_FINALIZE_FEE_SOMPI = 20_000_000n;
export const REFUND_TRANSITION_FEE_SOMPI = 2_400_000n;
export const MAX_REFUND_TRANSITION_FEE_SOMPI = 20_000_000n;
export const LEGACY_REFUND_TRANSITION_SPONSOR_SOMPI = 5_000_000n;
export const ESTIMATED_REFUND_BATCH_FEE_SOMPI = 4_000_000n;
const LEGACY_MAX_REFUND_BATCH_FEE_SOMPI = 20_000_000n;
export const MAX_REFUND_BATCH_FEE_SOMPI = 60_000_000n;
export const MAX_REFUND_PURCHASE_BATCHES_PER_TX = 13;
const STANDARD_REFUND_MIN_SOMPI = 5_000_000n;
export const MIN_COVENANT_CARRIER_SOMPI = 56_550_000n;
export const DEFAULT_COVENANT_CARRIER_SOMPI = 57_000_000n;
export const MAINNET_DEFAULT_RAFFLE_REGISTRY_ADDRESS =
  "kaspa:qzrhkehvwlzpzh8dv9ecl8eadayyzhrqlkcldzfzu32mrgv2m9npqpc4a6ugh";
const MANUAL_TX_FEE_SOMPI = COVENANT_CREATE_FEE_SOMPI;
const LOW_COST_FUNDING_MIN_SOMPI = 20_000_000n;
const SAFE_PAYMENT_CHANGE_SOMPI = 200_000_000n;
const RAFFLE_FINALIZE_COMPUTE_BUDGET = 200;
const LEGACY_REFUND_TRANSITION_COMPUTE_BUDGET = 4;
const GROUPED_REFUND_TRANSITION_COMPUTE_BUDGET = 150;
const LEGACY_REFUND_BATCH_COMPUTE_BUDGET = 100;
const NORMALIZED_TRANSIENT_GRAMS_PER_BYTE = 2n;
const MIN_RELAY_FEE_SOMPI_PER_GRAM = 100n;

export function covenantBuyFeeSompi(_contractVersion: string, _ticketCount = 1): bigint {
  return COVENANT_BUY_FEE_SOMPI;
}

export function covenantFinalizeFeeSompi(_contractVersion: string): bigint {
  return ESTIMATED_COVENANT_FINALIZE_FEE_SOMPI;
}

export function covenantRefundFeeSompi(contractVersion: string, batchCount = 1): bigint {
  if (contractVersion === LEGACY_RAFFLE_CONTRACT_VERSION) return ESTIMATED_REFUND_BATCH_FEE_SOMPI;
  return BigInt(refundBatchComputeBudget(contractVersion, Math.max(1, Math.min(MAX_REFUND_PURCHASE_BATCHES_PER_TX, batchCount)))) * 100_000n;
}

export function covenantRefundMaxFeeSompi(contractVersion: string): bigint {
  return contractVersion === LEGACY_RAFFLE_CONTRACT_VERSION
    ? LEGACY_MAX_REFUND_BATCH_FEE_SOMPI
    : MAX_REFUND_BATCH_FEE_SOMPI;
}

function raffleBuyComputeBudget(_ticketCount = 1): number {
  return 12;
}

function refundTransitionComputeBudget(contractVersion: string): number {
  return contractVersion === RAFFLE_CONTRACT_VERSION || contractVersion === PREVIOUS_RAFFLE_CONTRACT_VERSION
    ? GROUPED_REFUND_TRANSITION_COMPUTE_BUDGET
    : LEGACY_REFUND_TRANSITION_COMPUTE_BUDGET;
}

function refundBatchComputeBudget(contractVersion: string, batchCount: number): number {
  if (contractVersion === LEGACY_RAFFLE_CONTRACT_VERSION) return LEGACY_REFUND_BATCH_COMPUTE_BUDGET;
  if (contractVersion !== RAFFLE_CONTRACT_VERSION && contractVersion !== PREVIOUS_RAFFLE_CONTRACT_VERSION) {
    throw new Error(`Unsupported refund contract version: ${contractVersion}.`);
  }
  return Math.min(470, 15 + batchCount * 35);
}

function formatKasAmount(value: bigint): string {
  const whole = value / 100_000_000n;
  const fraction = (value % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${whole.toLocaleString()}${fraction ? `.${fraction}` : ""} KAS`;
}

function scriptPublicKeyLength(scriptPublicKey: { toJSON(): unknown }): number {
  const json = scriptPublicKey.toJSON() as { script?: string };
  if (!json.script || json.script.length % 2 !== 0) {
    throw new Error("Unable to measure the transaction output script.");
  }
  return json.script.length / 2;
}

function minimumV1TransientRelayFeeSompi(input: {
  signatureScriptHex: string;
  outputScriptLengths: number[];
  payloadLength: number;
}): bigint {
  const signatureScriptLength = input.signatureScriptHex.length / 2;
  if (!Number.isInteger(signatureScriptLength)) {
    throw new Error("Unable to measure the covenant signature script.");
  }

  let size = 2 + 8;
  size += 36 + 8 + signatureScriptLength + 8 + 2;
  size += 8;
  size += input.outputScriptLengths.reduce((total, scriptLength) => total + 8 + 2 + 8 + scriptLength, 0);
  size += 8 + 20 + 8 + 32 + 8 + input.payloadLength;

  return BigInt(size) * NORMALIZED_TRANSIENT_GRAMS_PER_BYTE * MIN_RELAY_FEE_SOMPI_PER_GRAM;
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

  if (/block [0-9a-f]{64} not selected/i.test(message)) {
    return new Error(
      "The selected-chain witness changed before relay. Retry Draw & pay to rebuild the transaction with the current on-chain randomness block."
    );
  }

  return new Error(message || "Unable to submit Kaspa transaction.");
}

export function requiredFeeFromNodeRejection(error: unknown): bigint | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/fees which is under the required amount of (\d+)/i);
  return match ? BigInt(match[1]) : undefined;
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

async function createLegacyRefundTransitionSponsorUtxo(
  connection: KaspaRpcConnection,
  wallet: BrowserTestWallet,
  amountSompi: bigint
): Promise<IUtxoEntry> {
  requireAtLeastSompi(amountSompi, STANDARD_REFUND_MIN_SOMPI, "Legacy refund fee sponsor");
  const utxos = await connection.client.getUtxosByAddresses({ addresses: [wallet.address] });
  const selectedEntries = selectPaymentEntries(utxos.entries ?? [], amountSompi);
  const { transactions } = await createTransactions({
    entries: selectedEntries,
    outputs: [{ address: wallet.address, amount: amountSompi }],
    changeAddress: wallet.address,
    priorityFee: 0n,
    networkId: transactionNetworkId(wallet.network)
  });
  const fundingTransaction = transactions[0];
  if (!fundingTransaction) throw new Error("Unable to create the legacy refund fee sponsor output.");

  await wallet.signTransaction(fundingTransaction);
  const txId = await fundingTransaction.submit(connection.client);
  return waitForAddressTransactionAmount(connection, wallet.address, txId, amountSompi);
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

async function waitForAddressTransactionAmount(
  connection: KaspaRpcConnection,
  address: string,
  txId: string,
  amount: bigint,
  timeoutMs = 60_000
): Promise<IUtxoEntry> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const utxos = await connection.client.getUtxosByAddresses({ addresses: [address] });
    const entry = (utxos.entries ?? []).find((candidate) => candidate.outpoint.transactionId === txId && candidate.amount === amount);
    if (entry) return entry;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error("Legacy refund fee sponsor output was not indexed in time. Wait a few seconds and retry.");
}

async function submitTransaction(connection: KaspaRpcConnection, tx: Transaction): Promise<string> {
  tx.finalize();
  try {
    const result = await connection.client.submitTransaction({ transaction: tx, allowOrphan: false });
    return result.transactionId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Error converting property `covenant`")) throw error;

    // This WASM release cannot convert a Transaction containing both bound and
    // unbound outputs. Its plain RPC converter works when absent bindings are
    // omitted and bound covenant ids remain hex strings.
    const serialized = JSON.parse(tx.serializeToSafeJSON(), reviveTransactionBigInts);
    const result = await connection.client.submitTransaction({
      transaction: rpcTransactionObjectForSubmit(serialized),
      allowOrphan: false
    } as never);
    return result.transactionId;
  }
}

export function rpcTransactionObjectForSubmit(serialized: {
  inputs?: Array<Record<string, unknown> & { transactionId?: string; index?: number }>;
  outputs?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}) {
  return {
    ...serialized,
    outputs: (serialized.outputs ?? []).map((output) => {
      if (output.covenant && typeof output.covenant === "object") return output;
      const { covenant: _covenant, ...plainOutput } = output;
      void _covenant;
      return plainOutput;
    }),
    inputs: (serialized.inputs ?? []).map(({ transactionId, index, ...input }) => {
      const previousOutpoint = { transactionId, index };
      if (!input.utxo || typeof input.utxo !== "object") return { ...input, previousOutpoint };

      const { covenantId, ...utxo } = input.utxo as Record<string, unknown>;
      return {
        ...input,
        utxo: {
          ...utxo,
          ...(typeof covenantId === "string" && /^[0-9a-fA-F]{64}$/.test(covenantId) ? { covenantId } : {}),
          outpoint: previousOutpoint
        },
        previousOutpoint
      };
    })
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
  refundBatchCursor?: number;
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
    refundBatchCursor: input.refundBatchCursor,
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
        chainSearchHintHash: input.round.chainSearchHintHash,
        refundCursor: input.round.refundCursor ?? 0,
        refundBatchCursor: input.round.refundBatchCursor ?? 0,
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
      refundBatchCursor: input.covenant.refundBatchCursor ?? 0,
      creatorPubkey: input.covenant.creatorPubkey,
      refundAfterDaaScore: input.covenant.refundAfterDaaScore,
      soldBatches: covenantSoldBatches(input.covenant),
      ticketBatchEnds: covenantBatchEnds(input.covenant),
      ticketOwnerPubkeys: input.covenant.ticketOwnerPubkeys
    };

    await assertRaffleRedeemScriptMatchesRound(currentRound, input.covenant.redeemScriptHex, "Buy");

    if (!isTicketBatchSize(input.ticketCount)) {
      throw new Error("A purchase must contain a positive whole number of tickets no greater than 1000000.");
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
    const currentChainHash = input.chainSearchHintHash ?? (await input.connection.client.getBlockDagInfo()).sink;
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
    const nextBatchIndex = covenantSoldBatches(input.covenant);
    const merkleAppend = await appendTicketBatch(
      input.covenant.ticketFrontier || "",
      nextBatchIndex,
      buyerPubkey,
      input.covenant.soldTickets,
      input.ticketCount
    );
    const nextTicketRoot = merkleAppend.rootHex;
    const ticketOwnerPubkeys = [...input.covenant.ticketOwnerPubkeys, buyerPubkey];
    const ticketBatchEnds = [...(input.covenant.ticketBatchEnds ?? []), input.covenant.soldTickets + input.ticketCount];
    const nextRound: RoundState = {
      ...input.round,
      soldTickets: input.covenant.soldTickets + input.ticketCount,
      soldBatches: nextBatchIndex + 1,
      ticketBatchEnds,
      potAmount: input.round.potAmount + purchaseAmount,
      status: "Open",
      ticketRoot: nextTicketRoot,
      ticketFrontier: merkleAppend.frontierHex,
      refundCursor: input.covenant.refundCursor ?? 0,
      refundBatchCursor: input.covenant.refundBatchCursor ?? 0,
      ticketOwnerPubkeys
    };
    const chainSearchHintHash = nextRound.soldTickets === input.round.maxTickets
      ? currentChainHash
      : input.covenant.chainSearchHintHash ?? currentChainHash;
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
        refundBatchCursor: nextRound.refundBatchCursor,
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
      refundBatchCursor: input.covenant.refundBatchCursor ?? 0,
      creatorPubkey: input.covenant.creatorPubkey,
      refundAfterDaaScore: input.covenant.refundAfterDaaScore,
      soldBatches: covenantSoldBatches(input.covenant),
      ticketBatchEnds: covenantBatchEnds(input.covenant),
      ticketOwnerPubkeys: input.covenant.ticketOwnerPubkeys
    };

    await assertRaffleRedeemScriptMatchesRound(activeRound, input.covenant.redeemScriptHex, "Finalize");

    const covenantUtxo = await getCurrentCovenantUtxo(input.connection, input.covenant);
    const randomSeed = input.randomnessWitness.randomSeedHex;
    const winnerIndex = raffleWinnerIndexFromSeed(randomSeed, input.covenant.soldTickets);

    if (winnerIndex + 1 !== input.winnerTicketId) {
      throw new Error("Selected winner does not match the covenant random seed.");
    }

    const winnerPubkey = input.winner.ownerPubkey || pubkeyHexFromAddress(input.winner.owner);
    const winnerBatchStart = input.winner.ticketId - 1;
    const winnerBatchCount = ticketRangeCount(input.winner);
    if (
      winnerIndex < winnerBatchStart || winnerIndex >= winnerBatchStart + winnerBatchCount ||
      !input.winnerProofHex ||
      !await verifyTicketBatchProof(
        activeRound.ticketRoot,
        winnerPubkey,
        winnerBatchStart,
        winnerBatchCount,
        input.winnerBatchIndex,
        input.winnerProofHex
      )
    ) {
      throw new Error("The winning batch proof does not match the covenant ticket root.");
    }

    const currentAmount = BigInt(input.covenant.amountSompi);

    if (currentAmount < activeRound.potAmount) {
      throw new Error("Covenant UTXO does not contain enough funds for the prize.");
    }

    const winnerScriptPublicKey = payToAddressScript(input.winner.owner);
    if (!activeRound.creator || activeRound.creator === "no-wallet") {
      throw new Error("The creator address is missing.");
    }

    const creatorScriptPublicKey = payToAddressScript(activeRound.creator);
    const outputScriptLengths = [scriptPublicKeyLength(winnerScriptPublicKey), scriptPublicKeyLength(creatorScriptPublicKey)];
    const buildFinalizeTransaction = (finalizeFeeSompi: bigint): { tx: Transaction; signatureScriptHex: string } => {
      const creatorRefundAmount = currentAmount - activeRound.potAmount - finalizeFeeSompi;
      if (creatorRefundAmount < STANDARD_REFUND_MIN_SOMPI) {
        throw new Error("Covenant carrier refund is too small.");
      }

      const signatureScriptHex = buildRaffleFinalizeSignatureScript(
        hexToBytes(input.covenant.redeemScriptHex),
        input.randomnessWitness,
        finalizeFeeSompi,
        winnerIndex,
        input.winnerBatchIndex,
        winnerBatchStart,
        winnerBatchCount,
        winnerScriptPublicKey,
        input.winnerProofHex
      );
      const tx = buildManualTransaction({
        inputs: [
          {
            previousOutpoint: covenantOutpoint(input.covenant),
            signatureScript: signatureScriptHex,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget: RAFFLE_FINALIZE_COMPUTE_BUDGET,
            utxo: asInputUtxo(covenantUtxo)
          }
        ],
        outputs: [
          new TransactionOutput(activeRound.potAmount, winnerScriptPublicKey),
          new TransactionOutput(creatorRefundAmount, creatorScriptPublicKey)
        ],
        payload: input.payload,
        lockTime: input.covenant.soldTickets >= input.round.maxTickets
          ? 0n
          : BigInt(input.covenant.refundAfterDaaScore)
      });
      return { tx, signatureScriptHex };
    };

    let finalizeFeeSompi = 0n;
    let built = buildFinalizeTransaction(finalizeFeeSompi);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const staticRequiredFee = calculateTransactionFee(transactionNetworkId(input.connection.status.network), built.tx, 0);
      if (staticRequiredFee === undefined) {
        throw new Error("The finalize transaction exceeds the standard mass limit.");
      }
      const transientRequiredFee = minimumV1TransientRelayFeeSompi({
        signatureScriptHex: built.signatureScriptHex,
        outputScriptLengths,
        payloadLength: input.payload?.length ?? 0
      });
      const requiredFee = staticRequiredFee > transientRequiredFee ? staticRequiredFee : transientRequiredFee;
      if (requiredFee > MAX_COVENANT_FINALIZE_FEE_SOMPI) {
        throw new Error(`The finalize transaction needs more than the ${formatKasAmount(MAX_COVENANT_FINALIZE_FEE_SOMPI)} covenant fee cap.`);
      }
      if (requiredFee <= finalizeFeeSompi) {
        break;
      }
      finalizeFeeSompi = requiredFee;
      built = buildFinalizeTransaction(finalizeFeeSompi);
    }

    const finalStaticRequiredFee = calculateTransactionFee(transactionNetworkId(input.connection.status.network), built.tx, 0);
    const finalTransientRequiredFee = minimumV1TransientRelayFeeSompi({
      signatureScriptHex: built.signatureScriptHex,
      outputScriptLengths,
      payloadLength: input.payload?.length ?? 0
    });
    if (finalStaticRequiredFee === undefined || finalStaticRequiredFee > finalizeFeeSompi || finalTransientRequiredFee > finalizeFeeSompi) {
      throw new Error("Unable to converge on the finalize transaction fee.");
    }
    let txId = "";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        txId = await submitTransaction(input.connection, built.tx);
        break;
      } catch (error) {
        const nodeRequiredFee = requiredFeeFromNodeRejection(error);
        if (nodeRequiredFee === undefined || nodeRequiredFee <= finalizeFeeSompi || attempt === 2) throw error;
        if (nodeRequiredFee > MAX_COVENANT_FINALIZE_FEE_SOMPI) {
          throw new Error(`The finalize transaction needs more than the ${formatKasAmount(MAX_COVENANT_FINALIZE_FEE_SOMPI)} covenant fee cap.`);
        }

        finalizeFeeSompi = nodeRequiredFee;
        built = buildFinalizeTransaction(finalizeFeeSompi);
        const retryStaticFee = calculateTransactionFee(transactionNetworkId(input.connection.status.network), built.tx, 0);
        if (retryStaticFee === undefined) throw new Error("The finalize transaction exceeds the standard mass limit.");
        const retryTransientFee = minimumV1TransientRelayFeeSompi({
          signatureScriptHex: built.signatureScriptHex,
          outputScriptLengths,
          payloadLength: input.payload?.length ?? 0
        });
        if (retryStaticFee > finalizeFeeSompi || retryTransientFee > finalizeFeeSompi) {
          finalizeFeeSompi = retryStaticFee > retryTransientFee ? retryStaticFee : retryTransientFee;
          built = buildFinalizeTransaction(finalizeFeeSompi);
        }
      }
    }
    if (!txId) throw new Error("Unable to submit the finalize transaction.");

    return {
      txId,
      feeSompi: finalizeFeeSompi,
      winnerTicketId: input.winnerTicketId,
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
      refundBatchCursor: input.covenant.refundBatchCursor ?? 0,
      creatorPubkey: input.covenant.creatorPubkey,
      refundAfterDaaScore: input.covenant.refundAfterDaaScore,
      soldBatches: covenantSoldBatches(input.covenant),
      ticketBatchEnds: covenantBatchEnds(input.covenant),
      ticketOwnerPubkeys: input.covenant.ticketOwnerPubkeys
    };

    await assertRaffleRedeemScriptMatchesRound(currentRound, input.covenant.redeemScriptHex, "Refund");

    const covenantUtxo = await getCurrentCovenantUtxo(input.connection, input.covenant);
    const currentAmount = BigInt(input.covenant.amountSompi);
    const refundArtifact = getRaffleRefundRuntimeArtifact(currentRound.contractVersion);

      if (input.covenant.status !== "Refunding") {
        const nextRound: RoundState = { ...currentRound, status: "Refunding", refundCursor: 0, refundBatchCursor: 0 };
        const nextState = await raffleCovenantStateFromRound(nextRound);
        const nextRedeemScript = buildRaffleRedeemScript(nextState, refundArtifact);
        const nextScriptPublicKey = await buildRaffleScriptPublicKey(nextState, refundArtifact);
        const nextAddress = await buildRaffleAddress(nextState, input.connection.status.network, refundArtifact);
        const supportsDynamicTransitionFee = currentRound.contractVersion === RAFFLE_CONTRACT_VERSION;
        const buildTransitionTransaction = (
          transitionFeeSompi: bigint,
          sponsorUtxos: IUtxoEntry[] = [],
          includeCovenantBinding = true
        ): Transaction => {
          const nextAmount = currentAmount - transitionFeeSompi;
          if (nextAmount <= 0n) throw new Error("The covenant carrier is too small to start batch refunds.");
          const inputs = [{
            previousOutpoint: covenantOutpoint(input.covenant),
            signatureScript: buildRaffleStartRefundSignatureScript(
              hexToBytes(input.covenant.redeemScriptHex),
              supportsDynamicTransitionFee ? transitionFeeSompi : undefined
            ),
            sequence: 0n,
            sigOpCount: 0,
            computeBudget: refundTransitionComputeBudget(currentRound.contractVersion),
            utxo: asInputUtxo(covenantUtxo)
          }];
          sponsorUtxos.forEach((sponsorUtxo) => {
            inputs.push({
              previousOutpoint: sponsorUtxo.outpoint,
              signatureScript: "",
              sequence: 0n,
              sigOpCount: 1,
              computeBudget: 0,
              utxo: asInputUtxo(sponsorUtxo)
            });
          });
          const tx = buildManualTransaction({
            inputs,
            outputs: [new TransactionOutput(nextAmount, nextScriptPublicKey)],
            payload: input.payload,
            lockTime: BigInt(input.covenant.refundAfterDaaScore)
          });
          if (includeCovenantBinding) bindSuccessorCovenant(tx, input.covenant.covenantId);
          return tx;
        };

        let transitionFeeSompi = REFUND_TRANSITION_FEE_SOMPI;
        if (supportsDynamicTransitionFee) {
          let measured = buildTransitionTransaction(transitionFeeSompi, undefined, false);
          for (let attempt = 0; attempt < 8; attempt += 1) {
            const staticRequiredFee = calculateTransactionFee(transactionNetworkId(input.connection.status.network), measured, 0);
            if (staticRequiredFee === undefined) throw new Error("The refund transition exceeds the standard mass limit.");
            const signatureScriptHex = measured.inputs[0]?.signatureScript ?? "";
            const transientRequiredFee = minimumV1TransientRelayFeeSompi({
              signatureScriptHex,
              outputScriptLengths: [scriptPublicKeyLength(nextScriptPublicKey)],
              payloadLength: input.payload?.length ?? 0
            });
            const requiredFee = staticRequiredFee > transientRequiredFee ? staticRequiredFee : transientRequiredFee;
            if (requiredFee > MAX_REFUND_TRANSITION_FEE_SOMPI) {
              throw new Error(`The refund transition needs more than the ${formatKasAmount(MAX_REFUND_TRANSITION_FEE_SOMPI)} covenant fee cap.`);
            }
            if (requiredFee <= transitionFeeSompi) break;
            transitionFeeSompi = requiredFee;
            measured = buildTransitionTransaction(transitionFeeSompi, undefined, false);
          }
        }

        let tx = buildTransitionTransaction(transitionFeeSompi);
        let txId = "";
        try {
          txId = await submitTransaction(input.connection, tx);
        } catch (error) {
          const nodeRequiredFee = requiredFeeFromNodeRejection(error);
          const requiresLegacySponsor = !supportsDynamicTransitionFee && nodeRequiredFee !== undefined && nodeRequiredFee > REFUND_TRANSITION_FEE_SOMPI;
          if (!requiresLegacySponsor) throw error;
          if (!input.sponsorWallet) {
            throw new Error(
              `This v15 round's fixed ${formatKasAmount(REFUND_TRANSITION_FEE_SOMPI)} transition fee is below the current node minimum ${formatKasAmount(nodeRequiredFee)}. Connect a wallet so this page can automatically sponsor and retry the recovery input.`
            );
          }
          const sponsorUtxos: IUtxoEntry[] = [];
          let requiredFee = nodeRequiredFee;
          for (let attempt = 0; attempt < 6; attempt += 1) {
            const fundedFee = REFUND_TRANSITION_FEE_SOMPI + sponsorUtxos.reduce((total, utxo) => total + utxo.amount, 0n);
            const supplement = requiredFee > fundedFee ? requiredFee - fundedFee : 0n;
            sponsorUtxos.push(await createLegacyRefundTransitionSponsorUtxo(
              input.connection,
              input.sponsorWallet,
              supplement > STANDARD_REFUND_MIN_SOMPI ? supplement : STANDARD_REFUND_MIN_SOMPI
            ));
            tx = buildTransitionTransaction(transitionFeeSompi, sponsorUtxos);
            await input.sponsorWallet.signTransaction(tx, sponsorUtxos.map((_, index) => index + 1));
            try {
              txId = await submitTransaction(input.connection, tx);
              break;
            } catch (retryError) {
              const retryRequiredFee = requiredFeeFromNodeRejection(retryError);
              const retryFundedFee = REFUND_TRANSITION_FEE_SOMPI + sponsorUtxos.reduce((total, utxo) => total + utxo.amount, 0n);
              if (retryRequiredFee === undefined || retryRequiredFee <= retryFundedFee || attempt === 5) throw retryError;
              requiredFee = retryRequiredFee;
            }
          }
          if (!txId) throw new Error("Unable to sponsor the legacy refund transition fee.");
        }
        return {
          txId,
          covenant: nextCovenantCursor({
            previous: input.covenant,
            address: nextAddress,
            txId,
            amountSompi: currentAmount - transitionFeeSompi,
            redeemScript: nextRedeemScript,
            soldTickets: input.covenant.soldTickets,
            potAmount: BigInt(input.covenant.potAmount),
            status: "Refunding",
            ticketRoot: currentRound.ticketRoot,
            ticketFrontier: currentRound.ticketFrontier,
            refundCursor: 0,
            refundBatchCursor: 0,
            creatorPubkey: currentRound.creatorPubkey,
            refundAfterDaaScore: currentRound.refundAfterDaaScore,
            soldBatches: currentRound.soldBatches,
            ticketBatchEnds: currentRound.ticketBatchEnds,
            ticketOwnerPubkeys: currentRound.ticketOwnerPubkeys
          })
        };
      }

      const refundCursor = input.covenant.refundCursor ?? 0;
      const refundBatchCursor = input.covenant.refundBatchCursor ?? 0;
      const requestedBatches = input.refundBatches?.length
        ? input.refundBatches
        : input.ticket && input.ownerProofHex && input.batchIndex !== undefined
          ? [{ ticket: input.ticket, batchIndex: input.batchIndex, ownerProofHex: input.ownerProofHex }]
          : [];
      const maximumBatchCount = currentRound.contractVersion === RAFFLE_CONTRACT_VERSION || currentRound.contractVersion === PREVIOUS_RAFFLE_CONTRACT_VERSION
        ? MAX_REFUND_PURCHASE_BATCHES_PER_TX
        : 1;
      if (!requestedBatches.length) {
        throw new Error(`Purchase batch #${refundBatchCursor + 1} and its Merkle proof are required for the next refund.`);
      }
      if (requestedBatches.length > maximumBatchCount) {
        throw new Error(`A refund transaction supports at most ${maximumBatchCount} consecutive purchase batches.`);
      }

      let nextRefundCursor = refundCursor;
      let totalBatchValue = 0n;
      const verifiedBatches: Array<{
        ticket: TicketState;
        batchIndex: number;
        ownerProofHex: string;
        ownerPubkey: string;
        ticketCount: number;
        batchValue: bigint;
        ownerScriptPublicKey: ReturnType<typeof payToAddressScript>;
      }> = [];
      for (let offset = 0; offset < requestedBatches.length; offset += 1) {
        const candidate = requestedBatches[offset];
        const expectedBatchIndex = refundBatchCursor + offset;
        if (candidate.batchIndex !== expectedBatchIndex || candidate.ticket.ticketId - 1 !== nextRefundCursor) {
          throw new Error("Refund batch cursor does not match the next purchase batch.");
        }
        const ticketCount = ticketRangeCount(candidate.ticket);
        if (!isTicketBatchSize(ticketCount)) throw new Error("Refund ticket batch size is invalid.");
        const ownerPubkey = candidate.ticket.ownerPubkey || pubkeyHexFromAddress(candidate.ticket.owner);
        if (!await verifyTicketBatchProof(
          currentRound.ticketRoot,
          ownerPubkey,
          nextRefundCursor,
          ticketCount,
          expectedBatchIndex,
          candidate.ownerProofHex
        )) {
          throw new Error(`Purchase batch #${expectedBatchIndex + 1} does not match the covenant ticket root.`);
        }
        const batchValue = currentRound.ticketPrice * BigInt(ticketCount);
        totalBatchValue += batchValue;
        verifiedBatches.push({
          ...candidate,
          ownerPubkey,
          ticketCount,
          batchValue,
          ownerScriptPublicKey: payToAddressScript(candidate.ticket.owner)
        });
        nextRefundCursor += ticketCount;
      }

      const nextRefundBatchCursor = refundBatchCursor + verifiedBatches.length;
      const hasSuccessor = nextRefundBatchCursor < currentRound.soldBatches;
      if (hasSuccessor && nextRefundCursor >= currentRound.soldTickets) {
        throw new Error("Refund batch metadata exceeds the sold ticket count.");
      }
      if (!hasSuccessor && nextRefundCursor !== currentRound.soldTickets) {
        throw new Error("The final refund batch does not cover all sold tickets.");
      }
      if (currentAmount < totalBatchValue) throw new Error("The refund covenant does not contain these purchase batches.");

      const creatorScriptPublicKey = payToAddressScript(currentRound.creator);
      let nextRedeemScript: Uint8Array | undefined;
      let nextAddress = "";
      let nextScriptPublicKey: Awaited<ReturnType<typeof buildRaffleScriptPublicKey>> | undefined;
      if (hasSuccessor) {
        const nextRound: RoundState = {
          ...currentRound,
          status: "Refunding",
          potAmount: currentRound.potAmount - totalBatchValue,
          refundCursor: nextRefundCursor,
          refundBatchCursor: nextRefundBatchCursor
        };
        const nextState = await raffleCovenantStateFromRound(nextRound);
        nextRedeemScript = buildRaffleRedeemScript(nextState, refundArtifact);
        nextAddress = await buildRaffleAddress(nextState, input.connection.status.network, refundArtifact);
        nextScriptPublicKey = await buildRaffleScriptPublicKey(nextState, refundArtifact);
      }

      const buildRefundTransaction = (refundFeeSompi: bigint, includeCovenantBinding = true): { tx: Transaction; signatureScriptHex: string } => {
        const feePerBatch = refundFeeSompi / BigInt(verifiedBatches.length);
        const feeRemainder = refundFeeSompi % BigInt(verifiedBatches.length);
        const ownerOutputs = verifiedBatches.map((batch, index) => {
          const ownerFee = feePerBatch + (index === 0 ? feeRemainder : 0n);
          const refundAmount = batch.batchValue - ownerFee;
          if (refundAmount < STANDARD_REFUND_MIN_SOMPI) {
            throw new Error(`Purchase batch #${batch.batchIndex + 1} is too small after its share of the refund network fee.`);
          }
          return new TransactionOutput(refundAmount, batch.ownerScriptPublicKey);
        });
        const outputs = hasSuccessor
          ? [new TransactionOutput(currentAmount - totalBatchValue, nextScriptPublicKey!), ...ownerOutputs]
          : [...ownerOutputs, new TransactionOutput(currentAmount - totalBatchValue, creatorScriptPublicKey)];
        const signatureScriptHex = buildRaffleRefundBatchSignatureScript(
          hexToBytes(input.covenant.redeemScriptHex),
          refundFeeSompi,
          verifiedBatches.map((batch) => ({
            ownerPubkeyHex: batch.ownerPubkey,
            firstTicketId: batch.ticket.ticketId - 1,
            ticketCount: batch.ticketCount,
            ownerProofHex: batch.ownerProofHex
          }))
        );
        const tx = buildManualTransaction({
          inputs: [{
            previousOutpoint: covenantOutpoint(input.covenant),
            signatureScript: signatureScriptHex,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget: refundBatchComputeBudget(currentRound.contractVersion, verifiedBatches.length),
            utxo: asInputUtxo(covenantUtxo)
          }],
          outputs,
          payload: input.payload,
          lockTime: BigInt(input.covenant.refundAfterDaaScore)
        });
        if (hasSuccessor && includeCovenantBinding) bindSuccessorCovenant(tx, input.covenant.covenantId);
        return { tx, signatureScriptHex };
      };

      const ownerOutputScriptLengths = verifiedBatches.map((batch) => scriptPublicKeyLength(batch.ownerScriptPublicKey));
      const outputScriptLengths = hasSuccessor
        ? [scriptPublicKeyLength(nextScriptPublicKey!), ...ownerOutputScriptLengths]
        : [...ownerOutputScriptLengths, scriptPublicKeyLength(creatorScriptPublicKey)];
      let refundFeeSompi = 0n;
      let built = buildRefundTransaction(refundFeeSompi, false);
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const staticRequiredFee = calculateTransactionFee(transactionNetworkId(input.connection.status.network), built.tx, 0);
        if (staticRequiredFee === undefined) {
          throw new Error(`Refund batch candidate of ${verifiedBatches.length} purchase batches exceeds the standard mass limit.`);
        }
        const transientRequiredFee = minimumV1TransientRelayFeeSompi({
          signatureScriptHex: built.signatureScriptHex,
          outputScriptLengths,
          payloadLength: input.payload?.length ?? 0
        });
        const requiredFee = staticRequiredFee > transientRequiredFee ? staticRequiredFee : transientRequiredFee;
        const maximumRefundFee = covenantRefundMaxFeeSompi(currentRound.contractVersion);
        if (requiredFee > maximumRefundFee) {
          throw new Error(`The refund transaction needs more than the ${formatKasAmount(maximumRefundFee)} covenant fee cap.`);
        }
        if (requiredFee <= refundFeeSompi) break;
        refundFeeSompi = requiredFee;
        built = buildRefundTransaction(refundFeeSompi, false);
      }

      const finalStaticRequiredFee = calculateTransactionFee(transactionNetworkId(input.connection.status.network), built.tx, 0);
      const finalTransientRequiredFee = minimumV1TransientRelayFeeSompi({
        signatureScriptHex: built.signatureScriptHex,
        outputScriptLengths,
        payloadLength: input.payload?.length ?? 0
      });
      if (finalStaticRequiredFee === undefined || finalStaticRequiredFee > refundFeeSompi || finalTransientRequiredFee > refundFeeSompi) {
        throw new Error("Unable to converge on the refund transaction fee.");
      }

      // The current WASM fee calculator cannot decode successor covenant bindings.
      // Measure an unbound twin, then submit a fresh transaction with the real binding.
      built = buildRefundTransaction(refundFeeSompi);
      let txId = "";
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          txId = await submitTransaction(input.connection, built.tx);
          break;
        } catch (error) {
          const nodeRequiredFee = requiredFeeFromNodeRejection(error);
          if (nodeRequiredFee === undefined || nodeRequiredFee <= refundFeeSompi || attempt === 2) throw error;
          const maximumRefundFee = covenantRefundMaxFeeSompi(currentRound.contractVersion);
          if (nodeRequiredFee > maximumRefundFee) {
            throw new Error(`The refund transaction needs more than the ${formatKasAmount(maximumRefundFee)} covenant fee cap.`);
          }

          refundFeeSompi = nodeRequiredFee;
          built = buildRefundTransaction(refundFeeSompi, false);
          const retryStaticFee = calculateTransactionFee(transactionNetworkId(input.connection.status.network), built.tx, 0);
          if (retryStaticFee === undefined) {
            throw new Error(`Refund batch candidate of ${verifiedBatches.length} purchase batches exceeds the standard mass limit.`);
          }
          const retryTransientFee = minimumV1TransientRelayFeeSompi({
            signatureScriptHex: built.signatureScriptHex,
            outputScriptLengths,
            payloadLength: input.payload?.length ?? 0
          });
          if (retryStaticFee > refundFeeSompi || retryTransientFee > refundFeeSompi) {
            refundFeeSompi = retryStaticFee > retryTransientFee ? retryStaticFee : retryTransientFee;
          }
          built = buildRefundTransaction(refundFeeSompi);
        }
      }
      if (!txId) throw new Error("Unable to submit the refund transaction.");
      return {
        txId,
        feeSompi: refundFeeSompi,
        refundedTicketCount: nextRefundCursor - refundCursor,
        refundedBatchCount: verifiedBatches.length,
        covenant: hasSuccessor && nextRedeemScript ? nextCovenantCursor({
          previous: input.covenant,
          address: nextAddress,
          txId,
          amountSompi: currentAmount - totalBatchValue,
          redeemScript: nextRedeemScript,
          soldTickets: input.covenant.soldTickets,
          potAmount: currentRound.potAmount - totalBatchValue,
          status: "Refunding",
          ticketRoot: currentRound.ticketRoot,
          ticketFrontier: currentRound.ticketFrontier,
          refundCursor: nextRefundCursor,
          refundBatchCursor: nextRefundBatchCursor,
          creatorPubkey: currentRound.creatorPubkey,
          refundAfterDaaScore: currentRound.refundAfterDaaScore,
          soldBatches: currentRound.soldBatches,
          ticketBatchEnds: currentRound.ticketBatchEnds,
          ticketOwnerPubkeys: currentRound.ticketOwnerPubkeys
        }) : undefined
      };
  } catch (error) {
    throw normalizeTransactionError(error);
  }
}
