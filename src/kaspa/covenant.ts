import {
  addressFromScriptPublicKey,
  payToScriptHashScript,
  payToAddressScript,
  ScriptBuilder,
  type ScriptPublicKey
} from "@onekeyfe/kaspa-wasm";
import raffleRoundV13Artifact from "../contracts/compiled/raffle-round-v13.artifact.json";
import raffleRoundV12Artifact from "../contracts/compiled/raffle-round-v12.artifact.json";
import raffleRefundV3Artifact from "../contracts/compiled/raffle-refund-v3.artifact.json";
import raffleRoundV11Artifact from "../contracts/compiled/raffle-round-v11.artifact.json";
import raffleRefundV2Artifact from "../contracts/compiled/raffle-refund-v2.artifact.json";
import { hexToBytes, sha256Hex } from "../raffle/randomness";
import { TICKET_EMPTY_FRONTIER_HEX, TICKET_EMPTY_ROOT_HEX, TICKET_MERKLE_PROOF_BYTES } from "../raffle/merkle";
import type { RoundState } from "../raffle/types";
import type { ChainRandomnessWitness } from "./chain-randomness";
import {
  LEGACY_RAFFLE_CONTRACT_VERSION,
  PREVIOUS_RAFFLE_CONTRACT_VERSION,
  RAFFLE_CONTRACT_VERSION,
  isSupportedRaffleContractVersion
} from "../raffle/metadata";
import { ensureKaspaWasmReady } from "./wasm";

export interface CovenantArtifactStatus {
  enabled: boolean;
  contract: string;
  network: string;
  status: string;
  message: string;
}

interface RuntimeAbiInput {
  name: string;
  type_name: string;
}

interface RuntimeAbiEntry {
  name: string;
  inputs: RuntimeAbiInput[];
  selector: number | null;
}

interface RuntimeStateField {
  name: string;
  type: string;
}

export interface RaffleRoundRuntimeArtifact {
  contract: string;
  compilerVersion: string;
  script: string;
  scriptLength: number;
  withoutSelector: boolean;
  abi: RuntimeAbiEntry[];
  stateLayout: {
    start: number;
    len: number;
  };
  stateFields: RuntimeStateField[];
}

export type RaffleCovenantEntrypoint = "buy" | "finalize" | "refund_next" | "start_refund";
export type RaffleCovenantStateValue = bigint | Uint8Array;
export type RaffleCovenantStateValues = Record<string, RaffleCovenantStateValue>;

const raffleArtifact = raffleRoundV13Artifact as RaffleRoundRuntimeArtifact;
const previousRaffleArtifact = raffleRoundV12Artifact as RaffleRoundRuntimeArtifact;
const refundArtifact = raffleRefundV3Artifact as RaffleRoundRuntimeArtifact;
const legacyRaffleArtifact = raffleRoundV11Artifact as RaffleRoundRuntimeArtifact;
const legacyRefundArtifact = raffleRefundV2Artifact as RaffleRoundRuntimeArtifact;
export const CURRENT_RAFFLE_CONTRACT_VERSION = RAFFLE_CONTRACT_VERSION;
const INT_STATE_FIELD_SIZE = 8;
const ZERO32_HEX = "00".repeat(32);

const entrypointNames: Record<RaffleCovenantEntrypoint, string> = {
  buy: "buy",
  finalize: "finalize",
  refund_next: "refundNext",
  start_refund: "startRefund"
};

export function getRaffleCovenantStatus(): CovenantArtifactStatus {
  const enabled = raffleArtifact.contract === "RaffleRoundV13" &&
    refundArtifact.contract === "RaffleRefundV3" &&
    [raffleArtifact, refundArtifact].every((candidate) => Boolean(candidate.script) && candidate.abi.length > 0);

  return {
    enabled,
    contract: raffleArtifact.contract,
    network: "toccata-v1",
    status: enabled ? "compiled-runtime" : "unavailable",
    message: enabled
      ? "Covenant artifacts are available. Finalize will build a Toccata covenant spend."
      : "Covenant bytecode is compiled, but the browser transaction builder must be wired and verified on Testnet 10 before enabling automatic contract payout."
  };
}

export function isCurrentRaffleContractVersion(contractVersion: string): boolean {
  return contractVersion === RAFFLE_CONTRACT_VERSION;
}

