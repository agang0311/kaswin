// Lowest sufficient layer: actual staging CLI on disposable files, no SDK/network/receipts.
// Protects against publishing stale sources or a broken CSP; failures must leave dist untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const sha = b => createHash('sha256').update(b).digest('hex');
test('staging checks source drift, missing inputs, unsafe paths and exact CSP before writing', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kaswin-stage-test-'));
  try {
    const manifestPath = 'releases/kaswin-v2/build-manifest.json';
    const manifest = JSON.parse(await fs.readFile(path.join(repo, manifestPath)));
    const files = new Set(['tools/stage-release.mjs', manifestPath, 'releases/kaswin-v2/index.html', ...Object.keys(manifest.inputSha256)]);
    for (const file of files) {
      await fs.mkdir(path.dirname(path.join(tmp, file)), {recursive: true});
      await fs.copyFile(path.join(repo, file), path.join(tmp, file));
    }
    const run = () => spawnSync(process.execPath, [path.join(tmp, 'tools/stage-release.mjs')], {encoding: 'utf8'});
    const control = run(); assert.equal(control.status, 0, control.stderr);
    const output = path.join(tmp, 'dist/index.html');
    const sentinel = 'do not overwrite on failure';
    await fs.writeFile(output, sentinel);
    const blocked = async pattern => {
      const r = run(); assert.notEqual(r.status, 0); assert.match(r.stderr, pattern);
      assert.equal(await fs.readFile(output, 'utf8'), sentinel);
    };
    const app = path.join(tmp, 'apps/kaswin-v2/scripts/app.mjs'), original = await fs.readFile(app);
    await fs.appendFile(app, '\n// source drift\n'); await blocked(/build input drift/);
    await fs.unlink(app); await blocked(/cannot verify build input/);
    await fs.writeFile(app, original);
    const save = m => fs.writeFile(path.join(tmp, manifestPath), JSON.stringify(m));
    await save({...manifest, inputSha256: {}}); await blocked(/missing inputSha256/);
    const withoutApp = structuredClone(manifest); delete withoutApp.inputSha256['apps/kaswin-v2/scripts/app.mjs'];
    await save(withoutApp); await blocked(/missing required build input/);
    await save({...manifest, inputSha256: {...manifest.inputSha256, '../outside': '00'.repeat(32)}});
    await blocked(/invalid build input/);
    const htmlPath = path.join(tmp, 'releases/kaswin-v2/index.html');
    const html = await fs.readFile(htmlPath, 'utf8');
    for (const bad of [html.replace(/script-src 'sha256-[^']+'/, "script-src 'sha256-AAAA'"), html.replace(/script-src ('sha256-[^']+')/, "script-src $1 'unsafe-inline'")]) {
      await fs.writeFile(htmlPath, bad); await save({...manifest, bytes: Buffer.byteLength(bad), sha256: sha(bad)});
      await blocked(/CSP must match/);
    }
  } finally { await fs.rm(tmp, {recursive: true, force: true}); }
});
