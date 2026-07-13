import type { DrandRisc0Proof } from "../raffle/types";

export const DEFAULT_BEACON_PROOF_URL = "http://127.0.0.1:8790";
const DEFAULT_PROOF_WAIT_MS = 10 * 60 * 1_000;
const DEFAULT_PROOF_POLL_MS = 5_000;

function proofUrl(baseUrl: string, round: number): string {
  const normalized = baseUrl.trim();
  if (!/^https?:\/\//i.test(normalized)) {
    throw new Error("Beacon proof URL must start with http:// or https://.");
  }
  if (normalized.includes("{round}")) return normalized.replace("{round}", String(round));
  return `${normalized.replace(/\/+$/, "")}/proofs/${round}`;
}

function retryDelayMs(response: Response): number {
  const retryAfterSeconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
    ? Math.min(30_000, Math.max(1_000, retryAfterSeconds * 1_000))
    : DEFAULT_PROOF_POLL_MS;
}

export async function loadDrandRisc0Proof(
  baseUrl: string,
  round: number,
  maxWaitMs = DEFAULT_PROOF_WAIT_MS
): Promise<DrandRisc0Proof> {
  const url = proofUrl(baseUrl, round);
  const deadline = Date.now() + Math.max(0, maxWaitMs);

  while (true) {
    let response: Response;
    try {
      response = await fetch(url, { cache: "no-store" });
    } catch {
      throw new Error(`Beacon proof service is unavailable for drand round ${round}: ${url}`);
    }
    let value: Partial<DrandRisc0Proof> & { error?: string };
    try {
      value = await response.json() as Partial<DrandRisc0Proof> & { error?: string };
    } catch {
      throw new Error(`Beacon proof service returned non-JSON data for drand round ${round}.`);
    }
    if (response.status === 202 || response.status === 429) {
      const delayMs = retryDelayMs(response);
      if (Date.now() + delayMs > deadline) {
        throw new Error(`Timed out waiting for the drand round ${round} proof. The proof service may still be working; retry Draw & Pay later.`);
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
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
}
