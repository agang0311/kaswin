import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const validationDir = path.join(root, "validation");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const write = (relative, value) => {
  const target = path.join(validationDir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value, "utf8");
};

function workspaceSourceFingerprint() {
  const files = [];
  const inputs = [
    "README.md", "README.en.md", "CHANGELOG.md", "index.html", "package.json", "package-lock.json", "protocol-manifest.json",
    ...fs.readdirSync(root).filter((name) => /^release-notes-v.*\.md$/i.test(name)),
    "tsconfig.json", "vite.config.ts", "src", "docs"
  ];
  function visit(directory) {
    const relativeDirectory = path.relative(root, directory).replaceAll("\\", "/");
    if (relativeDirectory === "src/contracts/compiled") return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) files.push(path.relative(root, target).replaceAll("\\", "/"));
    }
  }
  for (const input of inputs) {
    const target = path.join(root, input);
    if (!fs.existsSync(target)) continue;
    const stat = fs.statSync(target);
    if (stat.isDirectory()) visit(target);
    else files.push(input);
  }
  files.sort();
  const digest = createHash("sha256");
  for (const relative of files) {
    digest.update(relative); digest.update("\0"); digest.update(fs.readFileSync(path.join(root, relative))); digest.update("\0");
  }
  return digest.digest("hex");
}

function localCommand(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    // Node on Windows cannot CreateProcess a .cmd file directly. npm itself
    // invokes this generator through a .cmd shim, so use cmd only for that
    // local package command; Git and node remain direct processes.
    shell: process.platform === "win32" && command.toLowerCase().endsWith(".cmd")
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
}

function gitValue(args, fallback) {
  const result = localCommand("git", args);
  return result.status === 0 ? result.stdout.trim() : fallback;
}

function requireDocument(document, token, label) {
  if (!document.includes(token)) throw new Error(`${label} must contain ${JSON.stringify(token)}.`);
}

function parseMassReport(log) {
  const rows = [];
  const pattern = /^PASS (mainnet|testnet-10) (successor|final): maxBatches=(\d+), outputs=(\d+), totalMass=(\d+), storageMass=(\d+), minimumFee=(\d+)$/gm;
  for (const match of log.matchAll(pattern)) {
    rows.push({ network: match[1], shape: match[2], maxBatches: Number(match[3]), outputs: Number(match[4]), totalMass: match[5], storageMass: match[6], minimumFeeSompi: match[7] });
  }
  if (rows.length !== 4) throw new Error("The verified log does not contain all four vNext mass measurements.");
  return rows;
}

const packageJson = JSON.parse(read("package.json"));
const protocolManifest = JSON.parse(read("protocol-manifest.json"));
const compatibility = JSON.parse(read("docs/release-compatibility.json"));
const evidenceMatrix = read("docs/audit-evidence-matrix.md");
const verificationLoop = read("docs/development-verification-loop.md");
const offlineIndexerBenchmark = read("docs/offline-indexer-benchmark.md");
const testnetValidationLog = read("docs/testnet-validation-log.md");
const verifyCommand = packageJson.scripts?.verify;
if (!verifyCommand) throw new Error("package.json must define npm run verify.");
if (verifyCommand.includes("verify-mainnet-node")) throw new Error("Local validation evidence must not run the live Mainnet node check.");
if (packageJson.scripts?.["validation:local"] !== "node scripts/generate-validation-evidence.mjs") throw new Error("package.json validation:local must invoke this generator.");
if (compatibility.candidate?.protocol !== protocolManifest.protocolVersion || compatibility.candidate?.status !== "pre-release-integration-candidate") throw new Error("release compatibility candidate must match the pre-release protocol manifest.");
for (const token of ["Testnet A–E", "Mainnet small-value", "Conditional local pass / release blocked"]) requireDocument(evidenceMatrix, token, "audit evidence matrix");
requireDocument(verificationLoop, "npm run validation:local", "development verification loop");
for (const token of ["9.30 s", "507.02 s", "83,603,456 bytes", "RAFFLE_INDEX_OFFLINE=1"]) requireDocument(offlineIndexerBenchmark, token, "offline indexer benchmark");
for (const token of ["d375d8a87a854e905ec1a75991b1d9881c9f85cb198677b23da340a895d5ff13", "da7db39806caf9c5e6394b87054cf8728fbe9ca6e374022ef985ce97a03920ba", "Historical compatibility evidence", "None of these older records passes A–E for the current", "`testnetPassed` remains `false`"]) requireDocument(testnetValidationLog, token, "Testnet validation log");

