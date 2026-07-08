import raffleRoundManifest from "../contracts/compiled/raffle-round.manifest.json";

export interface CovenantArtifactStatus {
  enabled: boolean;
  contract: string;
  network: string;
  status: string;
  message: string;
}

interface RaffleRoundManifest {
  contract: string;
  network: string;
  status: string;
  script: string | null;
  abi: unknown;
}

const manifest = raffleRoundManifest as RaffleRoundManifest;

export function getRaffleCovenantStatus(): CovenantArtifactStatus {
  const enabled = manifest.status === "compiled" && Boolean(manifest.script) && Boolean(manifest.abi);

  return {
    enabled,
    contract: manifest.contract,
    network: manifest.network,
    status: manifest.status,
    message: enabled
      ? "Covenant artifacts are available. Finalize will build a Toccata covenant spend."
      : "Covenant artifacts are not compiled yet. Compile raffle_round.sil and wire the v1 covenant transaction builder before enabling automatic contract payout."
  };
}

export function assertRaffleCovenantReady(): void {
  const status = getRaffleCovenantStatus();

  if (!status.enabled) {
    throw new Error(status.message);
  }
}
