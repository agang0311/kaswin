import { PROTOCOL_MANIFEST } from "./manifest";
import { bytesToHex, concatBytes, hexToBytes, sha256, uint64Le } from "./encoding";

const DRAW_DOMAIN = new TextEncoder().encode(PROTOCOL_MANIFEST.drawDomain);
const UINT56_RANGE = 1n << 56n;

export function drawRandomnessBaseDaaScore(input: {
  covenantDaaScore: bigint;
  salesDeadlineDaaScore: bigint;
  soldTickets: number;
  maxTickets: number;
}): bigint {
  if (input.covenantDaaScore < 0n || input.salesDeadlineDaaScore <= 0n) throw new Error("Draw DAA values are invalid.");
  if (!Number.isSafeInteger(input.soldTickets) || !Number.isSafeInteger(input.maxTickets) || input.soldTickets < 1 || input.soldTickets > input.maxTickets) {
    throw new Error("Draw ticket counters are invalid.");
  }
  return input.soldTickets === input.maxTickets || input.covenantDaaScore >= input.salesDeadlineDaaScore
    ? input.covenantDaaScore
    : input.salesDeadlineDaaScore;
}

export async function deriveDrawSeed(roundNonceHex: string, ticketRootHex: string, targetBlockHashHex: string, chainSequenceCommitmentHex: string): Promise<Uint8Array> {
  return sha256(concatBytes(DRAW_DOMAIN, hexToBytes(roundNonceHex, 32), hexToBytes(ticketRootHex, 32), hexToBytes(targetBlockHashHex, 32), hexToBytes(chainSequenceCommitmentHex, 32)));
}

function uint56Le(bytes: Uint8Array<ArrayBufferLike>): bigint {
  let value = 0n;
  for (let index = 6; index >= 0; index -= 1) value = (value << 8n) | BigInt(bytes[index]);
  return value;
}

export async function winnerFromSeed(initialSeed: Uint8Array<ArrayBufferLike>, soldTickets: number): Promise<{ winnerTicketId: number; acceptedSeedHex: string; attempts: number; usedFallback: boolean }> {
  if (initialSeed.length !== 32) throw new Error("Draw seed must be 32 bytes.");
  if (!Number.isSafeInteger(soldTickets) || soldTickets < 1 || soldTickets > PROTOCOL_MANIFEST.maxTickets) throw new Error("soldTickets is outside the protocol limit.");
  const divisor = BigInt(soldTickets);
  const limit = (UINT56_RANGE / divisor) * divisor;
  let seed: Uint8Array<ArrayBufferLike> = initialSeed.slice();
  let random = uint56Le(seed);
  let attempts = 1;
  for (let counter = 1; counter <= 4 && random >= limit; counter += 1) {
    seed = await sha256(concatBytes(seed, uint64Le(counter)));
    random = uint56Le(seed);
    attempts = counter + 1;
  }
  return {
    winnerTicketId: Number(random % divisor),
    acceptedSeedHex: bytesToHex(seed),
    attempts,
    usedFallback: random >= limit
  };
}

export async function deriveWinner(roundNonceHex: string, ticketRootHex: string, targetBlockHashHex: string, chainSequenceCommitmentHex: string, soldTickets: number) {
  return winnerFromSeed(await deriveDrawSeed(roundNonceHex, ticketRootHex, targetBlockHashHex, chainSequenceCommitmentHex), soldTickets);
}
