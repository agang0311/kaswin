import fs from "node:fs";
import path from "node:path";

const distDir = path.resolve("dist");
const indexPath = path.join(distDir, "index.html");

if (!fs.existsSync(indexPath)) {
  throw new Error("dist/index.html was not produced by Vite.");
}

let html = fs.readFileSync(indexPath, "utf8");

html = html.replace(/<link\s+rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, (_match, href) => {
  const cssPath = path.join(distDir, href.replace(/^\.?\//, ""));
  return `<style>${fs.readFileSync(cssPath, "utf8")}</style>`;
});

html = html.replace(/<script\s+type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g, (_match, src) => {
  const scriptPath = path.join(distDir, src.replace(/^\.?\//, ""));
  const script = fs.readFileSync(scriptPath, "utf8").replace(/<\/script/gi, "<\\/script");
  return `<script type="module">${script}</script>`;
});

fs.writeFileSync(indexPath, html);
fs.rmSync(path.join(distDir, "assets"), { recursive: true, force: true });

const remainingFiles = fs.readdirSync(distDir);

if (remainingFiles.length !== 1 || remainingFiles[0] !== "index.html") {
  throw new Error(`Single-file SPA build left unexpected files: ${remainingFiles.join(", ")}`);
}

console.log(`Single-file SPA: ${indexPath} (${fs.statSync(indexPath).size} bytes)`);
