import { verifyTicketBatchProof } from "../raffle/merkle";

export const DEFAULT_RAFFLE_INDEX_API = "http://127.0.0.1:8787";
export const INDEXER_FREE_TICKET_LIMIT = 1_000;

export function requiresRaffleIndexer(maxTickets: number): boolean {
  return maxTickets > INDEXER_FREE_TICKET_LIMIT;
}

export function requiresRaffleIndexerProof(maxTickets: number, hasCompleteLocalHistory: boolean): boolean {
  return requiresRaffleIndexer(maxTickets) && !hasCompleteLocalHistory;
}

export function partitionRaffleRoundsByIndexer<T extends { maxTickets?: number }>(rounds: Iterable<T>): { direct: T[]; indexed: T[] } {
  const direct: T[] = [];
  const indexed: T[] = [];
  for (const round of rounds) (requiresRaffleIndexer(round.maxTickets ?? 1_000_000) ? indexed : direct).push(round);
  return { direct, indexed };
}

export interface IndexedTicketBatchProof {
  ticketId: number;
  batchIndex: number;
  firstTicketId: number;
  ticketCount: number;
  ownerPubkey: string;
  owner: string;
  transactionId?: string;
  proofHex: string;
  rootHex: string;
}

export interface IndexedRaffleRound {
  roundId: string;
  contractVersion: string;
  version?: string;
  creator?: string;
  creatorPubkey?: string;
  ticketPrice?: string;
  maxTickets?: number;
  minTickets?: number;
  maxBatches?: number;
  roundNonce?: string;
  salesDeadlineDaa?: string;
  refundAfterDaaScore?: string;
  createdAtDaaScore?: string;
  refundTimeoutSeconds?: string;
  registryAddress?: string;
  createTxId?: string;
  covenantId?: string;
  status: "Open" | "Finalized" | "Refunding" | "Refunded";
  soldTickets: number;
  soldBatches: number;
  ticketRoot: string;
  ticketFrontier: string;
  refundCursor: number;
  refundBatchCursor: number;
  latestCovenant?: {
    covenantId: string;
    address: string;
    txId: string;
    outputIndex: number;
    amountSompi: string;
    soldTickets: number;
    soldBatches: number;
    potAmount: string;
    status: "Open" | "Refunding";
    ticketRoot: string;
    ticketFrontier: string;
    refundCursor: number;
    refundBatchCursor: number;
    refundFeeDebtSompi?: string;
    creatorPubkey: string;
    refundAfterDaaScore: string;
    ticketOwnerPubkeys: string[];
  };
  finalized?: { txId: string; winnerTicketId: number; winnerAddress: string; amount: string };
  refundTxId?: string;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const value = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(value.error || `Raffle index returned ${response.status}.`);
  return value;
}

function baseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(normalized)) throw new Error("Raffle index URL must start with http:// or https://.");
  return normalized;
}

export interface RaffleIndexerHealth {
  ok: boolean;
  network: string;
  rounds: number;
  syncing: boolean;
}

export async function checkRaffleIndexer(apiBase: string): Promise<RaffleIndexerHealth> {
  const health = await fetchJson<RaffleIndexerHealth>(`${baseUrl(apiBase)}/health`);
  if (!health.ok || !health.network) throw new Error("Raffle index health check returned an invalid response.");
  return health;
}

export function loadIndexedRaffleRounds(apiBase: string): Promise<IndexedRaffleRound[]> {
  return fetchJson<IndexedRaffleRound[]>(`${baseUrl(apiBase)}/rounds`);
}

async function assertIndexedProof(proof: IndexedTicketBatchProof): Promise<void> {
  if (
    !Number.isInteger(proof.batchIndex) || proof.batchIndex < 0 ||
    !Number.isInteger(proof.firstTicketId) || proof.firstTicketId < 1 ||
    !Number.isInteger(proof.ticketCount) || proof.ticketCount < 1 ||
    proof.ticketId < proof.firstTicketId || proof.ticketId >= proof.firstTicketId + proof.ticketCount ||
    !await verifyTicketBatchProof(
      proof.rootHex,
      proof.ownerPubkey,
      proof.firstTicketId - 1,
      proof.ticketCount,
      proof.batchIndex,
      proof.proofHex
    )
  ) {
    throw new Error("Raffle index returned an invalid ticket batch proof.");
  }
}

export async function loadIndexedTicketProof(apiBase: string, roundId: string, ticketId: number): Promise<IndexedTicketBatchProof> {
  const proof = await fetchJson<IndexedTicketBatchProof>(
    `${baseUrl(apiBase)}/rounds/${encodeURIComponent(roundId)}/tickets/${ticketId}`
  );
  await assertIndexedProof(proof);
  if (proof.ticketId !== ticketId) throw new Error("Raffle index returned a proof for a different ticket.");
  return proof;
}

export async function loadIndexedBatchProof(apiBase: string, roundId: string, batchIndex: number): Promise<IndexedTicketBatchProof> {
  const proof = await fetchJson<IndexedTicketBatchProof>(
    `${baseUrl(apiBase)}/rounds/${encodeURIComponent(roundId)}/batches/${batchIndex}`
  );
  await assertIndexedProof(proof);
  if (proof.batchIndex !== batchIndex) throw new Error("Raffle index returned a proof for a different purchase batch.");
  return proof;
}

export async function loadIndexedOwnerProof(apiBase: string, roundId: string, ownerPubkey: string): Promise<IndexedTicketBatchProof> {
  const proof = await fetchJson<IndexedTicketBatchProof>(
    `${baseUrl(apiBase)}/rounds/${encodeURIComponent(roundId)}/owners/${encodeURIComponent(ownerPubkey)}/proof`
  );
  await assertIndexedProof(proof);
  if (proof.ownerPubkey !== ownerPubkey.toLowerCase()) throw new Error("Raffle index returned a proof for a different owner.");
  return proof;
}
