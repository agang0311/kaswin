const HEX_ALPHABET = "0123456789abcdef";

export function randomHex(bytes = 32): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(data, (byte) => {
    return HEX_ALPHABET[byte >> 4] + HEX_ALPHABET[byte & 15];
  }).join("");
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash), (byte) => {
    return HEX_ALPHABET[byte >> 4] + HEX_ALPHABET[byte & 15];
  }).join("");
}

export async function creatorCommitment(secretHex: string): Promise<string> {
  return sha256Hex(secretHex);
}

