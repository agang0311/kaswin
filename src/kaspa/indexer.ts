import { verifyTicketProof } from "../raffle/merkle";

export const DEFAULT_RAFFLE_INDEX_API = "http://127.0.0.1:8787";

export interface IndexedTicketProof {
  ticketId: number;
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
  oraclePublicKey?: string;
  ticketPrice?: string;
  maxTickets?: number;
  minTickets?: number;
  refundAfterDaaScore?: string;
  createdAtDaaScore?: string;
  refundTimeoutSeconds?: string;
  registryAddress?: string;
  createTxId?: string;
  covenantId?: string;
  status: "Open" | "Closed" | "Finalized" | "Refunding" | "Refunded";
  soldTickets: number;
  ticketRoot: string;
  ticketFrontier: string;
  refundCursor: number;
  latestCovenant?: {
    covenantId: string;
    address: string;
    txId: string;
    outputIndex: number;
    amountSompi: string;
    soldTickets: number;
    potAmount: string;
    status: "Open" | "Closed" | "Refunding";
    ticketRoot: string;
    ticketFrontier: string;
    refundCursor: number;
    creatorPubkey: string;
    refundAfterDaaScore: string;
    ticketOwnerPubkeys: string[];
  };
  finalized?: {
    txId: string;
    winnerTicketId: number;
    winnerAddress: string;
    amount: string;
  };
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

export function loadIndexedRaffleRounds(apiBase: string): Promise<IndexedRaffleRound[]> {
  return fetchJson<IndexedRaffleRound[]>(`${baseUrl(apiBase)}/rounds`);
}

export async function loadIndexedTicketProof(
  apiBase: string,
  roundId: string,
  ticketId: number
): Promise<IndexedTicketProof> {
  const proof = await fetchJson<IndexedTicketProof>(
    `${baseUrl(apiBase)}/rounds/${encodeURIComponent(roundId)}/tickets/${ticketId}`
  );
  await assertIndexedProof(proof);
  return proof;
}

export async function loadIndexedOwnerProof(
  apiBase: string,
  roundId: string,
  ownerPubkey: string
): Promise<IndexedTicketProof> {
  const proof = await fetchJson<IndexedTicketProof>(
    `${baseUrl(apiBase)}/rounds/${encodeURIComponent(roundId)}/owners/${encodeURIComponent(ownerPubkey)}/proof`
  );
  await assertIndexedProof(proof);
  if (proof.ownerPubkey !== ownerPubkey.toLowerCase()) throw new Error("Raffle index returned a proof for a different owner.");
  return proof;
}

async function assertIndexedProof(proof: IndexedTicketProof): Promise<void> {
  if (!Number.isInteger(proof.ticketId) || proof.ticketId < 1) throw new Error("Raffle index returned an invalid ticket number.");
  if (!await verifyTicketProof(proof.rootHex, proof.ownerPubkey, proof.ticketId - 1, proof.proofHex)) {
    throw new Error("Raffle index returned an invalid Merkle proof.");
  }
}