export function isSupportedRaffleCovenantVersion(contractVersion: string): boolean {
  return isSupportedRaffleContractVersion(contractVersion);
}

export function assertRaffleCovenantReady(): void {
  const status = getRaffleCovenantStatus();

  if (!status.enabled) {
    throw new Error(status.message);
  }
}

export function getRaffleRuntimeArtifact(contractVersion: string) {
  return raffleArtifactForContractVersion(contractVersion);
}

export function getRaffleRefundRuntimeArtifact(contractVersion = RAFFLE_CONTRACT_VERSION) {
  return refundArtifactForContractVersion(contractVersion);
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function bytes32FromHex(hex: string, label: string): Uint8Array {
  const bytes = hexToBytes(hex);

  if (bytes.length !== 32) {
    throw new Error(`${label} must be exactly 32 bytes.`);
  }

  return bytes;
}

export async function roundIdToBytes32(roundId: string): Promise<Uint8Array> {
  return /^[0-9a-fA-F]{64}$/.test(roundId) ? hexToBytes(roundId) : hexToBytes(await sha256Hex(roundId));
}

export function raffleStatusCode(status: RoundState["status"]): bigint {
  switch (status) {
    case "Open":
      return 0n;
    case "Closed":
      return 1n;
    case "Finalized":
      return 2n;
    case "Refunding":
      return 3n;
    case "Refunded":
      return 4n;
  }
}

export function emptyRaffleCovenantState(
  runtimeArtifact: RaffleRoundRuntimeArtifact = raffleArtifact
): RaffleCovenantStateValues {
  return Object.fromEntries(
    runtimeArtifact.stateFields.map((field) => [
      field.name,
      field.type === "int" ? 0n : new Uint8Array(fixedByteStateLength(field.type, field.name))
    ])
  );
}

export async function raffleCovenantStateFromRound(round: RoundState): Promise<RaffleCovenantStateValues> {
  const runtimeArtifact = round.status === "Refunding"
    ? refundArtifactForContractVersion(round.contractVersion)
    : raffleArtifactForContractVersion(round.contractVersion);
  return raffleCovenantStateFromRoundWithArtifact(round, runtimeArtifact);
}

async function raffleCovenantStateFromRoundWithArtifact(
  round: RoundState,
  runtimeArtifact: RaffleRoundRuntimeArtifact
): Promise<RaffleCovenantStateValues> {
  const state = emptyRaffleCovenantState(runtimeArtifact);
  const creatorPublicKey = bytes32FromHex(round.creatorPubkey, "creator public key");
  const ticketRoot = round.ticketRoot
    ? bytes32FromHex(round.ticketRoot, "ticket root")
    : hexToBytes(TICKET_EMPTY_ROOT_HEX);

  state.max_tickets = BigInt(round.maxTickets);
  state.ticket_price = round.ticketPrice;
  state.creator_pubkey = creatorPublicKey;
  state.refund_after_daa = BigInt(round.refundAfterDaaScore || "0");
  state.sold_tickets = BigInt(round.soldTickets);
  if ("sold_batches" in state) state.sold_batches = BigInt(round.soldBatches);
  state.ticket_root = ticketRoot;

  if ("frontier" in state) {
    const frontier = hexToBytes(round.ticketFrontier || TICKET_EMPTY_FRONTIER_HEX);
    if (frontier.length !== TICKET_MERKLE_PROOF_BYTES) throw new Error("Ticket frontier must be exactly 640 bytes.");
    state.frontier = frontier;
  }
  if ("refund_cursor" in state) {
    state.refund_cursor = BigInt(round.refundCursor ?? 0);
  }
  if ("refund_batch_cursor" in state) {
    state.refund_batch_cursor = BigInt(round.refundBatchCursor ?? 0);
  }

  for (let index = 0; index < 20 && `owner_${String(index + 1).padStart(2, "0")}` in state; index += 1) {
    const suffix = String(index + 1).padStart(2, "0");
    const fieldName = `owner_${suffix}`;
    const ownerPubkey = round.ticketOwnerPubkeys[index];

    state[`batch_end_${suffix}`] = BigInt(round.ticketBatchEnds[index] ?? 0);
    state[fieldName] = ownerPubkey ? bytes32FromHex(ownerPubkey, `ticket owner ${index + 1} public key`) : hexToBytes(ZERO32_HEX);
  }

  return state;
}

export function encodeRaffleCovenantState(
  state: RaffleCovenantStateValues,
  runtimeArtifact: RaffleRoundRuntimeArtifact = raffleArtifact
): Uint8Array {
  const chunks = runtimeArtifact.stateFields.map((field) => encodeStateField(field, state[field.name]));
  const encoded = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;

  for (const chunk of chunks) {
    encoded.set(chunk, offset);
    offset += chunk.length;
  }

  if (encoded.length !== runtimeArtifact.stateLayout.len) {
    throw new Error(`Encoded state length ${encoded.length} does not match artifact length ${runtimeArtifact.stateLayout.len}.`);
  }

  return encoded;
}

export function buildRaffleRedeemScript(
  state: RaffleCovenantStateValues,
  runtimeArtifact: RaffleRoundRuntimeArtifact = raffleArtifact
): Uint8Array {
  const script = hexToBytes(runtimeArtifact.script);
  const encodedState = encodeRaffleCovenantState(state, runtimeArtifact);

  script.set(encodedState, runtimeArtifact.stateLayout.start);
  return script;
}

export function buildRaffleRedeemScriptForContractVersion(
  state: RaffleCovenantStateValues,
  contractVersion?: string,
  status?: RoundState["status"]
): Uint8Array {
  const runtimeArtifact = status === "Refunding"
    ? refundArtifactForContractVersion(contractVersion)
    : raffleArtifactForContractVersion(contractVersion);

  return buildRaffleRedeemScript(state, runtimeArtifact);
}

export async function assertRaffleRedeemScriptMatchesRound(
  round: RoundState,
  redeemScriptHex: string,
  label: string
): Promise<void> {
  const redeemScript = hexToBytes(redeemScriptHex);
  const runtimeArtifact = raffleArtifactForRedeemScript(redeemScript);
  const state = await raffleCovenantStateFromRoundWithArtifact(round, runtimeArtifact);
  const expected = bytesToHex(buildRaffleRedeemScript(state, runtimeArtifact));

  if (expected !== redeemScriptHex.toLowerCase()) {
    throw new Error(
      `${label} covenant script does not match the current compiled contract and round state. ` +
        "This usually means the round was created with an older contract artifact or stale metadata; create a new round with the current page build."
    );
  }
}

export async function buildRaffleScriptPublicKey(
  state: RaffleCovenantStateValues,
  runtimeArtifact: RaffleRoundRuntimeArtifact = raffleArtifact
): Promise<ScriptPublicKey> {
  await ensureKaspaWasmReady();
  return payToScriptHashScript(buildRaffleRedeemScript(state, runtimeArtifact));
}

export async function buildRaffleAddress(
  state: RaffleCovenantStateValues,
  network: string,
  runtimeArtifact: RaffleRoundRuntimeArtifact = raffleArtifact
): Promise<string> {
  const scriptPublicKey = await buildRaffleScriptPublicKey(state, runtimeArtifact);
  const address = addressFromScriptPublicKey(scriptPublicKey, network);

  if (!address) {
    throw new Error("Unable to derive covenant P2SH address.");
  }

  return address.toString();
}

export function pubkeyHexFromAddress(address: string): string {
  return bytesToHex(pubkeyFromP2pkScriptPublicKey(payToAddressScript(address)));
}

export function buildRaffleBuySignatureScript(
  currentRedeemScript: Uint8Array,
  ownerPubkeyHex: string,
  ticketCount: number
): string {
  const ownerPubkey = bytes32FromHex(ownerPubkeyHex, "ticket owner public key");

  return buildRaffleP2shSignatureScript("buy", currentRedeemScript, (builder) => {
    builder.addData(ownerPubkey);
    builder.addI64(BigInt(ticketCount));
  });
}

function addChainHeaderPair(builder: ScriptBuilder, witness: ChainRandomnessWitness): void {
  builder.addData(hexToBytes(witness.target.beforeDaaHex));
  builder.addI64(witness.target.daaScore);
  builder.addI64(witness.target.blueScore);
  builder.addData(hexToBytes(witness.target.encodedBlueWorkHex));
  builder.addData(bytes32FromHex(witness.target.pruningPoint, "target pruning point"));
  builder.addData(bytes32FromHex(witness.parent.hash, "target selected parent hash"));
  builder.addData(hexToBytes(witness.parent.beforeDaaHex));
  builder.addI64(witness.parent.daaScore);
  builder.addI64(witness.parent.blueScore);
  builder.addData(hexToBytes(witness.parent.encodedBlueWorkHex));
  builder.addData(bytes32FromHex(witness.parent.pruningPoint, "parent pruning point"));
}

export function buildRaffleFinalizeSignatureScript(
  currentRedeemScript: Uint8Array,
  witness: ChainRandomnessWitness,
  finalizeFeeSompi: bigint,
  winnerTicketId: number,
  winnerBatchIndex: number,
  winnerBatchStart: number,
  winnerBatchCount: number,
  winnerScriptPublicKey: ScriptPublicKey,
  winnerProofHex?: string
): string {
  return buildRaffleP2shSignatureScript("finalize", currentRedeemScript, (builder) => {
    if (!winnerProofHex) {
      throw new Error("Finalize requires the winner Merkle proof.");
    }
    addChainHeaderPair(builder, witness);
    builder.addI64(finalizeFeeSompi);
    builder.addI64(BigInt(winnerTicketId));
    builder.addI64(BigInt(winnerBatchIndex));
    builder.addI64(BigInt(winnerBatchStart));
    builder.addI64(BigInt(winnerBatchCount));
    builder.addData(pubkeyFromP2pkScriptPublicKey(winnerScriptPublicKey));
    builder.addData(ticketProofFromHex(winnerProofHex, "winner"));
  });
}

export function buildRaffleRefundNextSignatureScript(
  currentRedeemScript: Uint8Array,
  refundFeeSompi: bigint,
  ownerPubkeyHex: string,
  firstTicketId: number,
  ticketCount: number,
  ownerProofHex: string
): string {
  return buildRaffleP2shSignatureScript("refund_next", currentRedeemScript, (builder) => {
    builder.addI64(refundFeeSompi);
    builder.addData(bytes32FromHex(ownerPubkeyHex, "refund owner public key"));
    builder.addI64(BigInt(firstTicketId));
    builder.addI64(BigInt(ticketCount));
    builder.addData(ticketProofFromHex(ownerProofHex, "refund owner"));
  });
}

export interface RaffleRefundBatchWitness {
  ownerPubkeyHex: string;
  firstTicketId: number;
  ticketCount: number;
  ownerProofHex: string;
}

export function buildRaffleRefundBatchSignatureScript(
  currentRedeemScript: Uint8Array,
  refundFeeSompi: bigint,
  batches: RaffleRefundBatchWitness[]
): string {
  if (!batches.length) throw new Error("A grouped refund requires at least one purchase batch.");
  const runtimeArtifact = raffleArtifactForRedeemScript(currentRedeemScript);
  if (runtimeArtifact.contract === legacyRefundArtifact.contract) {
    if (batches.length !== 1) throw new Error("Legacy raffle refunds support one purchase batch per transaction.");
    const batch = batches[0];
    return buildRaffleRefundNextSignatureScript(
      currentRedeemScript,
      refundFeeSompi,
      batch.ownerPubkeyHex,
      batch.firstTicketId,
      batch.ticketCount,
      batch.ownerProofHex
    );
  }
  if (runtimeArtifact.contract !== refundArtifact.contract) {
    throw new Error(`Contract ${runtimeArtifact.contract} does not support grouped refunds.`);
  }

  return buildRaffleP2shSignatureScript("refund_next", currentRedeemScript, (builder) => {
    builder.addI64(refundFeeSompi);
    builder.addI64(BigInt(batches.length));
    builder.addData(concatBytes(batches.map((batch) => bytes32FromHex(batch.ownerPubkeyHex, "refund owner public key"))));
    builder.addData(concatBytes(batches.map((batch) => encodeScriptI64Le(BigInt(batch.ticketCount), "refund ticket count"))));
    builder.addData(concatBytes(batches.map((batch) => ticketProofFromHex(batch.ownerProofHex, "refund owner"))));
  });
}

export function buildRaffleStartRefundSignatureScript(
  currentRedeemScript: Uint8Array,
  refundTransitionFeeSompi?: bigint
): string {
  const roundArtifact = raffleArtifactForRedeemScript(currentRedeemScript);
  const targetRefundArtifact = refundArtifactForRoundArtifact(roundArtifact);
  const template = hexToBytes(targetRefundArtifact.script);
  const stateStart = targetRefundArtifact.stateLayout.start;
  const stateEnd = stateStart + targetRefundArtifact.stateLayout.len;
  const startRefund = roundArtifact.abi.find((entry) => entry.name === "startRefund");
  const acceptsDynamicFee = startRefund?.inputs[0]?.name === "refund_transition_fee";
  if (acceptsDynamicFee && (refundTransitionFeeSompi === undefined || refundTransitionFeeSompi <= 0n)) {
    throw new Error("Dynamic refund transition requires a positive network fee.");
  }
  return buildRaffleP2shSignatureScript("start_refund", currentRedeemScript, (builder) => {
    if (acceptsDynamicFee) builder.addI64(refundTransitionFeeSompi!);
    builder.addData(template.slice(0, stateStart));
    builder.addData(template.slice(stateEnd));
  });
}

export function raffleWinnerIndexFromSeed(seedHex: string, soldTickets: number): number {
  if (soldTickets <= 0) {
    throw new Error("Cannot select a winner without tickets.");
  }

  const seed = bytes32FromHex(seedHex, "random seed");
  let value = 0n;
  for (let index = 0; index < 7; index += 1) value |= BigInt(seed[index]) << BigInt(index * 8);

  return Number(value % BigInt(soldTickets));
}

function buildRaffleP2shSignatureScript(
  entrypoint: RaffleCovenantEntrypoint,
  currentRedeemScript: Uint8Array,
  pushArgs?: (builder: ScriptBuilder, runtimeArtifact: RaffleRoundRuntimeArtifact, entry: RuntimeAbiEntry) => void
): string {
  const runtimeArtifact = raffleArtifactForRedeemScript(currentRedeemScript);
  const entry = runtimeArtifact.abi.find((candidate) => candidate.name === entrypointNames[entrypoint]);

  if (!entry || entry.selector === null) {
    throw new Error(`Missing covenant ABI entry for ${entrypoint}.`);
  }

  const builder = new ScriptBuilder({ flags: { covenantsEnabled: true } });

  pushArgs?.(builder, runtimeArtifact, entry);

  if (!runtimeArtifact.withoutSelector) {
    builder.addI64(BigInt(entry.selector));
  }

  builder.addData(currentRedeemScript);
  return builder.drain();
}

function raffleArtifactForRedeemScript(redeemScript: Uint8Array): RaffleRoundRuntimeArtifact {
  const candidates = [raffleArtifact, previousRaffleArtifact, refundArtifact, legacyRaffleArtifact, legacyRefundArtifact];

  for (const candidate of candidates) {
    const template = hexToBytes(candidate.script);

    if (template.length !== redeemScript.length) {
      continue;
    }

    const stateStart = candidate.stateLayout.start;
    const stateEnd = stateStart + candidate.stateLayout.len;
    let matches = true;

    for (let index = 0; index < template.length; index += 1) {
      if (index >= stateStart && index < stateEnd) {
        continue;
      }

      if (template[index] !== redeemScript[index]) {
        matches = false;
        break;
      }
    }

    if (matches) {
      return candidate;
    }
  }

  throw new Error("Covenant redeem script is not recognized by this page build.");
}

function encodeStateField(field: RuntimeStateField, value: RaffleCovenantStateValue | undefined): Uint8Array {
  if (field.type === "int") {
    if (typeof value !== "bigint") {
      throw new Error(`State field ${field.name} must be an int.`);
    }

    const encoded = new Uint8Array(1 + INT_STATE_FIELD_SIZE);
    encoded[0] = INT_STATE_FIELD_SIZE;
    encoded.set(encodeScriptI64Le(value, field.name), 1);
    return encoded;
  }

  if (field.type.startsWith("byte[")) {
    const length = fixedByteStateLength(field.type, field.name);
    if (!(value instanceof Uint8Array) || value.length !== length) {
      throw new Error(`State field ${field.name} must be exactly ${length} bytes.`);
    }
    return encodeScriptDataPush(value);
  }

  throw new Error(`Unsupported covenant state field type ${field.type} for ${field.name}.`);
}

function raffleArtifactForContractVersion(contractVersion?: string): RaffleRoundRuntimeArtifact {
  if (contractVersion === RAFFLE_CONTRACT_VERSION) return raffleArtifact;
  if (contractVersion === PREVIOUS_RAFFLE_CONTRACT_VERSION) return previousRaffleArtifact;
  if (contractVersion === LEGACY_RAFFLE_CONTRACT_VERSION) return legacyRaffleArtifact;
  throw new Error(`Unsupported raffle contract version: ${contractVersion || "missing"}.`);
}

function refundArtifactForContractVersion(contractVersion?: string): RaffleRoundRuntimeArtifact {
  if (contractVersion === RAFFLE_CONTRACT_VERSION) return refundArtifact;
  if (contractVersion === PREVIOUS_RAFFLE_CONTRACT_VERSION) return refundArtifact;
  if (contractVersion === LEGACY_RAFFLE_CONTRACT_VERSION) return legacyRefundArtifact;
  throw new Error(`Unsupported raffle refund contract version: ${contractVersion || "missing"}.`);
}

function refundArtifactForRoundArtifact(roundArtifact: RaffleRoundRuntimeArtifact): RaffleRoundRuntimeArtifact {
  if (roundArtifact.contract === raffleArtifact.contract) return refundArtifact;
  if (roundArtifact.contract === previousRaffleArtifact.contract) return refundArtifact;
  if (roundArtifact.contract === legacyRaffleArtifact.contract) return legacyRefundArtifact;
  throw new Error(`Contract ${roundArtifact.contract} cannot start a refund transition.`);
}

function fixedBytesFromHex(hex: string, length: number, label: string): Uint8Array {
  const bytes = hexToBytes(hex);
  if (bytes.length !== length) throw new Error(`${label} must be exactly ${length} bytes.`);
  return bytes;
}

function fixedByteStateLength(type: string, fieldName: string): number {
  const match = /^byte\[(\d+)]$/.exec(type);
  if (!match) throw new Error(`Unsupported covenant state field type ${type} for ${fieldName}.`);
  return Number(match[1]);
}

function encodeScriptDataPush(value: Uint8Array): Uint8Array {
  let prefix: Uint8Array;
  if (value.length <= 75) prefix = new Uint8Array([value.length]);
  else if (value.length <= 0xff) prefix = new Uint8Array([0x4c, value.length]);
  else if (value.length <= 0xffff) prefix = new Uint8Array([0x4d, value.length & 0xff, value.length >> 8]);
  else throw new Error(`Covenant state byte array is too large: ${value.length}.`);

  const encoded = new Uint8Array(prefix.length + value.length);
  encoded.set(prefix, 0);
  encoded.set(value, prefix.length);
  return encoded;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function ticketProofFromHex(proofHex: string, label: string): Uint8Array {
  const proof = hexToBytes(proofHex);
  if (proof.length !== TICKET_MERKLE_PROOF_BYTES) {
    throw new Error(`${label} ticket proof must be exactly ${TICKET_MERKLE_PROOF_BYTES} bytes.`);
  }
  return proof;
}

function encodeScriptI64Le(value: bigint, fieldName: string): Uint8Array {
  if (value < -0x7fff_ffff_ffff_ffffn || value > 0x7fff_ffff_ffff_ffffn) {
    throw new Error(`State field ${fieldName} is outside the supported int range.`);
  }

  const encoded = new Uint8Array(INT_STATE_FIELD_SIZE);
  let remaining = value < 0n ? -value : value;

  for (let index = 0; index < encoded.length; index += 1) {
    encoded[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }

  if (value < 0n) {
    encoded[encoded.length - 1] |= 0x80;
  }

  return encoded;
}

function scriptPublicKeyBytes(scriptPublicKey: ScriptPublicKey): Uint8Array {
  const json = scriptPublicKey.toJSON() as { version: number; script: string };
  void json.version;
  return hexToBytes(json.script);
}

function pubkeyFromP2pkScriptPublicKey(scriptPublicKey: ScriptPublicKey): Uint8Array {
  const bytes = scriptPublicKeyBytes(scriptPublicKey);

  if (bytes.length !== 34 || bytes[0] !== 0x20 || bytes[33] !== 0xac) {
    throw new Error("Winner address must resolve to a 32-byte P2PK script public key.");
  }

  return bytes.slice(1, 33);
}
