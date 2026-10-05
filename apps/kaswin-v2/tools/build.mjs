// Offline single-HTML bundler for Kaswin V2. No downloads, wallet, RPC, signing or deployment.
//   node tools/build.mjs                       -> releases/kaswin-v2/index.html + build-manifest.json
//   node tools/build.mjs --reproduce-deployed  -> in-memory proof that these sources rebuild the deployed
//                                                 2026-10-05 bytes (icons re-inlined); writes nothing.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import {parseCompiledFrame, makeProfile} from '../../../packages/f3.2-core/lib/artifacts.js';

assert.equal(esbuild.version, '0.28.2', 'esbuild is pinned to 0.28.2');
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const app = path.join(repo, 'apps/kaswin-v2'), contract = path.join(repo, 'contracts/f3.2'), out = path.join(repo, 'releases/kaswin-v2');
const reproduce = process.argv.includes('--reproduce-deployed');
const DEPLOYED = {file: 'deployed-20261005.html', sha256: '335fbf0485369c0b924401b7cfb0243c1deb1e2b0e049d288cdb3a89f3168003'};
const sha = b => createHash('sha256').update(b).digest('hex');

// Frames are re-derived from the .sil sources + linked compiler artifacts and checked against pins; never copied from a prior HTML.
const pins = JSON.parse(await fs.readFile(path.join(contract, 'pins.json'), 'utf8'));
const frames = {}, provenance = {};
for (const m of ['open', 'sealed', 'refunding']) {
  const src = await fs.readFile(path.join(contract, `src/${m}.sil`)), art = await fs.readFile(path.join(contract, `artifacts/${m}-linked.json`));
  assert.equal(sha(src), pins.frames[m].sourceSha256, `${m}.sil differs from pins.json`);
  assert.equal(sha(art), pins.frames[m].artifactSha256, `${m}-linked.json differs from pins.json`);
  const f = parseCompiledFrame(m, JSON.parse(art.toString('utf8')), sha(src));
  assert.equal(f.templateHash, pins.frames[m].templateHash, `${m} template hash differs from pins.json`);
  frames[m] = {...f, tail: Buffer.from(f.tail).toString('hex')};
  provenance[m] = {sourceSha256: sha(src), artifactSha256: sha(art), templateHash: f.templateHash, tailBytes: f.tail.length};
}
const profile = makeProfile(pins.networkGenesis, Object.fromEntries(Object.entries(frames).map(([k, v]) => [k, {...v, tail: Uint8Array.from(Buffer.from(v.tail, 'hex'))}])));
assert.equal(profile.id, pins.profileId, 'Profile ID differs from pins.json');

const transformations = [];
const plugins = [
  {name: 'pinned-data', setup(b) {
    b.onResolve({filter: /^@kaswin\/data$/}, () => ({path: 'data', namespace: 'pinned'}));
    b.onLoad({filter: /.*/, namespace: 'pinned'}, () => ({loader: 'js', contents: `export const frames=${JSON.stringify(frames)};`}));
  }},
];
if (reproduce) plugins.push({name: 'reinline-icons', setup(b) {
  // Exact inverse of the publication split: visual/icons.mjs was cut verbatim out of the controller (plus `export`).
  b.onLoad({filter: /scripts[\\/]app\.mjs$/}, async args => {
    const controller = await fs.readFile(args.path, 'utf8'), marker = "import {icon} from '../visual/icons.mjs';";
    const icons = (await fs.readFile(path.join(app, 'visual/icons.mjs'), 'utf8')).replace(/\n$/, '');
    assert.ok(controller.includes(marker) && icons.includes('export const icon ='), 'icon split changed: reproduction no longer applies');
    return {loader: 'js', contents: controller.replace(marker, () => icons.replace('export const icon =', 'const icon ='))};
  });
}});

