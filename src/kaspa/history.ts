export interface RaffleHistoryTicket {
  txId: string;
  ticketId: number;
  buyer: string;
  paidAmount: bigint;
  blockTime?: number;
}

export interface RaffleHistoryPayout {
  txId: string;
  winnerTicketId: number;
  winnerAddress: string;
  amount: bigint;
  blockTime?: number;
}

export interface RaffleHistoryRound {
  roundId: string;
  tickets: RaffleHistoryTicket[];
  payouts: RaffleHistoryPayout[];
  potAmount: bigint;
  lastBlockTime?: number;
}

interface RestTransaction {
  transaction_id?: string;
  payload?: string;
  block_time?: number;
  accepting_block_time?: number;
}

interface RafflePayload {
  app?: string;
  type?: string;
  roundId?: string;
  ticketId?: number;
  buyer?: string;
  paidAmount?: string;
  winnerTicketId?: number;
  winnerAddress?: string;
  amount?: string;
}

function decodeHexPayload(hex: string): RafflePayload | null {
  if (!hex) {
    return null;
  }

  try {
    const bytes = new Uint8Array(hex.match(/.{1,2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? []);
    const decoded = new TextDecoder().decode(bytes);
    const payload = JSON.parse(decoded) as RafflePayload;

    return payload.app === "kaspa-raffle-static" ? payload : null;
  } catch {
    return null;
  }
}

function toBigInt(value: string | undefined): bigint {
  return BigInt(value || "0");
}

function eventTime(tx: RestTransaction): number | undefined {
  return tx.accepting_block_time ?? tx.block_time;
}

function compareByTimeDesc(left?: number, right?: number) {
  return (right ?? 0) - (left ?? 0);
}

export async function loadRaffleHistory(apiBaseUrl: string, treasuryAddress: string, limit = 100): Promise<RaffleHistoryRound[]> {
  const apiBase = apiBaseUrl.replace(/\/+$/, "");
  const url = `${apiBase}/addresses/${encodeURIComponent(treasuryAddress)}/full-transactions?limit=${limit}&offset=0`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`History API returned ${response.status}.`);
  }

  const transactions = (await response.json()) as RestTransaction[];
  const rounds = new Map<string, RaffleHistoryRound>();

  for (const tx of transactions) {
    const payload = decodeHexPayload(tx.payload ?? "");

    if (!payload?.roundId || !tx.transaction_id) {
      continue;
    }

    const round =
      rounds.get(payload.roundId) ??
      ({
        roundId: payload.roundId,
        tickets: [],
        payouts: [],
        potAmount: 0n
      } satisfies RaffleHistoryRound);

    const blockTime = eventTime(tx);
    round.lastBlockTime = Math.max(round.lastBlockTime ?? 0, blockTime ?? 0) || undefined;

    if (payload.type === "ticket" && payload.buyer && payload.ticketId !== undefined) {
      const paidAmount = toBigInt(payload.paidAmount);

      round.tickets.push({
        txId: tx.transaction_id,
        ticketId: payload.ticketId,
        buyer: payload.buyer,
        paidAmount,
        blockTime
      });
      round.potAmount += paidAmount;
    }

    if (payload.type === "payout" && payload.winnerAddress && payload.winnerTicketId !== undefined) {
      round.payouts.push({
        txId: tx.transaction_id,
        winnerTicketId: payload.winnerTicketId,
        winnerAddress: payload.winnerAddress,
        amount: toBigInt(payload.amount),
        blockTime
      });
    }

    rounds.set(payload.roundId, round);
  }

  return [...rounds.values()]
    .map((round) => ({
      ...round,
      tickets: round.tickets.sort((left, right) => left.ticketId - right.ticketId),
      payouts: round.payouts.sort((left, right) => compareByTimeDesc(left.blockTime, right.blockTime))
    }))
    .sort((left, right) => compareByTimeDesc(left.lastBlockTime, right.lastBlockTime));
}
