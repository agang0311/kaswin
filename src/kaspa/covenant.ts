import {
  addressFromScriptPublicKey,
  payToScriptHashScript,
  ScriptBuilder,
  type ScriptPublicKey
} from "@onekeyfe/kaspa-wasm";
import raffleRoundArtifact from "../contracts/compiled/raffle-round.artifact.json";
import raffleRoundManifest from "../contracts/compiled/raffle-round.manifest.json";
import { hexToBytes, sha256Hex } from "../raffle/randomness";
import type { RoundState } from "../raffle/types";
import { ensureKaspaWasmReady } from "./wasm";

export interface CovenantArtifactStatus {
  enabled: boolean;
  contract: string;
  network: string;
  status: string;
  message: string;
}

interface RaffleRoundManifest {
  contract: string;
  network: string;
  status: string;
  script: string | null;
  abi: unknown;
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

interface RaffleRoundRuntimeArtifact {
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

export type RaffleCovenantEntrypoint = "buy" | "close" | "finalize" | "enter_refunding";
export type RaffleCovenantStateValues = Record<string, bigint>;

const manifest = raffleRoundManifest as RaffleRoundManifest;
const artifact = raffleRoundArtifact as RaffleRoundRuntimeArtifact;
const INT_STATE_FIELD_SIZE = 8;
const INT_STATE_CHUNK_SIZE = 1 + INT_STATE_FIELD_SIZE;
const EMPTY_BYTES = new Uint8Array();
const ZERO32_HEX = "00".repeat(32);

const entrypointNames: Record<RaffleCovenantEntrypoint, string> = {
  buy: "__covenant_entrypoint_auth_buy",
  close: "__covenant_entrypoint_auth_close",
  finalize: "__covenant_entrypoint_auth_finalize",
  enter_refunding: "__covenant_entrypoint_auth_enter_refunding"
};

export function getRaffleCovenantStatus(): CovenantArtifactStatus {
  const enabled = manifest.status === "compiled" && Boolean(manifest.script) && Boolean(manifest.abi);

  return {
    enabled,
    contract: manifest.contract,
    network: manifest.network,
    status: manifest.status,
    message: enabled
      ? "Covenant artifacts are available. Finalize will build a Toccata covenant spend."
      : "Covenant bytecode is compiled, but the browser transaction builder must be wired and verified on TN12 before enabling automatic contract payout."
  };
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
  }
}

export function emptyRaffleCovenantState(): RaffleCovenantStateValues {
  return Object.fromEntries(artifact.stateFields.map((field) => [field.name, 0n]));
}

export async function raffleCovenantStateFromRound(round: RoundState): Promise<RaffleCovenantStateValues> {
  const state = emptyRaffleCovenantState();
  const roundId = await roundIdToBytes32(round.roundId);
  const creatorCommitment = bytes32FromHex(round.creatorCommitment, "creator commitment");
  const ticketRoot = round.ticketRoot ? bytes32FromHex(round.ticketRoot, "ticket root") : hexToBytes(ZERO32_HEX);

  state.max_tickets = BigInt(round.maxTickets);
  state.min_tickets = BigInt(round.minTickets);
  state.ticket_price = round.ticketPrice;
  state.fee_bps = BigInt(round.feeBps);
  state.sold_tickets = BigInt(round.soldTickets);
  state.pot_amount = round.potAmount;
  state.status = raffleStatusCode(round.status);
  writeByteFields(state, "round_id", roundId);
  writeByteFields(state, "creator_commitment", creatorCommitment);
  writeByteFields(state, "ticket_root", ticketRoot);

  return state;
}

export function encodeRaffleCovenantState(state: RaffleCovenantStateValues): Uint8Array {
  const encoded = new Uint8Array(artifact.stateFields.length * INT_STATE_CHUNK_SIZE);
  let offset = 0;

  for (const field of artifact.stateFields) {
    const value = state[field.name] ?? 0n;
    encoded[offset] = INT_STATE_FIELD_SIZE;
    encoded.set(encodePositiveI64Le(value, field.name), offset + 1);
    offset += INT_STATE_CHUNK_SIZE;
  }

  if (encoded.length !== artifact.stateLayout.len) {
    throw new Error(`Encoded state length ${encoded.length} does not match artifact length ${artifact.stateLayout.len}.`);
  }

  return encoded;
}

export function buildRaffleRedeemScript(state: RaffleCovenantStateValues): Uint8Array {
  const script = hexToBytes(artifact.script);
  const encodedState = encodeRaffleCovenantState(state);

  script.set(encodedState, artifact.stateLayout.start);
  return script;
}

export async function buildRaffleScriptPublicKey(state: RaffleCovenantStateValues): Promise<ScriptPublicKey> {
  await ensureKaspaWasmReady();
  return payToScriptHashScript(buildRaffleRedeemScript(state));
}

export async function buildRaffleAddress(state: RaffleCovenantStateValues, network: string): Promise<string> {
  const scriptPublicKey = await buildRaffleScriptPublicKey(state);
  const address = addressFromScriptPublicKey(scriptPublicKey, network);

  if (!address) {
    throw new Error("Unable to derive covenant P2SH address.");
  }

  return address.toString();
}

export function buildRaffleBuySignatureScript(currentRedeemScript: Uint8Array, nextTicketRootHex: string): string {
  const nextTicketRoot = bytes32FromHex(nextTicketRootHex, "next ticket root");
  return buildRaffleP2shSignatureScript("buy", currentRedeemScript, (builder) => {
    builder.addData(nextTicketRoot);
  });
}

export function buildRaffleCloseSignatureScript(currentRedeemScript: Uint8Array): string {
  return buildRaffleP2shSignatureScript("close", currentRedeemScript);
}

export function buildRaffleFinalizeSignatureScript(
  currentRedeemScript: Uint8Array,
  creatorSecretHex: string,
  winnerTicketId: number,
  winnerScriptPublicKey: ScriptPublicKey
): string {
  const creatorSecret = bytes32FromHex(creatorSecretHex, "creator secret");

  return buildRaffleP2shSignatureScript("finalize", currentRedeemScript, (builder) => {
    pushEmptyStateArray(builder);
    builder.addData(creatorSecret);
    builder.addI64(BigInt(winnerTicketId));
    builder.addData(scriptPublicKeyBytes(winnerScriptPublicKey));
  });
}

export function buildRaffleRefundingSignatureScript(currentRedeemScript: Uint8Array): string {
  return buildRaffleP2shSignatureScript("enter_refunding", currentRedeemScript);
}

export function buildNextTicketRootHex(roundId: string, tickets: { ticketId: number; owner: string; buyerCommitment: string }[]): Promise<string> {
  const canonicalTickets = tickets
    .map((ticket) => `${ticket.ticketId}:${ticket.owner}:${ticket.buyerCommitment}`)
    .join("|");

  return sha256Hex(`${roundId}|${canonicalTickets}`);
}

export async function buildFinalizeSeedHex(round: RoundState, creatorSecretHex: string): Promise<string> {
  const roundId = await roundIdToBytes32(round.roundId);
  const ticketRoot = round.ticketRoot ? bytes32FromHex(round.ticketRoot, "ticket root") : hexToBytes(ZERO32_HEX);
  const creatorSecret = bytes32FromHex(creatorSecretHex, "creator secret");
  const seedBytes = new Uint8Array(roundId.length + ticketRoot.length + creatorSecret.length);

  seedBytes.set(roundId, 0);
  seedBytes.set(ticketRoot, roundId.length);
  seedBytes.set(creatorSecret, roundId.length + ticketRoot.length);

  const hash = await crypto.subtle.digest("SHA-256", seedBytes);
  return bytesToHex(new Uint8Array(hash));
}

function buildRaffleP2shSignatureScript(
  entrypoint: RaffleCovenantEntrypoint,
  currentRedeemScript: Uint8Array,
  pushArgs?: (builder: ScriptBuilder) => void
): string {
  const entry = artifact.abi.find((candidate) => candidate.name === entrypointNames[entrypoint]);

  if (!entry || entry.selector === null) {
    throw new Error(`Missing covenant ABI entry for ${entrypoint}.`);
  }

  const builder = new ScriptBuilder({ flags: { covenantsEnabled: true } });

  pushArgs?.(builder);

  if (!artifact.withoutSelector) {
    builder.addI64(BigInt(entry.selector));
  }

  builder.addData(currentRedeemScript);
  return builder.drain();
}

function pushEmptyStateArray(builder: ScriptBuilder): void {
  for (const field of artifact.stateFields) {
    if (field.type !== "int") {
      throw new Error(`Unsupported State[] field type ${field.type} for ${field.name}.`);
    }

    builder.addData(EMPTY_BYTES);
  }
}

function writeByteFields(state: RaffleCovenantStateValues, prefix: string, bytes: Uint8Array): void {
  if (bytes.length !== 32) {
    throw new Error(`${prefix} must be exactly 32 bytes.`);
  }

  for (let index = 0; index < bytes.length; index += 1) {
    state[`${prefix}_${index.toString().padStart(2, "0")}`] = BigInt(bytes[index]);
  }
}

function encodePositiveI64Le(value: bigint, fieldName: string): Uint8Array {
  if (value < 0n || value > 0x7fff_ffff_ffff_ffffn) {
    throw new Error(`State field ${fieldName} is outside the supported int range.`);
  }

  const encoded = new Uint8Array(INT_STATE_FIELD_SIZE);
  let remaining = value;

  for (let index = 0; index < encoded.length; index += 1) {
    encoded[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }

  return encoded;
}

function scriptPublicKeyBytes(scriptPublicKey: ScriptPublicKey): Uint8Array {
  const json = scriptPublicKey.toJSON() as { version: number; script: string };
  void json.version;
  return hexToBytes(json.script);
}
