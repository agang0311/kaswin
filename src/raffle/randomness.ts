const HEX_ALPHABET = "0123456789abcdef";

export function randomHex(bytes = 32): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(data, (byte) => {
    return HEX_ALPHABET[byte >> 4] + HEX_ALPHABET[byte & 15];
  }).join("");
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  return sha256BytesHex(data);
}

export async function sha256BytesHex(data: Uint8Array): Promise<string> {
  const copy = new ArrayBuffer(data.byteLength);
  new Uint8Array(copy).set(data);

  const hash = await crypto.subtle.digest("SHA-256", copy);
  return Array.from(new Uint8Array(hash), (byte) => {
    return HEX_ALPHABET[byte >> 4] + HEX_ALPHABET[byte & 15];
  }).join("");
}

export async function creatorCommitment(secretHex: string): Promise<string> {
  return sha256BytesHex(hexToBytes(secretHex));
}

export function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.trim().toLowerCase();

  if (!/^[0-9a-f]*$/.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error("Expected an even-length hex string.");
  }

  const bytes = new Uint8Array(normalized.length / 2);

  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }

  return bytes;
}
