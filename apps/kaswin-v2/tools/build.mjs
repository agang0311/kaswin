// Offline single-HTML bundler for Kaswin V2. No downloads, wallet, RPC, signing or deployment.
//   node tools/build.mjs                       -> releases/kaswin-v2/index.html + build-manifest.json
// Historical F3.2 deployed-byte reproduction is not an entry point for V2 sources.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import {loadV2Bundle} from '../../../contracts/f3.2/tools/linking.mjs';
import {requireReviewedBudgets} from '../../../contracts/f3.2/tools/budget-gate.mjs';

assert.equal(esbuild.version, '0.28.2', 'esbuild is pinned to 0.28.2');
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const app = path.join(repo, 'apps/kaswin-v2'), contract = path.join(repo, 'contracts/f3.2'), out = path.join(repo, 'releases/kaswin-v2');
const checkOnly = process.argv.length === 3 && process.argv[2] === '--check';
if (process.argv.length !== 2 && !checkOnly) throw Error('Usage: node tools/build.mjs [--check]; --check only compiles in memory, never publishes');
const DEPLOYED = {file: 'deployed-20261005.html', sha256: '335fbf0485369c0b924401b7cfb0243c1deb1e2b0e049d288cdb3a89f3168003'};
const sha = b => createHash('sha256').update(b).digest('hex');

// Never bundle stale lib/ or mix template sources, linked sources, ABI and Profile.
await import('./check-core.mjs');
const {pins, frames: loadedFrames, profile, provenance} = await loadV2Bundle(contract);
if (!checkOnly) await requireReviewedBudgets(contract, pins, profile); // no budget evidence => no release writes
const frames = Object.fromEntries(Object.entries(loadedFrames).map(([m, f]) => [m, {...f, tail: Buffer.from(f.tail).toString('hex')}]));

const transformations = [];
const plugins = [
  {name: 'pinned-data', setup(b) {
    b.onResolve({filter: /^@kaswin\/data$/}, () => ({path: 'data', namespace: 'pinned'}));
    b.onLoad({filter: /.*/, namespace: 'pinned'}, () => ({loader: 'js', contents: `export const frames=${JSON.stringify(frames)};`}));
  }},
];

const result = await esbuild.build({absWorkingDir: repo, entryPoints: ['apps/kaswin-v2/scripts/app.mjs'], bundle: true, metafile: true, write: false,
  platform: 'browser', format: 'iife', target: ['es2022'], minify: true, legalComments: 'none', charset: 'utf8', plugins});
// Layering guard: visual/ may import visual/ files plus two pure helper modules (constants/formatters in shared/core.mjs,
// recordStatus in rest.mjs); never the engine, wallet, node, storage or submit modules. Breaking the split fails the build.
const VISUAL_MAY_IMPORT = new Set(['apps/kaswin-v2/scripts/shared/core.mjs', 'apps/kaswin-v2/scripts/rest.mjs']);
for (const [file, {imports}] of Object.entries(result.metafile.inputs)) if (file.startsWith('apps/kaswin-v2/visual/'))
  for (const {path: dep} of imports) assert.ok(dep.startsWith('apps/kaswin-v2/visual/') || VISUAL_MAY_IMPORT.has(dep), `${file} imports ${dep}: visual layer must not depend on behaviour modules`);
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = await fs.readFile(path.join(app, 'visual/styles.css'), 'utf8'), tpl = await fs.readFile(path.join(app, 'visual/index.template.html'), 'utf8');
const scriptHash = createHash('sha256').update(js).digest('base64');
assert.equal(tpl.split('__APPLICATION_HASH__').length, 2, 'Missing/duplicate CSP hash placeholder');
assert.equal(tpl.split('/* APPLICATION */').length, 2, 'Missing/duplicate inline application placeholder');
const html = tpl.replace('__APPLICATION_HASH__', `sha256-${scriptHash}`)
  .replace('/* STYLES */', () => css).replace('/* APPLICATION */', () => js);
assert.ok(html.includes('wss://tn10.kaspay.top/wrpc'), 'built HTML missing default node');
assert.ok(html.includes('https://tn10.kaspay.top/indexer'), 'built HTML missing default indexer');
assert.equal(sha(await fs.readFile(path.join(out, DEPLOYED.file))), DEPLOYED.sha256, 'deployed snapshot file was modified');

if (checkOnly) {
  console.log(`Compile-only: ${Object.keys(result.metafile.inputs).length} inputs, ${Buffer.byteLength(html)} HTML bytes in memory; no release files written. Budget approval NOT established.`);
} else {
// esbuild applies `strict` from packages/f3.2-core/tsconfig.json to lib/*.js ("use strict"), so that file is a build input.
const inputs = Object.keys(result.metafile.inputs).filter(p => !p.startsWith('pinned:'))
  .concat(['apps/kaswin-v2/visual/styles.css', 'apps/kaswin-v2/visual/index.template.html', 'packages/f3.2-core/tsconfig.json',
    'contracts/f3.2/pins.json', 'contracts/f3.2/budget-evidence.json', 'contracts/f3.2/tools/budget-gate.mjs',
    'apps/kaswin-v2/tools/build.mjs']);
const inputSha256 = Object.fromEntries(await Promise.all(inputs.map(async p => [p, sha(await fs.readFile(path.join(repo, p)))])));
const manifest = {artifact: 'index.html', bytes: Buffer.byteLength(html), sha256: sha(html), esbuild: esbuild.version,
  profileId: profile.id, networkGenesis: pins.networkGenesis, frames: provenance, transformations, inputSha256,
  externalRuntime: ['user-configured indexer (GET /v1/rounds*), default https://tn10.kaspay.top/indexer', 'one configured TN10 JSON wRPC node (ws/wss, ordered fallback), default wss://tn10.kaspay.top/wrpc',
    'public TN10 REST GET /transactions/{txid} (https://api-tn10.kaspa.org) for old UNKNOWN records', 'KasWare provider (window.kasware)'],
  noRuntimeDownloads: true, embeddedSdk: false,
  deployedSnapshot: {...DEPLOYED, relation: 'Historical F3.2 deployment; preserved unchanged, not reproducible from or evidence for current V2 sources.'}};
await fs.writeFile(path.join(out, 'index.html'), html);
await fs.writeFile(path.join(out, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`index.html ${manifest.bytes} bytes sha256 ${manifest.sha256}`);
}
