// Internal acceptance of a DEPLOYED copy (e.g. the internal test site) before the same bytes are pushed to main,
// which Cloudflare Pages then publishes. READ ONLY: public GET/wRPC reads, no wallet provider, no signing, no submit.
// Protects against publishing a page that passes offline tests but is not what was tested, or breaks against the
// real TN10 node/indexer (CSP, connectivity, rendering). Lowest sufficient layer: real Chromium on the served URL.
// Usage: node tools/check-deployed.mjs https://host/path.html   ->  apps/kaswin-v2/test-results/deployed/<sha256>.json
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const repo = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const url = process.argv[2];
if (process.argv.length !== 3 || !/^https:\/\/[^/]+\/\S*$/.test(url)) throw Error('Usage: node tools/check-deployed.mjs https://host/path.html');
const {chromium} = createRequire(path.join(repo, 'apps/kaswin-v2/package.json'))('playwright');
const sha = b => createHash('sha256').update(b).digest('hex');
const git = (...a) => execFileSync('git', a, {cwd: repo, encoding: 'utf8'}).trim();

const checks = [], fail = (name, detail) => checks.push({name, ok: false, detail}), pass = (name, detail) => checks.push({name, ok: true, detail});
const manifest = JSON.parse(await fs.readFile(path.join(repo, 'releases/kaswin-v2/build-manifest.json'), 'utf8'));
const release = await fs.readFile(path.join(repo, 'releases/kaswin-v2/index.html'));

// 1. The served bytes are exactly the release this checkout would push.
const res = await fetch(url, {cache: 'no-store', headers: {'Cache-Control': 'no-cache'}});
const served = Buffer.from(await res.arrayBuffer()), servedSha256 = sha(served);
if (res.status !== 200) fail('served', `HTTP ${res.status}`);
else if (servedSha256 !== sha(release)) fail('served', `served ${servedSha256} != releases/kaswin-v2/index.html ${sha(release)}`);
else if (servedSha256 !== manifest.sha256) fail('served', `release ${servedSha256} != manifest ${manifest.sha256}`);
else pass('served', `${served.length} bytes, sha256 matches release and manifest`);

// 2. The same staging verification Cloudflare Pages runs (manifest, build inputs, CSP); a failure here = failed Pages build.
try { pass('stage-release', execFileSync(process.execPath, ['tools/stage-release.mjs'], {cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim()); }
catch (e) { fail('stage-release', String(e.stderr || e.message).trim().slice(0, 300)); }

// 3. Real browser on the deployed URL, against the real public TN10 node and indexer.
const browser = await chromium.launch();
try {
  for (const width of [1360, 390]) {
    const ctx = await browser.newContext({locale: 'zh-CN', viewport: {width, height: 900}}), page = await ctx.newPage();
    const errors = [], csp = [], submits = [];
    page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)));
    page.on('console', m => { if (/Content Security Policy|Refused to/.test(m.text())) csp.push(m.text().slice(0, 200)); });
    page.on('websocket', ws => ws.on('framesent', ({payload}) => { if (String(payload).includes('submitTransaction')) submits.push(ws.url()); }));
    const tag = `browser-${width}`;
    try {
      await page.goto(url, {waitUntil: 'domcontentloaded'});
      await page.waitForSelector('.hero', {timeout: 30000});
      await page.waitForFunction(() => document.querySelectorAll('.card[data-cid]').length > 0, null, {timeout: 60000});
      const cards = await page.locator('.card[data-cid]').count();
      // The node chip is hidden by design at <=1150px (styles.css); check node connectivity on desktop only.
      let node = 'not shown at this width';
      if (width > 1150) {
        await page.click('#nodeChip');
        await page.waitForFunction(() => document.querySelector('#nodeChip .dot')?.classList.contains('ok'), null, {timeout: 60000});
        node = await page.locator('#nodeChip').getAttribute('title');
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      const cid = await page.locator('.card[data-cid]').first().getAttribute('data-cid');
      await page.goto(url + '#/round/' + cid); await page.waitForTimeout(4000);
      const detail = (await page.evaluate(() => document.body.innerText)).length;
      const problems = [...errors.map(e => 'pageerror: ' + e), ...csp.map(e => 'csp: ' + e), ...submits.map(u => 'SUBMIT ' + u)];
      if (overflow) problems.push('horizontal overflow');
      if (detail < 200) problems.push('round detail rendered almost nothing');
      if (problems.length) fail(tag, problems.join(' | '));
      else pass(tag, `${cards} rounds, node: ${String(node).replace(/\s+/g, ' ').slice(0, 90)}, round detail ${cid.slice(0, 8)} rendered`);
    } catch (e) { fail(tag, [String(e.message).split('\n')[0].slice(0, 200), ...errors].join(' | ')); }
    await ctx.close();
  }
} finally { await browser.close(); }

const record = {at: new Date().toISOString(), url, servedSha256, manifestSha256: manifest.sha256, releaseMode: manifest.releaseMode,
  profileId: manifest.profileId, gitHead: git('rev-parse', 'HEAD'), workingTreeDirty: git('status', '--porcelain').length > 0,
  scope: 'DEPLOYED_COPY_REAL_TN10_READONLY_NO_WALLET_SIGN_OR_SUBMIT', passed: checks.every(c => c.ok), checks};
const dir = path.join(repo, 'apps/kaswin-v2/test-results/deployed');
await fs.mkdir(dir, {recursive: true});
await fs.writeFile(path.join(dir, servedSha256 + '.json'), JSON.stringify(record, null, 2) + '\n');
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}: ${c.detail}`);
console.log(record.passed ? `INTERNAL CHECK PASSED for ${servedSha256}` : 'INTERNAL CHECK FAILED');
process.exit(record.passed ? 0 : 1);
