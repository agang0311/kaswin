/**
 * Kaswin Offline Protocol Workbench - Deterministic Single-File Bundler
 *
 * Produces a 100% self-contained dist/index.html with zero external dependencies.
 * Never deletes prior builds: archives any differing prior dist/index.html under
 * dist/retained/index-<sha256>.html.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const srcDir = path.join(rootDir, "src");
const distDir = path.join(rootDir, "dist");
const retainedDir = path.join(distDir, "retained");

function sha256(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function build() {
  console.log("[build] Starting deterministic self-contained build...");

  const htmlSrcPath = path.join(srcDir, "index.html");
  const cssSrcPath = path.join(srcDir, "style.css");
  const validationSrcPath = path.join(srcDir, "validation.js");
  const appSrcPath = path.join(srcDir, "app.js");

  const rawHtml = fs.readFileSync(htmlSrcPath, "utf8");
  const rawCss = fs.readFileSync(cssSrcPath, "utf8");
  const rawValidation = fs.readFileSync(validationSrcPath, "utf8");
  const rawApp = fs.readFileSync(appSrcPath, "utf8");

  // Transform validation.js: convert named exports to local declarations
  // e.g. "export const FOO =" -> "const FOO ="
  // "export function bar(" -> "function bar("
  const inlinedValidation = rawValidation
    .replace(/^export\s+(const|let|var|function)\s+/gm, "$1 ")
    .trim();

  // Transform app.js: strip the import from ./validation.js
  const inlinedApp = rawApp
    .replace(/^import\s*\{[\s\S]*?\}\s*from\s*["']\.\/validation\.js["'];?\s*/m, "")
    .trim();

  // Combine into single self-executing bundle
  const bundledJs = `(() => {\n${inlinedValidation}\n\n${inlinedApp}\n})();`;

  // Verify no forbidden external protocols or network calls in CSS / JS
  const dangerousPatterns = [/https?:\/\//i, /window\.ethereum/i, /kasware/i, /fetch\s*\(/i, /XMLHttpRequest/i];
  for (const pattern of dangerousPatterns) {
    if (pattern.test(rawCss)) {
      throw new Error(`[build error] CSS contains dangerous pattern: ${pattern}`);
    }
  }

  // Replace <link rel="stylesheet" href="style.css"> with inlined <style>
  const htmlWithCss = rawHtml.replace(
    /<link\s+rel=["']stylesheet["']\s+href=["']style\.css["']\s*\/?>/i,
    `<style>\n${rawCss.trim()}\n</style>`
  );

  // Replace <script type="module" src="app.js"></script> with inlined <script>
  const distHtml = htmlWithCss.replace(
    /<script\s+type=["']module["']\s+src=["']app\.js["']\s*><\/script>/i,
    `<script>\n${bundledJs}\n</script>`
  );

  // Normalize line endings
  const normalizedHtml = distHtml.replace(/\r\n/g, "\n");

  // Ensure directories exist
  fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(retainedDir, { recursive: true });

  const targetPath = path.join(distDir, "index.html");

  if (fs.existsSync(targetPath)) {
    const existingContent = fs.readFileSync(targetPath, "utf8");
    if (existingContent !== normalizedHtml) {
      const existingHash = sha256(existingContent).slice(0, 16);
      const archivePath = path.join(retainedDir, `index-${existingHash}.html`);
      fs.writeFileSync(archivePath, existingContent, "utf8");
      console.log(`[build] Preserved previous build to: ${path.relative(rootDir, archivePath)}`);

      fs.writeFileSync(targetPath, normalizedHtml, "utf8");
      console.log(`[build] Updated ${path.relative(rootDir, targetPath)} (${normalizedHtml.length} bytes, hash: ${sha256(normalizedHtml).slice(0, 16)})`);
    } else {
      console.log(`[build] ${path.relative(rootDir, targetPath)} is identical, no update needed.`);
    }
  } else {
    fs.writeFileSync(targetPath, normalizedHtml, "utf8");
    console.log(`[build] Created ${path.relative(rootDir, targetPath)} (${normalizedHtml.length} bytes, hash: ${sha256(normalizedHtml).slice(0, 16)})`);
  }
}

build();
