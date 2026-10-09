// Cloudflare Pages entry: publish the COMMITTED single-file release, never rebuild it in CI.
// The TN10 candidate build needs local raw receipts (git-ignored) and the default build needs reviewed VM budgets,
// so CI only verifies the committed artifact against its committed build manifest and stages it into dist/.
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
const csp = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html.toString('utf8'))?.[1] ?? '';
if (!/script-src 'sha256-[A-Za-z0-9+/=]+'/.test(csp) || /unsafe-inline[^;]*;/.test(csp.split('script-src')[1]?.split(';')[0] ?? '')) fail('CSP must pin the application script by hash');

fs.mkdirSync(path.join(repo, 'dist'), {recursive: true});
fs.writeFileSync(path.join(repo, 'dist/index.html'), html);
console.log(`Staged releases/kaswin-v2/index.html -> dist/index.html (${html.length} bytes, sha256 ${sha}, ${manifest.releaseMode}, profile ${manifest.profileId.slice(0, 16)})`);
