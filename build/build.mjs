/** Kaswin Rolling browser build: source -> dist/index.html and build-manifest.json.
 * Usage: node build/build.mjs [--mode=mainnet|tn10] [--out-dir=<dir>]
 * Compiles the unified TypeScript core, checks the pinned contracts and browser graph,
 * and embeds the application. Does not test, deploy, connect, sign or broadcast. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import ts from 'typescript';
import {buildCore} from './core.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const sha256=data=>createHash('sha256').update(data).digest('hex');
const ALLOWED=[/^web\/(app|ui)\/[a-z0-9-]+\.(mjs|ts)$/,
  /^scripts\/(chain|wallet|round|store|tracking|contract)\/[a-z0-9-]+\.mjs$/,
  /^scripts\/core\/lib\/[a-z0-9-]+\.js$/,/^scripts\/(core|errors|release-safety)\.mjs$/,
  /^rolling-profile:/,/^node_modules\//];
const FORBIDDEN=[/^tests\//,/^experiments\//,/^scripts\/indexer\//,/^scripts\/contract\/bundle\.mjs$/,
  /(^|\/)(fixtures|test-signer|engine-gate|tn10-run|tn10-service|tn10-replay|service-client|fake-node)\.mjs$/,
  /\.test\.(mjs|ts)$/,/^scripts\/wallet\/(kasware|kastle|browser-test)\.mjs$/];

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

export function typeCheckPage() {
  assert.equal(ts.version,'5.8.3','TypeScript 5.8.3 is required');
  const cfgPath=path.join(root,'web/app/tsconfig.json'),host={getCanonicalFileName:x=>x,getCurrentDirectory:()=>root,getNewLine:()=> '\n'};
  const fail=list=>{if(list.length)throw Error('TYPECHECK_FAILED\n'+ts.formatDiagnostics(list,host));};
  const {config,error}=ts.readConfigFile(cfgPath,ts.sys.readFile);fail(error?[error]:[]);
  const parsed=ts.parseJsonConfigFileContent(config,ts.sys,path.dirname(cfgPath));fail(parsed.errors);
  assert.ok(parsed.fileNames.some(f=>f.endsWith('/app.ts')),'TYPECHECK_NO_APP');
  fail(ts.getPreEmitDiagnostics(ts.createProgram(parsed.fileNames,parsed.options)));
}

export async function buildKaswin({outDir=path.join(root,'dist'),mode='mainnet'}={}) {
  assert.ok(mode==='mainnet'||mode==='tn10','Rolling supports --mode=mainnet or --mode=tn10');
  assert.equal(esbuild.version,'0.28.2','esbuild 0.28.2 is required');
  const coreSources=await buildCore();
  const {MAINNET}=await import('../scripts/chain/mainnet.mjs');
  const {TN10}=await import('../scripts/chain/tn10.mjs');
  const defaultNet=mode==='mainnet'?MAINNET:TN10;
  const {loadDeploymentProfile,TN10_PROFILE_ID}=await import('../scripts/contract/bundle.mjs');
  const {profileToData}=await import('../scripts/contract/profile-data.mjs');
  const {TN10_PROFILE_ID:CLIENT_PROFILE_ID,TN10_GENESIS}=await import('../scripts/contract/protocol.mjs');
  typeCheckPage();
  assert.equal(CLIENT_PROFILE_ID,TN10_PROFILE_ID,'client/deployment Profile constants differ');
  assert.equal(TN10_GENESIS,TN10.genesis,'client TN10 genesis differs from the network table');
  const profile=await loadDeploymentProfile(),data=profileToData(profile);
  assert.equal(data.id,TN10_PROFILE_ID);assert.equal(data.status,'UNVALIDATED');
  const result=await esbuild.build({
    absWorkingDir:root,entryPoints:['web/app/app.ts'],bundle:true,metafile:true,write:false,
    platform:'browser',format:'iife',target:['es2022'],minify:true,legalComments:'none',charset:'utf8',
    define:{__KASWIN_DEFAULT_NET__:JSON.stringify(mode),__KASWIN_RELEASE_TRADING__:'true',__KASWIN_MAINNET_TRADING__:JSON.stringify(mode==='mainnet'),__KASWIN_BROWSER_TEST_WALLET__:'false'},
    plugins:[{name:'rolling-profile',setup(build){
      build.onResolve({filter:/^@kaswin\/rolling-profile$/},()=>({path:'data',namespace:'rolling-profile'}));
      build.onLoad({filter:/.*/,namespace:'rolling-profile'},()=>({loader:'js',contents:`export const profileData=${JSON.stringify(data)};`}));
    }}],
  });
  const sources=checkGraph(result.metafile);
  const js=result.outputFiles[0].text.replace(/<\/script/gi,'<\\/script');
  assert.ok(!/require\(["']node:|from["']node:/.test(js),'OUTPUT_NODE_IMPORT');
  const css=await fs.readFile(path.join(root,'web/ui/styles.css'),'utf8');
  const template=await fs.readFile(path.join(root,'web/ui/index.template.html'),'utf8');
  for(const m of ['__APPLICATION_HASH__','/* APPLICATION */','/* STYLES */','__PROFILE_ID__'])assert.equal(template.split(m).length,2,`Template marker: ${m}`);
  const scriptHash=createHash('sha256').update(js).digest('base64');
  const html=template.replace('__APPLICATION_HASH__',`sha256-${scriptHash}`).replace('__PROFILE_ID__',TN10_PROFILE_ID)
    .replace('/* STYLES */',()=>css).replace('/* APPLICATION */',()=>js);
  assert.ok(sources.includes('scripts/core.mjs')&&sources.includes('scripts/core/lib/transactions.js'),'ROLLING_TS_CORE_NOT_WIRED');
  const inputPaths=[...new Set([...sources.filter(f=>!f.startsWith('rolling-profile:')),...coreSources,
    'build/core.mjs','build/build.mjs','scripts/core/tsconfig.json','scripts/core/package.json',
    'web/ui/index.template.html','web/ui/styles.css','web/app/tsconfig.json','web/app/globals.d.ts','web/app/types.ts',
    'package.json','package-lock.json','contracts/pins.json','contracts/toolchain.json',
    ...Object.keys(profile.frames).flatMap(m=>[`contracts/artifacts/${m}.json`,`contracts/${m}.sil`])])].sort();
  const inputs=Object.fromEntries(await Promise.all(inputPaths.map(async f=>[f,sha256(await fs.readFile(path.join(root,f)))])));
  const manifest={formatVersion:1,mode,artifact:{file:'index.html',bytes:Buffer.byteLength(html),sha256:sha256(html)},
    capabilities:{tn10Trading:true,mainnetTrading:mode==='mainnet',memoryWallet:mode!=='mainnet',networkSwitch:true},
    contract:{version:'Rolling v1',profileId:TN10_PROFILE_ID},network:defaultNet.networkId,genesis:defaultNet.genesis,
    networks:['mainnet','tn10'],profileId:TN10_PROFILE_ID,evidence:'UNVALIDATED',toolchain:{esbuild:esbuild.version,typescript:ts.version},
    graph:{files:sources.length,nodeImports:0,forbiddenModules:0},inputs};
  await fs.mkdir(outDir,{recursive:true});
  await fs.writeFile(path.join(outDir,'index.html'),html);
  await fs.writeFile(path.join(outDir,'build-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  return {html,manifest,outDir};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const args=process.argv.slice(2),out=args.find(a=>a.startsWith('--out-dir=')),mode=args.find(a=>a.startsWith('--mode='));
  assert.ok(args.every(a=>a.startsWith('--out-dir=')||a==='--mode=mainnet'||a==='--mode=tn10'),'Usage: node build/build.mjs [--mode=mainnet|tn10] [--out-dir=<dir>]');
  const {manifest,outDir}=await buildKaswin({outDir:out?path.resolve(out.slice(10)):undefined,mode:mode?mode.slice(7):'mainnet'});
  console.log(`Built ${path.join(outDir,'index.html')} (${manifest.artifact.bytes} bytes, sha256=${manifest.artifact.sha256}, profile=${manifest.profileId}, ${manifest.graph.files} source files)`);
}
