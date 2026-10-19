import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import {buildCore} from './core.mjs';
import {TN10} from '../scripts/chain/tn10.mjs';
import {MAINNET} from '../scripts/chain/mainnet.mjs';
import {webEndpoints} from '../scripts/chain/endpoints.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const modes = new Set(['readonly', 'tn10', 'mainnet']);
const mode = args.length === 0 ? 'readonly' : args[0].startsWith('--mode=') ? args[0].slice(7) : null;
if (args.length > 1 || !modes.has(mode)) throw Error('Usage: node build/build.mjs [--mode=readonly|tn10|mainnet]');
assert.equal(esbuild.version, '0.28.2', 'esbuild 0.28.2 is required');
const sha256 = data => createHash('sha256').update(data).digest('hex');
const capabilities = {tn10Trading: mode !== 'readonly', mainnetTrading: mode === 'mainnet', tn10TestWallet: mode !== 'readonly'};

// Generate the core before importing modules that consume it. Build inputs never include test results.
const coreSources = await buildCore();
const {loadBundle} = await import('../scripts/contract/bundle.mjs');
const {CONTRACT_VERSION} = await import('../scripts/contract/runtime.mjs');
const {pins, frames: loadedFrames, profile} = await loadBundle(path.join(root, 'contracts'));
assert.equal(pins.contractVersion, CONTRACT_VERSION, 'Contract/runtime version mismatch');
const frames = Object.fromEntries(Object.entries(loadedFrames).map(([name, frame]) => [name, {...frame, tail: Buffer.from(frame.tail).toString('hex')}]));

const result = await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['web/app/app.mjs'],
  bundle: true, metafile: true, write: false,
  platform: 'browser', format: 'iife', target: ['es2022'], minify: true, legalComments: 'none', charset: 'utf8',
  define: {
    __KASWIN_RELEASE_TRADING__: JSON.stringify(capabilities.tn10Trading),
    __KASWIN_MAINNET_TRADING__: JSON.stringify(capabilities.mainnetTrading),
    __KASWIN_BROWSER_TEST_WALLET__: JSON.stringify(capabilities.tn10TestWallet),
  },
  plugins: [{name: 'contract-data', setup(build) {
    build.onResolve({filter: /^@kaswin\/data$/}, () => ({path: 'data', namespace: 'contract-data'}));
    build.onLoad({filter: /.*/, namespace: 'contract-data'}, () => ({loader: 'js', contents: `export const frames=${JSON.stringify(frames)};`}));
  }}],
});

const visualImports = new Set(['scripts/core.mjs', 'scripts/chain/rest.mjs']);
for (const [file, {imports}] of Object.entries(result.metafile.inputs)) {
  assert.ok(file.startsWith('web/') || file.startsWith('scripts/') || file.startsWith('contracts/') || file.startsWith('contract-data:'), `Unexpected browser dependency: ${file}`);
  if (file.startsWith('web/ui/')) {
    for (const {path: dependency} of imports) assert.ok(dependency.startsWith('web/ui/') || visualImports.has(dependency), `Visual layer imports application logic: ${file} -> ${dependency}`);
  }
}

const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = await fs.readFile(path.join(root, 'web/ui/styles.css'), 'utf8');
const template = await fs.readFile(path.join(root, 'web/ui/index.template.html'), 'utf8');
for (const marker of ['__APPLICATION_HASH__', '/* APPLICATION */', '/* STYLES */', '<!-- RELEASE_STATUS -->']) {
  assert.equal(template.split(marker).length, 2, `Missing or duplicate template marker: ${marker}`);
}
assert.equal(template.split('__CONTRACT_VERSION__').length, 5, 'Contract version placeholders differ');
const scriptHash = createHash('sha256').update(js).digest('base64');
let notice = '';
if (mode === 'readonly') {
  notice = '<aside class="notice" role="status" data-no-i18n><b>只读模式 / READ-ONLY</b><br>可以浏览与核验，交易计划、签名和提交已禁用。Browsing and verification are available; transaction planning, signing and submission are disabled.</aside>';
} else if (mode === 'tn10') {
  notice = '<aside class="notice" role="status" data-no-i18n><b>TN10 交易模式 / TN10 TRADING</b><br>TN10 可交易，主网仅浏览与核验。Trading is enabled on TN10; mainnet is read-only.</aside>';
}
const html = template.replaceAll('__CONTRACT_VERSION__', CONTRACT_VERSION)
  .replace('__APPLICATION_HASH__', `sha256-${scriptHash}`)
  .replace('<!-- RELEASE_STATUS -->', () => notice)
  .replace('/* STYLES */', () => css)
  .replace('/* APPLICATION */', () => js);
for (const network of [TN10, MAINNET]) {
  const endpoints = webEndpoints(network);
  for (const url of endpoints.nodes) assert.ok(html.includes(url), `Missing configured ${network.key} node: ${url}`);
  if (endpoints.indexer) assert.ok(html.includes(endpoints.indexer), `Missing configured ${network.key} indexer`);
}

const sourceFiles = [...new Set([
  ...Object.keys(result.metafile.inputs).filter(file => !file.startsWith('contract-data:')),
  ...coreSources,
  'package.json', 'package-lock.json', 'build/build.mjs', 'build/core.mjs',
  'web/ui/styles.css', 'web/ui/index.template.html', 'scripts/core/tsconfig.json', 'scripts/core/package.json',
  'scripts/contract/bundle.mjs', 'scripts/contract/sync-layout.mjs',
  'contracts/ledger-layout.json', 'contracts/pins.json', 'contracts/profile.json', 'contracts/artifacts/build-report.json',
  ...['open', 'sealed', 'refunding'].flatMap(name => [`contracts/${name}.sil`, ...['json', 'sil', 'args.json'].map(ext => `contracts/artifacts/${name}-linked.${ext}`)]),
])].sort();
const inputs = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, sha256(await fs.readFile(path.join(root, file)))])));
const manifest = {
  formatVersion: 1,
  mode,
  artifact: {file: 'index.html', bytes: Buffer.byteLength(html), sha256: sha256(html)},
  capabilities,
  contract: {version: CONTRACT_VERSION, profileId: profile.id},
  networks: {tn10: TN10.genesis, mainnet: MAINNET.genesis},
  toolchain: {esbuild: esbuild.version, typescript: '5.8.3'},
  inputs,
};
const out = path.join(root, 'dist');
await fs.mkdir(out, {recursive: true});
await fs.writeFile(path.join(out, 'index.html'), html);
await fs.writeFile(path.join(out, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Built dist/index.html (${manifest.artifact.bytes} bytes, mode=${mode}, sha256=${manifest.artifact.sha256})`);
