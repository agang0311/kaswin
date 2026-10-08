// Source-only regression added for the read-only candidate; NOT RUN in this task.
// Minimum layer: compile the real safety module with the same false literal then
// import that isolated module (no DOM, wallet, node or VM). This is not proof of
// browser enforcement; it protects against accidentally inverted build constants.
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

test('candidate constant refuses trading even in Node; runtime globals cannot opt in', async () => {
  const result = await build({entryPoints: [fileURLToPath(new URL('../scripts/shared/release-safety.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
    define: {__KASWIN_RELEASE_TRADING__: 'false'}});
  const prior = Object.getOwnPropertyDescriptor(globalThis, '__KASWIN_RELEASE_TRADING__');
  try {
    Object.defineProperty(globalThis, '__KASWIN_RELEASE_TRADING__', {value: true, configurable: true});
    const gate = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
    assert.equal(gate.TRADING_ENABLED, false);
    assert.throws(() => gate.requireTradingRelease(), /READ_ONLY_CANDIDATE/);
  } finally {
    if (prior) Object.defineProperty(globalThis, '__KASWIN_RELEASE_TRADING__', prior);
    else delete globalThis.__KASWIN_RELEASE_TRADING__;
  }
});
