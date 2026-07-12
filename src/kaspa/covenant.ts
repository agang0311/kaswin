import {
  addressFromScriptPublicKey,
  payToScriptHashScript,
  payToAddressScript,
  ScriptBuilder,
  type ScriptPublicKey
} from "@onekeyfe/kaspa-wasm";
import raffleRoundV5Artifact from "../contracts/compiled/raffle-round-v5.artifact.json";
import raffleRefundV1Artifact from "../contracts/compiled/raffle-refund-v1.artifact.json";
import { hexToBytes, sha256Hex } from "../raffle/randomness";
import { TICKET_EMPTY_FRONTIER_HEX, TICKET_EMPTY_ROOT_HEX, TICKET_MERKLE_PROOF_BYTES } from "../raffle/merkle";
import type { RoundState } from "../raffle/types";
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

export type RaffleCovenantEntrypoint = "buy" | "close" | "finalize" | "refund_all" | "refund_next" | "start_refund" | "refund_batch8";
export type RaffleCovenantStateValue = bigint | Uint8Array;
export type RaffleCovenantStateValues = Record<string, RaffleCovenantStateValue>;

const artifact = raffleRoundV5Artifact as RaffleRoundRuntimeArtifact;
const refundArtifact = raffleRefundV1Artifact as RaffleRoundRuntimeArtifact;
export const MILLION_USER_CONTRACT_VERSION = "raffle-v6-aligned-batch-buy";
const INT_STATE_FIELD_SIZE = 8;
const ZERO32_HEX = "00".repeat(32);

const entrypointNames: Record<RaffleCovenantEntrypoint, string> = {
  buy: "buy",
  close: "close",
  finalize: "finalize",
  refund_all: "refund_all",
  refund_next: "refundNext",
  start_refund: "startRefund",
  refund_batch8: "refundBatch8"
};

export function getRaffleCovenantStatus(): CovenantArtifactStatus {
  const enabled = artifact.contract === "RaffleRoundV5" && refundArtifact.contract === "RaffleRefundV1" && Boolean(artifact.script) && Boolean(refundArtifact.script) && artifact.abi.length > 0;

  return {
    enabled,
    contract: artifact.contract,
    network: "toccata-v1",
    status: enabled ? "compiled-runtime" : "unavailable",
    message: enabled
      ? "Covenant artifacts are available. Finalize will build a Toccata covenant spend."
      : "Covenant bytecode is compiled, but the browser transaction builder must be wired and verified on TN12 before enabling automatic contract payout."
  };
}

export function isParticipantFinalizeContractVersion(contractVersion: string): boolean {
  return isMillionUserContractVersion(contractVersion);
}

export function isLowFeeContractVersion(contractVersion: string): boolean {
  return isMillionUserContractVersion(contractVersion);
}

export function isMillionUserContractVersion(contractVersion: string): boolean {
  return contractVersion === MILLION_USER_CONTRACT_VERSION;
}

export function isBatchRefundContractVersion(contractVersion: string): boolean {
  return contractVersion === MILLION_USER_CONTRACT_VERSION;
}

export function assertRaffleCovenantReady(): void {
  const status = getRaffleCovenantStatus();

  if (!status.enabled) {
    throw new Error(status.message);
  }
}

export function getRaffleRuntimeArtifact() {
  return artifact;
}

export function getRaffleRefundRuntimeArtifact() {
  return refundArtifact;
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
  runtimeArtifact: RaffleRoundRuntimeArtifact = artifact
): RaffleCovenantStateValues {
  return Object.fromEntries(
    runtimeArtifact.stateFields.map((field) => [
      field.name,
      field.type === "int" ? 0n : new Uint8Array(fixedByteStateLength(field.type, field.name))
    ])
  );
}

export async function raffleCovenantStateFromRound(round: RoundState): Promise<RaffleCovenantStateValues> {
  const runtimeArtifact = isBatchRefundContractVersion(round.contractVersion) && round.status === "Refunding"
    ? refundArtifact
    : raffleArtifactForContractVersion(round.contractVersion);
  return raffleCovenantStateFromRoundWithArtifact(round, runtimeArtifact);
}

