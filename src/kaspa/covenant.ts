import {
  addressFromScriptPublicKey,
  payToScriptHashScript,
  payToAddressScript,
  ScriptBuilder,
  type ScriptPublicKey
} from "@onekeyfe/kaspa-wasm";
import raffleRoundArtifact from "../contracts/compiled/raffle-round.artifact.json";
import raffleRoundV1Artifact from "../contracts/compiled/raffle-round-v1.artifact.json";
import raffleRoundV2Artifact from "../contracts/compiled/raffle-round-v2.artifact.json";
import raffleRoundV3BetaArtifact from "../contracts/compiled/raffle-round-v3-beta.artifact.json";
import raffleRoundV31Artifact from "../contracts/compiled/raffle-round-v3.1.artifact.json";
import raffleRoundV32Artifact from "../contracts/compiled/raffle-round-v3.2.artifact.json";
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

export type RaffleCovenantEntrypoint = "buy" | "close" | "finalize" | "refund_all";
export type RaffleCovenantStateValue = bigint | Uint8Array;
export type RaffleCovenantStateValues = Record<string, RaffleCovenantStateValue>;

const manifest = raffleRoundManifest as RaffleRoundManifest;
const artifact = raffleRoundArtifact as RaffleRoundRuntimeArtifact;
const legacyV1Artifact = raffleRoundV1Artifact as RaffleRoundRuntimeArtifact;
const legacyV2Artifact = raffleRoundV2Artifact as RaffleRoundRuntimeArtifact;
const legacyV3BetaArtifact = raffleRoundV3BetaArtifact as RaffleRoundRuntimeArtifact;
const legacyV31Artifact = raffleRoundV31Artifact as RaffleRoundRuntimeArtifact;
const legacyV32Artifact = raffleRoundV32Artifact as RaffleRoundRuntimeArtifact;
const LEGACY_V1_CONTRACT_VERSION = "raffle-v1-timeout-refund";
const LEGACY_V2_CONTRACT_VERSION = "raffle-v2-direct-finalize";
const LEGACY_V3_BETA_CONTRACT_VERSION = "raffle-v3-batch-1000";
const LEGACY_V3_1_CONTRACT_VERSION = "raffle-v3.1-batch-1000";
const LEGACY_V3_2_CONTRACT_VERSION = "raffle-v3.2-participant-finalize";
export const PARTICIPANT_FINALIZE_CONTRACT_VERSION = "raffle-v3.3-participant-finalize-fee40";
const INT_STATE_FIELD_SIZE = 8;
const ZERO32_HEX = "00".repeat(32);
const BYTES32_STATE_BYTES = 32;

const entrypointNames: Record<RaffleCovenantEntrypoint, string> = {
  buy: "buy",
  close: "close",
  finalize: "finalize",
  refund_all: "refund_all"
};

export function getRaffleCovenantStatus(): CovenantArtifactStatus {
  const enabled = artifact.contract === "RaffleRound" && Boolean(artifact.script) && artifact.abi.length > 0;

  return {
    enabled,
    contract: manifest.contract,
    network: manifest.network,
    status: enabled ? "compiled-runtime" : manifest.status,
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
    case "Refunded":
      return 4n;
  }
}

export function emptyRaffleCovenantState(): RaffleCovenantStateValues {
  return Object.fromEntries(
    artifact.stateFields.map((field) => [
      field.name,
      field.type === "byte[32]" ? hexToBytes(ZERO32_HEX) : 0n
    ])
  );
}

export async function raffleCovenantStateFromRound(round: RoundState): Promise<RaffleCovenantStateValues> {
  const state = emptyRaffleCovenantState();
  const creatorPublicKey = bytes32FromHex(round.creatorPubkey, "creator public key");
  const oraclePublicKey = bytes32FromHex(round.oraclePublicKey, "oracle public key");
  const ticketRoot = round.ticketRoot ? bytes32FromHex(round.ticketRoot, "ticket root") : hexToBytes(ZERO32_HEX);

  state.max_tickets = BigInt(round.maxTickets);
  state.ticket_price = round.ticketPrice;
  state.creator_pubkey = creatorPublicKey;
  state.refund_after_daa = BigInt(round.refundAfterDaaScore || "0");
  state.sold_tickets = BigInt(round.soldTickets);
  state.sold_batches = BigInt(round.soldBatches);
  state.oracle_pubkey = oraclePublicKey;
  state.ticket_root = ticketRoot;

  for (let index = 0; index < 20; index += 1) {
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
  contractVersion?: string
): Uint8Array {
  const runtimeArtifact = contractVersion === LEGACY_V1_CONTRACT_VERSION
    ? legacyV1Artifact
    : contractVersion === LEGACY_V2_CONTRACT_VERSION
      ? legacyV2Artifact
      : contractVersion === LEGACY_V3_BETA_CONTRACT_VERSION
        ? legacyV3BetaArtifact
        : contractVersion === LEGACY_V3_1_CONTRACT_VERSION
          ? legacyV31Artifact
          : contractVersion === LEGACY_V3_2_CONTRACT_VERSION
            ? legacyV32Artifact
          : artifact;

  return buildRaffleRedeemScript(state, runtimeArtifact);
}

export async function assertRaffleRedeemScriptMatchesRound(
  round: RoundState,
  redeemScriptHex: string,
  label: string
): Promise<void> {
  const state = await raffleCovenantStateFromRound(round);
  const redeemScript = hexToBytes(redeemScriptHex);
  const runtimeArtifact = raffleArtifactForRedeemScript(redeemScript);
  const expected = bytesToHex(buildRaffleRedeemScript(state, runtimeArtifact));

  if (expected !== redeemScriptHex.toLowerCase()) {
    throw new Error(
      `${label} covenant script does not match the current compiled contract and round state. ` +
        "This usually means the round was created with an older contract artifact or stale metadata; create a new round with the current page build."
    );
  }
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

  return buildRaffleP2shSignatureScript("buy", currentRedeemScript, (builder, _runtimeArtifact, entry) => {
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
  callerScriptPublicKey: ScriptPublicKey
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
    builder.addData(pubkeyFromP2pkScriptPublicKey(callerScriptPublicKey));
  });
}

export function buildRaffleRefundAllSignatureScript(currentRedeemScript: Uint8Array): string {
  return buildRaffleP2shSignatureScript("refund_all", currentRedeemScript);
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
  const candidates = [artifact, legacyV32Artifact, legacyV31Artifact, legacyV3BetaArtifact, legacyV2Artifact, legacyV1Artifact];

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

  if (field.type === "byte[32]") {
    if (!(value instanceof Uint8Array) || value.length !== BYTES32_STATE_BYTES) {
      throw new Error(`State field ${field.name} must be exactly 32 bytes.`);
    }

    const encoded = new Uint8Array(1 + BYTES32_STATE_BYTES);
    encoded[0] = BYTES32_STATE_BYTES;
    encoded.set(value, 1);
    return encoded;
  }

  throw new Error(`Unsupported covenant state field type ${field.type} for ${field.name}.`);
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
