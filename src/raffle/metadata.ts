import type { RaffleMetadata } from "./types";

export const MAINNET_RAFFLE_CONTRACT_VERSION = "raffle-v8-drand-risc0-mainnet";
export const TN12_RAFFLE_CONTRACT_VERSION = "raffle-v8-drand-risc0-tn12";

export function raffleContractVersionForNetwork(network: string): string {
  return network === "mainnet" ? MAINNET_RAFFLE_CONTRACT_VERSION : TN12_RAFFLE_CONTRACT_VERSION;
}

export function createEmptyMetadata(network = "testnet-10"): RaffleMetadata {
  return {
    app: "kaspa-raffle-static",
    version: "0.6.0",
    network,
    roundId: "",
    createTxId: "",
    ticketPrice: "30000000",
    maxTickets: 10,
    minTickets: 1,
    creatorAddress: "",
    creatorPubkey: "",
    creatorCommitment: "",
    beaconProofUrl: "",
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

  const expectedContractVersion = raffleContractVersionForNetwork(String(parsed.network));
  if (parsed.contractVersion !== expectedContractVersion) {
    throw new Error(`Unsupported raffle contract version. This page only accepts ${expectedContractVersion} on ${parsed.network}.`);
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
