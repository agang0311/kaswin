/** Build-mode capability gate. The bundler replaces these identifiers with literal
 * booleans selected by an explicit candidate mode; the default build is read-only.
 * Building happens before testing. Enabled capabilities do not claim test results
 * or public-launch approval, and do not replace per-transaction authorization.
 * No URL, storage, globalThis property or UI control may override a bundled value.
 * Raw Node modules are a development API; browser source without the bundler fails closed.
 * Mainnet is enabled only by --mode=mainnet; --mode=tn10 keeps it read-only. */
import {requireNet} from './chain/network-schema.mjs';
import {failure, requireSyncPermission} from './chain/operation.mjs';

export const TRADING_ENABLED = typeof __KASWIN_RELEASE_TRADING__ === 'boolean'
  ? __KASWIN_RELEASE_TRADING__ : typeof window === 'undefined';
export const MAINNET_TRADING_ENABLED = typeof __KASWIN_MAINNET_TRADING__ === 'boolean'
  ? __KASWIN_MAINNET_TRADING__ : false;
/** Explicit network wins; an absent/unknown network keeps the historical TN10 behaviour. */
export const tradingEnabledFor = net => net?.key === 'mainnet' ? MAINNET_TRADING_ENABLED : TRADING_ENABLED;
export function requireTradingRelease(net = null) {
  if (tradingEnabledFor(net)) return;
  if (net?.key === 'mainnet') {
    throw new Error('READ_ONLY_CANDIDATE: 本页主网为只读模式，禁止签名和提交。Mainnet is read-only in this build; signing and submission are disabled. 可以浏览与复验，但不能在本页签名或提交主网交易。');
  }
  throw new Error('READ_ONLY_CANDIDATE: 本页为只读模式，禁止签名和提交。This build is read-only; signing and submission are disabled.');
}

// Runtime-only CLI capability. Never serialized, read from global flags, or accepted in a browser.
const cliPermits = new WeakMap();
const nativeNode = () => typeof window === 'undefined' && globalThis.process?.release?.name === 'node';
export function createCliSubmitPermit(net, authorize) {
  requireNet(net);
  if (!nativeNode() || typeof authorize !== 'function') throw failure('CLI_SUBMIT_PERMISSION_REQUIRED');
  const permit = Object.freeze({}); cliPermits.set(permit, {genesis: net.genesis, authorize}); return permit;
}
export function requireSubmitPermission(net, permit, request) {
  requireNet(net);
  if (permit == null) return requireTradingRelease(net);
  const grant = cliPermits.get(permit);
  if (!nativeNode() || !grant || grant.genesis !== net.genesis || request.method !== 'submitTransaction') throw failure('CLI_SUBMIT_PERMISSION_REQUIRED');
  const result = grant.authorize(request); requireSyncPermission(result);
  if (result === false) throw failure('CLI_SUBMIT_PERMISSION_REQUIRED');
}