async function raffleCovenantStateFromRoundWithArtifact(
  round: RoundState,
  runtimeArtifact: RaffleRoundRuntimeArtifact
): Promise<RaffleCovenantStateValues> {
  const state = emptyRaffleCovenantState(runtimeArtifact);
  const creatorPublicKey = bytes32FromHex(round.creatorPubkey, "creator public key");
  const oraclePublicKey = bytes32FromHex(round.oraclePublicKey, "oracle public key");
  const ticketRoot = round.ticketRoot
    ? bytes32FromHex(round.ticketRoot, "ticket root")
    : hexToBytes(isMillionUserContractVersion(round.contractVersion) ? TICKET_EMPTY_ROOT_HEX : ZERO32_HEX);

  state.max_tickets = BigInt(round.maxTickets);
  state.ticket_price = round.ticketPrice;
  state.creator_pubkey = creatorPublicKey;
  state.refund_after_daa = BigInt(round.refundAfterDaaScore || "0");
  state.sold_tickets = BigInt(round.soldTickets);
  if ("sold_batches" in state) state.sold_batches = BigInt(round.soldBatches);
  state.oracle_pubkey = oraclePublicKey;
  state.ticket_root = ticketRoot;

  if ("frontier" in state) {
    const frontier = hexToBytes(round.ticketFrontier || TICKET_EMPTY_FRONTIER_HEX);
    if (frontier.length !== TICKET_MERKLE_PROOF_BYTES) throw new Error("Ticket frontier must be exactly 640 bytes.");
    state.frontier = frontier;
  }
  if ("refund_cursor" in state) state.refund_cursor = BigInt(round.refundCursor ?? 0);

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
  runtimeArtifact: RaffleRoundRuntimeArtifact = artifact
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
  runtimeArtifact: RaffleRoundRuntimeArtifact = artifact
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
  const runtimeArtifact = contractVersion && isBatchRefundContractVersion(contractVersion) && status === "Refunding"
    ? refundArtifact
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
  runtimeArtifact: RaffleRoundRuntimeArtifact = artifact
): Promise<ScriptPublicKey> {
  await ensureKaspaWasmReady();
  return payToScriptHashScript(buildRaffleRedeemScript(state, runtimeArtifact));
}

export async function buildRaffleAddress(
  state: RaffleCovenantStateValues,
  network: string,
  runtimeArtifact: RaffleRoundRuntimeArtifact = artifact
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
  nextTicketRootHex: string,
  ownerPubkeyHex: string,
  ticketCount: number
): string {
  const nextTicketRoot = bytes32FromHex(nextTicketRootHex, "next ticket root");
  const ownerPubkey = bytes32FromHex(ownerPubkeyHex, "ticket owner public key");

  return buildRaffleP2shSignatureScript("buy", currentRedeemScript, (builder, runtimeArtifact, entry) => {
    if (runtimeArtifact.contract === "RaffleRoundV5") {
      builder.addData(ownerPubkey);
      builder.addI64(BigInt(ticketCount));
      return;
    }

    builder.addData(nextTicketRoot);
    builder.addData(ownerPubkey);

    if (entry.inputs.length >= 3) {
      builder.addI64(BigInt(ticketCount));
    } else if (ticketCount !== 1) {
      throw new Error("Rounds created with an older contract support one ticket per purchase.");
    }
  });
}

export function buildRaffleCloseSignatureScript(currentRedeemScript: Uint8Array): string {
  return buildRaffleP2shSignatureScript("close", currentRedeemScript);
}

export function buildRaffleFinalizeSignatureScript(
  currentRedeemScript: Uint8Array,
  oracleSignatureHex: string,
  oracleSeedHex: string,
  winnerTicketId: number,
  winnerScriptPublicKey: ScriptPublicKey,
  callerScriptPublicKey: ScriptPublicKey,
  winnerProofHex?: string,
  callerTicketId?: number,
  callerProofHex?: string
): string {
  const oracleSignature = hexToBytes(oracleSignatureHex);
  const oracleSeed = bytes32FromHex(oracleSeedHex, "oracle seed");

  if (oracleSignature.length !== 64) {
    throw new Error("Oracle signature must be exactly 64 bytes.");
  }

  return buildRaffleP2shSignatureScript("finalize", currentRedeemScript, (builder, _runtimeArtifact, entry) => {
    if (entry.inputs.length < 5) {
      throw new Error("This legacy round does not enforce participant-only drawing. Refund it after timeout or create a new round.");
    }

    builder.addData(oracleSignature);
    builder.addData(oracleSeed);
    builder.addI64(BigInt(winnerTicketId));
    builder.addData(pubkeyFromP2pkScriptPublicKey(winnerScriptPublicKey));

    if (entry.inputs.length >= 8) {
      if (!winnerProofHex || callerTicketId === undefined || !callerProofHex) {
        throw new Error("Million-user finalize requires winner and caller Merkle proofs.");
      }
      builder.addData(ticketProofFromHex(winnerProofHex, "winner"));
      builder.addI64(BigInt(callerTicketId));
      builder.addData(pubkeyFromP2pkScriptPublicKey(callerScriptPublicKey));
      builder.addData(ticketProofFromHex(callerProofHex, "caller"));
      return;
    }

    builder.addData(pubkeyFromP2pkScriptPublicKey(callerScriptPublicKey));
  });
}