fs.mkdirSync(validationDir, { recursive: true });
const packageRunner = process.env.npm_execpath
  ? { command: process.execPath, prefix: [process.env.npm_execpath] }
  : { command: process.platform === "win32" ? "npm.cmd" : "npm", prefix: [] };
const sourceFingerprintBeforeVerify = workspaceSourceFingerprint();
const verified = localCommand(packageRunner.command, [...packageRunner.prefix, "run", "verify"]);
const verifyLog = `${verified.stdout}${verified.stderr}`;
write("npm-verify.log", verifyLog);
if (verified.error) throw verified.error;
if (verified.status !== 0) throw new Error(`npm run verify failed with status ${verified.status}; validation/npm-verify.log was retained.`);

const roundArtifact = JSON.parse(read("src/contracts/compiled/raffle-round-vnext.artifact.json"));
const refundArtifact = JSON.parse(read("src/contracts/compiled/raffle-refund-vnext.artifact.json"));
const roundHash = sha256(Buffer.from(roundArtifact.script, "hex"));
const refundHash = sha256(Buffer.from(refundArtifact.script, "hex"));
if (roundHash !== protocolManifest.roundArtifactSha256 || refundHash !== protocolManifest.refundArtifactSha256) throw new Error("Compiled artifact hashes changed after the verified run.");
const htmlPath = path.join(root, "dist", "index.html");
if (!fs.existsSync(htmlPath)) throw new Error("npm run verify did not leave dist/index.html for the evidence package.");
const firstBuildHtmlHash = sha256(fs.readFileSync(htmlPath));
const sourceFingerprintBeforeRebuild = workspaceSourceFingerprint();
const rebuild = localCommand(packageRunner.command, [...packageRunner.prefix, "run", "build"]);
const rebuildLog = `${rebuild.stdout}${rebuild.stderr}`;
write("rebuild.log", rebuildLog);
if (rebuild.error) throw rebuild.error;
if (rebuild.status !== 0) throw new Error(`second local build failed with status ${rebuild.status}; validation/rebuild.log was retained.`);
if (!fs.existsSync(htmlPath)) throw new Error("second local build did not leave dist/index.html.");
const htmlHash = sha256(fs.readFileSync(htmlPath));
const sourceFingerprintAfterRebuild = workspaceSourceFingerprint();
// `npm run verify` starts by recompiling artifacts before it builds. That
// expected preparation may change generated artifact files, so it is not part
// of the two-build comparison. The first HTML exists after verify; compare the
// source immediately before the second build to the source immediately after.
const sourceChangedDuringVerify = sourceFingerprintBeforeVerify !== sourceFingerprintBeforeRebuild;
const sourceStableAcrossBuilds = sourceFingerprintBeforeRebuild === sourceFingerprintAfterRebuild;
const sameWorkspaceDoubleBuildMatches = sourceStableAcrossBuilds ? htmlHash === firstBuildHtmlHash : null;
const buildReproducibilityStatus = !sourceStableAcrossBuilds
  ? "inconclusive-workspace-changed-during-generation"
  : sameWorkspaceDoubleBuildMatches
    ? "same-workspace-match"
    : "same-workspace-mismatch";
