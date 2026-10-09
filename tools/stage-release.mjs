// Cloudflare Pages entry: publish the COMMITTED single-file release, never rebuild it in CI.
// The TN10 candidate build needs local raw receipts (git-ignored) and the default build needs reviewed VM budgets,
// CI verifies both the artifact and every recorded build input against the manifest before staging dist/.
// It does not bypass any gate: whatever releases/kaswin-v2 holds was produced (and gated) by tools/build.mjs locally.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const repo = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const rel = path.join(repo, 'releases/kaswin-v2');
const html = fs.readFileSync(path.join(rel, 'index.html'));
const manifest = JSON.parse(fs.readFileSync(path.join(rel, 'build-manifest.json'), 'utf8'));
const sha = createHash('sha256').update(html).digest('hex');
const fail = m => { console.error('STAGE_BLOCKED: ' + m); process.exit(1); };

if (manifest.artifact !== 'index.html') fail('manifest artifact');
if (sha !== manifest.sha256 || html.length !== manifest.bytes) fail(`artifact ${sha} does not match manifest ${manifest.sha256}`);
if (!['TN10_ACCEPTANCE_CANDIDATE', 'REVIEWED_BUDGET_BUILD', 'READ_ONLY_UNVERIFIED_CANDIDATE'].includes(manifest.releaseMode)) fail('unknown releaseMode ' + manifest.releaseMode);
if (manifest.publicLaunchApproved !== false) fail('publicLaunchApproved must stay false until a separate launch review');
// A matching HTML/manifest pair is insufficient if the source changed after the build.
const inputs = manifest.inputSha256;
if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs) || !Object.keys(inputs).length) fail('missing inputSha256');
for (const required of ['apps/kaswin-v2/scripts/app.mjs', 'apps/kaswin-v2/tools/build.mjs',
  'apps/kaswin-v2/visual/styles.css', 'apps/kaswin-v2/visual/index.template.html',
  'contracts/f3.2/pins.json', 'contracts/f3.2/profile.json']) {
  if (!Object.hasOwn(inputs, required)) fail('missing required build input: ' + required);
}
for (const [file, expected] of Object.entries(inputs)) {
  if (path.isAbsolute(file) || file.includes('\\') || file.split('/').some(p => !p || p === '.' || p === '..') ||
      typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)) fail('invalid build input: ' + file);
  try {
    const resolved = fs.realpathSync(path.join(repo, file));
    const relative = path.relative(repo, resolved);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) fail('build input escapes repository: ' + file);
    const actual = createHash('sha256').update(fs.readFileSync(resolved)).digest('hex');
    if (actual !== expected) fail('build input drift: ' + file + '; rebuild and review the release');
  } catch (err) { fail('cannot verify build input: ' + file + ' (' + err.code + ')'); }
}
const source = html.toString('utf8');
const csp = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(source)?.[1] ?? '';
const scripts = [...source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
if (scripts.length !== 1 || scripts[0][1].trim()) fail('expected one inline application script');
const scriptHash = createHash('sha256').update(scripts[0][2]).digest('base64');
const directives = csp.split(';').map(d => d.trim()).filter(d => /^script-src(?:\s|$)/.test(d));
if (directives.length !== 1 || directives[0] !== `script-src 'sha256-${scriptHash}'`) fail('CSP must match the application script hash');

fs.mkdirSync(path.join(repo, 'dist'), {recursive: true});
fs.writeFileSync(path.join(repo, 'dist/index.html'), html);
console.log(`Staged releases/kaswin-v2/index.html -> dist/index.html (${html.length} bytes, sha256 ${sha}, ${manifest.releaseMode}, profile ${manifest.profileId.slice(0, 16)})`);
