export type SupportedNetworkId = "mainnet" | "testnet-10";

export interface NetworkProfile {
  id: SupportedNetworkId;
  label: string;
  shortLabel: string;
  defaultRpcUrl: string;
  historyApiBase: string;
  addressPrefix: "kaspa:" | "kaspatest:";
  toccataActive: boolean;
  toccataActivationDaaScore: string;
}

export const NETWORK_PROFILES: readonly NetworkProfile[] = [
  {
    id: "mainnet",
    label: "Mainnet",
    shortLabel: "Mainnet",
    defaultRpcUrl: "ws://127.0.0.1:18110",
    historyApiBase: "https://api.kaspa.org",
    addressPrefix: "kaspa:",
    toccataActive: false,
    toccataActivationDaaScore: ""
  },
  {
    id: "testnet-10",
    label: "Testnet 12",
    shortLabel: "TN12",
    defaultRpcUrl: "ws://tn12-node.kaspa.com:18210",
    historyApiBase: "https://api-tn10.kaspa.org",
    addressPrefix: "kaspatest:",
    toccataActive: true,
    toccataActivationDaaScore: "467579632"
  }
] as const;

export function normalizeNetworkId(network: string): string {
  return network === "testnet-12" ? "testnet-10" : network;
}

export function networkProfile(network: string): NetworkProfile | undefined {
  const normalized = normalizeNetworkId(network);
  return NETWORK_PROFILES.find((profile) => profile.id === normalized);
}

export function requireNetworkProfile(network: string): NetworkProfile {
  const profile = networkProfile(network);

  if (!profile) {
    throw new Error(`Unsupported Kaspa network: ${network || "unknown"}.`);
  }

  return profile;
}

export function assertToccataActive(network: string, virtualDaaScore: bigint): void {
  const profile = requireNetworkProfile(network);

  if (!profile.toccataActive || !profile.toccataActivationDaaScore) {
    throw new Error(`Toccata covenant transactions are not active on ${profile.label} yet. Use Testnet 12 until mainnet activation.`);
  }

  const activation = BigInt(profile.toccataActivationDaaScore);

  if (virtualDaaScore < activation) {
    throw new Error(
      `Toccata is not active on ${profile.label} at DAA ${virtualDaaScore.toString()}. ` +
      `Covenant transactions require DAA ${activation.toString()} or later.`
    );
  }
}

export function networkFromAddress(address: string): SupportedNetworkId | undefined {
  if (address.startsWith("kaspa:")) {
    return "mainnet";
  }

  if (address.startsWith("kaspatest:")) {
    return "testnet-10";
  }

  return undefined;
}
