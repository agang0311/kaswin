import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const brokenOneKeyWasmLoader =
  'return await WebAssembly.instantiate(require("./kaspa_bg.wasm.js")(), imports);';
const unusedOneKeyDefaultWasmUrl =
  "module_or_path = new URL('kaspa_bg.wasm.bin', import.meta.url);";

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
        const walletFile = requestUrl.searchParams.get("wallet") === "outsider"
          ? "round-testnet-12.json"
          : "experiment-testnet-12.json";
        const walletPath = path.resolve("wallets", walletFile);

        try {
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
  plugins: [patchOneKeyBrowserWasmLoader(), localTestWalletPlugin(), react()],
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
