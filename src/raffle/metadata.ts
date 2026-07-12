import type { RaffleMetadata } from "./types";

export function createEmptyMetadata(network = "testnet-10"): RaffleMetadata {
  return {
    app: "kaspa-raffle-static",
    version: "0.5.0",
    network,
    roundId: "",
    createTxId: "",
    ticketPrice: "30000000",
    maxTickets: 10,
    minTickets: 1,
    creatorAddress: "",
    creatorPubkey: "",
    creatorCommitment: "",
    oraclePublicKey: "",
    oraclePublicKey2: "",
    oraclePublicKey3: "",
    oracleSeedCommitment: "",
    oracleSeedCommitment2: "",
    oracleSeedCommitment3: "",
    oracleEndpoint: "",
    oracleEndpoint2: "",
    oracleEndpoint3: "",
    refundTimeoutSeconds: "600",
    refundTimeoutDaa: "6000",
    refundAfterDaaScore: "",
    treasuryAddress: "",
    registryAddress: "",
    contractVersion: "raffle-v7-three-commitment-oracles"
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
    "oraclePublicKey",
    "oraclePublicKey2",
    "oraclePublicKey3",
    "oracleSeedCommitment",
    "oracleSeedCommitment2",
    "oracleSeedCommitment3",
    "contractVersion"
  ];

  for (const field of requiredFields) {
    if (parsed[field] === undefined || parsed[field] === "") {
      throw new Error(`Metadata is missing ${field}.`);
    }
  }

  if (parsed.contractVersion !== "raffle-v7-three-commitment-oracles") {
    throw new Error("Unsupported raffle contract version. This page only accepts raffle-v7-three-commitment-oracles.");
  }

  const oracleHexFields: Array<keyof RaffleMetadata> = [
    "oraclePublicKey",
    "oraclePublicKey2",
    "oraclePublicKey3",
    "oracleSeedCommitment",
    "oracleSeedCommitment2",
    "oracleSeedCommitment3"
  ];
  for (const field of oracleHexFields) {
    if (!/^[0-9a-f]{64}$/.test(String(parsed[field]))) {
      throw new Error(`Metadata ${field} must be 32 bytes of lowercase hex.`);
    }
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
