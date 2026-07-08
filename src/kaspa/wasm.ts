import { Buffer } from "buffer";
import initKaspaWasm from "@onekeyfe/kaspa-wasm";

const browserGlobal = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
browserGlobal.Buffer ??= Buffer;

let kaspaWasmReady: Promise<unknown> | null = null;

export function ensureKaspaWasmReady() {
  kaspaWasmReady ??= initKaspaWasm();
  return kaspaWasmReady;
}
