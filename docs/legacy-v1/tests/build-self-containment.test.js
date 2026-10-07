import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
// Necessary: the actual deliverable must be self-contained, honest about unavailable funds,
// deterministic, and preserve previous outputs. Run retention probes in an isolated retained dir.
test('single HTML delivery, deterministic build and non-destructive retention', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'kaswin-build-check-'));
  for (const name of ['src', 'tools']) fs.cpSync(path.join(root, name), path.join(sandbox, name), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(sandbox, 'package.json'));
  const run = () => execFileSync(process.execPath, ['tools/build.js'], { cwd: sandbox });
  const target = path.join(sandbox, 'dist/index.html');
  run();
  const html = fs.readFileSync(target, 'utf8');
  assert.ok(html.includes('离线设计工作台 · 未部署 · 不可投注'));
  assert.ok(html.includes('不可投注 · 协议未部署 · 链上逻辑尚未冻结'));
  assert.doesNotMatch(html, /<script\b[^>]*\bsrc\s*=|<link\b[^>]*\brel=["']stylesheet|https?:\/\/|\bfetch\s*\(|XMLHttpRequest|signTransaction|generatePrivateKey/i);
  run();
  assert.equal(fs.readFileSync(target, 'utf8'), html);
  const prior = html + '\n<!-- isolated retention probe -->';
  fs.writeFileSync(target, prior);
  run();
  const hash = crypto.createHash('sha256').update(prior).digest('hex').slice(0, 16);
  assert.equal(fs.readFileSync(path.join(sandbox, 'dist/retained', `index-${hash}.html`), 'utf8'), prior);
  assert.equal(fs.readFileSync(target, 'utf8'), html);
  // Preserve test intermediate files per user request; never alter real dist for this probe.
});
