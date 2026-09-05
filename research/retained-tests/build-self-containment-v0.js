import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const distHtmlPath = path.join(rootDir, "dist", "index.html");
const retainedDir = path.join(rootDir, "dist", "retained");

function sha256(str) {
  return crypto.createHash("sha256").update(str, "utf8").digest("hex");
}

test("Build Self-Containment and Security Constraints", async (t) => {
  await t.test("dist/index.html exists and is non-empty", () => {
    assert.equal(fs.existsSync(distHtmlPath), true, "dist/index.html must exist");
    const stat = fs.statSync(distHtmlPath);
    assert.ok(stat.size > 10000, `dist/index.html size (${stat.size}) should be substantial`);
  });

  const content = fs.readFileSync(distHtmlPath, "utf8");

  await t.test("contains zero external stylesheets or external scripts", () => {
    // No external script tags
    const scriptSrcMatches = content.match(/<script\s+[^>]*src=/gi);
    assert.equal(scriptSrcMatches, null, "Should not contain any <script src=...>");

    // No external stylesheet link tags
    const linkCssMatches = content.match(/<link\s+[^>]*rel=["']stylesheet["']/gi);
    assert.equal(linkCssMatches, null, "Should not contain any <link rel='stylesheet'>");
  });

  await t.test("contains zero external network URLs (http:// or https://)", () => {
    // Check for http/https URLs that could fetch resources
    // (excluding xmlns if any, but our html has no xmlns)
    const urlMatches = content.match(/https?:\/\/[^\s"'<>]+/gi);
    assert.equal(urlMatches, null, `Found external URLs in dist/index.html: ${JSON.stringify(urlMatches)}`);
  });

  await t.test("contains no wallet APIs, fetch or private key generation/signing", () => {
    assert.equal(/window\.ethereum/i.test(content), false, "Must not reference window.ethereum");
    assert.equal(/kasware/i.test(content), false, "Must not reference kasware wallet");
    assert.equal(/fetch\s*\(/i.test(content), false, "Must not use fetch()");
    assert.equal(/XMLHttpRequest/i.test(content), false, "Must not use XMLHttpRequest");
    assert.equal(/signTransaction|signMessage|generatePrivateKey|bip39|secp256k1/i.test(content), false, "Must not include signing or key derivation");
  });

  await t.test("contains explicit persistent banner: 离线设计工作台 · 未部署 · 不可投注", () => {
    assert.ok(
      content.includes("离线设计工作台 · 未部署 · 不可投注"),
      "dist/index.html must display the required persistent banner text"
    );
  });

  await t.test("contains disabled money action buttons clearly marked unavailable", () => {
    assert.ok(
      content.includes("不可投注 · 协议未部署 · 链上逻辑尚未冻结"),
      "dist/index.html must explicitly state action is unavailable due to undeployed contract"
    );
    assert.ok(
      content.includes("disabled"),
      "Money action buttons must have the disabled attribute"
    );
  });

  await t.test("explains the three core blocking points from docs", () => {
    assert.ok(content.includes("时间与购买竞争"), "Must document Time vs Buy contention");
    assert.ok(
      content.includes("公平随机与证据窗口") || content.includes("OpChainblockSeqCommit"),
      "Must document Randomness Beacon and SeqCommit window"
    );
    assert.ok(content.includes("满额后的活性保障"), "Must document Post-Sealed Liveness");
  });
});

test("Build retention preserving prior differing dist artifact without deletion", async (t) => {
  // Ensure dist exists
  execFileSync("node", ["tools/build.js"], { cwd: rootDir });

  // Read current dist/index.html
  const originalDist = fs.readFileSync(distHtmlPath, "utf8");
  const originalHash = sha256(originalDist).slice(0, 16);

  // Write a synthetic differing temporary version to dist/index.html
  const dummyDifferingContent = originalDist + "\n<!-- test differing build -->";
  const dummyHash = sha256(dummyDifferingContent).slice(0, 16);
  fs.writeFileSync(distHtmlPath, dummyDifferingContent, "utf8");

  // Run build again
  execFileSync("node", ["tools/build.js"], { cwd: rootDir });

  // Verify that dist/retained/index-<dummyHash>.html was created
  const expectedRetainedPath = path.join(retainedDir, `index-${dummyHash}.html`);
  assert.ok(
    fs.existsSync(expectedRetainedPath),
    `Prior build must be preserved in ${expectedRetainedPath}`
  );
  assert.equal(
    fs.readFileSync(expectedRetainedPath, "utf8"),
    dummyDifferingContent,
    "Preserved artifact must match prior differing content exactly"
  );

  // Verify that dist/index.html is restored to canonical build
  const currentDist = fs.readFileSync(distHtmlPath, "utf8");
  assert.equal(currentDist, originalDist, "dist/index.html must be restored to canonical output");
});
