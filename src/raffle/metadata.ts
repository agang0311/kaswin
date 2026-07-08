import type { RaffleMetadata } from "./types";

export function createEmptyMetadata(): RaffleMetadata {
  return {
    app: "kaspa-raffle-static",
    version: "0.1.0",
    network: "testnet",
    roundId: "",
    createTxId: "",
    ticketPrice: "0",
    maxTickets: 100,
    minTickets: 10,
    creatorCommitment: "",
    contractVersion: "raffle-v0"
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
    "createTxId",
    "ticketPrice",
    "maxTickets",
    "minTickets",
    "creatorCommitment",
    "contractVersion"
  ];

  for (const field of requiredFields) {
    if (parsed[field] === undefined || parsed[field] === "") {
      throw new Error(`Metadata is missing ${field}.`);
    }
  }

  return parsed as RaffleMetadata;
}

export function stringifyMetadata(metadata: RaffleMetadata): string {
  return JSON.stringify(metadata, null, 2);
}

