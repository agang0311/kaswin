import type { RaffleMetadata } from "./types";

export const RAFFLE_CONTRACT_VERSION = "raffle-vnext-liveness-guard-b1000";
export const PREVIOUS_LIVENESS_GUARD_CONTRACT_VERSION = "raffle-vnext-liveness-guard";
export const CARRIER_TOP_UP_CONTRACT_VERSION = "raffle-vnext-carrier-topup";
export const BUYER_FUNDED_REFUND_CONTRACT_VERSION = "raffle-vnext-buyer-funded-refund";
export const MIN_REFUNDABLE_TICKET_PRICE_SOMPI = 100_000_000n;
export const MAX_ROUND_PRINCIPAL_SOMPI = 4_611_686_018_427_387_904n;
export const PREVIOUS_RAFFLE_CONTRACT_VERSION = "raffle-v15-arbitrary-batched-refund";
export const LEGACY_RAFFLE_CONTRACT_VERSION = "raffle-v14-batch-range";
export const KNOWN_RAFFLE_CONTRACT_VERSIONS = [
  RAFFLE_CONTRACT_VERSION,
  PREVIOUS_LIVENESS_GUARD_CONTRACT_VERSION,
  CARRIER_TOP_UP_CONTRACT_VERSION,
  BUYER_FUNDED_REFUND_CONTRACT_VERSION,
  "raffle-vnext-deterministic-settlement",
  "raffle-v16-dynamic-refund-transition",
  PREVIOUS_RAFFLE_CONTRACT_VERSION,
  LEGACY_RAFFLE_CONTRACT_VERSION
] as const;
export const SUPPORTED_RAFFLE_CONTRACT_VERSIONS = [RAFFLE_CONTRACT_VERSION] as const;

export function isKnownRaffleContractVersion(contractVersion: string): boolean {
  return KNOWN_RAFFLE_CONTRACT_VERSIONS.includes(
    contractVersion as (typeof KNOWN_RAFFLE_CONTRACT_VERSIONS)[number]
  );
}

export function isSupportedRaffleContractVersion(contractVersion: string): boolean {
  return SUPPORTED_RAFFLE_CONTRACT_VERSIONS.includes(
    contractVersion as (typeof SUPPORTED_RAFFLE_CONTRACT_VERSIONS)[number]
  );
}

export function isVNextRaffleContractVersion(contractVersion: string): boolean {
  return contractVersion === RAFFLE_CONTRACT_VERSION || contractVersion === PREVIOUS_LIVENESS_GUARD_CONTRACT_VERSION || contractVersion === CARRIER_TOP_UP_CONTRACT_VERSION || contractVersion === BUYER_FUNDED_REFUND_CONTRACT_VERSION;
}

export function archivedReleaseForRaffleContractVersion(contractVersion: string): string | undefined {
  if (
    contractVersion === PREVIOUS_RAFFLE_CONTRACT_VERSION ||
    contractVersion === LEGACY_RAFFLE_CONTRACT_VERSION
  ) {
    return "v0.9.6";
  }
  return undefined;
}

export function isQuarantinedRaffleContractVersion(contractVersion: string): boolean {
  return contractVersion === PREVIOUS_LIVENESS_GUARD_CONTRACT_VERSION || contractVersion === CARRIER_TOP_UP_CONTRACT_VERSION || contractVersion === BUYER_FUNDED_REFUND_CONTRACT_VERSION;
}

export function raffleContractVersionForNetwork(network: string): string {
  void network;
  return RAFFLE_CONTRACT_VERSION;
}

export function supportsGroupedRefunds(contractVersion: string): boolean {
  return contractVersion === RAFFLE_CONTRACT_VERSION || contractVersion === BUYER_FUNDED_REFUND_CONTRACT_VERSION || contractVersion === PREVIOUS_RAFFLE_CONTRACT_VERSION;
}

export function hasFixedRefundTransitionFee(contractVersion: string): boolean {
  return contractVersion === PREVIOUS_RAFFLE_CONTRACT_VERSION || contractVersion === LEGACY_RAFFLE_CONTRACT_VERSION;
}

export function createEmptyMetadata(network = "testnet-10"): RaffleMetadata {
  return {
    app: "kaspa-raffle-static",
    version: "1.0.0",
    network,
    roundId: "",
    createTxId: "",
    ticketPrice: "100000000",
    maxTickets: 10,
    minTickets: 1,
    maxBatches: 100,
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

  if (!isKnownRaffleContractVersion(String(parsed.contractVersion))) {
    throw new Error(`Unsupported raffle contract version: ${parsed.contractVersion}.`);
  }

  const ticketPriceText = String(parsed.ticketPrice);
  if (!/^[1-9]\d*$/.test(ticketPriceText)) throw new Error("Metadata ticketPrice must be a positive decimal sompi value.");
  if (String(parsed.contractVersion) === RAFFLE_CONTRACT_VERSION && BigInt(ticketPriceText) < MIN_REFUNDABLE_TICKET_PRICE_SOMPI) {
    throw new Error(`Current-protocol ticketPrice must be at least ${MIN_REFUNDABLE_TICKET_PRICE_SOMPI} sompi so every purchase batch can pay its worst-case refund fees.`);
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

  if (
    String(parsed.contractVersion) === RAFFLE_CONTRACT_VERSION &&
    BigInt(ticketPriceText) * BigInt(maxTickets) > MAX_ROUND_PRINCIPAL_SOMPI
  ) {
    throw new Error(`Current-protocol ticketPrice * maxTickets cannot exceed ${MAX_ROUND_PRINCIPAL_SOMPI} sompi.`);
  }

  const maxBatches = parsed.maxBatches ?? 100;
  if (typeof maxBatches !== "number" || !Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > 1_000) {
    throw new Error("Metadata maxBatches must be an integer from 1 to 1000.");
  }

  return parsed as RaffleMetadata;
}

export function stringifyMetadata(metadata: RaffleMetadata): string {
  return JSON.stringify(metadata, null, 2);
}
