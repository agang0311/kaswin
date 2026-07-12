export type SupportedNetworkId = "mainnet" | "testnet-10";

export interface NetworkProfile {
  id: SupportedNetworkId;
  label: string;
  shortLabel: string;
  defaultRpcUrl: string;
  historyApiBase: string;
  addressPrefix: "kaspa:" | "kaspatest:";
}

export const NETWORK_PROFILES: readonly NetworkProfile[] = [
  {
    id: "mainnet",
    label: "Mainnet",
    shortLabel: "Mainnet",
    defaultRpcUrl: "ws://127.0.0.1:18110",
    historyApiBase: "https://api.kaspa.org",
    addressPrefix: "kaspa:"
  },
  {
    id: "testnet-10",
    label: "Testnet 10",
    shortLabel: "TN10",
    defaultRpcUrl: "ws://tn12-node.kaspa.com:18210",
    historyApiBase: "https://api-tn10.kaspa.org",
    addressPrefix: "kaspatest:"
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

export function networkFromAddress(address: string): SupportedNetworkId | undefined {
  if (address.startsWith("kaspa:")) {
    return "mainnet";
  }

  if (address.startsWith("kaspatest:")) {
    return "testnet-10";
  }

  return undefined;
}
