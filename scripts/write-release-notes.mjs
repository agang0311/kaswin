import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const outputPath = path.resolve(root, process.argv[2] ?? "release-notes.md");
const compatibility = JSON.parse(fs.readFileSync(path.join(root, "docs", "release-compatibility.json"), "utf8"));
const releaseUrl = (release) => `https://github.com/agang0311/kaswin/releases/tag/${release}`;

const candidate = compatibility.candidate;
const legacy = compatibility.legacy.map((entry) => entry.release
  ? `- \`${entry.protocol}\`: download [Kaswin ${entry.release}](${releaseUrl(entry.release)})`
  : `- \`${entry.protocol}\`: ${entry.status ?? "unsupported"}; no compatible published Release.`
);

const notes = [
  "# Kaswin v0.9.13",
  "",
  "## Highlights",
  "",
  "- Buyer-funded refund network fees with a 1 KAS minimum ticket-price liveness floor.",
  "- Public sold-out draw, below-minimum refund, empty-round close, and state-preserving carrier top-up paths.",
  "- Purchase-batch hard limit raised to 1,000 with a sales-duration recommendation and one-million-ticket range support.",
  "- Direct Create, Registry, and Buy wallet transactions with explicit signing previews and action-local feedback.",
  "- Recoverable Registry publication/marker return, including exact-parent confirmation and stale Create-input exclusion.",
  "- Chinese and English README files, kaspa.stream links, validation evidence, and compatibility guidance.",
  "",
  "## Network evidence and release status",
  "",
  "The exact current artifact completed a Mainnet Create → Registry → Buy → sold-out Draw loop on 2026-07-20. See [the transaction log](https://github.com/agang0311/kaswin/blob/v0.9.13/docs/mainnet-validation-log.md). The below-minimum Mainnet refund loop and the other blockers listed below are still pending, so this GitHub Release is intentionally marked as a **pre-release integration candidate**, not an audited production release.",
  "",
  "## Applicable covenant version",
  "",
  `This Release can create and spend only \`${candidate.protocol}\` using \`${candidate.roundContract}\` and \`${candidate.refundContract}\`.`,
  `- Round artifact SHA-256: \`${candidate.roundArtifactSha256}\``,
  `- Refund artifact SHA-256: \`${candidate.refundArtifactSha256}\``,
  `- Release classification: **${candidate.status}**.`,
  `- Release blockers: ${candidate.releaseBlockedBy.join("; ")}.`,
  "- Historical or quarantined covenant versions are never spent with the current artifact.",
  "",
  "### Historical protocols",
  "For a historical round, use only the explicitly matching standalone page. Historical releases do not authorize the current vNext artifact.",
  ...legacy,
  ""
].join("\n");

fs.writeFileSync(outputPath, notes, "utf8");
