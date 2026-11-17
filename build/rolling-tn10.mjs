/** Standalone TN10 rolling experiment page -> dist/rolling-tn10.html (+ dist/rolling-tn10.manifest.json).
 *   node build/rolling-tn10.mjs [--out-dir=<dir>]
 * Never writes dist/index.html or dist/build-manifest.json and never starts a server.
 * Compiles the Rolling TypeScript core first; bootstraps the shared core only when its generated declarations are missing.
 * The authenticated Profile frames are loaded and checked at BUILD time (loadDeploymentProfile) and inlined; the browser
 * re-derives the Profile id (assertProfile). The browser import graph is checked: no node:*, test signer, fixtures,
 * engine gate, CLI runner, service, indexer server or V2 wallet adapters. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import ts from 'typescript';
import {buildRollingCore} from './rolling-core.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const sha256=data=>createHash('sha256').update(data).digest('hex');
const ALLOWED=[/^web\/rolling-tn10\/[a-z-]+\.(mjs|ts)$/,/^web\/ui\/(icons|i18n|messages-en)\.mjs$/,/^scripts\/(chain|wallet|round|core|contract)\/[A-Za-z0-9._/-]+\.(mjs|js)$/,/^scripts\/core\.mjs$/,/^scripts\/release-safety\.mjs$/,
  /^scripts\/rolling\/core\.mjs$/,/^scripts\/rolling\/core\/lib\/[a-z-]+\.js$/,
  /^contracts\/pins\.json$/,/^experiments\/rolling\/tn10-proof\.mjs$/,/^rolling-profile:/,/^node_modules\//];
const FORBIDDEN=[/(^|\/)(fixtures|test-signer|deployment-profile|engine-gate|tn10-run|tn10-service|tn10-replay|http|indexer|archive|node-adapter|receiver|measure|compile|prepare-sources)\.mjs$/,
  /^experiments\/rolling\/(state|profile|transactions|mass|accepted|receiver)\.mjs$/,
  /(^|\/)vm-[a-z-]+\.mjs$/,/\.test\.(mjs|ts)$/,/scripts\/wallet\/(kasware|kastle|browser-test)\.mjs$/,/(^|\/)controller\.test\.mjs$/];

/** Throws unless the bundled graph is exactly browser-safe and inside the allowlist. */
export function checkGraph(metafile) {
  const files=Object.keys(metafile.inputs);
  assert.ok(files.length>20,'GRAPH_EMPTY');
  for(const [file,{imports}] of Object.entries(metafile.inputs)) {
    assert.ok(!file.startsWith('node:')&&!/^\/|\.\.\//.test(file),`GRAPH_ESCAPE: ${file}`);
    assert.ok(ALLOWED.some(r=>r.test(file)),`GRAPH_NOT_ALLOWED: ${file}`);
    assert.ok(!FORBIDDEN.some(r=>r.test(file)),`GRAPH_FORBIDDEN: ${file}`);
    for(const i of imports) {
      assert.ok(!i.path.startsWith('node:')&&!i.external,`GRAPH_NODE_IMPORT: ${file} -> ${i.path}`);
      assert.ok(!FORBIDDEN.some(r=>r.test(i.path)),`GRAPH_FORBIDDEN_IMPORT: ${file} -> ${i.path}`);
    }
  }
  return files;
}

/** Strict type-check of the TypeScript presentation layer (web/rolling-tn10/*.ts; the plain-JS protocol modules are reached through bridge.ts). Throws on any diagnostic. */
export function typeCheckPage() {
  assert.equal(ts.version,'5.8.3','TypeScript 5.8.3 is required');
  const cfgPath=path.join(root,'web/rolling-tn10/tsconfig.json'),host={getCanonicalFileName:x=>x,getCurrentDirectory:()=>root,getNewLine:()=>'\n'};
  const fail=list=>{if(list.length)throw Error('TYPECHECK_FAILED\n'+ts.formatDiagnostics(list,host));};
  const {config,error}=ts.readConfigFile(cfgPath,ts.sys.readFile);fail(error?[error]:[]);
  const parsed=ts.parseJsonConfigFileContent(config,ts.sys,path.dirname(cfgPath));fail(parsed.errors);
  assert.ok(parsed.fileNames.some(f=>f.endsWith('/app.ts')),'TYPECHECK_NO_APP');
  fail(ts.getPreEmitDiagnostics(ts.createProgram(parsed.fileNames,parsed.options)));
}

export async function buildRollingTn10({outDir=path.join(root,'dist')}={}) {
  assert.equal(esbuild.version,'0.28.2','esbuild 0.28.2 is required');
  await fs.access(path.join(root,'scripts/core/lib/bytes.d.ts')).catch(async()=>{const {buildCore}=await import('./core.mjs');await buildCore();});
  const coreSources=await buildRollingCore();
  const {TN10}=await import('../scripts/chain/tn10.mjs');
  const {loadDeploymentProfile,TN10_PROFILE_ID}=await import('../experiments/rolling/deployment-profile.mjs');
  const {profileToData}=await import('../web/rolling-tn10/profile-data.mjs');
  const {TN10_PROFILE_ID:CLIENT_PROFILE_ID,TN10_GENESIS}=await import('../web/rolling-tn10/protocol.mjs');
  typeCheckPage();
  assert.equal(CLIENT_PROFILE_ID,TN10_PROFILE_ID,'client/deployment Profile constants differ');
  assert.equal(TN10_GENESIS,TN10.genesis,'client TN10 genesis differs from the network table');
  const profile=await loadDeploymentProfile(),data=profileToData(profile);
  assert.equal(data.id,TN10_PROFILE_ID);assert.equal(data.status,'UNVALIDATED');
  const pin=JSON.parse(await fs.readFile(path.join(root,'experiments/rolling/engine-pin.json'),'utf8'));
  assert.match(pin.binarySha256,/^[0-9a-f]{64}$/);
  const result=await esbuild.build({
    absWorkingDir:root,entryPoints:['web/rolling-tn10/app.ts'],bundle:true,metafile:true,write:false,
    platform:'browser',format:'iife',target:['es2022'],minify:true,legalComments:'none',charset:'utf8',
    define:{__KASWIN_RELEASE_TRADING__:'true',__KASWIN_MAINNET_TRADING__:'false',__KASWIN_BROWSER_TEST_WALLET__:'false'},
    plugins:[{name:'rolling-profile',setup(build) {
      build.onResolve({filter:/^@kaswin\/rolling-profile$/},()=>({path:'data',namespace:'rolling-profile'}));
      build.onLoad({filter:/.*/,namespace:'rolling-profile'},()=>({loader:'js',contents:`export const profileData=${JSON.stringify(data)};export const enginePin=${JSON.stringify(pin.binarySha256)};`}));
    }}],
  });
  const sources=checkGraph(result.metafile);
  const js=result.outputFiles[0].text.replace(/<\/script/gi,'<\\/script');
  assert.ok(!/require\(["']node:|from["']node:/.test(js),'OUTPUT_NODE_IMPORT');
  const css=await fs.readFile(path.join(root,'web/rolling-tn10/styles.css'),'utf8');
  const template=await fs.readFile(path.join(root,'web/rolling-tn10/index.template.html'),'utf8');
  for(const m of ['__APPLICATION_HASH__','/* APPLICATION */','/* STYLES */','__PROFILE_ID__'])assert.equal(template.split(m).length,2,`Template marker: ${m}`);
  const scriptHash=createHash('sha256').update(js).digest('base64');
  const html=template.replace('__APPLICATION_HASH__',`sha256-${scriptHash}`).replace('__PROFILE_ID__',TN10_PROFILE_ID)
    .replace('/* STYLES */',()=>css).replace('/* APPLICATION */',()=>js);
  assert.ok(sources.includes('scripts/rolling/core.mjs')&&sources.some(f=>f.startsWith('scripts/rolling/core/lib/')),'ROLLING_TS_CORE_NOT_WIRED');
  const inputs=Object.fromEntries(await Promise.all([...new Set([...sources.filter(f=>!f.startsWith('rolling-profile:')),...coreSources,'build/rolling-core.mjs','scripts/rolling/core/tsconfig.json','build/rolling-tn10.mjs','web/rolling-tn10/index.template.html','web/rolling-tn10/styles.css','web/rolling-tn10/tsconfig.json','web/rolling-tn10/globals.d.ts','web/rolling-tn10/types.ts','experiments/rolling/engine-pin.json',
    ...Object.keys(profile.frames).flatMap(m=>[`experiments/rolling/artifacts/${m}.json`,`experiments/rolling/generated/${m}.sil`])])].sort().map(async f=>[f,sha256(await fs.readFile(path.join(root,f)))])));
  const manifest={formatVersion:1,artifact:{file:'rolling-tn10.html',bytes:Buffer.byteLength(html),sha256:sha256(html)},network:TN10.networkId,genesis:TN10.genesis,
    profileId:TN10_PROFILE_ID,evidence:'UNVALIDATED',engine:{binarySha256:pin.binarySha256},toolchain:{esbuild:esbuild.version,typescript:ts.version},
    graph:{files:sources.length,nodeImports:0,forbiddenModules:0},inputs};
  await fs.mkdir(outDir,{recursive:true});
  await fs.writeFile(path.join(outDir,'rolling-tn10.html'),html);
  await fs.writeFile(path.join(outDir,'rolling-tn10.manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  return {html,manifest,outDir};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const args=process.argv.slice(2),out=args.find(a=>a.startsWith('--out-dir='));
  assert.ok(args.every(a=>a.startsWith('--out-dir=')),'Usage: node build/rolling-tn10.mjs [--out-dir=<dir>]');
  const {manifest,outDir}=await buildRollingTn10({outDir:out?path.resolve(out.slice(10)):undefined});
  console.log(`Built ${path.join(outDir,'rolling-tn10.html')} (${manifest.artifact.bytes} bytes, sha256=${manifest.artifact.sha256}, profile=${manifest.profileId}, ${manifest.graph.files} source files)`);
}
