import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const manifest = JSON.parse(fs.readFileSync(path.join(root, "protocol-manifest.json"), "utf8"));
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const packageLock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const protocolDoc = fs.readFileSync(path.join(root, "docs/protocol-vnext.md"), "utf8");
const compatibilityDoc = fs.readFileSync(path.join(root, "docs/contract-compatibility.md"), "utf8");
const developmentDoc = fs.readFileSync(path.join(root, "docs/development-verification-loop.md"), "utf8");
const evidenceDoc = fs.readFileSync(path.join(root, "docs/audit-evidence-matrix.md"), "utf8");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const englishReadme = fs.readFileSync(path.join(root, "README.en.md"), "utf8");
const releaseNotes = fs.readFileSync(path.join(root, `release-notes-v${manifest.appVersion}.md`), "utf8");
const technicalGuide = fs.readFileSync(path.join(root, "docs/technical-guide.zh-CN.md"), "utf8");
const contractsReadme = fs.readFileSync(path.join(root, "src/contracts/README.md"), "utf8");
const compatibility = JSON.parse(fs.readFileSync(path.join(root, "docs/release-compatibility.json"), "utf8"));
const validationGenerator = fs.readFileSync(path.join(root, "scripts/generate-validation-evidence.mjs"), "utf8");
const testnetValidationDoc = fs.readFileSync(path.join(root, "docs/testnet-validation-log.md"), "utf8");

assert.equal(manifest.appVersion, packageJson.version, "manifest appVersion must match package.json");
assert.equal(manifest.appVersion, packageLock.version, "manifest appVersion must match package-lock.json");
assert.equal(manifest.appVersion, packageLock.packages[""].version, "manifest appVersion must match the root lock package");
for (const value of [manifest.protocolVersion, manifest.roundContract, manifest.refundContract, manifest.batchLeafDomain, manifest.drawDomain]) assert.ok(protocolDoc.includes(value), `protocol documentation must contain ${value}`);
assert.equal(manifest.artifactStatus, "compiled");
for (const [file, expected] of [["raffle-round-vnext.artifact.json", manifest.roundArtifactSha256], ["raffle-refund-vnext.artifact.json", manifest.refundArtifactSha256]]) {
  const artifact = JSON.parse(fs.readFileSync(path.join(root, "src/contracts/compiled", file), "utf8"));
  const actual = createHash("sha256").update(Buffer.from(artifact.script, "hex")).digest("hex");
  assert.equal(actual, expected, file + " script hash must match the manifest");
}
assert.equal(compatibility.candidate.protocol, manifest.protocolVersion, "release compatibility candidate protocol must match manifest");
assert.equal(compatibility.candidate.roundContract, manifest.roundContract, "release compatibility Round contract must match manifest");
assert.equal(compatibility.candidate.refundContract, manifest.refundContract, "release compatibility Refund contract must match manifest");
assert.equal(compatibility.candidate.status, "pre-release-integration-candidate", "candidate must state its pre-release status");
assert.equal(compatibility.candidate.release, `v${manifest.appVersion}`, "candidate release tag must match the app version");
assert.equal(compatibility.candidate.roundArtifactSha256, manifest.roundArtifactSha256, "release compatibility Round hash must match manifest");
assert.equal(compatibility.candidate.refundArtifactSha256, manifest.refundArtifactSha256, "release compatibility Refund hash must match manifest");
assert.ok(Array.isArray(compatibility.candidate.releaseBlockedBy) && compatibility.candidate.releaseBlockedBy.length >= 4, "candidate release blockers must be explicit");
assert.ok(Array.isArray(compatibility.legacy) && compatibility.legacy.some((entry) => entry.protocol === "raffle-v16-dynamic-refund-transition"), "v16 must remain explicitly historical");

