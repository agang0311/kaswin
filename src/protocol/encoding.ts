export function hexToBytes(hex: string, expectedBytes?: number): Uint8Array<ArrayBuffer> {
  const normalized = hex.toLowerCase();
  if (!/^[0-9a-f]*$/.test(normalized) || normalized.length % 2 !== 0) throw new Error("Expected even-length hexadecimal data.");
  const result = Uint8Array.from({ length: normalized.length / 2 }, (_, index) => Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16));
  if (expectedBytes !== undefined && result.length !== expectedBytes) throw new Error(`Expected exactly ${expectedBytes} bytes.`);
  return result;
}

export function bytesToHex(bytes: Uint8Array<ArrayBufferLike>): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function uint64Le(value: number | bigint): Uint8Array<ArrayBuffer> {
  let remaining = typeof value === "bigint" ? value : BigInt(value);
  if (remaining < 0n || remaining > 0xffff_ffff_ffff_ffffn || (typeof value === "number" && !Number.isSafeInteger(value))) throw new Error("Value is outside uint64.");
  const result = new Uint8Array(8);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return result;
}

export function concatBytes(...parts: Uint8Array<ArrayBufferLike>[]): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

export async function sha256(bytes: Uint8Array<ArrayBufferLike>): Promise<Uint8Array<ArrayBuffer>> {
  const input = bytes.slice().buffer;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", input));
}
