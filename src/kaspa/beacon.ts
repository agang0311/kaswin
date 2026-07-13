import type { DrandRisc0Proof } from "../raffle/types";

export const DEFAULT_BEACON_PROOF_URL = "http://127.0.0.1:8790";

function proofUrl(baseUrl: string, round: number): string {
  const normalized = baseUrl.trim();
  if (!/^https?:\/\//i.test(normalized)) {
    throw new Error("Beacon proof URL must start with http:// or https://.");
  }
  if (normalized.includes("{round}")) return normalized.replace("{round}", String(round));
  return `${normalized.replace(/\/+$/, "")}/proofs/${round}`;
}

export async function loadDrandRisc0Proof(baseUrl: string, round: number): Promise<DrandRisc0Proof> {
  const url = proofUrl(baseUrl, round);
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new Error(`Beacon proof service is unavailable for drand round ${round}: ${url}`);
  }
  let value: Partial<DrandRisc0Proof> & { error?: string };
  try {
    value = await response.json() as Partial<DrandRisc0Proof> & { error?: string };
  } catch {
    throw new Error(`Beacon proof service returned non-JSON data for drand round ${round}.`);
  }
  if (!response.ok) throw new Error(value.error || `Beacon proof service returned HTTP ${response.status}.`);
  if (
    value.round !== round ||
    typeof value.randomness !== "string" ||
    typeof value.claim !== "string" ||
    typeof value.controlIndex !== "string" ||
    typeof value.controlDigests !== "string" ||
    typeof value.seal !== "string" ||
    typeof value.journalDigest !== "string" ||
    typeof value.imageId !== "string" ||
    typeof value.controlId !== "string" ||
    typeof value.hashfn !== "number"
  ) {
    throw new Error("Beacon proof service returned a malformed proof.");
  }
  return value as DrandRisc0Proof;
}
