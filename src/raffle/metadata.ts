import type { RaffleMetadata } from "./types";

export const RAFFLE_CONTRACT_VERSION = "raffle-v15-arbitrary-batched-refund";
export const LEGACY_RAFFLE_CONTRACT_VERSION = "raffle-v14-batch-range";
export const SUPPORTED_RAFFLE_CONTRACT_VERSIONS = [
  RAFFLE_CONTRACT_VERSION,
  LEGACY_RAFFLE_CONTRACT_VERSION
] as const;

export function isSupportedRaffleContractVersion(contractVersion: string): boolean {
  return SUPPORTED_RAFFLE_CONTRACT_VERSIONS.includes(
    contractVersion as (typeof SUPPORTED_RAFFLE_CONTRACT_VERSIONS)[number]
  );
}

export function raffleContractVersionForNetwork(network: string): string {
  void network;
  return RAFFLE_CONTRACT_VERSION;
}

export function createEmptyMetadata(network = "testnet-10"): RaffleMetadata {
  return {
    app: "kaspa-raffle-static",
    version: "0.9.0",
    network,
    roundId: "",
    createTxId: "",
    ticketPrice: "30000000",
    maxTickets: 10,
    minTickets: 1,
    creatorAddress: "",
    creatorPubkey: "",
    refundTimeoutSeconds: "600",
    refundTimeoutDaa: "6000",
    refundAfterDaaScore: "",
    treasuryAddress: "",
    registryAddress: "",
    contractVersion: raffleContractVersionForNetwork(network)
  };
}

export function parseMetadata(raw: string): RaffleMetadata {
  const parsed = JSON.parse(raw) as Partial<RaffleMetadata>;

  if (parsed.app !== "kaspa-raffle-static") {
    throw new Error("Metadata app field must be kaspa-raffle-static.");
  }

  const requiredFields: Array<keyof RaffleMetadata> = [
    "version",
    "network",
    "roundId",
    "ticketPrice",
    "maxTickets",
    "minTickets",
    "contractVersion"
  ];

  for (const field of requiredFields) {
    if (parsed[field] === undefined || parsed[field] === "") {
      throw new Error(`Metadata is missing ${field}.`);
    }
  }

  if (!isSupportedRaffleContractVersion(String(parsed.contractVersion))) {
    throw new Error(`Unsupported raffle contract version: ${parsed.contractVersion}.`);
  }

  if (Number(parsed.ticketPrice) <= 0) {
    throw new Error("Metadata ticketPrice must be greater than zero.");
  }

  const maxTickets = parsed.maxTickets;
  const minTickets = parsed.minTickets;

  if (typeof maxTickets !== "number" || !Number.isInteger(maxTickets) || maxTickets < 1) {
    throw new Error("Metadata maxTickets must be a positive integer.");
  }

  if (maxTickets > 1_000_000) {
    throw new Error("Metadata maxTickets cannot exceed 1000000.");
  }

  if (typeof minTickets !== "number" || !Number.isInteger(minTickets) || minTickets < 1) {
    throw new Error("Metadata minTickets must be a positive integer.");
  }

  if (minTickets > maxTickets) {
    throw new Error("Metadata minTickets cannot exceed maxTickets.");
  }

  return parsed as RaffleMetadata;
}

export function stringifyMetadata(metadata: RaffleMetadata): string {
  return JSON.stringify(metadata, null, 2);
}
