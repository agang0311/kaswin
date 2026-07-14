import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const manifest = JSON.parse(read("indexer/package.json"));
const lock = JSON.parse(read("indexer/package-lock.json"));
const dockerfile = read("indexer/Dockerfile");
const source = read("indexer/raffle-indexer.mjs");

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`PASS ${message}`);
}

assert(manifest.name === "kaspa-raffle-indexer", "indexer has an independent package manifest");
assert(manifest.scripts?.start === "node raffle-indexer.mjs", "indexer starts without the web application toolchain");
assert(Object.keys(manifest.dependencies || {}).length === 1 && manifest.dependencies["@onekeyfe/kaspa-wasm"], "indexer only installs its Kaspa runtime dependency");
assert(lock.packages?.[""]?.version === manifest.version, "indexer lockfile matches its package version");
assert(source.includes('process.env.RAFFLE_INDEX_HOST || "127.0.0.1"'), "indexer listen host is configurable");
assert(source.includes("server.listen(port, host"), "indexer listens on the configured interface");
assert(dockerfile.includes("RAFFLE_INDEX_HOST=0.0.0.0"), "container exposes the indexer outside localhost");
assert(dockerfile.includes('VOLUME ["/data"]'), "container persists its ticket index");
assert(dockerfile.includes("HEALTHCHECK"), "container declares an HTTP health check");

console.log("Standalone indexer package checks passed.");
