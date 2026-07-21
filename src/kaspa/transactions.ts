import {
  Address,
  calculateTransactionFee,
  CovenantBinding,
  covenantId as deriveCovenantId,
  createTransactions,
  Hash,
  addressFromScriptPublicKey,
  payToAddressScript,
  payToScriptHashScript,
  ScriptBuilder,
  ScriptPublicKey,
  Transaction,
  TransactionOutput,
  type IUtxoEntry
} from "@onekeyfe/kaspa-wasm";
import {
  assertRaffleRedeemScriptMatchesRound,
  buildRaffleAddress,
  buildRaffleBuySignatureScript,
  buildRaffleCloseEmptySignatureScript,
  buildRaffleFinalizeSignatureScript,
  buildRaffleRefundBatchSignatureScript,
  buildRaffleStartRefundSignatureScript,
  buildRaffleRedeemScript,
  buildRaffleScriptPublicKey,
  buildRaffleTopUpSignatureScript,
  bytesToHex,
  getRaffleRefundRuntimeArtifact,
  getRaffleRuntimeArtifact,
  pubkeyHexFromAddress,
  raffleCovenantStateFromRound,
  roundIdToBytes32,
  raffleWinnerIndexFromSeed
} from "./covenant";
import type { KaspaRpcConnection } from "./rpc";
import type { ChainRandomnessWitness } from "./chain-randomness";
import { hexToBytes } from "../raffle/randomness";
import type { RaffleCovenantCursor, RoundState, TicketState } from "../raffle/types";
import { appendTicketBatch, isTicketBatchSize, verifyTicketBatchProof } from "../raffle/merkle";
import { appendBatch as appendVNextBatch, buildBatchProof as buildVNextBatchProof, rootFromFrontier as vNextRootFromFrontier, verifyBatchProof as verifyVNextBatchProof } from "../protocol/merkle";
import { deriveDrawSeed } from "../protocol/randomness";
import { ticketRangeCount } from "../raffle/tickets";
import {
  isVNextRaffleContractVersion,
  LEGACY_RAFFLE_CONTRACT_VERSION,
  MAX_ROUND_PRINCIPAL_SOMPI,
  MIN_REFUNDABLE_TICKET_PRICE_SOMPI,
  PREVIOUS_RAFFLE_CONTRACT_VERSION,
  RAFFLE_CONTRACT_VERSION
} from "../raffle/metadata";
import type { BrowserTestWallet } from "./wallet";
import { normalizeWalletTransactionJson } from "./wallet-types";
import { ensureKaspaWasmReady } from "./wasm";

export interface SendKaspaPaymentInput {
  connection: KaspaRpcConnection;
  wallet: BrowserTestWallet;
  toAddress: string;
  amountSompi: bigint;
  payload: Uint8Array;
  /**
   * Exact parent output that must be confirmed before this independent
   * payment is allowed to select wallet inputs. Registry publication uses
   * this to avoid racing a just-broadcast Create transaction.
   */
  confirmedParentOutpoint?: TransactionOutpointRef & { address: string };
  /** Wallet inputs already consumed by the parent transaction. */
  excludedOutpoints?: readonly TransactionOutpointRef[];
}

export interface TransactionOutpointRef {
  transactionId: string;
  index: number;
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
  allowDeadlineRescueBuy?: boolean;
  payload: Uint8Array;
}

export interface TopUpRaffleCovenantCarrierInput {
  connection: KaspaRpcConnection;
  wallet: BrowserTestWallet;
  round: RoundState;
  covenant: RaffleCovenantCursor;
  amountSompi: bigint;
  payload?: Uint8Array;
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

export interface CloseEmptyRaffleCovenantRoundInput {
  connection: KaspaRpcConnection;
  round: RoundState;
  covenant: RaffleCovenantCursor;
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
  /** Builds the refund-start payload after its exact dynamic fee is known. */
  refundStartPayload?: (transitionFeeSompi: bigint) => Uint8Array;
}

export interface RaffleCovenantSpendResult {
  txId: string;
  feeSompi?: bigint;
  /** Fee paid by the wallet-owned staging transaction, separate from the covenant spend. */
  fundingFeeSompi?: bigint;
  covenant?: RaffleCovenantCursor;
  winnerTicketId?: number;
  randomSeed?: string;
  refundedTicketCount?: number;
  refundedBatchCount?: number;
  /** Wallet-owned inputs consumed by this spend, used to avoid RPC UTXO-view races. */
  spentWalletOutpoints?: TransactionOutpointRef[];
}

// Kaspa cannot relay a standalone 0.01 KAS UTXO: its storage mass is above the
// standard transaction limit.  Use a relay-safe temporary marker and return
// 0.19 KAS publicly; the remaining 0.01 KAS is the non-refundable registry
// marker cost requested by the UI policy.
export const DEFAULT_RAFFLE_REGISTRY_MARKER_SOMPI = 20_000_000n;
export const REGISTRY_MARKER_REFUND_FEE_SOMPI = 1_000_000n;
export const REGISTRY_PAYMENT_FEE_SOMPI = 500_000n;
export const COVENANT_CREATE_FEE_SOMPI = 6_000_000n;
export const COVENANT_BUY_FEE_SOMPI = 2_100_000n;
export const MAX_COVENANT_BUY_FEE_SOMPI = 10_000_000n;
export const COVENANT_TOP_UP_FEE_SOMPI = 2_100_000n;
export const MAX_COVENANT_TOP_UP_FEE_SOMPI = 10_000_000n;
export const MAX_REGISTRY_PAYLOAD_BYTES = 1_536;
export const MAX_COVENANT_CREATE_PAYLOAD_BYTES = 1_536;
export const MAX_COVENANT_BUY_PAYLOAD_BYTES = 768;
export const MAX_COVENANT_TOP_UP_PAYLOAD_BYTES = 768;
export const MIN_COVENANT_TOP_UP_SOMPI = 19_000_000n;
export const ESTIMATED_COVENANT_FINALIZE_FEE_SOMPI = 6_000_000n;
export const MAX_COVENANT_FINALIZE_FEE_SOMPI = 20_000_000n;
export const MAX_COVENANT_CLOSE_FEE_SOMPI = 20_000_000n;
export const REFUND_TRANSITION_FEE_SOMPI = 2_400_000n;
export const MAX_REFUND_TRANSITION_FEE_SOMPI = 20_000_000n;
export const LEGACY_REFUND_TRANSITION_SPONSOR_SOMPI = 5_000_000n;
export const ESTIMATED_REFUND_BATCH_FEE_SOMPI = 4_000_000n;
const LEGACY_MAX_REFUND_BATCH_FEE_SOMPI = 20_000_000n;
export const MAX_REFUND_BATCH_FEE_SOMPI = 20_000_000n;
export const MAX_REFUND_PURCHASE_BATCHES_PER_TX = 13;
export const VNEXT_RELAY_SAFE_PURCHASE_BATCHES = 100;
const STANDARD_REFUND_MIN_SOMPI = 5_000_000n;
/**
 * Refund transitions are buyer-funded in vNext, but a public finalize still
 * needs a creator-carrier output.  Reserve enough value so the large vNext
 * witness remains relay-standard while its fee is deducted from that output.
 */
/** Measured for the vNext finalization witness with the default 0.3 KAS minimum prize. */
export const MIN_COVENANT_CARRIER_SOMPI = 57_300_000n;
export const DEFAULT_COVENANT_CARRIER_SOMPI = MIN_COVENANT_CARRIER_SOMPI;
export const MAINNET_DEFAULT_RAFFLE_REGISTRY_ADDRESS =
  "kaspa:qzrhkehvwlzpzh8dv9ecl8eadayyzhrqlkcldzfzu32mrgv2m9npqpc4a6ugh";
const MANUAL_TX_FEE_SOMPI = COVENANT_CREATE_FEE_SOMPI;
const LOW_COST_FUNDING_MIN_SOMPI = 20_000_000n;
const SAFE_PAYMENT_CHANGE_SOMPI = 200_000_000n;
export const RAFFLE_BUY_COMPUTE_BUDGET = 12;
export const RAFFLE_TOP_UP_COMPUTE_BUDGET = 8;
export const RAFFLE_FINALIZE_COMPUTE_BUDGET = 200;
export const RAFFLE_CLOSE_EMPTY_COMPUTE_BUDGET = 24;
// One P2PK CHECKSIG costs 1,000 grams on current Kaspa parameters. A
// compute-budget unit commits 100 grams, so version-1 wallet inputs need 10.
export const P2PK_WALLET_COMPUTE_BUDGET = 10;
const LEGACY_REFUND_TRANSITION_COMPUTE_BUDGET = 4;
export const GROUPED_REFUND_TRANSITION_COMPUTE_BUDGET = 150;
const LEGACY_REFUND_BATCH_COMPUTE_BUDGET = 100;
export const GROUPED_REFUND_BASE_COMPUTE_BUDGET = 15;
export const GROUPED_REFUND_PER_BATCH_COMPUTE_BUDGET = 35;
export const GROUPED_REFUND_MAX_COMPUTE_BUDGET = 470;
const NORMALIZED_TRANSIENT_GRAMS_PER_BYTE = 2n;
const MIN_RELAY_FEE_SOMPI_PER_GRAM = 100n;
const P2PK_SIGNATURE_SCRIPT_BYTES = 66;
const MAX_DIRECT_WALLET_INPUTS = 64;
const MAX_DIRECT_CREATE_FEE_SOMPI = 20_000_000n;
const MAX_DIRECT_REGISTRY_FEE_SOMPI = 20_000_000n;
const MAX_FINALIZE_FEE_CONVERGENCE_ATTEMPTS = 32;
const CURRENT_COVENANT_LOOKUP_TIMEOUT_MS = 15_000;
const REGISTRY_CONFIRMED_INPUT_TIMEOUT_MS = 120_000;

/**
 * The legacy helper deliberately has no nonce.  Keep that compatibility path
 * isolated: every new (vNext) covenant transaction uses the domain-separated
 * V2 tree that the contract recomputes.
 */
async function appendRoundBatch(round: RoundState, frontierHex: string, batchIndex: number, ownerPubkeyHex: string, firstTicketId: number, ticketCount: number) {
  if (isVNextRaffleContractVersion(round.contractVersion)) {
    return appendVNextBatch(frontierHex, batchIndex, {
      roundNonceHex: bytesToHex(await roundIdToBytes32(round.roundNonce || round.roundId)),
      ownerPubkeyHex,
      firstTicketId,
      ticketCount
    });
  }
  return appendTicketBatch(frontierHex, batchIndex, ownerPubkeyHex, firstTicketId, ticketCount);
}

async function verifyRoundBatchProof(round: RoundState, rootHex: string, ownerPubkeyHex: string, firstTicketId: number, ticketCount: number, batchIndex: number, proofHex: string): Promise<boolean> {
  if (isVNextRaffleContractVersion(round.contractVersion)) {
    return verifyVNextBatchProof(rootHex, {
      roundNonceHex: bytesToHex(await roundIdToBytes32(round.roundNonce || round.roundId)),
      ownerPubkeyHex,
      firstTicketId,
      ticketCount
    }, batchIndex, proofHex);
  }
  return verifyTicketBatchProof(rootHex, ownerPubkeyHex, firstTicketId, ticketCount, batchIndex, proofHex);
}

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
  return RAFFLE_BUY_COMPUTE_BUDGET;
}

