import rawManifest from "../../protocol-manifest.json";

export interface ProtocolManifest {
  appVersion: string;
  protocolId: "kaspa-raffle-static";
  protocolVersion: "raffle-vnext-liveness-guard-b1000";
  roundContract: "RaffleRoundVNext";
  refundContract: "RaffleRefundVNext";
  roundArtifactSha256: string | null;
  refundArtifactSha256: string | null;
  artifactStatus: "pending-phase-2" | "compiled";
  supportedNetworks: readonly ["mainnet", "testnet-10"];
  metadataSchema: 2;
  ticketMerkleDepth: 20;
  maxTickets: number;
  defaultMaxBatches: number;
  maxRelaySafePurchaseBatches: number;
  recommendedSecondsPerPurchaseBatch: number;
  refundTransitionFeeCapSompi: string;
  refundFeeCapSompi: string;
  minimumTicketPriceSompi: string;
  maxRoundPrincipalSompi: string;
  maxRefundBatchesPerTransaction: 13;
  randomDelayDaa: string;
  batchLeafDomain: "KASPA_RAFFLE_BATCH_V2";
  drawDomain: "KASPA_RAFFLE_DRAW_V2";
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function validateProtocolManifest(value: unknown): ProtocolManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Protocol manifest must be an object.");
  const manifest = value as Record<string, unknown>;
  if (manifest.protocolId !== "kaspa-raffle-static") throw new Error("Unexpected protocol id.");
  if (manifest.protocolVersion !== "raffle-vnext-liveness-guard-b1000") throw new Error("Unexpected protocol version.");
  if (manifest.roundContract !== "RaffleRoundVNext" || manifest.refundContract !== "RaffleRefundVNext") throw new Error("Unexpected vNext contract names.");
  if (manifest.metadataSchema !== 2) throw new Error("vNext metadata schema must be 2.");
  if (manifest.ticketMerkleDepth !== 20 || manifest.maxTickets !== 1_000_000) throw new Error("Unexpected ticket capacity constants.");
  if (!Number.isInteger(manifest.defaultMaxBatches) || Number(manifest.defaultMaxBatches) < 1 || Number(manifest.defaultMaxBatches) > 1_000) throw new Error("defaultMaxBatches is outside the covenant limit.");
  if (!Number.isInteger(manifest.maxRelaySafePurchaseBatches) || Number(manifest.maxRelaySafePurchaseBatches) < 1 || Number(manifest.maxRelaySafePurchaseBatches) > 1_000 || Number(manifest.defaultMaxBatches) > Number(manifest.maxRelaySafePurchaseBatches)) throw new Error("vNext purchase-batch policy must match the covenant bound.");
  if (!Number.isInteger(manifest.recommendedSecondsPerPurchaseBatch) || Number(manifest.recommendedSecondsPerPurchaseBatch) < 1) throw new Error("vNext purchase-batch recommendation interval is invalid.");
  if (manifest.refundTransitionFeeCapSompi !== "20000000" || manifest.refundFeeCapSompi !== "20000000") throw new Error("Unexpected vNext refund liveness fee caps.");
  if (manifest.minimumTicketPriceSompi !== "100000000") throw new Error("Unexpected one-batch refund liveness minimum.");
  if (manifest.maxRoundPrincipalSompi !== "4611686018427387904") throw new Error("Unexpected round principal arithmetic bound.");
  if (manifest.maxRefundBatchesPerTransaction !== 13 || manifest.randomDelayDaa !== "30") throw new Error("Unexpected settlement constants.");
  if (manifest.batchLeafDomain !== "KASPA_RAFFLE_BATCH_V2" || manifest.drawDomain !== "KASPA_RAFFLE_DRAW_V2") throw new Error("Unexpected domain separation constants.");
  if (!Array.isArray(manifest.supportedNetworks) || manifest.supportedNetworks.join(",") !== "mainnet,testnet-10") throw new Error("Only Mainnet and Testnet 10 are supported.");
  const compiled = manifest.artifactStatus === "compiled";
  if (manifest.artifactStatus !== "pending-phase-2" && !compiled) throw new Error("Unknown artifact status.");
  if (compiled !== (isSha256(manifest.roundArtifactSha256) && isSha256(manifest.refundArtifactSha256))) throw new Error("Artifact hashes and artifact status disagree.");
  if (typeof manifest.appVersion !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.appVersion)) throw new Error("Invalid app version.");
  return manifest as unknown as ProtocolManifest;
}

export const PROTOCOL_MANIFEST = Object.freeze(validateProtocolManifest(rawManifest));
