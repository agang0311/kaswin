export type RoundStatus = "Open" | "Closed" | "Finalized" | "Refunding" | "Refunded";
export type RandomnessMode = "oracle";

export interface RoundState {
  appId: "KASPA_RAFFLE_ROUND_V1";
  contractVersion: string;
  roundId: string;
  creator: string;
  ticketPrice: bigint;
  maxTickets: number;
  minTickets: number;
  soldTickets: number;
  potAmount: bigint;
  feeBps: number;
  status: RoundStatus;
  randomnessMode: RandomnessMode;
  creatorPubkey: string;
  oraclePublicKey: string;
  oraclePublicKey2: string;
  oraclePublicKey3: string;
  oracleSeedCommitment: string;
  oracleSeedCommitment2: string;
  oracleSeedCommitment3: string;
  refundAfterDaaScore: string;
  ticketRoot: string;
  ticketFrontier?: string;
  refundCursor?: number;
  soldBatches: number;
  ticketBatchEnds: number[];
  ticketOwnerPubkeys: string[];
}

export interface TicketState {
  appId: "KASPA_RAFFLE_TICKET_V1";
  roundId: string;
  ticketId: number;
  ticketCount?: number;
  owner: string;
  ownerPubkey?: string;
  paidAmount: bigint;
  buyerCommitment: string;
  ticketTxId: string;
}

export interface FinalizeState {
  appId: "KASPA_RAFFLE_FINAL_V1";
  roundId: string;
  randomSeed: string;
  oracleSeed?: string;
  oracleSignature?: string;
  oracleSeed2?: string;
  oracleSignature2?: string;
  oracleSeed3?: string;
  oracleSignature3?: string;
  winnerTicketId: number;
  winnerAddress: string;
  payoutTxId: string;
}

export interface RaffleCovenantCursor {
  covenantId: string;
  address: string;
  txId: string;
  outputIndex: number;
  amountSompi: string;
  redeemScriptHex: string;
  soldTickets: number;
  potAmount: string;
  status: RoundStatus;
  ticketRoot: string;
  ticketFrontier?: string;
  refundCursor?: number;
  creatorPubkey: string;
  refundAfterDaaScore: string;
  soldBatches?: number;
  ticketBatchEnds?: number[];
  ticketOwnerPubkeys: string[];
}

export interface RaffleMetadata {
  app: "kaspa-raffle-static";
  version: string;
  network: string;
  roundId: string;
  createTxId: string;
  startBlockHash?: string;
  createdAtDaaScore?: string;
  refundTimeoutSeconds?: string;
  refundTimeoutDaa?: string;
  ticketPrice: string;
  maxTickets: number;
  minTickets: number;
  creatorAddress?: string;
  creatorPubkey?: string;
  creatorCommitment?: string;
  oraclePublicKey: string;
  oraclePublicKey2: string;
  oraclePublicKey3: string;
  oracleSeedCommitment: string;
  oracleSeedCommitment2: string;
  oracleSeedCommitment3: string;
  oracleEndpoint?: string;
  oracleEndpoint2?: string;
  oracleEndpoint3?: string;
  refundAfterDaaScore?: string;
  treasuryAddress?: string;
  registryAddress?: string;
  covenant?: RaffleCovenantCursor;
  contractVersion: string;
}

export interface VerificationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface RaffleState {
  round: RoundState;
  tickets: TicketState[];
  finalized?: FinalizeState;
  myTickets: TicketState[];
  verification: VerificationResult;
}