function refundTransitionComputeBudget(contractVersion: string): number {
  return isVNextRaffleContractVersion(contractVersion) || contractVersion === PREVIOUS_RAFFLE_CONTRACT_VERSION
    ? GROUPED_REFUND_TRANSITION_COMPUTE_BUDGET
    : LEGACY_REFUND_TRANSITION_COMPUTE_BUDGET;
}

function refundBatchComputeBudget(contractVersion: string, batchCount: number): number {
  if (contractVersion === LEGACY_RAFFLE_CONTRACT_VERSION) return LEGACY_REFUND_BATCH_COMPUTE_BUDGET;
  if (!isVNextRaffleContractVersion(contractVersion) && contractVersion !== PREVIOUS_RAFFLE_CONTRACT_VERSION) {
    throw new Error(`Unsupported refund contract version: ${contractVersion}.`);
  }
  return Math.min(GROUPED_REFUND_MAX_COMPUTE_BUDGET, GROUPED_REFUND_BASE_COMPUTE_BUDGET + batchCount * GROUPED_REFUND_PER_BATCH_COMPUTE_BUDGET);
}

function formatKasAmount(value: bigint): string {
  const whole = value / 100_000_000n;
  const fraction = (value % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${whole.toLocaleString()}${fraction ? `.${fraction}` : ""} KAS`;
}

function p2pkScriptPublicKey(pubkeyHex: string, label: string): ScriptPublicKey {
  const normalized = pubkeyHex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error(`${label} must be a 32-byte x-only public key.`);
  return new ScriptPublicKey(0, `20${normalized}ac`);
}

function scriptPublicKeyLength(scriptPublicKey: { toJSON(): unknown }): number {
  const json = scriptPublicKey.toJSON() as { script?: string };
  if (!json.script || json.script.length % 2 !== 0) {
    throw new Error("Unable to measure the transaction output script.");
  }
  return json.script.length / 2;
}

function minimumV1TransientRelayFeeForInputs(input: {
  inputSignatureScriptLengths: number[];
  outputScriptLengths: number[];
  payloadLength: number;
}): bigint {
  let size = 2 + 8;
  for (const inputSignatureScriptLength of input.inputSignatureScriptLengths) {
    if (!Number.isSafeInteger(inputSignatureScriptLength) || inputSignatureScriptLength < 0) {
      throw new Error("Unable to measure an additional transaction input signature script.");
    }
    size += 36 + 8 + inputSignatureScriptLength + 8 + 2;
  }
  size += 8;
  size += input.outputScriptLengths.reduce((total, scriptLength) => total + 8 + 2 + 8 + scriptLength, 0);
  size += 8 + 20 + 8 + 32 + 8 + input.payloadLength;

  return BigInt(size) * NORMALIZED_TRANSIENT_GRAMS_PER_BYTE * MIN_RELAY_FEE_SOMPI_PER_GRAM;
}

function minimumV1TransientRelayFeeSompi(input: {
  signatureScriptHex: string;
  additionalInputSignatureScriptLengths?: number[];
  outputScriptLengths: number[];
  payloadLength: number;
}): bigint {
  const signatureScriptLength = input.signatureScriptHex.length / 2;
  if (!Number.isInteger(signatureScriptLength)) {
    throw new Error("Unable to measure the covenant signature script.");
  }
  return minimumV1TransientRelayFeeForInputs({
    inputSignatureScriptLengths: [signatureScriptLength, ...(input.additionalInputSignatureScriptLengths ?? [])],
    outputScriptLengths: input.outputScriptLengths,
    payloadLength: input.payloadLength
  });
}

const ZERO_SUBNETWORK_ID = "0000000000000000000000000000000000000000";
const LEGACY_LOW_COST_REDEEM_SCRIPT = new Uint8Array([0x51]);
const KASWIN_REGISTRY_TAG = new TextEncoder().encode("KASWIN_REGISTRY_V1");
// A tagged DROP/TRUE script keeps the auto-refundable marker behavior while
// giving Kaswin its own address instead of the globally shared OP_TRUE address.
const LOW_COST_REDEEM_SCRIPT = new Uint8Array([
  KASWIN_REGISTRY_TAG.length,
  ...KASWIN_REGISTRY_TAG,
  0x75, // OP_DROP
  0x51 // OP_TRUE
]);

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

/**
 * Select wallet inputs for the final transaction itself. Prefer one input and
 * then the largest inputs so Create/Buy/Registry normally need one wallet
 * approval without first creating a consolidation output.
 */
function selectDirectPaymentEntries(entries: IUtxoEntry[], requiredTotal: bigint, minimumChangeSompi = SAFE_PAYMENT_CHANGE_SOMPI): IUtxoEntry[] {
  const sorted = [...entries].sort((left, right) => left.amount === right.amount ? 0 : left.amount > right.amount ? -1 : 1);
  const singleEntry = [...sorted].reverse().find((entry) => {
    if (entry.amount < requiredTotal) return false;
    const remainder = entry.amount - requiredTotal;
    return remainder === 0n || remainder >= minimumChangeSompi;
  });
  if (singleEntry) return [singleEntry];

  const selected: IUtxoEntry[] = [];
  let total = 0n;
  for (const entry of sorted) {
    selected.push(entry);
    total += entry.amount;
    if (selected.length > MAX_DIRECT_WALLET_INPUTS) {
      throw new Error(`The wallet needs more than ${MAX_DIRECT_WALLET_INPUTS} inputs. Consolidate wallet UTXOs before retrying.`);
    }
    if (total >= requiredTotal + minimumChangeSompi) return selected;
  }
  throw new Error("Not enough spendable balance for this transaction.");
}

function walletInputFromEntry(entry: IUtxoEntry) {
  return {
    previousOutpoint: entry.outpoint,
    signatureScript: "",
    sequence: 0n,
    sigOpCount: 0,
    computeBudget: P2PK_WALLET_COMPUTE_BUDGET,
    utxo: asInputUtxo(entry)
  };
}

function sumUtxoAmounts(entries: IUtxoEntry[]): bigint {
  return entries.reduce((total, entry) => total + entry.amount, 0n);
}

export function transactionRejectionRequiresStateRefresh(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:double[- ]?spend|already spent|spent by another|missing (?:referenced )?(?:outpoint|input)|(?:outpoint|input).*(?:not found|unknown|missing)|conflicting transaction|loaded covenant UTXO is no longer available|loaded covenant amount .*does not match)/i.test(message);
}

export function normalizeTransactionError(error: unknown): Error {
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

  if (/orphan.*disallowed|is an orphan where orphan is disallowed/i.test(message)) {
    return new Error(
      `The RPC backend has not received this transaction's parent yet, so it rejected the dependent transaction. ${message} Verify the locally computed transaction id and wait until the parent is visible before retrying.`
    );
  }

  if (transactionRejectionRequiresStateRefresh(message)) {
    return new Error(
      `A transaction input is no longer current, usually because another operation already advanced the round. ${message} Refresh the latest round state; any replacement transaction requires a new review and signature.`
    );
  }

  if (/(?:already accepted|already in (?:the )?mempool|duplicate transaction)/i.test(message)) {
    return new Error(
      `The node reports that this transaction may already be known. ${message} Verify the locally computed transaction id in history or the explorer before doing anything again.`
    );
  }

  if (/rejected transaction|transaction rejected/i.test(message)) {
    return new Error(
      `The Kaspa node rejected the transaction. ${message} No retry or replacement signing request was opened automatically; verify the locally computed transaction id and refresh chain state before retrying.`
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

function outpointKey(outpoint: TransactionOutpointRef): string {
  return `${outpoint.transactionId.toLowerCase()}:${outpoint.index}`;
}

export function excludeUtxoEntries(
  entries: readonly IUtxoEntry[],
  excludedOutpoints: readonly TransactionOutpointRef[] = []
): IUtxoEntry[] {
  if (!excludedOutpoints.length) return [...entries];
  const excluded = new Set(excludedOutpoints.map(outpointKey));
  return entries.filter((entry) => !excluded.has(outpointKey(entry.outpoint)));
}

async function temporaryFundingRecoveryMessage(
  connection: KaspaRpcConnection,
  walletAddress: string,
  stagingUtxo: IUtxoEntry
): Promise<string> {
  try {
    const result = await connection.client.getUtxosByAddresses({ addresses: [walletAddress] });
    const stillUnspent = (result.entries ?? []).some((entry) => sameOutpoint(
      entry,
      stagingUtxo.outpoint.transactionId,
      stagingUtxo.outpoint.index
    ));
    return stillUnspent
      ? `Temporary funding is still unspent and locked to ${walletAddress}; the wallet can reuse it.`
      : "Temporary funding is no longer unspent. The second transaction may already have been accepted; reload history and verify the covenant/Registry UTXO before retrying.";
  } catch {
    return `The temporary funding status could not be verified. Check wallet address ${walletAddress} and the staging outpoint ${stagingUtxo.outpoint.transactionId}:${stagingUtxo.outpoint.index} before retrying.`;
  }
}

function covenantOutpoint(covenant: RaffleCovenantCursor) {
  return { transactionId: covenant.txId, index: covenant.outputIndex };
}

function lowCostFundingSignatureScript(redeemScript = LOW_COST_REDEEM_SCRIPT): string {
  const builder = new ScriptBuilder();

  builder.addData(redeemScript);
  return builder.drain();
}

function lowCostFundingAddress(network: string, redeemScript = LOW_COST_REDEEM_SCRIPT): string {
  const scriptPublicKey = payToScriptHashScript(redeemScript);
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
  // Both supported networks use the tagged Kaswin script so the relay-safe
  // temporary marker can return 0.19 KAS and leave the same 0.01 KAS net cost.
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

function requirePayloadLimit(payload: Uint8Array | undefined, maximumBytes: number, label: string): void {
  if ((payload?.byteLength ?? 0) > maximumBytes) {
    throw new Error(`${label} payload exceeds the ${maximumBytes}-byte relay-fee envelope.`);
  }
}

async function refundLowCostFundingUtxo(
  connection: KaspaRpcConnection,
  stagingUtxo: IUtxoEntry,
  refundAddress: string,
  feeSompi = MANUAL_TX_FEE_SOMPI,
  redeemScript = LOW_COST_REDEEM_SCRIPT
): Promise<string> {
  const refundAmount = stagingUtxo.amount - feeSompi;

  if (refundAmount <= 0n) {
    throw new Error("Temporary funding UTXO is too small to refund.");
  }

  const tx = buildManualTransaction({
    inputs: [
      {
        previousOutpoint: stagingUtxo.outpoint,
        signatureScript: lowCostFundingSignatureScript(redeemScript),
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
  let utxo: IUtxoEntry;
  try {
    utxo = await waitForAddressUtxo(
      connection,
      covenant.address,
      covenant.txId,
      covenant.outputIndex,
      CURRENT_COVENANT_LOOKUP_TIMEOUT_MS
    );
  } catch {
    throw new Error(
      "The loaded covenant UTXO is no longer available. Another transaction may have advanced the round; reload the latest round state before trying again."
    );
  }
  const expectedAmount = BigInt(covenant.amountSompi);
  if (utxo.amount !== expectedAmount) {
    throw new Error(`The loaded covenant amount ${expectedAmount} does not match the node UTXO amount ${utxo.amount}. Reload the round before constructing a transaction.`);
  }
  return utxo;
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
  timeoutMs = 60_000,
  requireConfirmed = false
): Promise<IUtxoEntry> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const utxos = await connection.client.getUtxosByAddresses({ addresses: [address] });
    const entry = (utxos.entries ?? []).find((candidate) => sameOutpoint(candidate, txId, outputIndex));

    if (entry && (!requireConfirmed || BigInt(entry.blockDaaScore) > 0n)) {
      return entry;
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error("Transaction output was not indexed in time. Wait a few seconds and retry.");
}

async function waitForConfirmedDirectPaymentEntries(
  connection: KaspaRpcConnection,
  address: string,
  requiredTotal: bigint,
  excludedOutpoints: readonly TransactionOutpointRef[] = [],
  timeoutMs = REGISTRY_CONFIRMED_INPUT_TIMEOUT_MS
): Promise<IUtxoEntry[]> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const utxos = await connection.client.getUtxosByAddresses({ addresses: [address] });
    const confirmedEntries = excludeUtxoEntries(
      (utxos.entries ?? []).filter((entry) => BigInt(entry.blockDaaScore) > 0n),
      excludedOutpoints
    );
    try {
      return selectDirectPaymentEntries(confirmedEntries, requiredTotal);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  throw new Error(
    "Registry publication is waiting for enough confirmed wallet UTXOs. No wallet signing request was opened; the covenant is already saved and Registry can be published later."
  );
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
  const safeJson = tx.serializeToSafeJSON();
  const safeShape = JSON.parse(safeJson) as { outputs?: Array<{ covenant?: unknown }> };
  const hasBoundOutput = (safeShape.outputs ?? []).some((output) => Boolean(output.covenant));
  const hasUnboundOutput = (safeShape.outputs ?? []).some((output) => !output.covenant);

  if (hasBoundOutput && hasUnboundOutput) {
    // Finalizing the original mixed-output wrapper triggers the same bundled
    // WASM null-covenant conversion bug as RPC submission. An equivalent
    // normalized twin omits only absent optional bindings; use it for the
    // deterministic id and the plain RPC shape while preserving signatures.
    let normalizedTx: Transaction;
    try {
      normalizedTx = Transaction.deserializeFromSafeJSON(normalizeWalletTransactionJson(safeJson));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to deserialize the normalized mixed-output transaction before submission: ${message}`);
    }
    try {
      normalizedTx.finalize();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to finalize the normalized mixed-output transaction before submission: ${message}`);
    }
    const expectedTxId = normalizedTx.id;
    let serialized: ReturnType<typeof rpcTransactionObjectForSubmit>;
    try {
      serialized = rpcTransactionObjectForSubmit(JSON.parse(normalizedTx.serializeToSafeJSON(), reviveTransactionBigInts));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to build the normalized mixed-output RPC request: ${message}`);
    }
    try {
      const result = await connection.client.submitTransaction({
        transaction: serialized,
        allowOrphan: false
      } as never);
      return result.transactionId;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message} Locally computed transaction id: ${expectedTxId}. Verify this id before retrying.`);
    }
  }

  tx.finalize();
  const expectedTxId = tx.id;
  try {
    const result = await connection.client.submitTransaction({ transaction: tx, allowOrphan: false });
    return result.transactionId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Error converting property `covenant`")) {
      throw new Error(`${message} Locally computed transaction id: ${expectedTxId}. Verify this id before retrying.`);
    }

    // This WASM release cannot convert a Transaction containing both bound and
    // unbound outputs. Its plain RPC converter works when absent bindings are
    // omitted and bound covenant ids remain hex strings.
    const serialized = JSON.parse(tx.serializeToSafeJSON(), reviveTransactionBigInts);
    try {
      const result = await connection.client.submitTransaction({
        transaction: rpcTransactionObjectForSubmit(serialized),
        allowOrphan: false
      } as never);
      return result.transactionId;
    } catch (fallbackError) {
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(`${fallbackMessage} Locally computed transaction id: ${expectedTxId}. Verify this id before retrying.`);
    }
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
  refundFeeDebtSompi?: string;
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
    refundFeeDebtSompi: input.refundFeeDebtSompi,
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

function covenantRemainingPrincipal(round: RoundState, covenant: RaffleCovenantCursor): bigint {
  const refundedTickets = covenant.status === "Refunding" || covenant.status === "Refunded"
    ? covenant.refundCursor ?? 0
    : 0;
  if (refundedTickets < 0 || refundedTickets > covenant.soldTickets) {
    throw new Error("The loaded refund cursor is outside the sold ticket range.");
  }
  return round.ticketPrice * BigInt(covenant.soldTickets - refundedTickets);
}

export function assertRaffleCarrierLiveness(
  round: Pick<RoundState, "ticketPrice">,
  covenant: Pick<RaffleCovenantCursor, "amountSompi" | "soldTickets" | "status" | "refundCursor">,
  action = "Raffle action"
): bigint {
  const principal = covenantRemainingPrincipal(round as RoundState, covenant as RaffleCovenantCursor);
  const amount = BigInt(covenant.amountSompi);
  if (amount < principal) {
    throw new Error(`${action} is blocked because the loaded covenant amount is below its committed ticket principal. No wallet signing request was opened.`);
  }
  const carrier = amount - principal;
  if (carrier < MIN_COVENANT_CARRIER_SOMPI) {
    throw new Error(
      `${action} is blocked because this round has only ${formatKasAmount(carrier)} of carrier, below the ${formatKasAmount(MIN_COVENANT_CARRIER_SOMPI)} settlement minimum. ` +
      "Top up the carrier before anyone buys. No wallet signing request was opened."
    );
  }
  return carrier;
}

export async function assertRaffleAppendState(
  round: Pick<RoundState, "roundNonce" | "roundId">,
  covenant: Pick<RaffleCovenantCursor, "soldTickets" | "soldBatches" | "ticketOwnerPubkeys" | "ticketBatchEnds" | "ticketFrontier" | "ticketRoot">
): Promise<void> {
  const soldTickets = covenant.soldTickets;
  const soldBatches = covenant.soldBatches ?? covenant.ticketOwnerPubkeys.length;
  if (!Number.isSafeInteger(soldTickets) || soldTickets < 0 || !Number.isSafeInteger(soldBatches) || soldBatches < 0 || soldBatches > 1_000 || soldBatches > soldTickets) {
    throw new Error("Ticket purchase is blocked because the loaded ticket and purchase-batch counters are inconsistent. No wallet signing request was opened.");
  }
  if ((soldTickets === 0 && soldBatches !== 0) || (soldTickets > 0 && soldBatches === 0)) {
    throw new Error("Ticket purchase is blocked because the loaded ticket and purchase-batch topology is inconsistent. No wallet signing request was opened.");
  }
  const frontierRoot = await vNextRootFromFrontier(covenant.ticketFrontier || "", soldBatches);
  if (frontierRoot !== covenant.ticketRoot.toLowerCase()) {
    throw new Error("Ticket purchase is blocked because the loaded ticket root does not match its append frontier. No wallet signing request was opened.");
  }
  const owners = covenant.ticketOwnerPubkeys;
  const ends = covenant.ticketBatchEnds ?? [];
  if (owners.length !== soldBatches || ends.length !== soldBatches) {
    throw new Error("Ticket purchase is blocked because the loaded purchase-batch history is incomplete. No wallet signing request was opened.");
  }
  if (soldBatches > 0) {
    // UI-created rounds intentionally use a readable `round-...` nonce.  The
    // vNext Merkle domain always commits its deterministic bytes32 form; apply
    // the same normalization here when rebuilding prior purchase batches.
    const roundNonceHex = bytesToHex(await roundIdToBytes32(round.roundNonce || round.roundId));
    let firstTicketId = 0;
    const records = owners.map((ownerPubkeyHex, index) => {
      const end = ends[index];
      if (!Number.isSafeInteger(end) || end <= firstTicketId || end > soldTickets) {
        throw new Error("Ticket purchase is blocked because the loaded purchase-batch ranges are inconsistent. No wallet signing request was opened.");
      }
      const record = { roundNonceHex, ownerPubkeyHex, firstTicketId, ticketCount: end - firstTicketId };
      firstTicketId = end;
      return record;
    });
    if (firstTicketId !== soldTickets) {
      throw new Error("Ticket purchase is blocked because the loaded purchase-batch ranges do not cover all sold tickets. No wallet signing request was opened.");
    }
    const rebuilt = await buildVNextBatchProof(records, 0);
    if (rebuilt.rootHex !== covenant.ticketRoot.toLowerCase()) {
      throw new Error("Ticket purchase is blocked because the loaded purchase-batch history does not reconstruct the on-chain ticket root. No wallet signing request was opened.");
    }
  }
}

export async function sendKaspaPayment(input: SendKaspaPaymentInput): Promise<SendKaspaPaymentResult> {
  await ensureKaspaWasmReady();

  try {
    requirePayloadLimit(input.payload, MAX_REGISTRY_PAYLOAD_BYTES, "Registry payment");
    // Registry publication is deliberately strict. A newly created round can
    // leave the wallet with only unconfirmed change; signing a child from that
    // change makes Resolver backend propagation races user-visible. Wait for
    // confirmed wallet inputs before the one Registry approval, and never ask
    // the node to store an orphan.
    if (input.confirmedParentOutpoint) {
      await waitForAddressUtxo(
        input.connection,
        input.confirmedParentOutpoint.address,
        input.confirmedParentOutpoint.transactionId,
        input.confirmedParentOutpoint.index,
        REGISTRY_CONFIRMED_INPUT_TIMEOUT_MS,
        true
      );
    }
    const selectedEntries = await waitForConfirmedDirectPaymentEntries(
      input.connection,
      input.wallet.address,
      input.amountSompi + REGISTRY_PAYMENT_FEE_SOMPI,
      input.excludedOutpoints
    );
    const selectedAmount = sumUtxoAmounts(selectedEntries);
    const buildMarkerTransaction = (feeSompi: bigint) => {
      const changeAmount = selectedAmount - input.amountSompi - feeSompi;
      if (changeAmount < 0n || (changeAmount > 0n && changeAmount < SAFE_PAYMENT_CHANGE_SOMPI)) {
        throw new Error("The registry transaction cannot return a storage-mass-safe wallet change output.");
      }
      const outputs = [new TransactionOutput(input.amountSompi, payToAddressScript(input.toAddress))];
      if (changeAmount > 0n) outputs.push(new TransactionOutput(changeAmount, payToAddressScript(input.wallet.address)));
      const tx = buildManualTransaction({
        inputs: selectedEntries.map(walletInputFromEntry),
        outputs,
        payload: input.payload
      });
      return { tx, outputs };
    };

    let feeSompi = REGISTRY_PAYMENT_FEE_SOMPI;
    let built = buildMarkerTransaction(feeSompi);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const staticRequiredFee = calculateTransactionFee(transactionNetworkId(input.connection.status.network), built.tx, 0);
      if (staticRequiredFee === undefined) throw new Error("The registry transaction exceeds the standard mass limit.");
      const transientRequiredFee = minimumV1TransientRelayFeeForInputs({
        inputSignatureScriptLengths: selectedEntries.map(() => P2PK_SIGNATURE_SCRIPT_BYTES),
        outputScriptLengths: built.outputs.map((output) => scriptPublicKeyLength(output.scriptPublicKey)),
        payloadLength: input.payload.length
      });
      const requiredFee = staticRequiredFee > transientRequiredFee ? staticRequiredFee : transientRequiredFee;
      if (requiredFee > MAX_DIRECT_REGISTRY_FEE_SOMPI) {
        throw new Error(`The registry transaction needs more than the ${formatKasAmount(MAX_DIRECT_REGISTRY_FEE_SOMPI)} fee cap.`);
      }
      if (requiredFee <= feeSompi) break;
      feeSompi = requiredFee;
      built = buildMarkerTransaction(feeSompi);
      if (attempt === 7) throw new Error("Unable to converge on the registry transaction fee.");
    }

    const walletInputIndexes = selectedEntries.map((_, index) => index);
    await input.wallet.signTransaction(built.tx, walletInputIndexes);
    const markerTxId = await submitTransaction(input.connection, built.tx);

    return {
      txIds: [markerTxId],
      feeSompi,
      selectedUtxoCount: selectedEntries.length
    };
  } catch (error) {
    throw normalizeTransactionError(error);
  }
}

export async function refundRaffleRegistryMarker(input: RefundRaffleRegistryMarkerInput): Promise<string> {
  await ensureKaspaWasmReady();

  try {
    const markerUtxo = await waitForAddressUtxo(
      input.connection,
      input.registryAddress,
      input.markerTxId,
      0,
      REGISTRY_CONFIRMED_INPUT_TIMEOUT_MS,
      true
    );
    const network = input.connection.status.network;
    const currentAddress = lowCostFundingAddress(network);
    const legacyAddress = lowCostFundingAddress(network, LEGACY_LOW_COST_REDEEM_SCRIPT);
    const redeemScript = input.registryAddress === currentAddress
      ? LOW_COST_REDEEM_SCRIPT
      : input.registryAddress === legacyAddress
        ? LEGACY_LOW_COST_REDEEM_SCRIPT
        : undefined;
    if (!redeemScript) throw new Error("Registry marker address is not an auto-refundable Kaswin registry.");

    return refundLowCostFundingUtxo(
      input.connection,
      markerUtxo,
      input.refundAddress,
      REGISTRY_MARKER_REFUND_FEE_SOMPI,
      redeemScript
    );
  } catch (error) {
    throw normalizeTransactionError(error);
  }
}

export async function createRaffleCovenantRound(input: CreateRaffleCovenantRoundInput): Promise<RaffleCovenantSpendResult> {
  await ensureKaspaWasmReady();
  let failureStage = "preflight validation";

  try {
    requirePayloadLimit(input.payload, MAX_COVENANT_CREATE_PAYLOAD_BYTES, "Round creation");
    if (input.round.contractVersion !== RAFFLE_CONTRACT_VERSION) {
      throw new Error(`New rounds must use the current ${RAFFLE_CONTRACT_VERSION} covenant.`);
    }
    if (!Number.isSafeInteger(input.round.maxTickets) || input.round.maxTickets < 1 || input.round.maxTickets > 1_000_000) throw new Error("Round maxTickets must be from 1 to 1000000.");
    if (!Number.isSafeInteger(input.round.minTickets) || input.round.minTickets < 1 || input.round.minTickets > input.round.maxTickets) throw new Error("Round minTickets must be from 1 to maxTickets.");
    if (!Number.isSafeInteger(input.round.maxBatches) || input.round.maxBatches! < 1 || input.round.maxBatches! > 1_000) throw new Error("Round maxBatches must be from 1 to 1000.");
    if (input.round.ticketPrice < MIN_REFUNDABLE_TICKET_PRICE_SOMPI) {
      throw new Error(`Ticket price must be at least ${formatKasAmount(MIN_REFUNDABLE_TICKET_PRICE_SOMPI)} so a one-ticket purchase can always cover its maximum refund fees.`);
    }
    if (input.round.ticketPrice * BigInt(input.round.maxTickets) > MAX_ROUND_PRINCIPAL_SOMPI) {
      throw new Error(`Ticket price multiplied by max tickets must not exceed ${formatKasAmount(MAX_ROUND_PRINCIPAL_SOMPI)}.`);
    }
    failureStage = "covenant state and script construction";
    const state = await raffleCovenantStateFromRound(input.round);
    const runtimeArtifact = getRaffleRuntimeArtifact(input.round.contractVersion);
    const redeemScript = buildRaffleRedeemScript(state, runtimeArtifact);
    const covenantAddress = await buildRaffleAddress(state, input.wallet.network, runtimeArtifact);
    const covenantScriptPublicKey = await buildRaffleScriptPublicKey(state, runtimeArtifact);
    const carrierAmount = input.carrierAmountSompi ?? DEFAULT_COVENANT_CARRIER_SOMPI;

    requireAtLeastSompi(carrierAmount, MIN_COVENANT_CARRIER_SOMPI, "Covenant carrier");

    failureStage = "wallet UTXO selection";
    const utxos = await input.connection.client.getUtxosByAddresses({ addresses: [input.wallet.address] });
    const selectedEntries = selectDirectPaymentEntries(
      utxos.entries ?? [],
      carrierAmount + COVENANT_CREATE_FEE_SOMPI
    );
    const selectedAmount = sumUtxoAmounts(selectedEntries);
    const buildCreateTransaction = (feeSompi: bigint) => {
      const changeAmount = selectedAmount - carrierAmount - feeSompi;
      if (changeAmount < 0n || (changeAmount > 0n && changeAmount < SAFE_PAYMENT_CHANGE_SOMPI)) {
        throw new Error("The create transaction cannot return a storage-mass-safe wallet change output.");
      }
      const outputs = [new TransactionOutput(carrierAmount, covenantScriptPublicKey)];
      if (changeAmount > 0n) outputs.push(new TransactionOutput(changeAmount, payToAddressScript(input.wallet.address)));
      failureStage = "Genesis covenant id derivation";
      const genesisCovenantHash = deriveCovenantId(selectedEntries[0].outpoint, [{ index: 0, output: outputs[0] }]);
      const covenantId = genesisCovenantHash.toString();
      if (!/^[0-9a-fA-F]{64}$/.test(covenantId)) throw new Error("Unable to derive genesis covenant id.");
      failureStage = "unbound create transaction construction";
      const transaction = buildManualTransaction({
        inputs: selectedEntries.map(walletInputFromEntry),
        outputs,
        payload: input.payload
      });
      // The browser WASM constructor cannot round-trip a TransactionOutput that
      // already owns a CovenantBinding (it tries to convert its Hash wrapper as
      // a plain slice). Build the transaction first, then install the binding on
      // the live output—the same pattern used by every successor covenant.
      failureStage = "Genesis covenant binding installation";
      transaction.outputs[0].covenant = new CovenantBinding(0, genesisCovenantHash);
      const measurementOutputs = [new TransactionOutput(carrierAmount, covenantScriptPublicKey)];
      if (changeAmount > 0n) measurementOutputs.push(new TransactionOutput(changeAmount, payToAddressScript(input.wallet.address)));
      const measurementTransaction = buildManualTransaction({
        inputs: selectedEntries.map(walletInputFromEntry),
        outputs: measurementOutputs,
        payload: input.payload
      });
      return { transaction, measurementTransaction, outputs, covenantId };
    };

    failureStage = "create transaction fee convergence";
    let createFeeSompi = COVENANT_CREATE_FEE_SOMPI;
    let builtCreate = buildCreateTransaction(createFeeSompi);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      failureStage = "unbound create transaction fee measurement";
      const staticRequiredFee = calculateTransactionFee(transactionNetworkId(input.connection.status.network), builtCreate.measurementTransaction, 0);
      if (staticRequiredFee === undefined) throw new Error("The create transaction exceeds the standard mass limit.");
      const transientRequiredFee = minimumV1TransientRelayFeeForInputs({
        inputSignatureScriptLengths: selectedEntries.map(() => P2PK_SIGNATURE_SCRIPT_BYTES),
        outputScriptLengths: builtCreate.outputs.map((output) => scriptPublicKeyLength(output.scriptPublicKey)),
        payloadLength: input.payload.length
      });
      const requiredFee = staticRequiredFee > transientRequiredFee ? staticRequiredFee : transientRequiredFee;
      if (requiredFee > MAX_DIRECT_CREATE_FEE_SOMPI) {
        throw new Error(`The create transaction needs more than the ${formatKasAmount(MAX_DIRECT_CREATE_FEE_SOMPI)} fee cap.`);
      }
      if (requiredFee <= createFeeSompi) break;
      createFeeSompi = requiredFee;
      builtCreate = buildCreateTransaction(createFeeSompi);
      if (attempt === 7) throw new Error("Unable to converge on the create transaction fee.");
    }
    const tx = builtCreate.transaction;

    failureStage = "Genesis covenant id validation";
    const covenantId = builtCreate.covenantId;

    if (!covenantId || !/^[0-9a-fA-F]{64}$/.test(covenantId)) {
      throw new Error("Unable to derive genesis covenant id.");
    }

    let txId = "";
    let preparedTxId = "";

    try {
      failureStage = "wallet signing";
      await input.wallet.signTransaction(tx, selectedEntries.map((_, index) => index));
      failureStage = "transaction finalization and broadcast";
      tx.finalize();
      preparedTxId = tx.id;
      txId = await submitTransaction(input.connection, tx);
    } catch (error) {
      if (preparedTxId) {
        try {
          await waitForAddressUtxo(input.connection, covenantAddress, preparedTxId, 0, 10_000);
          txId = preparedTxId;
        } catch {
          // The exact candidate id is appended below so a later reconnect can
          // distinguish an accepted transaction from wallet inputs that remain unspent.
        }
      }
      if (txId) {
        // The RPC response was lost, but the exact covenant output is already
        // visible at its deterministic address, so return the normal cursor.
      } else {
        const normalized = normalizeTransactionError(error);
        throw new Error(
          `${normalized.message} ${preparedTxId ? `Candidate covenant transaction: ${preparedTxId}; covenant id: ${covenantId}; address: ${covenantAddress}. ` : ""}` +
          "No preliminary funding transaction was broadcast; reload history before retrying if the candidate id is shown."
        );
      }
    }

    return {
      txId,
      feeSompi: createFeeSompi,
      spentWalletOutpoints: selectedEntries.map((entry) => ({
        transactionId: entry.outpoint.transactionId,
        index: entry.outpoint.index
      })),
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
    const normalized = normalizeTransactionError(error);
    throw new Error(`Round creation failed during ${failureStage}: ${normalized.message}`);
  }
}
export async function buyRaffleCovenantTicket(input: BuyRaffleCovenantTicketInput): Promise<RaffleCovenantSpendResult> {
  await ensureKaspaWasmReady();
  let failureStage = "preflight validation";

  try {
    requirePayloadLimit(input.payload, MAX_COVENANT_BUY_PAYLOAD_BYTES, "Ticket purchase");
    if (input.round.contractVersion !== RAFFLE_CONTRACT_VERSION) {
      throw new Error(`Buying is disabled for non-current covenant version ${input.round.contractVersion}. Use its exactly matching archived release.`);
    }
    if (input.round.ticketPrice < MIN_REFUNDABLE_TICKET_PRICE_SOMPI) {
      throw new Error(`This round's ticket price is below the ${formatKasAmount(MIN_REFUNDABLE_TICKET_PRICE_SOMPI)} refund-liveness minimum.`);
    }
    const currentRound: RoundState = {
      ...input.round,
      soldTickets: input.covenant.soldTickets,
      potAmount: covenantRemainingPrincipal(input.round, input.covenant),
      status: "Open",
      ticketRoot: input.covenant.ticketRoot,
      ticketFrontier: input.covenant.ticketFrontier,
      refundCursor: input.covenant.refundCursor ?? 0,
      refundBatchCursor: input.covenant.refundBatchCursor ?? 0,
      refundFeeDebtSompi: input.covenant.refundFeeDebtSompi ?? "0",
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

    await assertRaffleAppendState(currentRound, input.covenant);
    const currentAmount = BigInt(input.covenant.amountSompi);
    assertRaffleCarrierLiveness(input.round, input.covenant, "Ticket purchase");
    const purchaseAmount = input.round.ticketPrice * BigInt(input.ticketCount);
    const successorAmount = currentAmount + purchaseAmount;

    requireAtLeastSompi(
      successorAmount,
      MIN_COVENANT_CARRIER_SOMPI,
      "Next covenant output"
    );

    const covenantUtxo = await getCurrentCovenantUtxo(input.connection, input.covenant);
    const dagInfo = await input.connection.client.getBlockDagInfo();
    const salesDeadline = BigInt(input.covenant.refundAfterDaaScore || "0");
    if (salesDeadline <= 0n || dagInfo.virtualDaaScore >= salesDeadline) {
      const covenantInputDaa = BigInt(covenantUtxo.blockDaaScore);
      const canRescueStuckDrawableRound = Boolean(
        input.allowDeadlineRescueBuy &&
        input.covenant.status === "Open" &&
        input.covenant.soldTickets >= input.round.minTickets &&
        input.covenant.soldTickets < input.round.maxTickets &&
        input.ticketCount === 1 &&
        covenantInputDaa > 0n &&
        covenantInputDaa < salesDeadline
      );
      if (!canRescueStuckDrawableRound) {
        throw new Error(`Ticket sales closed at DAA ${salesDeadline}. No wallet signing request was opened.`);
      }
    }
    const currentChainHash = input.chainSearchHintHash ?? dagInfo.sink;
    failureStage = "wallet input selection";
    const walletUtxos = await input.connection.client.getUtxosByAddresses({ addresses: [input.wallet.address] });
    let buyFeeSompi = covenantBuyFeeSompi(input.round.contractVersion, input.ticketCount);
    failureStage = "successor covenant construction";
    const buyerPubkey = pubkeyHexFromAddress(input.wallet.address);
    const nextBatchIndex = covenantSoldBatches(input.covenant);
    const merkleAppend = await appendRoundBatch(
      input.round,
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
    // Refresh the client-side lookup anchor with every successor covenant.
    const chainSearchHintHash = currentChainHash;
    const nextState = await raffleCovenantStateFromRound(nextRound);
    const runtimeArtifact = getRaffleRuntimeArtifact(nextRound.contractVersion);
    const nextRedeemScript = buildRaffleRedeemScript(nextState, runtimeArtifact);
    const nextScriptPublicKey = await buildRaffleScriptPublicKey(nextState, runtimeArtifact);
    const nextAddress = await buildRaffleAddress(nextState, input.wallet.network, runtimeArtifact);
    const buySignatureScript = buildRaffleBuySignatureScript(
      hexToBytes(input.covenant.redeemScriptHex),
      buyerPubkey,
      input.ticketCount
    );
    const walletEntries = selectDirectPaymentEntries(
      walletUtxos.entries ?? [],
      purchaseAmount + MAX_COVENANT_BUY_FEE_SOMPI
    );
    const walletInputAmount = sumUtxoAmounts(walletEntries);
    const buildBuyTransaction = (feeSompi: bigint, includeCovenantBinding = true) => {
      if (feeSompi <= 0n || feeSompi > MAX_COVENANT_BUY_FEE_SOMPI) {
        throw new Error(`The ticket purchase fee must be between 1 sompi and ${formatKasAmount(MAX_COVENANT_BUY_FEE_SOMPI)}.`);
      }
      const fundingRefundAmount = walletInputAmount - purchaseAmount - feeSompi;
      if (fundingRefundAmount < SAFE_PAYMENT_CHANGE_SOMPI) {
        throw new Error("The ticket funding reserve cannot return a storage-mass-safe wallet change output.");
      }
      const outputs = [
        new TransactionOutput(successorAmount, nextScriptPublicKey),
        new TransactionOutput(fundingRefundAmount, payToAddressScript(input.wallet.address))
      ];
      const tx = buildManualTransaction({
        inputs: [
          {
            previousOutpoint: covenantOutpoint(input.covenant),
            signatureScript: buySignatureScript,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget: raffleBuyComputeBudget(input.ticketCount),
            utxo: asInputUtxo(covenantUtxo)
          },
          ...walletEntries.map(walletInputFromEntry)
        ],
        outputs,
        payload: input.payload
      });
      if (includeCovenantBinding) bindSuccessorCovenant(tx, input.covenant.covenantId);
      return { tx, outputs };
    };
    const convergeBuyTransaction = (minimumFeeSompi: bigint) => {
      let feeSompi = minimumFeeSompi > buyFeeSompi ? minimumFeeSompi : buyFeeSompi;
      // The bundled browser WASM converter cannot mass-measure a large
      // mixed-output wrapper reliably. Covenant bindings do not affect storage
      // mass; measure an otherwise identical unbound twin, then rebuild the
      // transaction with the exact successor binding before signing.
      let built = buildBuyTransaction(feeSompi, false);
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const staticRequiredFee = calculateTransactionFee(transactionNetworkId(input.connection.status.network), built.tx, 0);
        if (staticRequiredFee === undefined) throw new Error("The ticket purchase exceeds the standard mass limit.");
        const transientRequiredFee = minimumV1TransientRelayFeeSompi({
          signatureScriptHex: buySignatureScript,
          additionalInputSignatureScriptLengths: walletEntries.map(() => P2PK_SIGNATURE_SCRIPT_BYTES),
          outputScriptLengths: built.outputs.map((output) => scriptPublicKeyLength(output.scriptPublicKey)),
          payloadLength: input.payload.length
        });
        const requiredFee = staticRequiredFee > transientRequiredFee ? staticRequiredFee : transientRequiredFee;
        if (requiredFee > MAX_COVENANT_BUY_FEE_SOMPI) {
          throw new Error(`The ticket purchase needs more than the ${formatKasAmount(MAX_COVENANT_BUY_FEE_SOMPI)} fee cap.`);
        }
        if (requiredFee <= feeSompi) return { ...buildBuyTransaction(feeSompi, true), feeSompi };
        feeSompi = requiredFee;
        built = buildBuyTransaction(feeSompi, false);
      }
      throw new Error("Unable to converge on the ticket purchase transaction fee.");
    };

    failureStage = "transaction fee convergence";
    let converged = convergeBuyTransaction(buyFeeSompi);
    let txId = "";

    failureStage = "single wallet signing and RPC submission";
    try {
      const walletInputIndexes = walletEntries.map((_, index) => index + 1);
      await input.wallet.signTransaction(converged.tx, walletInputIndexes);
      try {
        txId = await submitTransaction(input.connection, converged.tx);
        buyFeeSompi = converged.feeSompi;
      } catch (error) {
        const nodeRequiredFee = requiredFeeFromNodeRejection(error);
        if (nodeRequiredFee !== undefined && nodeRequiredFee > converged.feeSompi) {
          throw new Error(`The node fee floor changed to ${formatKasAmount(nodeRequiredFee)} after signing. No automatic second wallet request was opened; review and retry the purchase.`);
        }
        throw error;
      }
      if (!txId) throw new Error("The ticket purchase transaction was not submitted.");
    } catch (error) {
      throw normalizeTransactionError(error);
    }

    return {
      txId,
      feeSompi: buyFeeSompi,
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
    const normalized = normalizeTransactionError(error);
    throw new Error(`Ticket purchase failed during ${failureStage}: ${normalized.message} No preliminary funding transaction was broadcast.`);
  }
}

export async function topUpRaffleCovenantCarrier(input: TopUpRaffleCovenantCarrierInput): Promise<RaffleCovenantSpendResult> {
  await ensureKaspaWasmReady();

  let failureStage = "preflight checks";
  let recoveryUtxo: IUtxoEntry | undefined;
  try {
    requirePayloadLimit(input.payload, MAX_COVENANT_TOP_UP_PAYLOAD_BYTES, "Carrier top-up");
    if (input.round.contractVersion !== RAFFLE_CONTRACT_VERSION) {
      throw new Error("This round's deployed covenant does not support carrier top-ups.");
    }
    if (input.amountSompi < MIN_COVENANT_TOP_UP_SOMPI) {
      throw new Error(`Carrier top-up amount must be at least ${formatKasAmount(MIN_COVENANT_TOP_UP_SOMPI)}.`);
    }
    if (input.covenant.status === "Refunding" || input.covenant.status === "Refunded" || input.covenant.status === "Finalized") {
      throw new Error("Carrier can only be added before settlement starts.");
    }
    if (input.covenant.soldTickets >= input.round.minTickets) {
      throw new Error("Carrier cannot be added after the minimum is met because this covenant DAA fixes the draw boundary.");
    }

    const currentRound: RoundState = {
      ...input.round,
      soldTickets: input.covenant.soldTickets,
      potAmount: covenantRemainingPrincipal(input.round, input.covenant),
      status: input.covenant.status,
      ticketRoot: input.covenant.ticketRoot,
      ticketFrontier: input.covenant.ticketFrontier,
      refundCursor: input.covenant.refundCursor ?? 0,
      refundBatchCursor: input.covenant.refundBatchCursor ?? 0,
      refundFeeDebtSompi: input.covenant.refundFeeDebtSompi ?? "0",
      creatorPubkey: input.covenant.creatorPubkey,
      refundAfterDaaScore: input.covenant.refundAfterDaaScore,
      soldBatches: covenantSoldBatches(input.covenant),
      ticketBatchEnds: covenantBatchEnds(input.covenant),
      ticketOwnerPubkeys: input.covenant.ticketOwnerPubkeys
    };
    await assertRaffleRedeemScriptMatchesRound(currentRound, input.covenant.redeemScriptHex, "Carrier top-up");
    await assertRaffleAppendState(currentRound, input.covenant);

    const covenantUtxo = await getCurrentCovenantUtxo(input.connection, input.covenant);
    const deadline = BigInt(input.covenant.refundAfterDaaScore || "0");
    const dagInfo = await input.connection.client.getBlockDagInfo();
    if (deadline <= 0n || dagInfo.virtualDaaScore >= deadline) {
      throw new Error(`Carrier top-up closed at DAA ${deadline}. No temporary funding transaction was created.`);
    }
    failureStage = "wallet-owned temporary funding";
    const walletUtxos = await input.connection.client.getUtxosByAddresses({ addresses: [input.wallet.address] });
    let topUpFeeSompi = COVENANT_TOP_UP_FEE_SOMPI;
    // Keep the bounded retry envelope and a storage-mass-safe ordinary change
    // output in the wallet-owned staging UTXO. Only the converged fee is paid.
    const stagingAmount = lowCostFundingAmount(
      input.amountSompi,
      MAX_COVENANT_TOP_UP_FEE_SOMPI + SAFE_PAYMENT_CHANGE_SOMPI
    );
    const stagingAddress = input.wallet.address;
    const walletEntries = selectPaymentEntries(walletUtxos.entries ?? [], stagingAmount);
    const { transactions } = await createTransactions({
      entries: walletEntries,
      outputs: [{ address: stagingAddress, amount: stagingAmount }],
      changeAddress: input.wallet.address,
      priorityFee: 0n,
      networkId: transactionNetworkId(input.wallet.network)
    });
    const stagingTransaction = transactions[0];
    if (!stagingTransaction) throw new Error("Unable to build the carrier funding transaction.");

    await input.wallet.signTransaction(stagingTransaction);
    const stagingTxId = await stagingTransaction.submit(input.connection.client);
    const stagingUtxo = await waitForAddressUtxo(input.connection, stagingAddress, stagingTxId, 0);
    recoveryUtxo = stagingUtxo;
    failureStage = "successor covenant construction";
    const successorAmount = BigInt(input.covenant.amountSompi) + input.amountSompi;
    const successorScriptPublicKey = await buildRaffleScriptPublicKey(
      await raffleCovenantStateFromRound(currentRound),
      getRaffleRuntimeArtifact(currentRound.contractVersion)
    );
    const topUpSignatureScript = buildRaffleTopUpSignatureScript(hexToBytes(input.covenant.redeemScriptHex), input.amountSompi);
    const walletChangeScriptPublicKey = payToAddressScript(input.wallet.address);
    const buildTopUpTransaction = (feeSompi: bigint, includeCovenantBinding = true) => {
      if (feeSompi <= 0n || feeSompi > MAX_COVENANT_TOP_UP_FEE_SOMPI) {
        throw new Error(`The carrier top-up fee must be between 1 sompi and ${formatKasAmount(MAX_COVENANT_TOP_UP_FEE_SOMPI)}.`);
      }
      const fundingRefundAmount = stagingAmount - input.amountSompi - feeSompi;
      if (fundingRefundAmount < SAFE_PAYMENT_CHANGE_SOMPI) {
        throw new Error("The carrier funding reserve cannot return a storage-mass-safe wallet change output.");
      }
      const outputs = [
        new TransactionOutput(successorAmount, successorScriptPublicKey),
        new TransactionOutput(fundingRefundAmount, walletChangeScriptPublicKey)
      ];
      const tx = buildManualTransaction({
        inputs: [
          {
            previousOutpoint: covenantOutpoint(input.covenant),
            signatureScript: topUpSignatureScript,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget: RAFFLE_TOP_UP_COMPUTE_BUDGET,
            utxo: asInputUtxo(covenantUtxo)
          },
          {
            previousOutpoint: stagingUtxo.outpoint,
            signatureScript: "",
            sequence: 0n,
            sigOpCount: 0,
            computeBudget: P2PK_WALLET_COMPUTE_BUDGET,
            utxo: asInputUtxo(stagingUtxo)
          }
        ],
        outputs,
        payload: input.payload
      });
      if (includeCovenantBinding) bindSuccessorCovenant(tx, input.covenant.covenantId);
      return { tx, outputs };
    };
    const convergeTopUpTransaction = (minimumFeeSompi: bigint) => {
      let feeSompi = minimumFeeSompi > topUpFeeSompi ? minimumFeeSompi : topUpFeeSompi;
      // As with Buy, measure an otherwise identical unbound twin because the
      // browser converter cannot reliably mass-measure a large mixed wrapper.
      let built = buildTopUpTransaction(feeSompi, false);
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const staticRequiredFee = calculateTransactionFee(transactionNetworkId(input.connection.status.network), built.tx, 0);
        if (staticRequiredFee === undefined) throw new Error("The carrier top-up exceeds the standard mass limit.");
        const transientRequiredFee = minimumV1TransientRelayFeeSompi({
          signatureScriptHex: topUpSignatureScript,
          additionalInputSignatureScriptLengths: [P2PK_SIGNATURE_SCRIPT_BYTES],
          outputScriptLengths: built.outputs.map((output) => scriptPublicKeyLength(output.scriptPublicKey)),
          payloadLength: input.payload?.length ?? 0
        });
        const requiredFee = staticRequiredFee > transientRequiredFee ? staticRequiredFee : transientRequiredFee;
        if (requiredFee > MAX_COVENANT_TOP_UP_FEE_SOMPI) {
          throw new Error(`The carrier top-up needs more than the ${formatKasAmount(MAX_COVENANT_TOP_UP_FEE_SOMPI)} fee cap.`);
        }
        if (requiredFee <= feeSompi) return { ...buildTopUpTransaction(feeSompi, true), feeSompi };
        feeSompi = requiredFee;
        built = buildTopUpTransaction(feeSompi, false);
      }
      throw new Error("Unable to converge on the carrier top-up transaction fee.");
    };

    failureStage = "transaction fee convergence";
    let converged = convergeTopUpTransaction(topUpFeeSompi);
    let txId = "";
    failureStage = "wallet signing and RPC submission";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await input.wallet.signTransaction(converged.tx, [1]);
        txId = await submitTransaction(input.connection, converged.tx);
        topUpFeeSompi = converged.feeSompi;
        break;
      } catch (error) {
        const nodeRequiredFee = requiredFeeFromNodeRejection(error);
        if (nodeRequiredFee === undefined || nodeRequiredFee <= converged.feeSompi || attempt === 2) throw error;
        if (nodeRequiredFee > MAX_COVENANT_TOP_UP_FEE_SOMPI) {
          throw new Error(`The carrier top-up needs more than the ${formatKasAmount(MAX_COVENANT_TOP_UP_FEE_SOMPI)} fee cap.`);
        }
        converged = convergeTopUpTransaction(nodeRequiredFee);
      }
    }
    if (!txId) throw new Error("The carrier top-up transaction was not submitted.");

    return {
      txId,
      feeSompi: topUpFeeSompi,
      fundingFeeSompi: stagingTransaction.feeAmount,
      covenant: nextCovenantCursor({
        previous: input.covenant,
        address: input.covenant.address,
        txId,
        amountSompi: successorAmount,
        redeemScript: hexToBytes(input.covenant.redeemScriptHex),
        soldTickets: input.covenant.soldTickets,
        potAmount: covenantRemainingPrincipal(input.round, input.covenant),
        status: input.covenant.status,
        ticketRoot: input.covenant.ticketRoot,
        ticketFrontier: input.covenant.ticketFrontier,
        chainSearchHintHash: input.covenant.chainSearchHintHash,
        refundCursor: input.covenant.refundCursor,
        refundBatchCursor: input.covenant.refundBatchCursor,
        refundFeeDebtSompi: input.covenant.refundFeeDebtSompi,
        creatorPubkey: input.covenant.creatorPubkey,
        refundAfterDaaScore: input.covenant.refundAfterDaaScore,
        soldBatches: covenantSoldBatches(input.covenant),
        ticketBatchEnds: covenantBatchEnds(input.covenant),
        ticketOwnerPubkeys: input.covenant.ticketOwnerPubkeys
      })
    };
  } catch (error) {
    const normalized = normalizeTransactionError(error);
    const recovery = recoveryUtxo
      ? ` ${await temporaryFundingRecoveryMessage(input.connection, input.wallet.address, recoveryUtxo)}`
      : "";
    throw new Error(`Carrier top-up failed during ${failureStage}: ${normalized.message}${recovery}`);
  }
}

export async function finalizeRaffleCovenantRound(input: FinalizeRaffleCovenantRoundInput): Promise<RaffleCovenantSpendResult> {
  await ensureKaspaWasmReady();

  try {
    if (input.round.contractVersion !== RAFFLE_CONTRACT_VERSION) {
      throw new Error(`Finalization is disabled for non-current covenant version ${input.round.contractVersion}. Use its exactly matching archived release.`);
    }
    const activeRound: RoundState = {
      ...input.round,
      soldTickets: input.covenant.soldTickets,
      potAmount: covenantRemainingPrincipal(input.round, input.covenant),
      status: "Open",
      ticketRoot: input.covenant.ticketRoot,
      ticketFrontier: input.covenant.ticketFrontier,
      refundCursor: input.covenant.refundCursor ?? 0,
      refundBatchCursor: input.covenant.refundBatchCursor ?? 0,
      refundFeeDebtSompi: input.covenant.refundFeeDebtSompi ?? "0",
      creatorPubkey: input.covenant.creatorPubkey,
      refundAfterDaaScore: input.covenant.refundAfterDaaScore,
      soldBatches: covenantSoldBatches(input.covenant),
      ticketBatchEnds: covenantBatchEnds(input.covenant),
      ticketOwnerPubkeys: input.covenant.ticketOwnerPubkeys
    };

    await assertRaffleRedeemScriptMatchesRound(activeRound, input.covenant.redeemScriptHex, "Finalize");

    const covenantUtxo = await getCurrentCovenantUtxo(input.connection, input.covenant);
    const randomSeed = isVNextRaffleContractVersion(activeRound.contractVersion)
      ? bytesToHex(await deriveDrawSeed(
          bytesToHex(await roundIdToBytes32(activeRound.roundNonce || activeRound.roundId)),
          activeRound.ticketRoot,
          input.randomnessWitness.target.hash,
          input.randomnessWitness.target.seqcommit
        ))
      : input.randomnessWitness.randomSeedHex;
    const winnerIndex = await raffleWinnerIndexFromSeed(randomSeed, input.covenant.soldTickets);

    if (winnerIndex + 1 !== input.winnerTicketId) {
      throw new Error("Selected winner does not match the covenant random seed.");
    }

    const winnerPubkey = input.winner.ownerPubkey || pubkeyHexFromAddress(input.winner.owner);
    const winnerBatchStart = input.winner.ticketId - 1;
    const winnerBatchCount = ticketRangeCount(input.winner);
    if (
      winnerIndex < winnerBatchStart || winnerIndex >= winnerBatchStart + winnerBatchCount ||
      !input.winnerProofHex ||
      !await verifyRoundBatchProof(
        activeRound,
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

    const finalizeCarrierSompi = currentAmount - activeRound.potAmount;
    if (finalizeCarrierSompi < MIN_COVENANT_CARRIER_SOMPI) {
      throw new Error(
        `Covenant carrier is ${formatKasAmount(finalizeCarrierSompi)}, but a vNext finalize needs at least ${formatKasAmount(MIN_COVENANT_CARRIER_SOMPI)} for a relay-standard transaction. ` +
        (activeRound.contractVersion === RAFFLE_CONTRACT_VERSION
          ? "Add carrier to this covenant and retry."
          : "This deployed covenant version cannot be topped up; create a replacement round.")
      );
    }

    const winnerScriptPublicKey = p2pkScriptPublicKey(winnerPubkey, "Winner public key");
    const creatorScriptPublicKey = p2pkScriptPublicKey(activeRound.creatorPubkey, "Creator public key");
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
    for (let attempt = 0; attempt < MAX_FINALIZE_FEE_CONVERGENCE_ATTEMPTS; attempt += 1) {
      const staticRequiredFee = calculateTransactionFee(transactionNetworkId(input.connection.status.network), built.tx, 0);
      if (staticRequiredFee === undefined) {
        throw new Error(activeRound.contractVersion === RAFFLE_CONTRACT_VERSION
          ? "The finalize transaction exceeds the standard mass limit; add carrier to this covenant and retry."
          : "The finalize transaction exceeds the standard mass limit; create a replacement round with more carrier.");
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
      throw new Error(activeRound.contractVersion === RAFFLE_CONTRACT_VERSION
        ? "The finalize fee did not stabilize within the relay-safe measurement limit; add carrier and retry."
        : "The finalize fee did not stabilize within the relay-safe measurement limit; create a replacement round with a larger carrier.");
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
          if (finalizeFeeSompi > MAX_COVENANT_FINALIZE_FEE_SOMPI) {
            throw new Error(`The finalize transaction needs more than the ${formatKasAmount(MAX_COVENANT_FINALIZE_FEE_SOMPI)} covenant fee cap.`);
          }
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

/** Closes an expired zero-sale round. Anyone may relay it, but the covenant
 * fixes the only output to the committed creator public key. */
export async function closeEmptyRaffleCovenantRound(input: CloseEmptyRaffleCovenantRoundInput): Promise<RaffleCovenantSpendResult> {
  await ensureKaspaWasmReady();

  try {
    const currentRound: RoundState = {
      ...input.round,
      soldTickets: input.covenant.soldTickets,
      potAmount: covenantRemainingPrincipal(input.round, input.covenant),
      status: input.covenant.status,
      ticketRoot: input.covenant.ticketRoot,
      ticketFrontier: input.covenant.ticketFrontier,
      refundCursor: input.covenant.refundCursor ?? 0,
      refundBatchCursor: input.covenant.refundBatchCursor ?? 0,
      refundFeeDebtSompi: input.covenant.refundFeeDebtSompi ?? "0",
      creatorPubkey: input.covenant.creatorPubkey,
      refundAfterDaaScore: input.covenant.refundAfterDaaScore,
      soldBatches: covenantSoldBatches(input.covenant),
      ticketBatchEnds: covenantBatchEnds(input.covenant),
      ticketOwnerPubkeys: input.covenant.ticketOwnerPubkeys
    };
    await assertRaffleRedeemScriptMatchesRound(currentRound, input.covenant.redeemScriptHex, "Close empty round");
    if (currentRound.contractVersion !== RAFFLE_CONTRACT_VERSION) {
      throw new Error("closeEmpty is available only for the current vNext covenant.");
    }
    if (input.covenant.soldTickets !== 0 || covenantSoldBatches(input.covenant) !== 0) {
      throw new Error("Only a round with zero sold tickets and zero purchase batches can be closed empty.");
    }
    if (input.covenant.status !== "Open" && input.covenant.status !== "Closed") {
      throw new Error("This covenant is not an open empty round.");
    }
    const creatorPubkey = input.covenant.creatorPubkey.toLowerCase();
    const deadline = BigInt(input.covenant.refundAfterDaaScore || "0");
    const dagInfo = await input.connection.client.getBlockDagInfo();
    if (deadline <= 0n || dagInfo.virtualDaaScore < deadline) {
      throw new Error(`Empty rounds can close only at or after DAA ${deadline}.`);
    }

    const covenantUtxo = await getCurrentCovenantUtxo(input.connection, input.covenant);
    const currentAmount = BigInt(input.covenant.amountSompi);
    const creatorOutput = p2pkScriptPublicKey(creatorPubkey, "Creator public key");
    const redeemScript = hexToBytes(input.covenant.redeemScriptHex);

    const buildCloseTransaction = (closeFeeSompi: bigint): { tx: Transaction; signatureScriptHex: string } => {
      if (closeFeeSompi <= 0n || closeFeeSompi > MAX_COVENANT_CLOSE_FEE_SOMPI) {
        throw new Error(`The empty-round close fee must be between 1 sompi and ${formatKasAmount(MAX_COVENANT_CLOSE_FEE_SOMPI)}.`);
      }
      const creatorRefund = currentAmount - closeFeeSompi;
      if (creatorRefund <= 0n) throw new Error("The empty-round carrier cannot pay its close fee.");
      const signatureScriptHex = buildRaffleCloseEmptySignatureScript(redeemScript, closeFeeSompi);
      const tx = buildManualTransaction({
        inputs: [{
          previousOutpoint: covenantOutpoint(input.covenant),
          signatureScript: signatureScriptHex,
          sequence: 0n,
          sigOpCount: 0,
          computeBudget: RAFFLE_CLOSE_EMPTY_COMPUTE_BUDGET,
          utxo: asInputUtxo(covenantUtxo)
        }],
        outputs: [new TransactionOutput(creatorRefund, creatorOutput)],
        payload: input.payload,
        lockTime: deadline
      });
      return { tx, signatureScriptHex };
    };

    const convergeCloseTransaction = (minimumFeeSompi: bigint) => {
      let feeSompi = minimumFeeSompi > 0n ? minimumFeeSompi : 1n;
      let built = buildCloseTransaction(feeSompi);
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const staticRequiredFee = calculateTransactionFee(transactionNetworkId(input.connection.status.network), built.tx, 0);
        if (staticRequiredFee === undefined) throw new Error("The empty-round close transaction exceeds the standard mass limit.");
        const transientRequiredFee = minimumV1TransientRelayFeeSompi({
          signatureScriptHex: built.signatureScriptHex,
          outputScriptLengths: [scriptPublicKeyLength(creatorOutput)],
          payloadLength: input.payload?.length ?? 0
        });
        const requiredFee = staticRequiredFee > transientRequiredFee ? staticRequiredFee : transientRequiredFee;
        if (requiredFee > MAX_COVENANT_CLOSE_FEE_SOMPI) {
          throw new Error(`The empty-round close transaction needs more than the ${formatKasAmount(MAX_COVENANT_CLOSE_FEE_SOMPI)} covenant fee cap.`);
        }
        if (requiredFee <= feeSompi) return { feeSompi, tx: built.tx };
        feeSompi = requiredFee;
        built = buildCloseTransaction(feeSompi);
      }
      throw new Error("The empty-round close fee did not converge.");
    };

    let converged = convergeCloseTransaction(1n);
    let txId = "";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        txId = await submitTransaction(input.connection, converged.tx);
        break;
      } catch (error) {
        const nodeRequiredFee = requiredFeeFromNodeRejection(error);
        if (nodeRequiredFee === undefined || nodeRequiredFee <= converged.feeSompi || attempt === 2) throw error;
        if (nodeRequiredFee > MAX_COVENANT_CLOSE_FEE_SOMPI) {
          throw new Error(`The empty-round close transaction needs more than the ${formatKasAmount(MAX_COVENANT_CLOSE_FEE_SOMPI)} covenant fee cap.`);
        }
        converged = convergeCloseTransaction(nodeRequiredFee);
      }
    }
    if (!txId) throw new Error("Unable to submit the empty-round close transaction.");
    return { txId, feeSompi: converged.feeSompi };
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
      potAmount: covenantRemainingPrincipal(input.round, input.covenant),
      status: input.covenant.status,
      ticketRoot: input.covenant.ticketRoot,
      ticketFrontier: input.covenant.ticketFrontier,
      refundCursor: input.covenant.refundCursor ?? 0,
      refundBatchCursor: input.covenant.refundBatchCursor ?? 0,
      refundFeeDebtSompi: input.covenant.refundFeeDebtSompi ?? "0",
      creatorPubkey: input.covenant.creatorPubkey,
      refundAfterDaaScore: input.covenant.refundAfterDaaScore,
      soldBatches: covenantSoldBatches(input.covenant),
      ticketBatchEnds: covenantBatchEnds(input.covenant),
      ticketOwnerPubkeys: input.covenant.ticketOwnerPubkeys
    };

    await assertRaffleRedeemScriptMatchesRound(currentRound, input.covenant.redeemScriptHex, "Refund");

    if (currentRound.contractVersion !== RAFFLE_CONTRACT_VERSION) {
      throw new Error(`Refund spending is disabled for quarantined covenant version ${currentRound.contractVersion}. Load an archived release that exactly matches that version instead.`);
    }

    const covenantUtxo = await getCurrentCovenantUtxo(input.connection, input.covenant);
    const currentAmount = BigInt(input.covenant.amountSompi);
    const refundArtifact = getRaffleRefundRuntimeArtifact(currentRound.contractVersion);

      if (input.covenant.status !== "Refunding") {
        const supportsDynamicTransitionFee = isVNextRaffleContractVersion(currentRound.contractVersion);
        const prepareTransitionSuccessor = async (transitionFeeSompi: bigint) => {
          const nextRound: RoundState = {
            ...currentRound,
            status: "Refunding",
            refundCursor: 0,
            refundBatchCursor: 0,
            refundFeeDebtSompi: supportsDynamicTransitionFee ? transitionFeeSompi.toString() : undefined
          };
          const nextState = await raffleCovenantStateFromRound(nextRound);
          return {
            nextRound,
            redeemScript: buildRaffleRedeemScript(nextState, refundArtifact),
            scriptPublicKey: await buildRaffleScriptPublicKey(nextState, refundArtifact),
            address: await buildRaffleAddress(nextState, input.connection.status.network, refundArtifact)
          };
        };
        const buildTransitionTransaction = (
          transitionFeeSompi: bigint,
          successor: Awaited<ReturnType<typeof prepareTransitionSuccessor>>,
          sponsorUtxos: IUtxoEntry[] = [],
          includeCovenantBinding = true
        ): Transaction => {
          const nextAmount = currentAmount - transitionFeeSompi;
          if (nextAmount <= 0n) throw new Error("The covenant carrier is too small to start batch refunds.");
          if (isVNextRaffleContractVersion(currentRound.contractVersion)) {
            const requiredAfterTransition = currentRound.ticketPrice * BigInt(currentRound.soldTickets);
            if (nextAmount < requiredAfterTransition) {
              throw new Error("The covenant carrier cannot preserve all ticket principal after the refund transition.");
            }
          }
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
              sigOpCount: 0,
              computeBudget: P2PK_WALLET_COMPUTE_BUDGET,
              utxo: asInputUtxo(sponsorUtxo)
            });
          });
          const tx = buildManualTransaction({
            inputs,
            outputs: [new TransactionOutput(nextAmount, successor.scriptPublicKey)],
            payload: supportsDynamicTransitionFee ? input.refundStartPayload?.(transitionFeeSompi) ?? input.payload : input.payload,
            lockTime: BigInt(input.covenant.refundAfterDaaScore)
          });
          if (includeCovenantBinding) bindSuccessorCovenant(tx, input.covenant.covenantId);
          return tx;
        };

        let transitionFeeSompi = REFUND_TRANSITION_FEE_SOMPI;
        let transitionSuccessor = await prepareTransitionSuccessor(transitionFeeSompi);
        if (supportsDynamicTransitionFee) {
          let measured = buildTransitionTransaction(transitionFeeSompi, transitionSuccessor, [], false);
          for (let attempt = 0; attempt < 8; attempt += 1) {
            const staticRequiredFee = calculateTransactionFee(transactionNetworkId(input.connection.status.network), measured, 0);
            if (staticRequiredFee === undefined) throw new Error("The refund transition exceeds the standard mass limit.");
            const signatureScriptHex = measured.inputs[0]?.signatureScript ?? "";
            const transientRequiredFee = minimumV1TransientRelayFeeSompi({
              signatureScriptHex,
              outputScriptLengths: [scriptPublicKeyLength(transitionSuccessor.scriptPublicKey)],
              payloadLength: (input.refundStartPayload?.(transitionFeeSompi) ?? input.payload)?.length ?? 0
            });
            const requiredFee = staticRequiredFee > transientRequiredFee ? staticRequiredFee : transientRequiredFee;
            if (requiredFee > MAX_REFUND_TRANSITION_FEE_SOMPI) {
              throw new Error(`The refund transition needs more than the ${formatKasAmount(MAX_REFUND_TRANSITION_FEE_SOMPI)} covenant fee cap.`);
            }
            if (requiredFee <= transitionFeeSompi) break;
            transitionFeeSompi = requiredFee;
            transitionSuccessor = await prepareTransitionSuccessor(transitionFeeSompi);
            measured = buildTransitionTransaction(transitionFeeSompi, transitionSuccessor, [], false);
          }
        }

        let tx = buildTransitionTransaction(transitionFeeSompi, transitionSuccessor);
        let txId = "";
        try {
          txId = await submitTransaction(input.connection, tx);
        } catch (error) {
          const nodeRequiredFee = requiredFeeFromNodeRejection(error);
          if (supportsDynamicTransitionFee && nodeRequiredFee !== undefined && nodeRequiredFee > transitionFeeSompi) {
            let requiredFee = nodeRequiredFee;
            for (let attempt = 0; attempt < 3; attempt += 1) {
              if (requiredFee > MAX_REFUND_TRANSITION_FEE_SOMPI) {
                throw new Error(`The refund transition needs more than the ${formatKasAmount(MAX_REFUND_TRANSITION_FEE_SOMPI)} covenant fee cap.`);
              }
              transitionFeeSompi = requiredFee;
              transitionSuccessor = await prepareTransitionSuccessor(transitionFeeSompi);
              tx = buildTransitionTransaction(transitionFeeSompi, transitionSuccessor);
              try {
                txId = await submitTransaction(input.connection, tx);
                break;
              } catch (retryError) {
                const retryRequiredFee = requiredFeeFromNodeRejection(retryError);
                if (retryRequiredFee === undefined || retryRequiredFee <= transitionFeeSompi || attempt === 2) throw retryError;
                requiredFee = retryRequiredFee;
              }
            }
            if (!txId) throw new Error("Unable to submit the refund transition.");
          } else {
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
            tx = buildTransitionTransaction(transitionFeeSompi, transitionSuccessor, sponsorUtxos);
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
        }
        return {
          txId,
          covenant: nextCovenantCursor({
            previous: input.covenant,
            address: transitionSuccessor.address,
            txId,
            amountSompi: currentAmount - transitionFeeSompi,
            redeemScript: transitionSuccessor.redeemScript,
            soldTickets: input.covenant.soldTickets,
            potAmount: covenantRemainingPrincipal(input.round, input.covenant),
            status: "Refunding",
            ticketRoot: currentRound.ticketRoot,
            ticketFrontier: currentRound.ticketFrontier,
            refundCursor: 0,
            refundBatchCursor: 0,
            refundFeeDebtSompi: transitionSuccessor.nextRound.refundFeeDebtSompi,
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
      const maximumBatchCount = MAX_REFUND_PURCHASE_BATCHES_PER_TX;
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
        if (!await verifyRoundBatchProof(
          currentRound,
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
          ownerScriptPublicKey: p2pkScriptPublicKey(ownerPubkey, `Refund owner #${expectedBatchIndex + 1}`)
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

      const creatorScriptPublicKey = p2pkScriptPublicKey(currentRound.creatorPubkey, "Creator public key");
      let nextRedeemScript: Uint8Array | undefined;
      let nextAddress = "";
      let nextScriptPublicKey: Awaited<ReturnType<typeof buildRaffleScriptPublicKey>> | undefined;
      if (hasSuccessor) {
        const nextRound: RoundState = {
          ...currentRound,
          status: "Refunding",
          potAmount: currentRound.potAmount - totalBatchValue,
          refundCursor: nextRefundCursor,
          refundBatchCursor: nextRefundBatchCursor,
          refundFeeDebtSompi: "0"
        };
        const nextState = await raffleCovenantStateFromRound(nextRound);
        nextRedeemScript = buildRaffleRedeemScript(nextState, refundArtifact);
        nextAddress = await buildRaffleAddress(nextState, input.connection.status.network, refundArtifact);
        nextScriptPublicKey = await buildRaffleScriptPublicKey(nextState, refundArtifact);
      }

      const buildRefundTransaction = (refundFeeSompi: bigint, includeCovenantBinding = true): { tx: Transaction; signatureScriptHex: string } => {
        const buyerFundedVNext = isVNextRaffleContractVersion(currentRound.contractVersion);
        const refundFeeDebtSompi = buyerFundedVNext ? BigInt(input.covenant.refundFeeDebtSompi ?? "0") : 0n;
        const totalBuyerFeeSompi = buyerFundedVNext ? refundFeeSompi + refundFeeDebtSompi : 0n;
        const feePerBatch = totalBuyerFeeSompi / BigInt(verifiedBatches.length);
        const feeRemainder = totalBuyerFeeSompi % BigInt(verifiedBatches.length);
        const nextCovenantValue = buyerFundedVNext
          ? currentAmount - totalBatchValue + refundFeeDebtSompi
          : currentAmount - totalBatchValue - refundFeeSompi;
        if (nextCovenantValue < 0n) {
          throw new Error("The refund covenant does not contain enough value for this transaction.");
        }
        if (hasSuccessor && buyerFundedVNext) {
          const remainingPrincipal = currentRound.ticketPrice * BigInt(currentRound.soldTickets - nextRefundCursor);
          if (nextCovenantValue < remainingPrincipal) {
            throw new Error("The refund covenant cannot preserve the remaining ticket principal.");
          }
        }
        const ownerOutputs = verifiedBatches.map((batch, index) => {
          const buyerFee = feePerBatch + (index === 0 ? feeRemainder : 0n);
          if (batch.batchValue <= buyerFee) {
            throw new Error(`Purchase batch #${batch.batchIndex + 1} cannot cover its allocated refund network fee.`);
          }
          return new TransactionOutput(batch.batchValue - buyerFee, batch.ownerScriptPublicKey);
        });
        const outputs = hasSuccessor
          ? [new TransactionOutput(nextCovenantValue, nextScriptPublicKey!), ...ownerOutputs]
          : [...ownerOutputs, new TransactionOutput(nextCovenantValue, creatorScriptPublicKey)];
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
          if (refundFeeSompi > maximumRefundFee) {
            throw new Error(`The refund transaction needs more than the ${formatKasAmount(maximumRefundFee)} covenant fee cap.`);
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
          amountSompi: isVNextRaffleContractVersion(currentRound.contractVersion)
            ? currentAmount - totalBatchValue + BigInt(input.covenant.refundFeeDebtSompi ?? "0")
            : currentAmount - totalBatchValue - refundFeeSompi,
          redeemScript: nextRedeemScript,
          soldTickets: input.covenant.soldTickets,
          potAmount: currentRound.potAmount - totalBatchValue,
          status: "Refunding",
          ticketRoot: currentRound.ticketRoot,
          ticketFrontier: currentRound.ticketFrontier,
          refundCursor: nextRefundCursor,
          refundBatchCursor: nextRefundBatchCursor,
          refundFeeDebtSompi: "0",
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
