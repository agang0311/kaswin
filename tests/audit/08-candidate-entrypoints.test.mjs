// Compile actual public entrypoints with false release literal, then assert they
// refuse BEFORE touching a wallet/node. Source-only, NOT RUN in remediation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const {build} = createRequire(new URL('../../apps/kaswin-v2/package.json', import.meta.url))('esbuild');

test('candidate plan/execute/wallet/submit guards reject before any side effect', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const result = await build({absWorkingDir: root, stdin: {resolveDir: root, contents: `
    export {Engine} from './apps/kaswin-v2/scripts/shared/engine.mjs';
    export {signWithWallet} from './apps/kaswin-v2/scripts/shared/wallet.mjs';
    export {JsonRpc} from './apps/kaswin-v2/scripts/shared/nodes.mjs';
  `}, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', define: {__KASWIN_RELEASE_TRADING__: 'false'}});
  const mod = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
  const forbidden = () => {throw Error('UNEXPECTED_SIDE_EFFECT');};
  const engine = new mod.Engine({pair: {connect: forbidden}, profile: null, indexer: '', openStore: forbidden, locks: {request: forbidden}});
  await assert.rejects(engine.plan(null, null), /READ_ONLY_CANDIDATE/);
  await assert.rejects(engine.execute(null), /READ_ONLY_CANDIDATE/);
  await assert.rejects(mod.signWithWallet(null, null, {p: {getAccounts: forbidden, signPskt: forbidden}}), /READ_ONLY_CANDIDATE/);
  const rpc = new mod.JsonRpc('ws://127.0.0.1:1', {WebSocketImpl: forbidden});
  await assert.rejects(rpc.call('submitTransaction', {}), /READ_ONLY_CANDIDATE/);
});