for (const [name, document] of Object.entries({ protocolDoc, compatibilityDoc, developmentDoc, evidenceDoc, readme, englishReadme, releaseNotes, technicalGuide, contractsReadme })) {
  assert.ok(document.includes(manifest.protocolVersion), `${name} must identify the manifest protocol`);
}
for (const document of [readme, englishReadme, releaseNotes]) {
  assert.ok(document.includes(manifest.roundContract) && document.includes(manifest.refundContract), "release-facing documentation must name both applicable contracts");
  assert.ok(document.includes(manifest.roundArtifactSha256) && document.includes(manifest.refundArtifactSha256), "release-facing documentation must include both artifact hashes");
}
for (const [name, document] of Object.entries({ protocolDoc, developmentDoc, evidenceDoc, readme, technicalGuide, contractsReadme })) {
  assert.match(document, /(not network-released|尚未|Pending external|本地|local)/i, `${name} must state a non-release/local boundary`);
}
for (const document of [readme, technicalGuide, contractsReadme, developmentDoc, protocolDoc]) {
  assert.equal(document.includes("New rounds use `raffle-v16-dynamic-refund-transition`"), false, "documentation must not call v16 the new-round protocol");
  assert.equal(document.includes("production UI continues treating v16 as the only executable protocol"), false, "documentation must not deny the local vNext integration");
  assert.equal(document.includes("current protocol and compiled implementation are both v16"), false, "documentation must not describe v16 as current vNext implementation");
}
assert.match(evidenceDoc, /Testnet A–E/, "evidence matrix must preserve the Testnet release blocker");
assert.match(evidenceDoc, /Mainnet small-value/, "evidence matrix must preserve the Mainnet release blocker");
assert.match(evidenceDoc, /independent audit/i, "evidence matrix must preserve the audit release blocker");
assert.equal(packageJson.scripts["validation:local"], "node scripts/generate-validation-evidence.mjs", "package must expose reproducible local validation evidence command");
assert.equal(packageJson.scripts["verify:validation-evidence"], "node scripts/verify-local-validation-evidence.mjs", "package must expose validation evidence consistency check");
assert.equal(packageJson.scripts["verify:validation-fingerprint"], "node scripts/verify-validation-fingerprint.mjs", "package must expose build-input fingerprint behavior check");
assert.match(packageJson.scripts.verify, /verify-validation-fingerprint/, "full verification must execute the build-input fingerprint behavior check");
assert.match(developmentDoc, /npm run validation:local/, "development loop must document local evidence generation");
assert.match(readme, /npm run validation:local/, "README must document local evidence generation");
assert.match(evidenceDoc, /testnetPassed: false/, "evidence matrix must state local evidence cannot pass Testnet");
assert.match(evidenceDoc, /mainnetSmokePassed: false/, "evidence matrix must state local evidence cannot pass Mainnet smoke");
for (const token of ["networkOperationsPerformed: false", "testnetPassed: false", "mainnetSmokePassed: false", "criticalOpen: null", "highOpen: null", "human-acceptance-report.md"]) {
  assert.ok(validationGenerator.includes(token), `local evidence generator must preserve ${token}`);
}
assert.ok(validationGenerator.includes('"src/contracts/compiled"'), "build-input fingerprint must exclude compiler-generated artifacts");
assert.ok(validationGenerator.includes('"package-lock.json"') && validationGenerator.includes('"protocol-manifest.json"') && validationGenerator.includes('"docs"'), "build-input fingerprint must include lock, manifest, and documentation inputs");
for (const token of ["d375d8a87a854e905ec1a75991b1d9881c9f85cb198677b23da340a895d5ff13", "da7db39806caf9c5e6394b87054cf8728fbe9ca6e374022ef985ce97a03920ba", "Historical compatibility evidence", "None of these older records passes A–E for the current", "`testnetPassed` remains `false`"]) {
  assert.ok(testnetValidationDoc.includes(token), `Testnet validation log must preserve ${token}`);
}
assert.ok(validationGenerator.includes("testnetValidationLog") && validationGenerator.includes('testnetEvidenceStatus: "current-exact-hash-network-evidence-pending"'), "evidence generator must copy historical Testnet observations without self-certifying current-artifact network evidence");
console.log("PASS manifest, local-vNext status, historical compatibility, and release blockers are consistent");

const uploadCandidates = [...new Set([
  ...execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split(/\r?\n/),
  ...execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split(/\r?\n/)
].filter(Boolean))];
const files = uploadCandidates
  .map((relative) => path.join(root, relative))
  .filter((file) => fs.existsSync(file) && fs.statSync(file).isFile());
const forbidden = [
  /(?:privateKey|private_key)\s*[:=]\s*["'`]\s*[0-9a-f]{64}\s*["'`]/i,
  /(?:seedPhrase|mnemonic)\s*[:=]\s*["'`][^"'`]{16,}["'`]/i
];
for (const file of files) {
  const content = fs.readFileSync(file, "utf8");
  for (const pattern of forbidden) assert.equal(pattern.test(content), false, `production source contains a private credential: ${path.relative(root, file)}`);
}
if (fs.existsSync(path.join(root, "dist/index.html"))) {
  const html = fs.readFileSync(path.join(root, "dist/index.html"), "utf8");
  for (const pattern of forbidden) assert.equal(pattern.test(html), false, "release HTML contains a private credential");
  assert.equal(html.includes("/__kaspa_raffle_local_test_wallet"), false, "release HTML contains the development wallet endpoint");
}
console.log("PASS production sources and release HTML contain no embedded wallet credential");
assert.equal(uploadCandidates.some((file) => /^wallets\//i.test(file.replaceAll("\\", "/"))), false, "Git upload candidates must not contain local wallet files");
console.log(`PASS ${uploadCandidates.length} tracked or unignored upload candidates contain no wallet credential or wallets/ path`);
