import fs from "node:fs";
import path from "node:path";

const distDir = path.resolve("dist");
const files = fs.readdirSync(distDir);

if (files.length !== 1 || files[0] !== "index.html") {
  throw new Error(`Expected one release file, found: ${files.join(", ")}`);
}

const htmlPath = path.join(distDir, "index.html");
const html = fs.readFileSync(htmlPath, "utf8");
const size = fs.statSync(htmlPath).size;

if (!html.includes("data:application/gzip;base64,")) {
  throw new Error("The single HTML does not contain the compressed Kaspa WASM payload.");
}

if (html.includes("experiment-mainnet.json") || html.includes("__kaspa_raffle_local_test_wallet")) {
  throw new Error("The release contains the development-only local wallet harness.");
}

if (size >= 7_000_000) {
  throw new Error(`The single HTML is ${size} bytes; expected less than 7 MB.`);
}

console.log(`Single-file release verified: ${size.toLocaleString()} bytes with compressed Kaspa WASM.`);
