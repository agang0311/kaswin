export type RoundStatus = "Open" | "Closed" | "Finalized" | "Refunding";
export type RandomnessMode = "commit-reveal";

export interface RoundState {
  appId: "KASPA_RAFFLE_ROUND_V1";
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
  creatorCommitment: string;
  ticketRoot: string;
}

export interface TicketState {
  appId: "KASPA_RAFFLE_TICKET_V1";
  roundId: string;
  ticketId: number;
  owner: string;
  paidAmount: bigint;
  buyerCommitment: string;
  ticketTxId: string;
}

export interface FinalizeState {
  appId: "KASPA_RAFFLE_FINAL_V1";
  roundId: string;
  randomSeed: string;
  winnerTicketId: number;
  winnerAddress: string;
  payoutTxId: string;
}

export interface RaffleMetadata {
  app: "kaspa-raffle-static";
  version: string;
  network: string;
  roundId: string;
  createTxId: string;
  startBlockHash?: string;
  createdAtDaaScore?: string;
  ticketPrice: string;
  maxTickets: number;
  minTickets: number;
  creatorCommitment: string;
  treasuryAddress?: string;
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
