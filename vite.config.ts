import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import zlib from "node:zlib";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const requireFromConfig = createRequire(import.meta.url);
const kaspaPackageDirectory = path.dirname(requireFromConfig.resolve("@onekeyfe/kaspa-wasm/kaspa.js"));

const brokenOneKeyWasmLoader =
  'return await WebAssembly.instantiate(require("./kaspa_bg.wasm.js")(), imports);';
const unusedOneKeyDefaultWasmUrl =
  "module_or_path = new URL('kaspa_bg.wasm.bin', import.meta.url);";

function inlineCompressedKaspaWasm(): Plugin {
  const virtualModuleId = "\0kaspa-raffle-gzip-wasm";
  const wasmImport = "@onekeyfe/kaspa-wasm/kaspa_bg.wasm.bin?url";

  return {
    name: "inline-compressed-kaspa-wasm",
    enforce: "pre",
    resolveId(source) {
      return source === wasmImport ? virtualModuleId : null;
    },
    load(id) {
      if (id !== virtualModuleId) return null;
      const wasmPath = path.join(kaspaPackageDirectory, "kaspa_bg.wasm.bin");
      const compressed = zlib.gzipSync(fs.readFileSync(wasmPath), { level: 9 });
      const dataUrl = `data:application/gzip;base64,${compressed.toString("base64")}`;
      return `export default ${JSON.stringify(dataUrl)};`;
    }
  };
}

function patchOneKeyBrowserWasmLoader(): Plugin {
  const unusedWasmModule = "\0kaspa-raffle-unused-default-wasm";
  return {
    name: "patch-onekey-browser-wasm-loader",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "./kaspa_bg.wasm.js" && importer?.includes("@onekeyfe/kaspa-wasm/kaspa.js")) {
        return unusedWasmModule;
      }
      return null;
    },
    load(id) {
      if (id === unusedWasmModule) {
        return "export default function unusedDefaultWasmLoader() { throw new Error('Use explicit Kaspa WASM initialization.'); }";
      }
      return null;
    },
    transform(code, id) {
      if (!id.includes("@onekeyfe/kaspa-wasm/kaspa.js")) {
        return null;
      }

      if (!code.includes(brokenOneKeyWasmLoader) || !code.includes(unusedOneKeyDefaultWasmUrl)) {
        throw new Error("The OneKey Kaspa WASM loader changed; review the browser patch.");
      }

      return code
        .replace(brokenOneKeyWasmLoader, "")
        .replace(unusedOneKeyDefaultWasmUrl, "throw new Error('Kaspa WASM must be initialized explicitly.');");
    }
  };
}

function localTestWalletPlugin(): Plugin {
  return {
    name: "local-test-wallet",
    configureServer(server) {
      server.middlewares.use("/__kaspa_raffle_local_test_wallet", (request, response, next) => {
        if (request.method !== "GET") {
          next();
          return;
        }

        const requestUrl = new URL(request.url ?? "", "http://localhost");
        const walletRole = requestUrl.searchParams.get("wallet");
        const network = requestUrl.searchParams.get("network");
        // An operator can supply a disposable test key only to a local Vite
        // process through an environment variable.  It is never bundled and
        // is deliberately unavailable outside the development-only route.
        const operatorTestKey = network === "testnet-10" && walletRole === "participant"
          ? process.env.KASPA_RAFFLE_TESTNET_PRIVATE_KEY?.trim()
          : undefined;
        const testnetWalletFiles: Record<string, string> = {
          outsider: "round-testnet-12.json",
          participant: "experiment-testnet-12.json",
          "validation-creator": "validation-creator-testnet-10.json",
          "validation-buyer-a": "validation-buyer-a-testnet-10.json",
          "validation-buyer-b": "validation-buyer-b-testnet-10.json",
          "validation-buyer-c": "validation-buyer-c-testnet-10.json"
        };
        const walletFile = network === "mainnet"
          ? walletRole === "participant" ? "experiment-mainnet.json" : undefined
          : network === "testnet-10" && walletRole ? testnetWalletFiles[walletRole] : undefined;

        if (!walletFile) {
          response.statusCode = 404;
          response.end("Local test wallet unavailable");
          return;
        }

        const walletPath = path.resolve("wallets", walletFile);

        try {
          if (operatorTestKey) {
            if (!/^[0-9a-f]{64}$/i.test(operatorTestKey)) {
              throw new Error("Invalid operator test key");
            }
            response.statusCode = 200;
            response.setHeader("Cache-Control", "no-store");
            response.setHeader("Content-Type", "text/plain; charset=utf-8");
            response.end(operatorTestKey);
            return;
          }

          const wallet = JSON.parse(fs.readFileSync(walletPath, "utf8")) as { privateKey?: string };

          if (!wallet.privateKey) {
            throw new Error("Missing private key");
          }

          response.statusCode = 200;
          response.setHeader("Cache-Control", "no-store");
          response.setHeader("Content-Type", "text/plain; charset=utf-8");
          response.end(wallet.privateKey);
        } catch {
          response.statusCode = 404;
          response.end("Local test wallet unavailable");
        }
      });
    }
  };
}

export default defineConfig({
  base: "./",
  plugins: [inlineCompressedKaspaWasm(), patchOneKeyBrowserWasmLoader(), localTestWalletPlugin(), react()],
  build: {
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    target: "es2022",
    rollupOptions: {
      output: {
        inlineDynamicImports: true
      }
    }
  }
});