const massMeasurements = parseMassReport(verifyLog);
const contractLines = verifyLog.split(/\r?\n/).filter((line) => /PASS vNext (VM behavior|public closeEmpty construction)|PASS compiled vNext artifact/.test(line));
if (contractLines.length < 3) throw new Error("The verified log is missing expected vNext contract evidence lines.");

const gitHead = gitValue(["rev-parse", "HEAD"], "unavailable");
const workspaceDirty = gitValue(["status", "--porcelain"], "unknown") === "" ? false : true;
const reportManifest = {
  evidenceSchemaVersion: 1,
  evidenceKind: "local-automated-candidate",
  verificationCommand: "npm run verify",
  networkOperationsPerformed: false,
  localVerificationPassed: true,
  appVersion: protocolManifest.appVersion,
  protocolVersion: protocolManifest.protocolVersion,
  commit: gitHead,
  workspaceDirty,
  roundArtifactSha256: roundHash,
  refundArtifactSha256: refundHash,
  singleHtmlSha256: htmlHash,
  sameWorkspaceDoubleBuildSha256: [firstBuildHtmlHash, htmlHash],
  sameWorkspaceDoubleBuildMatches,
  sourceFingerprintBeforeVerify,
  sourceFingerprintBeforeRebuild,
  sourceFingerprintAfterRebuild,
  sourceChangedDuringVerify,
  sourceStableAcrossBuilds,
  buildReproducibilityStatus,
  cleanEnvironmentRebuildVerified: false,
  testnetPassed: false,
  testnetEvidenceStatus: "current-exact-hash-network-evidence-pending",
  testnetCreateEvidenceTxId: null,
  mainnetSmokePassed: false,
  criticalOpen: null,
  highOpen: null,
  criticalHighAssessment: "Not independently assessed; null is intentional and must not be read as zero open defects.",
  releaseStatus: "blocked",
  releaseBlockers: compatibility.candidate.releaseBlockedBy
};
write("manifest.json", json(reportManifest));
write("artifact-hashes.txt", [
  `protocolVersion=${protocolManifest.protocolVersion}`,
  `roundArtifactSha256=${roundHash}`,
  `refundArtifactSha256=${refundHash}`,
  `roundArtifactManifestMatch=${roundHash === protocolManifest.roundArtifactSha256}`,
  `refundArtifactManifestMatch=${refundHash === protocolManifest.refundArtifactSha256}`,
  ""
].join("\n"));
write("mass-report.json", json({
  evidenceKind: "local-transaction-shape-measurement",
  networkOperationsPerformed: false,
  protocolVersion: protocolManifest.protocolVersion,
  configuredPurchaseBatchLimit: protocolManifest.maxRelaySafePurchaseBatches,
  abiProofBatchLimit: protocolManifest.maxRefundBatchesPerTransaction,
  refundTransitionFeeCapSompi: protocolManifest.refundTransitionFeeCapSompi,
  refundFeeCapSompi: protocolManifest.refundFeeCapSompi,
  measurements: massMeasurements,
  conclusion: "The configured purchase-batch limit is distinct from the measured standard refund-transaction prefix. Measurements are local SDK transaction-shape checks; they do not prove node admission or a live network refund."
}));
write("indexer-benchmark.json", json({
  evidenceKind: "recorded-offline-indexer-benchmark",
  command: "npm run benchmark:indexer:1m",
  recordedDate: "2026-07-19",
  networkOperationsPerformed: false,
  fixture: "1,000,000 generated one-ticket range records; local disk state and loopback HTTP; retained v15 batch encoding",
  generatedRecords: 1000000,
  generationSeconds: 9.30,
  coldDiskIndexRebuildSeconds: 507.02,
  warmCheckpointRestartSeconds: 0.27,
  proofLatencyMilliseconds: { first: 11.71, middle: 2.70, last: 3.25 },
  ownerLookupMilliseconds: 21.49,
  warmIndexerRssBytes: 83603456,
  limitations: "Recorded local performance evidence only. It does not demonstrate a live node, Testnet/Mainnet, wallet, browser flow, or vNext network settlement."
}));
write("indexer-benchmark-report.md", offlineIndexerBenchmark);
write("contract-test.log", [
  "command: npm run verify",
  "scope: extracted successful vNext contract/artifact checks from npm-verify.log",
  ...contractLines,
  "",
  "Limitation: closeEmpty evidence is transaction construction and fee-shape verification; the VM debugger cannot supply its typed signature fixture.",
  "Limitation: a passing local VM/log result is not Testnet/Mainnet covenant deployment evidence.",
  ""
].join("\n"));
write("release-sha256.txt", [
  `SHA256 (dist/index.html from npm run verify) = ${firstBuildHtmlHash}`,
  `SHA256 (same-workspace rebuild dist/index.html) = ${htmlHash}`,
  `Source fingerprint before verify preparation = ${sourceFingerprintBeforeVerify}`,
  `Source fingerprint before rebuild = ${sourceFingerprintBeforeRebuild}`,
  `Source fingerprint after rebuild = ${sourceFingerprintAfterRebuild}`,
  `Same-workspace comparison status = ${buildReproducibilityStatus}`,
  sourceStableAcrossBuilds
    ? sameWorkspaceDoubleBuildMatches
      ? "Scope: stable-workspace hashes match."
      : "Scope: stable-workspace hashes differ; reproducibility is not established."
    : "Scope: workspace changed between the two compared builds; hashes are not comparable.",
  "A clean-environment build comparison remains required before a release reproducibility claim.",
  ""
].join("\n"));
write("property-test-report.json", json({
  evidenceKind: "local-deterministic-refund-conservation-property-test",
  networkOperationsPerformed: false,
  command: "npm run verify:phase1 (within npm run verify)",
  cases: 10000,
  assertion: "Every generated shape preserves buyer principals and successor conservation; insufficient carrier is rejected.",
  logEvidence: "PASS 10,000 deterministic buyer-funded refund cases conserve value, restore transition debt, and preserve carrier",
  limitations: "This is deterministic local arithmetic/property coverage, not live signed-transaction or network settlement evidence."
}));
write("browser-e2e-report/README.md", "# Browser E2E status\n\nNot run by `npm run validation:local`. The external Testnet log records Chrome local-development-wallet Create/Buy/Draw/Refund paths for historical artifact hashes only. The current b1000 artifact still needs fresh network evidence. Release E2E also requires KasWare, Kastle, Edge, a 390×844 mobile viewport, reload/recovery across a second profile or device, and static HTTPS.\n");
write("testnet-rounds.md", testnetValidationLog);
write("mainnet-smoke.md", "# Mainnet smoke — not executed\n\n`mainnetSmokePassed` is deliberately `false`. No Mainnet node, wallet, signing or broadcast is used by this generator.\n\nRequired before release: isolated small-value sold-out and refund rounds, manual output review, independent HTML/artifact hash checks and transaction records.\n");
write("known-limitations.md", [
  "# Known limitations and release blockers", "",
  "- The current b1000 Round artifact has no accepted exact-hash Testnet transaction yet. All Testnet A–E scenarios and Mainnet smoke remain incomplete; earlier Chrome transactions are historical compatibility evidence only.",
  "- A mid-refund interruption followed by continuation from a second browser/user must be repeated as a fresh current-hash live sequence; deterministic integration coverage does not replace that external evidence.",
  "- KasWare/Kastle, desktop/mobile browser E2E and static HTTPS hosting checks are not complete.",
  "- The recorded million-batch Indexer benchmark is offline/local and uses the retained v15 fixture encoding; it is not live-network or vNext settlement evidence.",
  "- Build reproducibility is recorded in `release-sha256.txt`; a clean-environment reproducibility run remains pending, and a mismatch/inconclusive result is a release blocker.",
  "- No independent security audit has been completed; Critical/High issue counts are intentionally unassessed, not zero.",
  "- The round purchase-batch hard limit is 1000 and the default is 100. The UI recommendation is `max(1, min(1000, floor(salesSeconds / 6)))`; it is not a concurrency guarantee. Refund ABI can verify 13 proofs, while current local mass measurement chooses a 2-batch standard-relay prefix per refund transaction.",
  "- The current artifact rejects sponsor inputs; refund fees are deducted from selected ticket payments and the 1 KAS minimum is mass-gated for liveness.",
  "- Target-block miners retain the documented economic withholding ability inherent in block-hash randomness.",
  "- A successful finalize VM fixture remains unavailable because the local debugger lacks a selected-chain commitment fixture. Public closeEmpty has positive and negative VM coverage.", ""
].join("\n"));
write("human-acceptance-report.md", [
  "# Human acceptance report — local candidate", "",
  `Protocol: ${protocolManifest.protocolVersion}`,
  `App version: ${protocolManifest.appVersion}`, "",
  "## Overall conclusion", "",
  "CONDITIONAL LOCAL PASS / RELEASE BLOCKED. The automated local suite passed for this evidence run, but this is not a statement that the system is complete or safe for public funds.", "",
  "## P0/P1 local evidence", "",
  "- Artifact hashes, version/document consistency, vNext state/negative VM cases, buyer-funded exact refund-fee allocation and carrier checks, transaction-shape mass, immutable signing-preview and rejection-recovery checks, Indexer proof/reorg simulation and single-file build were executed through `npm run verify`.",
  "- 10,000 deterministic refund-conservation property cases passed. The two-build SHA-256 result is recorded verbatim in `release-sha256.txt` and must not be treated as a pass unless its status says `same-workspace-match`.",
  "- The recorded offline one-million-range Indexer benchmark is included in `indexer-benchmark.json`; it is not a Testnet/Mainnet or vNext network-flow result.",
  "- Historical Testnet vNext transactions are recorded for compatibility only. The current b1000 artifact has no accepted exact-hash Testnet transaction; A–E remain incomplete and `testnetPassed` remains false.",
  "- A successful finalize VM fixture is explicitly unavailable in the local debugger; public closeEmpty is covered. Inspect `known-limitations.md` and `npm-verify.log`.", "",
  "## Release blockers", "",
  "- Testnet 10 A–E, including full draw/refund/recovery/stale/service-failure records.",
  "- Mainnet small-value draw and refund smoke with isolated wallets.",
  "- KasWare/Kastle and desktop/mobile E2E plus static HTTPS-host verification.",
  "- Independent security audit and an assessed Critical/High defect register.",
  "- A same-workspace mismatch/inconclusive result, if recorded in `release-sha256.txt`, plus a clean-environment build hash comparison for release reproducibility.", "",
  "Do not change `testnetPassed`, `mainnetSmokePassed`, `criticalOpen`, or `highOpen` from this local generator without the corresponding external evidence.", ""
].join("\n"));
write("README.md", "# Local validation evidence package\n\nGenerated by `npm run validation:local`. The command runs `npm run verify` without the live Mainnet-node command, then writes this package. It intentionally leaves Testnet/Mainnet result flags false and Critical/High issue counts unassessed.\n\nThis directory is a local candidate evidence package, not the release evidence required by the validation specification. Preserve real-network records and audit outputs before changing its release status.\n");

const evidenceCheck = localCommand(process.execPath, ["scripts/verify-local-validation-evidence.mjs"]);
process.stdout.write(evidenceCheck.stdout);
process.stderr.write(evidenceCheck.stderr);
if (evidenceCheck.error) throw evidenceCheck.error;
if (evidenceCheck.status !== 0) throw new Error("Generated validation evidence package failed its consistency check.");

console.log(`PASS local validation evidence package written to ${path.relative(root, validationDir)} (network release remains blocked).`);
