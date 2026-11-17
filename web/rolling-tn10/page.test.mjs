import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildRollingTn10,checkGraph} from '../../build/rolling-tn10.mjs';
import {TN10_PROFILE_ID} from './protocol.mjs';

const out=mkdtempSync(join(tmpdir(),'rolling-tn10-build-'));
process.on('exit',()=>rmSync(out,{recursive:true,force:true}));
const sha=b=>createHash('sha256').update(b).digest('hex');
const mainBefore=existsSync(new URL('../../dist/index.html',import.meta.url))?sha(readFileSync(new URL('../../dist/index.html',import.meta.url))):null;
const built=await buildRollingTn10({outDir:out}),{html,manifest}=built;
const script=html.slice(html.lastIndexOf('<script>')+8,html.lastIndexOf('</script>'));

test('build writes only the standalone files and leaves the main page untouched',()=>{
  assert.equal(manifest.artifact.file,'rolling-tn10.html');assert.equal(manifest.artifact.sha256,sha(html));
  assert.equal(readFileSync(join(out,'rolling-tn10.html'),'utf8'),html);assert.ok(!existsSync(join(out,'index.html')));
  const after=existsSync(new URL('../../dist/index.html',import.meta.url))?sha(readFileSync(new URL('../../dist/index.html',import.meta.url))):null;
  assert.equal(after,mainBefore);
});
test('page prominently states TN10-only, the fixed Profile and the UNVALIDATED evidence boundary; never claims full validation',()=>{
  assert.match(html,/Testnet 10 实验版/);assert.match(html,/UNVALIDATED/);assert.ok(html.includes(TN10_PROFILE_ID)&&manifest.profileId===TN10_PROFILE_ID);
  assert.equal(manifest.evidence,'UNVALIDATED');assert.match(html,/未完成全面验证/);assert.doesNotMatch(html,/已全部验证|fully validated|已通过全部验证/i);
  assert.equal(manifest.network,'testnet-10');assert.ok(!/id="netSwitch"|mainnet-trading/.test(html));
});
test('CSP hash matches the inline script, and GitHub navigation is the only external link in the shell',()=>{
  const m=/script-src 'sha256-([^']+)'/.exec(html);assert.ok(m);
  assert.equal(createHash('sha256').update(script).digest('base64'),m[1]);
  const shell=html.replace(script,'');
  assert.match(shell,/<a class="icon-btn" id="githubBtn" href="https:\/\/github\.com\/agang0311\/kaswin" target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(shell.replace(/<a\b[^>]*id="githubBtn"[^>]*>/,''),/(src|href)="https?:/);
  assert.match(html,/default-src 'none'/);
});
test('browser import graph is clean: no node:*, fs, test signer, fixtures, engine gate, CLI, service or old wallet adapters',()=>{
  assert.equal(manifest.graph.nodeImports,0);
  const files=Object.keys(manifest.inputs).filter(f=>/\.(mjs|js|ts)$/.test(f));
  for(const bad of ['test-signer','fixtures','engine-gate','tn10-run','tn10-service','service-client','deployment-profile','kasware','kastle','browser-test','fake-node','experiments/rolling/state.mjs','experiments/rolling/profile.mjs','experiments/rolling/transactions.mjs','experiments/rolling/mass.mjs','experiments/rolling/accepted.mjs','experiments/rolling/receiver.mjs'])
    assert.ok(!files.some(f=>f.includes(bad)),bad);
  assert.ok(!files.some(f=>/\.test\.(mjs|ts)$/.test(f)));
  // the presentation layer is TypeScript (type-checked by the build); the protocol modules it drives stay plain .mjs
  for(const ts of ['app','bridge','ui','views','messages','share','settings'])assert.ok(files.includes(`web/rolling-tn10/${ts}.ts`),ts);
  assert.ok(!files.includes('web/rolling-tn10/app.mjs'));assert.equal(manifest.toolchain.typescript,'5.8.3');
  for(const needed of ['scripts/rolling/core.mjs','scripts/rolling/core/lib/index.js','scripts/rolling/core/lib/state.js','scripts/rolling/core/lib/profile.js','scripts/rolling/core/lib/transactions.js','scripts/rolling/core/lib/mass.js','scripts/rolling/core/lib/accepted.js','experiments/rolling/tn10-proof.mjs','scripts/chain/chain.mjs','scripts/wallet/sighash.mjs','scripts/round/draw-confirmations.mjs'])
    assert.ok(files.includes(needed),needed);
  assert.doesNotMatch(script,/from"node:|require\("node:|readFileSync|createHash\(/);
  // The graph checker itself rejects each class of forbidden dependency.
  const meta=(...paths)=>({inputs:Object.fromEntries([...Array(25)].map((_,i)=>[`scripts/core/lib/x${i}.js`,{imports:[]}]).concat(paths.map(p=>[p,{imports:[]}])))});
  for(const p of ['experiments/rolling/fixtures.mjs','experiments/rolling/test-signer.mjs','experiments/rolling/engine-gate.mjs','experiments/rolling/tn10-run.mjs','experiments/rolling/state.mjs','experiments/rolling/transactions.mjs','web/rolling-tn10/controller.test.mjs','scripts/wallet/kasware.mjs','node:fs','../outside.mjs'])
    assert.throws(()=>checkGraph(meta(p)),/GRAPH_/,p);
  assert.throws(()=>checkGraph({inputs:{...meta().inputs,'web/rolling-tn10/app.ts':{imports:[{path:'node:fs',external:true}]}}}),/GRAPH_NODE_IMPORT/);
});

// ---- Static checks of the SHIPPED bundle (the pure views are exercised in views.test.mjs; there is no DOM stub any more) ----
test('shipped bundle keeps the key hygiene hooks: password input, wallet wipe on pagehide, no key in localStorage keys',()=>{
  assert.match(script,/type="password"/);assert.match(script,/autocomplete="off"/);
  assert.match(script,/pagehide/);
  assert.doesNotMatch(script,/localStorage\.setItem\([^)]*(secret|private|wKey)/i);
  // user-facing page: the experiment banner and the footer profile id are in the static HTML, outside the script
  const shell=html.replace(script,'');
  assert.match(shell,/class="exp-bar"/);assert.ok(shell.includes(`id="profileId">${TN10_PROFILE_ID}<`));
  for(const id of ['view','toasts','modal','mTitle','mBody','mFoot','mClose','nodeChip','walletBtn','settingsBtn','themeBtn','githubBtn','languageBtn'])assert.ok(shell.includes(`id="${id}"`),id);
});
