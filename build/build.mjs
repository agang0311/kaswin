/** Kaswin browser build: source -> dist/index.html and build-manifest.json.
 * Usage: node build/build.mjs [--mode=mainnet|tn10] [--out-dir=<dir>]
 * Compiles the unified TypeScript core, checks the pinned contracts and browser graph,
 * and embeds the application. Does not test, deploy, connect, sign or broadcast. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import ts from 'typescript';
import {buildCore} from './core.mjs';
import {loadInstalledProtocolBundles} from './protocol-bundles.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha256 = data => createHash('sha256').update(data).digest('hex');
const ALLOWED = [
  /^web\/(app|ui)\/([a-z0-9-]+\/)?[a-z0-9-]+\.(mjs|ts)$/,
  /^scripts\/(chain|wallet|round|store|tracking|contract)\/[a-z0-9-]+\.mjs$/,
  /^scripts\/protocols\/([a-z0-9-]+\/)?[a-z0-9-]+\.mjs$/,
  /^scripts\/core\/lib\/[a-z0-9-]+\.js$/,
  /^scripts\/(core|errors|release-safety)\.mjs$/,
  /^protocol-bundles:/,
  /^node_modules\//,
];
const FORBIDDEN = [
  /^tests\//, /^experiments\//, /^scripts\/indexer\//, /^scripts\/contract\/bundle\.mjs$/, /^build\//,
  /(^|\/)(fixtures|test-signer|engine-gate|tn10-run|tn10-service|tn10-replay|service-client|fake-node)\.mjs$/,
  /\.test\.(mjs|ts)$/, /^scripts\/wallet\/(kasware|kastle|browser-test)\.mjs$/,
];
/** Architectural gate: web/ presentation & wiring files may only import generic protocol contracts/registries, never concrete covenant implementations. */
const WEB_FORBIDDEN_PROTOCOL_IMPORT = /^(?:\.\.\/)*scripts\/protocols\/(?!registry\.mjs$|installed\.mjs$|receipts\.mjs$)|^(?:\.\.\/)*scripts\/contract\/profile-data\.mjs$|^@kaswin\/.*profile/;

export function checkGraph(metafile) {
  const files = Object.keys(metafile.inputs);
  assert.ok(files.length > 20, 'GRAPH_EMPTY');
  for (const [file, {imports}] of Object.entries(metafile.inputs)) {
    assert.ok(!file.startsWith('node:') && !/^\/|\.\.\//.test(file), `GRAPH_ESCAPE: ${file}`);
    assert.ok(ALLOWED.some(r => r.test(file)), `GRAPH_NOT_ALLOWED: ${file}`);
    assert.ok(!FORBIDDEN.some(r => r.test(file)), `GRAPH_FORBIDDEN: ${file}`);
    const isWeb = file.startsWith('web/');
    for (const i of imports) {
      assert.ok(!i.path.startsWith('node:') && !i.external, `GRAPH_NODE_IMPORT: ${file} -> ${i.path}`);
      assert.ok(!FORBIDDEN.some(r => r.test(i.path)), `GRAPH_FORBIDDEN_IMPORT: ${file} -> ${i.path}`);
      if (isWeb) {
        assert.ok(!WEB_FORBIDDEN_PROTOCOL_IMPORT.test(i.path), `GRAPH_WEB_PROTOCOL_COUPLING: ${file} -> ${i.path}`);
      }
    }
  }
  return files;
}

export function typeCheckPage() {
  assert.equal(ts.version, '5.8.3', 'TypeScript 5.8.3 is required');
  const cfgPath = path.join(root, 'web/app/tsconfig.json');
  const host = {getCanonicalFileName: x => x, getCurrentDirectory: () => root, getNewLine: () => '\n'};
  const fail = list => { if (list.length) throw Error('TYPECHECK_FAILED\n' + ts.formatDiagnostics(list, host)); };
  const {config, error} = ts.readConfigFile(cfgPath, ts.sys.readFile);
  fail(error ? [error] : []);
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, path.dirname(cfgPath));
  fail(parsed.errors);
  assert.ok(parsed.fileNames.some(f => f.endsWith('/app.ts')), 'TYPECHECK_NO_APP');
  fail(ts.getPreEmitDiagnostics(ts.createProgram(parsed.fileNames, parsed.options)));
}

