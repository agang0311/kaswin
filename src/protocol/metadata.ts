import { PROTOCOL_MANIFEST } from "./manifest";

export interface RaffleMetadataV2 {
  app: "kaspa-raffle-static";
  metadataSchema: 2;
  createdByAppVersion: string;
  network: "mainnet" | "testnet-10";
  protocolVersion: string;
  roundContract: string;
  refundContract: string;
  roundArtifactSha256: string;
  refundArtifactSha256: string;
  roundNonce: string;
  roundId: string;
  createTxId: string;
  covenantId: string;
  creatorAddress: string;
  creatorPubkey: string;
  ticketPriceSompi: string;
  maxTickets: number;
  minTickets: number;
  maxBatches: number;
  salesDeadlineDaa: string;
  randomDelayDaa: string;
  registryAddress: string;
  feePolicy: { refundNetworkFees: "deduct-from-ticket-payments"; carrierSompi: string };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function decimal(value: unknown, label: string, positive = false): string {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value) || (positive && value === "0")) throw new Error(`${label} must be a canonical decimal string.`);
  return value;
}
function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be a lowercase SHA-256 value.`);
  return value;
}
function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} is outside its integer range.`);
  return value;
}

export function parseMetadataV2(raw: string | unknown): RaffleMetadataV2 {
  const data = object(typeof raw === "string" ? JSON.parse(raw) : raw, "Metadata");
  if (data.app !== PROTOCOL_MANIFEST.protocolId) throw new Error("Metadata app id is invalid.");
  if (data.metadataSchema !== 2) throw new Error("Unknown metadata schema; use a compatible release.");
  if (data.network !== "mainnet" && data.network !== "testnet-10") throw new Error("Metadata network is unsupported.");
  const maxTickets = integer(data.maxTickets, "maxTickets", 1, PROTOCOL_MANIFEST.maxTickets);
  const minTickets = integer(data.minTickets, "minTickets", 1, maxTickets);
  const maxBatches = integer(data.maxBatches, "maxBatches", 1, Math.min(maxTickets, PROTOCOL_MANIFEST.maxRelaySafePurchaseBatches));
  const feePolicy = object(data.feePolicy, "feePolicy");
  if (feePolicy.refundNetworkFees !== "deduct-from-ticket-payments") throw new Error("vNext metadata must declare buyer-funded refund network fees.");
  const parsed: RaffleMetadataV2 = {
    app: "kaspa-raffle-static", metadataSchema: 2,
    createdByAppVersion: String(data.createdByAppVersion ?? ""),
    network: data.network,
    protocolVersion: String(data.protocolVersion ?? ""), roundContract: String(data.roundContract ?? ""), refundContract: String(data.refundContract ?? ""),
    roundArtifactSha256: sha(data.roundArtifactSha256, "roundArtifactSha256"), refundArtifactSha256: sha(data.refundArtifactSha256, "refundArtifactSha256"),
    roundNonce: sha(data.roundNonce, "roundNonce"), roundId: sha(data.roundId, "roundId"), createTxId: sha(data.createTxId, "createTxId"), covenantId: sha(data.covenantId, "covenantId"),
    creatorAddress: String(data.creatorAddress ?? ""), creatorPubkey: sha(data.creatorPubkey, "creatorPubkey"),
    ticketPriceSompi: decimal(data.ticketPriceSompi, "ticketPriceSompi", true), maxTickets, minTickets, maxBatches,
    salesDeadlineDaa: decimal(data.salesDeadlineDaa, "salesDeadlineDaa", true), randomDelayDaa: decimal(data.randomDelayDaa, "randomDelayDaa", true),
    registryAddress: String(data.registryAddress ?? ""), feePolicy: { refundNetworkFees: "deduct-from-ticket-payments", carrierSompi: decimal(feePolicy.carrierSompi, "carrierSompi") }
  };
  if (!/^\d+\.\d+\.\d+/.test(parsed.createdByAppVersion)) throw new Error("createdByAppVersion is invalid.");
  if (!parsed.creatorAddress || !parsed.registryAddress) throw new Error("Metadata addresses are required.");
  const minimumCarrier = BigInt(PROTOCOL_MANIFEST.refundTransitionFeeCapSompi);
  if (BigInt(parsed.feePolicy.carrierSompi) < minimumCarrier) throw new Error("carrierSompi does not preserve the vNext refund-transition cap.");
  if (parsed.protocolVersion === PROTOCOL_MANIFEST.protocolVersion && BigInt(parsed.ticketPriceSompi) < BigInt(PROTOCOL_MANIFEST.minimumTicketPriceSompi)) {
    throw new Error("ticketPriceSompi cannot cover the current protocol's worst-case one-batch refund fees.");
  }
  if (parsed.protocolVersion === PROTOCOL_MANIFEST.protocolVersion && BigInt(parsed.ticketPriceSompi) * BigInt(parsed.maxTickets) > BigInt(PROTOCOL_MANIFEST.maxRoundPrincipalSompi)) {
    throw new Error("ticketPriceSompi * maxTickets exceeds the current protocol arithmetic bound.");
  }
  return parsed;
}

export function metadataCompatibility(metadata: RaffleMetadataV2): "native" | "compatible-release-required" {
  return metadata.protocolVersion === PROTOCOL_MANIFEST.protocolVersion &&
    metadata.roundContract === PROTOCOL_MANIFEST.roundContract &&
    metadata.refundContract === PROTOCOL_MANIFEST.refundContract &&
    metadata.roundArtifactSha256 === PROTOCOL_MANIFEST.roundArtifactSha256 &&
    metadata.refundArtifactSha256 === PROTOCOL_MANIFEST.refundArtifactSha256
    ? "native"
    : "compatible-release-required";
}
