import { Buffer } from "buffer";
import initKaspaWasm from "@onekeyfe/kaspa-wasm";
import kaspaWasmUrl from "@onekeyfe/kaspa-wasm/kaspa_bg.wasm.bin?url";

const browserGlobal = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
browserGlobal.Buffer ??= Buffer;

let kaspaWasmReady: Promise<unknown> | null = null;

async function loadKaspaWasmBytes(): Promise<Uint8Array> {
  if (kaspaWasmUrl.startsWith("data:")) {
    const isGzip = kaspaWasmUrl.startsWith("data:application/gzip;");
    const base64 = kaspaWasmUrl.slice(kaspaWasmUrl.indexOf(",") + 1);
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));

    if (!isGzip) return bytes;
    if (typeof DecompressionStream === "undefined") {
      throw new Error("This browser cannot decompress the embedded Kaspa WASM. Use a current browser version.");
    }

    const decompressed = new Blob([bytes])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(decompressed).arrayBuffer());
  }

  const response = await fetch(kaspaWasmUrl);

  if (!response.ok) {
    throw new Error(`Unable to load Kaspa WASM (${response.status}).`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

export function ensureKaspaWasmReady() {
  kaspaWasmReady ??= loadKaspaWasmBytes().then((bytes) => initKaspaWasm({ module_or_path: bytes }));
  return kaspaWasmReady;
}
