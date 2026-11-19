import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildKaswin,checkGraph} from '../../build/build.mjs';
import {TN10_PROFILE_ID} from '../../scripts/contract/protocol.mjs';

const out=mkdtempSync(join(tmpdir(),'kaswin-build-'));
process.on('exit',()=>rmSync(out,{recursive:true,force:true}));
const sha=b=>createHash('sha256').update(b).digest('hex');
const mainBefore=existsSync(new URL('../../dist/index.html',import.meta.url))?sha(readFileSync(new URL('../../dist/index.html',import.meta.url))):null;
const built=await buildKaswin({outDir:out}),{html,manifest}=built;
const script=html.slice(html.lastIndexOf('<script>')+8,html.lastIndexOf('</script>'));

test('build writes index.html and build-manifest.json to the selected directory and leaves dist untouched',()=>{
  assert.equal(manifest.artifact.file,'index.html');assert.equal(manifest.artifact.sha256,sha(html));
  assert.equal(readFileSync(join(out,'index.html'),'utf8'),html);
  assert.deepEqual(JSON.parse(readFileSync(join(out,'build-manifest.json'),'utf8')),manifest);
  const after=existsSync(new URL('../../dist/index.html',import.meta.url))?sha(readFileSync(new URL('../../dist/index.html',import.meta.url))):null;
  assert.equal(after,mainBefore);
});
test('page defaults to mainnet with TN10 switch, fixed Profile and UNVALIDATED evidence boundary; never claims full validation',()=>{
  assert.match(html,/Kaspa 主网/);assert.match(html,/UNVALIDATED/);assert.ok(html.includes(TN10_PROFILE_ID)&&manifest.profileId===TN10_PROFILE_ID);
  assert.equal(manifest.evidence,'UNVALIDATED');assert.doesNotMatch(html,/已全部验证|fully validated|已通过全部验证/i);
  assert.equal(manifest.mode,'mainnet');assert.equal(manifest.network,'mainnet');
  assert.equal(manifest.capabilities.mainnetTrading,true);assert.equal(manifest.capabilities.tn10Trading,true);
  assert.equal(manifest.capabilities.memoryWallet,false);assert.equal(manifest.capabilities.networkSwitch,true);
  assert.match(html,/id="netBtn"/);
});
test('tn10 mode builds with testnet-10 default network',async()=>{
  const tn10Out=mkdtempSync(join(tmpdir(),'kaswin-build-tn10-'));
  try{
    const {manifest:m}=await buildKaswin({outDir:tn10Out,mode:'tn10'});
    assert.equal(m.mode,'tn10');assert.equal(m.network,'testnet-10');
    assert.equal(m.capabilities.mainnetTrading,false);assert.equal(m.capabilities.tn10Trading,true);
    assert.equal(m.capabilities.networkSwitch,true);
  }finally{rmSync(tn10Out,{recursive:true,force:true});}
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
  for(const bad of ['test-signer','fixtures','engine-gate','tn10-run','tn10-service','service-client','scripts/contract/bundle.mjs','kasware','kastle','browser-test','fake-node','tests/contracts/state.mjs','tests/contracts/profile.mjs','tests/contracts/transactions.mjs','tests/contracts/mass.mjs','tests/contracts/accepted.mjs','tests/contracts/receiver.mjs'])
    assert.ok(!files.some(f=>f.includes(bad)),bad);
  assert.ok(!files.some(f=>/\.test\.(mjs|ts)$/.test(f)));
  // the presentation layer is TypeScript (type-checked by the build); the protocol modules it drives stay plain .mjs
  for(const ts of ['app','bridge','share','settings'])assert.ok(files.includes(`web/app/${ts}.ts`),ts);
  for(const ts of ['ui','views','messages','draw-readiness'])assert.ok(files.includes(`web/ui/${ts}.ts`),ts);
  assert.ok(!files.includes('web/app/app.mjs'));assert.equal(manifest.toolchain.typescript,'5.8.3');
  for(const needed of ['scripts/core.mjs','scripts/core/lib/index.js','scripts/core/lib/state.js','scripts/core/lib/profile.js','scripts/core/lib/transactions.js','scripts/core/lib/mass.js','scripts/core/lib/accepted.js','scripts/round/draw-proof.mjs','scripts/round/draw-progress.mjs','scripts/chain/chain.mjs','scripts/wallet/sighash.mjs','scripts/round/draw-confirmations.mjs'])
    assert.ok(files.includes(needed),needed);
  assert.doesNotMatch(script,/from"node:|require\("node:|readFileSync|createHash\(/);
  // The graph checker itself rejects each class of forbidden dependency.
  const meta=(...paths)=>({inputs:Object.fromEntries([...Array(25)].map((_,i)=>[`scripts/core/lib/x${i}.js`,{imports:[]}]).concat(paths.map(p=>[p,{imports:[]}])))});
  for(const p of ['tests/contracts/fixtures.mjs','tests/contracts/test-signer.mjs','tests/contracts/engine-gate.mjs','tests/contracts/tn10-run.mjs','tests/contracts/state.mjs','tests/contracts/transactions.mjs','tests/unit/controller.test.mjs','tests/helpers/fake-node.mjs','scripts/contract/bundle.mjs','scripts/wallet/kasware.mjs','node:fs','../../web/outside.mjs'])
    assert.throws(()=>checkGraph(meta(p)),/GRAPH_/,p);
  assert.throws(()=>checkGraph({inputs:{...meta().inputs,'web/app/app.ts':{imports:[{path:'node:fs',external:true}]}}}),/GRAPH_NODE_IMPORT/);
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
