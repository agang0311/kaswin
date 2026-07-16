import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const outputPath = path.resolve(root, process.argv[2] ?? "release-notes.md");
const compatibility = JSON.parse(fs.readFileSync(path.join(root, "docs", "release-compatibility.json"), "utf8"));
const releaseUrl = (release) => `https://github.com/agang0311/kaswin/releases/tag/${release}`;

const supported = compatibility.supported.map((entry) => (
  `- \`${entry.protocol}\` using \`${entry.roundContract}\` and \`${entry.refundContract}\``
));
const archived = compatibility.archived.map((entry) => (
  `- \`${entry.protocol}\`: download [Kaswin ${entry.release}](${releaseUrl(entry.release)})`
));

const notes = [
  "## Covenant compatibility",
  "",
  "### This release can operate",
  ...supported,
  "",
  "### Archived protocols",
  "For a round outside the list above, download the matching standalone web page from the linked GitHub Release.",
  ...archived,
  ""
].join("\n");

fs.writeFileSync(outputPath, notes, "utf8");
