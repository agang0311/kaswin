/** Opt-in TN10 test wallet. Secrets live only in a revocable closure; no storage, RPC or submit API.
 * Uses the existing pure-JS BIP-340 signer (variable-time BigInt; dedicated test keys only).
 * Compiled candidate gate + explicit TN10 scope, independent of the mainnet release gate.
 */
import {ensure, hex, unhex} from '../core.mjs';
import {TN10} from '../chain/tn10.mjs';
import {requireNet} from '../chain/network-schema.mjs';
import {parseJson, jsonText} from '../chain/json.mjs';
import {parseSpk} from '../chain/nodes.mjs';
import {requireTradingRelease} from '../release-safety.mjs';
import {pubkeyToAddress} from './address.mjs';
import {xonlyPubkey, schnorrSign} from './schnorr.mjs';
import {schnorrSighash} from './sighash.mjs';

export const BROWSER_TEST_WALLET_ENABLED = typeof __KASWIN_BROWSER_TEST_WALLET__ === 'boolean' && __KASWIN_BROWSER_TEST_WALLET__;
let active = null;
export const browserTestWallet = () => active;
export const isBrowserTestWallet = p => !!active && p === active;

export function requireBrowserTestWallet(net) {
  requireNet(net);
  ensure(BROWSER_TEST_WALLET_ENABLED, 'TEST_WALLET_BUILD_REQUIRED');
  ensure(net.key === TN10.key && net.genesis === TN10.genesis && net.networkId === TN10.networkId && net.addressPrefix === TN10.addressPrefix && net.kaswareNetwork === TN10.kaswareNetwork, 'TEST_WALLET_TN10_ONLY');
  ensure(globalThis.isSecureContext === true, 'TEST_WALLET_SECURE_CONTEXT_REQUIRED');
  requireTradingRelease(net);
}
export function clearBrowserTestWallet() {
  const previous = active;
  active = null;
  previous?.destroy();
}

/** Import, do not generate. Caller clears the password input immediately; no secret in returned public metadata.
 * fill(0) is best effort: JavaScript cannot promise erasure of temporary strings/BigInts or browser/OS copies.
 */
export function importBrowserTestWallet(secretHex, {net} = {}) {
  requireBrowserTestWallet(net);
  ensure(typeof secretHex === 'string' && /^[0-9a-fA-F]{64}$/.test(secretHex.trim()), 'TEST_WALLET_KEY_FORMAT');
  const secret = unhex(secretHex.trim().toLowerCase(), 32);
  secretHex = ''; // Do not retain the input string in the signing closure's scope.
  let key;
  try { key = hex(xonlyPubkey(secret)); }
  catch { secret.fill(0); throw Error('TEST_WALLET_KEY_RANGE'); }
  const address = pubkeyToAddress(key, net.addressPrefix), expectedScript = '20' + key + 'ac';
  const listeners = new Map();
  let alive = true;
  const check = () => { ensure(alive, 'TEST_WALLET_CLEARED'); requireBrowserTestWallet(net); };
  const decimal = value => { ensure(typeof value === 'string' && /^\d+$/.test(value), 'TEST_WALLET_TRANSACTION_FORMAT'); return BigInt(value); };
  const wallet = Object.freeze({
    requestAccounts: async () => { check(); return [address]; },
    getAccounts: async () => { check(); return [address]; },
    getNetwork: async () => { check(); return net.kaswareNetwork; },
    getPublicKey: async () => { check(); return key; },
    async signPskt({txJsonString, options} = {}) {
      check();
      ensure(typeof txJsonString === 'string' && txJsonString.length < 8 * 1024 * 1024, 'TEST_WALLET_TRANSACTION_FORMAT');
      const out = parseJson(txJsonString), signInputs = options?.signInputs;
      ensure(Array.isArray(out?.inputs) && Array.isArray(out.outputs) && Array.isArray(signInputs) && signInputs.length > 0, 'TEST_WALLET_TRANSACTION_FORMAT');
      const tx = {version: out.version,
        inputs: out.inputs.map(i => ({previousOutpoint: {transactionId: i.transactionId, index: i.index}, sequence: decimal(i.sequence), signatureScript: i.signatureScript, computeBudget: i.computeBudget ?? 0})),
        outputs: out.outputs.map(o => ({value: decimal(o.value), scriptPublicKey: parseSpk(o.scriptPublicKey), covenant: o.covenant ?? null})),
        lockTime: decimal(out.lockTime), subnetworkId: out.subnetworkId, gas: decimal(out.gas), storageMass: decimal(out.storageMass), payload: out.payload};
      const utxos = out.inputs.map(i => ({outpoint: {transactionId: i.transactionId, index: i.index}, value: decimal(i.utxo?.amount), spk: parseSpk(i.utxo.scriptPublicKey), daa: decimal(i.utxo.blockDaaScore), covenantId: i.utxo.covenantId ?? null}));
      const seen = new Set();
      // Validate the whole requested set before producing any signature. The existing adapter then verifies each
      // signature against its OWN draft and takes no other returned field from this provider.
      for (const {index, sighashType} of signInputs) {
        ensure(Number.isSafeInteger(index) && index >= 0 && index < tx.inputs.length && !seen.has(index) && sighashType === 1, 'TEST_WALLET_SIGN_INPUT');
        seen.add(index);
        ensure(out.inputs[index].utxo.address === address && utxos[index].spk.version === 0 && utxos[index].spk.script === expectedScript && !utxos[index].covenantId, 'TEST_WALLET_INPUT_NOT_OWNED');
      }
      for (const {index} of signInputs) {
        check();
        const aux = crypto.getRandomValues(new Uint8Array(32));
        try { out.inputs[index].signatureScript = '41' + hex(schnorrSign(secret, schnorrSighash(tx, utxos, index), aux)) + '01'; }
        finally { aux.fill(0); }
      }
      check();
      return jsonText(out);
    },
    on(name, fn) { if (alive) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); } },
    removeListener(name, fn) { listeners.get(name)?.delete(fn); },
    destroy() {
      if (!alive) return;
      alive = false; secret.fill(0);
      const callbacks = [...(listeners.get('accountsChanged') ?? [])]; listeners.clear();
      for (const fn of callbacks) { try { fn([]); } catch {} }
    },
  });
  clearBrowserTestWallet();
  active = wallet;
  return wallet;
}