const result = await esbuild.build({absWorkingDir: repo, entryPoints: ['apps/kaswin-v2/scripts/app.mjs'], bundle: true, metafile: true, write: false,
  platform: 'browser', format: 'iife', target: ['es2022'], minify: true, legalComments: 'none', charset: 'utf8', plugins});
// Layering guard: visual/ may import visual/ files plus two pure helper modules (constants/formatters in shared/core.mjs,
// recordStatus in rest.mjs); never the engine, wallet, node, storage or submit modules. Breaking the split fails the build.
const VISUAL_MAY_IMPORT = new Set(['apps/kaswin-v2/scripts/shared/core.mjs', 'apps/kaswin-v2/scripts/rest.mjs']);
for (const [file, {imports}] of Object.entries(result.metafile.inputs)) if (file.startsWith('apps/kaswin-v2/visual/'))
  for (const {path: dep} of imports) assert.ok(dep.startsWith('apps/kaswin-v2/visual/') || VISUAL_MAY_IMPORT.has(dep), `${file} imports ${dep}: visual layer must not depend on behaviour modules`);
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = await fs.readFile(path.join(app, 'visual/styles.css'), 'utf8'), tpl = await fs.readFile(path.join(app, 'visual/index.template.html'), 'utf8');
const html = tpl.replace('/* STYLES */', () => css).replace('/* APPLICATION */', () => js);
assert.ok(html.includes('wss://tn10.kaspay.top/wrpc'), 'built HTML missing default node');
assert.ok(html.includes('https://tn10.kaspay.top/indexer'), 'built HTML missing default indexer');
assert.equal(sha(await fs.readFile(path.join(out, DEPLOYED.file))), DEPLOYED.sha256, 'deployed snapshot file was modified');

if (reproduce) {
  const ok = sha(html) === DEPLOYED.sha256;
  console.log(`${ok ? 'PASS' : 'FAIL'}: sources with icons re-inlined -> ${Buffer.byteLength(html)} bytes sha256 ${sha(html)}; deployed ${DEPLOYED.sha256}`);
  if (!ok) console.log('Expected after any source change: the deployed snapshot is a fixed 2026-10-05 record, not a moving target.');
  process.exit(ok ? 0 : 1);
}

// esbuild applies `strict` from packages/f3.2-core/tsconfig.json to lib/*.js ("use strict"), so that file is a build input.
const inputs = Object.keys(result.metafile.inputs).filter(p => !p.startsWith('pinned:'))
  .concat(['apps/kaswin-v2/visual/styles.css', 'apps/kaswin-v2/visual/index.template.html', 'packages/f3.2-core/tsconfig.json', 'contracts/f3.2/pins.json']);
const inputSha256 = Object.fromEntries(await Promise.all(inputs.map(async p => [p, sha(await fs.readFile(path.join(repo, p)))])));
const manifest = {artifact: 'index.html', bytes: Buffer.byteLength(html), sha256: sha(html), esbuild: esbuild.version,
  profileId: profile.id, networkGenesis: pins.networkGenesis, frames: provenance, transformations, inputSha256,
  externalRuntime: ['user-configured indexer (GET /v1/rounds*), default https://tn10.kaspay.top/indexer', 'one configured TN10 JSON wRPC node (ws/wss, ordered fallback), default wss://tn10.kaspay.top/wrpc',
    'public TN10 REST GET /transactions/{txid} (https://api-tn10.kaspa.org) for old UNKNOWN records', 'KasWare provider (window.kasware)'],
  noRuntimeDownloads: true, embeddedSdk: false,
  deployedSnapshot: {...DEPLOYED, relation: 'Same sources except visual/icons.mjs is a separate module here; `npm run verify:deployed` re-inlines it in memory and must reproduce these exact bytes.'}};
await fs.writeFile(path.join(out, 'index.html'), html);
await fs.writeFile(path.join(out, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`index.html ${manifest.bytes} bytes sha256 ${manifest.sha256}`);
