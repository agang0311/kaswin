import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const inputs = [
  "README.md", "index.html", "package.json", "package-lock.json", "protocol-manifest.json",
  "tsconfig.json", "vite.config.ts", "src", "docs"
];

function fingerprintBuildInputs() {
  const files = [];
  function visit(directory) {
    if (path.relative(root, directory).replaceAll("\\", "/") === "src/contracts/compiled") return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) files.push(path.relative(root, target).replaceAll("\\", "/"));
    }
  }
  for (const input of inputs) {
    const target = path.join(root, input);
    if (!fs.existsSync(target)) continue;
    if (fs.statSync(target).isDirectory()) visit(target);
    else files.push(input);
  }
  files.sort();
  const digest = createHash("sha256");
  for (const relative of files) {
    digest.update(relative); digest.update("\0"); digest.update(fs.readFileSync(path.join(root, relative))); digest.update("\0");
  }
  return digest.digest("hex");
}

const before = fingerprintBuildInputs();
for (const target of ["raffle_refund_vnext", "raffle_round_vnext"]) {
  const compile = spawnSync(process.execPath, [path.join(root, "scripts/compile-raffle-contract.mjs"), target], {
    cwd: root,
    encoding: "utf8"
  });
  process.stdout.write(compile.stdout ?? "");
  process.stderr.write(compile.stderr ?? "");
  if (compile.error) throw compile.error;
  assert.equal(compile.status, 0, `compile:vnext ${target} must complete before comparing fingerprint inputs`);
}
const after = fingerprintBuildInputs();
assert.equal(after, before, "compile:vnext must not mutate the declared build-input fingerprint; compiled artifacts and transient test logs are excluded");
console.log("PASS compile:vnext preserves the declared build-input fingerprint.");