export async function buildKaswin({
  outDir = path.join(root, 'dist'),
  mode = 'mainnet',
  defaults = {},
} = {}) {
  assert.ok(mode === 'mainnet' || mode === 'tn10', 'Rolling supports --mode=mainnet or --mode=tn10');
  assert.equal(esbuild.version, '0.28.2', 'esbuild 0.28.2 is required');
  const buildDefaults = {
    mainnetNode: String(defaults.mainnetNode ?? process.env.KASWIN_MAINNET_NODE ?? '').trim(),
    tn10Node: String(defaults.tn10Node ?? process.env.KASWIN_TN10_NODE ?? '').trim(),
    mainnetIndexer: String(defaults.mainnetIndexer ?? process.env.KASWIN_MAINNET_INDEXER ?? '').trim(),
    tn10Indexer: String(defaults.tn10Indexer ?? process.env.KASWIN_TN10_INDEXER ?? '').trim(),
  };
  const coreSources = await buildCore();
  const {MAINNET} = await import('../scripts/chain/mainnet.mjs');
  const {TN10} = await import('../scripts/chain/tn10.mjs');
  const defaultNet = mode === 'mainnet' ? MAINNET : TN10;
  const {TN10_GENESIS} = await import('../scripts/contract/protocol.mjs');
  typeCheckPage();
  assert.equal(TN10_GENESIS, TN10.genesis, 'client TN10 genesis differs from the network table');
  const loaded = await loadInstalledProtocolBundles(root, defaultNet);

  const wcResult = await esbuild.build({
    absWorkingDir: root, entryPoints: ['scripts/wallet/kaspire-wc-entry.mjs'], bundle: true, metafile: true, write: false,
    platform: 'browser', format: 'iife', globalName: '__KASWIN_KASPIRE_WC__', target: ['es2022'], minify: true, legalComments: 'none', charset: 'utf8',
  });
  const wcSources = checkGraph(wcResult.metafile);
  const wcJs = wcResult.outputFiles[0].text;
  assert.ok(!/require\(["']node:|from["']node:/.test(wcJs), 'WC_OUTPUT_NODE_IMPORT');
  const wcIntegrity = `sha256-${createHash('sha256').update(wcJs).digest('base64')}`;

  const virtualContents = `export const protocolBundles=${JSON.stringify(loaded.protocolBundles)};export const defaultCreateProfileId=${JSON.stringify(loaded.defaultCreateProfileId)};export const defaultUiCreateId=${JSON.stringify(loaded.defaultUiCreateId)};`;
  const result = await esbuild.build({
    absWorkingDir: root, entryPoints: ['web/app/app.ts'], bundle: true, metafile: true, write: false,
    platform: 'browser', format: 'iife', target: ['es2022'], minify: true, legalComments: 'none', charset: 'utf8',
    define: {
      __KASWIN_DEFAULT_NET__: JSON.stringify(mode),
      __KASWIN_RELEASE_TRADING__: 'true',
      __KASWIN_MAINNET_TRADING__: JSON.stringify(mode === 'mainnet'),
      __KASWIN_BROWSER_TEST_WALLET__: 'false',
      __KASWIN_DEFAULT_MAINNET_NODE__: JSON.stringify(buildDefaults.mainnetNode),
      __KASWIN_DEFAULT_TN10_NODE__: JSON.stringify(buildDefaults.tn10Node),
      __KASWIN_DEFAULT_MAINNET_INDEXER__: JSON.stringify(buildDefaults.mainnetIndexer),
      __KASWIN_DEFAULT_TN10_INDEXER__: JSON.stringify(buildDefaults.tn10Indexer),
      __KASWIN_KASPIRE_WC_INTEGRITY__: JSON.stringify(wcIntegrity),
    },
    plugins: [
      {
        name: 'protocol-bundles',
        setup(build) {
          build.onResolve({filter: /^@kaswin\/protocol-bundles$/}, () => ({path: 'data', namespace: 'protocol-bundles'}));
          build.onLoad({filter: /.*/, namespace: 'protocol-bundles'}, () => ({loader: 'js', contents: virtualContents}));
        },
      },
    ],
  });
  const sources = checkGraph(result.metafile);
  assert.ok(!sources.some(f => f.includes('@walletconnect/sign-client') || f.includes('node_modules/qrcode/')), 'KASPIRE_WC_STILL_IN_MAIN_BUNDLE');
  const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  assert.ok(!/require\(["']node:|from["']node:/.test(js), 'OUTPUT_NODE_IMPORT');
  const cssRaw = await fs.readFile(path.join(root, 'web/ui/styles.css'), 'utf8');
  const css = (await esbuild.transform(cssRaw, {loader: 'css', minify: true})).code.trim();
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const appVersion = String(pkg.version || '0.0.0');
  const template = await fs.readFile(path.join(root, 'web/ui/index.template.html'), 'utf8');
  for (const m of ['__APPLICATION_HASH__', '/* APPLICATION */', '/* STYLES */', '__PROFILE_ID__', '__APP_VERSION__']) {
    assert.equal(template.split(m).length, 2, `Template marker: ${m}`);
  }
  const scriptHash = createHash('sha256').update(js).digest('base64');
  const html = template
    .replace('__APPLICATION_HASH__', `sha256-${scriptHash}`)
    .replace('__PROFILE_ID__', loaded.primaryProfileId)
    .replace('__APP_VERSION__', appVersion)
    .replace('/* STYLES */', () => css)
    .replace('/* APPLICATION */', () => js);
  assert.ok(sources.includes('scripts/core.mjs') && sources.includes('scripts/core/lib/transactions.js'), 'ROLLING_TS_CORE_NOT_WIRED');
  const inputPaths = [...new Set([
    ...sources.filter(f => !f.startsWith('protocol-bundles:')),
    ...wcSources,
    ...coreSources,
    'build/core.mjs',
    'build/build.mjs',
    'scripts/core/tsconfig.json',
    'scripts/core/package.json',
    'web/ui/index.template.html',
    'web/ui/styles.css',
    'web/app/tsconfig.json',
    'web/app/globals.d.ts',
    'web/app/types.ts',
    'package.json',
    'package-lock.json',
    ...loaded.contractInputPaths,
  ])].sort();
  const inputs = Object.fromEntries(await Promise.all(inputPaths.map(async f => [f, sha256(await fs.readFile(path.join(root, f)))])));
  const manifest = {
    formatVersion: 1,
    version: appVersion,
    mode,
    artifact: {file: 'index.html', bytes: Buffer.byteLength(html), sha256: sha256(html)},
    kaspireWc: {file: 'kaspire-wc.js', bytes: Buffer.byteLength(wcJs), sha256: sha256(wcJs), integrity: wcIntegrity},
    capabilities: {tn10Trading: true, mainnetTrading: mode === 'mainnet', memoryWallet: mode !== 'mainnet', networkSwitch: true},
    contract: {version: loaded.primaryVersion, profileId: loaded.primaryProfileId},
    compatibleProfiles: loaded.compatibleProfiles,
    network: defaultNet.networkId,
    genesis: defaultNet.genesis,
    networks: ['mainnet', 'tn10'],
    profileId: loaded.primaryProfileId,
    evidence: loaded.evidence,
    toolchain: {esbuild: esbuild.version, typescript: ts.version},
    graph: {files: sources.length, nodeImports: 0, forbiddenModules: 0},
    inputs,
  };
  await fs.mkdir(outDir, {recursive: true});
  await fs.writeFile(path.join(outDir, 'index.html'), html);
  await fs.writeFile(path.join(outDir, 'kaspire-wc.js'), wcJs);
  await fs.writeFile(path.join(outDir, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await fs.writeFile(path.join(outDir, '_headers'), [
    '/*',
    "  Content-Security-Policy: frame-ancestors 'none'",
    '  X-Frame-Options: DENY',
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: no-referrer',
    '  Strict-Transport-Security: max-age=31536000; includeSubDomains',
    '',
  ].join('\n'));
  return {html, wcJs, manifest, outDir};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const out = args.find(a => a.startsWith('--out-dir='));
  const mode = args.find(a => a.startsWith('--mode='));
  const flag = name => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const allowed = a => a.startsWith('--out-dir=') || a === '--mode=mainnet' || a === '--mode=tn10'
    || a.startsWith('--mainnet-node=') || a.startsWith('--tn10-node=')
    || a.startsWith('--mainnet-indexer=') || a.startsWith('--tn10-indexer=');
  assert.ok(args.every(allowed), 'Usage: node build/build.mjs [--mode=mainnet|tn10] [--out-dir=<dir>] [--mainnet-indexer=<url>] [--tn10-indexer=<url>] [--mainnet-node=<url>] [--tn10-node=<url>]');
  const {manifest, outDir} = await buildKaswin({
    outDir: out ? path.resolve(out.slice(10)) : undefined,
    mode: mode ? mode.slice(7) : 'mainnet',
    defaults: {
      mainnetNode: flag('mainnet-node'),
      tn10Node: flag('tn10-node'),
      mainnetIndexer: flag('mainnet-indexer'),
      tn10Indexer: flag('tn10-indexer'),
    },
  });
  console.log(`Built ${path.join(outDir, 'index.html')} (${manifest.artifact.bytes} bytes, sha256=${manifest.artifact.sha256}, profile=${manifest.profileId}, ${manifest.graph.files} source files)`);
}
