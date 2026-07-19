import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const validation = path.join(root, "validation");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const readValidation = (relative) => fs.readFileSync(path.join(validation, relative), "utf8");
const required = [
  "manifest.json", "npm-verify.log", "contract-test.log", "mass-report.json", "artifact-hashes.txt",
  "browser-e2e-report/README.md", "testnet-rounds.md", "mainnet-smoke.md", "known-limitations.md",
  "release-sha256.txt", "rebuild.log", "property-test-report.json", "human-acceptance-report.md", "indexer-benchmark.json", "indexer-benchmark-report.md", "README.md"
];
for (const relative of required) assert.ok(fs.existsSync(path.join(validation, relative)), `missing validation evidence file: ${relative}`);

const protocol = JSON.parse(read("protocol-manifest.json"));
const packageJson = JSON.parse(read("package.json"));
const evidence = JSON.parse(readValidation("manifest.json"));
const mass = JSON.parse(readValidation("mass-report.json"));
const indexerBenchmark = JSON.parse(readValidation("indexer-benchmark.json"));
const property = JSON.parse(readValidation("property-test-report.json"));
const hash = (value) => createHash("sha256").update(value).digest("hex");

assert.equal(packageJson.scripts["validation:local"], "node scripts/generate-validation-evidence.mjs");
assert.equal(evidence.evidenceSchemaVersion, 1);
assert.equal(evidence.evidenceKind, "local-automated-candidate");
assert.equal(evidence.networkOperationsPerformed, false);
assert.equal(evidence.localVerificationPassed, true);
assert.equal(evidence.appVersion, protocol.appVersion);
assert.equal(evidence.protocolVersion, protocol.protocolVersion);
assert.equal(evidence.roundArtifactSha256, protocol.roundArtifactSha256);
assert.equal(evidence.refundArtifactSha256, protocol.refundArtifactSha256);
assert.equal(evidence.singleHtmlSha256, hash(fs.readFileSync(path.join(root, "dist", "index.html"))));
assert.equal(evidence.sameWorkspaceDoubleBuildSha256.length, 2);
assert.equal(evidence.sameWorkspaceDoubleBuildSha256[1], evidence.singleHtmlSha256);
assert.ok([true, false, null].includes(evidence.sameWorkspaceDoubleBuildMatches));
assert.ok(["same-workspace-match", "same-workspace-mismatch", "inconclusive-workspace-changed-during-generation"].includes(evidence.buildReproducibilityStatus));
if (evidence.buildReproducibilityStatus === "same-workspace-match") {
  assert.equal(evidence.sourceStableAcrossBuilds, true);
  assert.equal(evidence.sameWorkspaceDoubleBuildMatches, true);
  assert.equal(evidence.sameWorkspaceDoubleBuildSha256[0], evidence.sameWorkspaceDoubleBuildSha256[1]);
}
if (evidence.buildReproducibilityStatus === "same-workspace-mismatch") {
  assert.equal(evidence.sourceStableAcrossBuilds, true);
  assert.equal(evidence.sameWorkspaceDoubleBuildMatches, false);
  assert.notEqual(evidence.sameWorkspaceDoubleBuildSha256[0], evidence.sameWorkspaceDoubleBuildSha256[1]);
}
if (evidence.buildReproducibilityStatus === "inconclusive-workspace-changed-during-generation") {
  assert.equal(evidence.sourceStableAcrossBuilds, false);
  assert.equal(evidence.sameWorkspaceDoubleBuildMatches, null);
}
assert.equal(evidence.cleanEnvironmentRebuildVerified, false);
assert.equal(evidence.testnetPassed, false);
assert.equal(evidence.testnetEvidenceStatus, "current-exact-hash-network-evidence-pending");
assert.equal(evidence.testnetCreateEvidenceTxId, null);
assert.equal(evidence.mainnetSmokePassed, false);
assert.equal(evidence.criticalOpen, null);
assert.equal(evidence.highOpen, null);
assert.equal(evidence.releaseStatus, "blocked");
assert.ok(Array.isArray(evidence.releaseBlockers) && evidence.releaseBlockers.length >= 4);

assert.equal(mass.networkOperationsPerformed, false);
assert.equal(mass.protocolVersion, protocol.protocolVersion);
assert.equal(mass.configuredPurchaseBatchLimit, protocol.maxRelaySafePurchaseBatches);
assert.equal(mass.abiProofBatchLimit, protocol.maxRefundBatchesPerTransaction);
assert.equal(mass.measurements.length, 4);
assert.ok(mass.measurements.every((row) => row.maxBatches >= 1 && row.maxBatches <= protocol.maxRefundBatchesPerTransaction));

assert.equal(property.networkOperationsPerformed, false);
assert.equal(property.cases, 10000);
assert.match(property.logEvidence, /10,000 deterministic buyer-funded refund cases/);

assert.equal(indexerBenchmark.networkOperationsPerformed, false);
assert.equal(indexerBenchmark.generatedRecords, 1000000);
assert.equal(indexerBenchmark.generationSeconds, 9.30);
assert.equal(indexerBenchmark.coldDiskIndexRebuildSeconds, 507.02);
assert.equal(indexerBenchmark.warmCheckpointRestartSeconds, 0.27);
assert.equal(indexerBenchmark.warmIndexerRssBytes, 83603456);
assert.match(indexerBenchmark.limitations, /not demonstrate a live node/i);

const verifyLog = readValidation("npm-verify.log");
for (const token of ["PASS compile:vnext preserves the declared build-input fingerprint.", "PASS vNext VM behavior", "PASS vNext public closeEmpty construction", "PASS signing confirmation state transitions and stale buy/carrier-top-up guards", "vNext refund transaction-shape mass and fee checks passed.", "PASS manifest, local-vNext status"]) {
  assert.ok(verifyLog.includes(token), `validation verify log must contain ${token}`);
}
assert.match(verifyLog, /PASS 10,000 deterministic buyer-funded refund cases/);
assert.match(readValidation("rebuild.log"), /Single-file SPA/);
assert.match(readValidation("testnet-rounds.md"), /historical compatibility evidence only/i);
assert.match(readValidation("testnet-rounds.md"), /42db7c7e4757ed5a6117b0ed1129baa77cc6eae78dd92f640b4d3f28aa69823c/);
assert.match(readValidation("testnet-rounds.md"), /None of these older records passes A–E for the current/);
assert.match(readValidation("mainnet-smoke.md"), /not executed/i);
assert.match(readValidation("known-limitations.md"), /independent security audit/i);
assert.match(readValidation("indexer-benchmark-report.md"), /RAFFLE_INDEX_OFFLINE=1/);
assert.match(readValidation("human-acceptance-report.md"), /RELEASE BLOCKED/);
assert.match(read("docs/audit-evidence-matrix.md"), /npm run validation:local/);
assert.match(read("docs/development-verification-loop.md"), /npm run validation:local/);
console.log("PASS local validation evidence package is complete, manifest-consistent, and explicitly network-blocked.");