export function buildRaffleRefundAllSignatureScript(currentRedeemScript: Uint8Array): string {
  return buildRaffleP2shSignatureScript("refund_all", currentRedeemScript);
}

export function buildRaffleRefundNextSignatureScript(
  currentRedeemScript: Uint8Array,
  ticketId: number,
  ownerPubkeyHex: string,
  ownerProofHex: string
): string {
  return buildRaffleP2shSignatureScript("refund_next", currentRedeemScript, (builder) => {
    builder.addI64(BigInt(ticketId));
    builder.addData(bytes32FromHex(ownerPubkeyHex, "refund owner public key"));
    builder.addData(ticketProofFromHex(ownerProofHex, "refund owner"));
  });
}

export function buildRaffleStartRefundSignatureScript(currentRedeemScript: Uint8Array): string {
  const template = hexToBytes(refundArtifact.script);
  const stateStart = refundArtifact.stateLayout.start;
  const stateEnd = stateStart + refundArtifact.stateLayout.len;
  return buildRaffleP2shSignatureScript("start_refund", currentRedeemScript, (builder) => {
    builder.addData(template.slice(0, stateStart));
    builder.addData(template.slice(stateEnd));
  });
}

export function buildRaffleRefundBatch8SignatureScript(
  currentRedeemScript: Uint8Array,
  ownerPubkeysHex: string[],
  rangeProofHex: string
): string {
  if (ownerPubkeysHex.length !== 8) throw new Error("A batch refund requires exactly 8 ticket owners.");
  const owners = new Uint8Array(8 * 32);
  ownerPubkeysHex.forEach((owner, index) => owners.set(bytes32FromHex(owner, `refund owner ${index + 1} public key`), index * 32));
  const proof = hexToBytes(rangeProofHex);
  if (proof.length !== 17 * 32) throw new Error("A batch refund range proof must be exactly 544 bytes.");
  return buildRaffleP2shSignatureScript("refund_batch8", currentRedeemScript, (builder) => {
    builder.addData(owners);
    builder.addData(proof);
  });
}

export function buildNextTicketRootHex(
  roundId: string,
  currentTicketRoot: string,
  ticket: { ticketId: number; owner: string; buyerCommitment: string; ticketCount?: number }
): Promise<string> {
  const root = currentTicketRoot || ZERO32_HEX;
  const ticketRange = ticket.ticketCount === undefined
    ? `${ticket.ticketId}`
    : `${ticket.ticketId}-${ticket.ticketId + ticket.ticketCount - 1}`;

  return sha256Hex(`${roundId}|${root}|${ticketRange}:${ticket.owner}:${ticket.buyerCommitment}`);
}

export async function buildFinalizeSeedHex(round: RoundState, oracleSeedHex: string): Promise<string> {
  const ticketRoot = round.ticketRoot ? bytes32FromHex(round.ticketRoot, "ticket root") : hexToBytes(ZERO32_HEX);
  const oracleSeed = bytes32FromHex(oracleSeedHex, "oracle seed");
  const seedBytes = new Uint8Array(ticketRoot.length + oracleSeed.length);

  seedBytes.set(ticketRoot, 0);
  seedBytes.set(oracleSeed, ticketRoot.length);

  const hash = await crypto.subtle.digest("SHA-256", seedBytes);
  return bytesToHex(new Uint8Array(hash));
}

export function raffleWinnerIndexFromSeed(seedHex: string, soldTickets: number): number {
  if (soldTickets <= 0) {
    throw new Error("Cannot select a winner without tickets.");
  }

  const seed = bytes32FromHex(seedHex, "random seed");
  const value =
    BigInt(seed[0] & 0x7f) |
    (BigInt(seed[1] & 0x7f) << 7n) |
    (BigInt(seed[2] & 0x7f) << 14n) |
    (BigInt(seed[3] & 0x7f) << 21n);

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
  const candidates = [artifact, refundArtifact];

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
  if (contractVersion && contractVersion !== MILLION_USER_CONTRACT_VERSION) {
    throw new Error(`Unsupported legacy raffle contract: ${contractVersion}.`);
  }
  return artifact;
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
