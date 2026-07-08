import { randomHex } from "../raffle/randomness";

export interface BrowserTestWallet {
  id: string;
  address: string;
  balanceSompi: bigint;
}

export function createPlaceholderWallet(): BrowserTestWallet {
  const id = randomHex(16);

  return {
    id,
    address: `kaspatest:placeholder-${id.slice(0, 16)}`,
    balanceSompi: 0n
  };
}

