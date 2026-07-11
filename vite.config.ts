import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const brokenOneKeyWasmLoader =
  'return await WebAssembly.instantiate(require("./kaspa_bg.wasm.js")(), imports);';

function patchOneKeyBrowserWasmLoader(): Plugin {
  return {
    name: "patch-onekey-browser-wasm-loader",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("@onekeyfe/kaspa-wasm/kaspa.js")) {
        return null;
      }

      if (!code.includes(brokenOneKeyWasmLoader)) {
        throw new Error("The OneKey Kaspa WASM loader changed; review the browser patch.");
      }

      return code.replace(brokenOneKeyWasmLoader, "");
    }
  };
}

export default defineConfig({
  base: "./",
  plugins: [patchOneKeyBrowserWasmLoader(), react()],
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
