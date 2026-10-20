/** Kastle adapter. Pinned source: forbole/kastle 82dc666027b0f9285f8e382f0babe3d83982f3fe (extension 2.61.1):
 *  api/browser.ts (window.kastle: connect/getAccount/getNetwork/signTx; accountsChanged/networkChanged events) and
 *  lib/wallet/sign-script.ts (signTx signs ONLY the listed inputs with the requested sighash, refuses inputs that already
 *  carry a signature script, never broadcasts, returns serializeToSafeJSON()).
 * Presents the subset of the KasWare page provider that kasware.mjs uses, so the SAME session checks and post-sign
 * verification apply unchanged: committed fields compared, then each 66-byte signature script verified (BIP-340) against
 * the page's own sighash. Nothing else Kastle returns is used.
 */
import {ensure} from '../core.mjs';

// Kastle network IDs (api/browser.ts switchNetwork) -> the KasWare names the network schema compares against.
const NETWORK = {mainnet: 'kaspa_mainnet', 'testnet-10': 'kaspa_testnet_10'};
const shims = new WeakMap();

export function kastleProvider(k = globalThis.kastle) {
  if (!k || typeof k !== 'object' || typeof k.getAccount !== 'function' || typeof k.getNetwork !== 'function') return null;
  let shim = shims.get(k);
  if (shim) return shim; // stable identity: the app compares the session's provider with provider()
  const account = async () => {
    const a = await k.getAccount();
    return a && typeof a.address === 'string' && a.address ? a : null;
  };
  const getNetwork = async () => { const n = await k.getNetwork(); return NETWORK[n] ?? String(n ?? ''); };
  shim = Object.freeze({
    walletName: 'Kastle',
    async requestAccounts() {
      ensure(await k.connect?.() === true, 'Kastle 未授权本页访问账户');
      const a = await account();
      return a ? [a.address] : [];
    },
    // A host that is not connected gets an error from Kastle: report "no account", like KasWare's empty list.
    async getAccounts() { try { const a = await account(); return a ? [a.address] : []; } catch { return []; } },
    getNetwork,
    async getPublicKey() { return (await account())?.publicKey ?? ''; },
    signPskt: typeof k.signTx === 'function' ? async ({txJsonString, options} = {}) => {
      const network = await k.getNetwork();
      ensure(Object.hasOwn(NETWORK, network), `Kastle 当前网络 ${network || '未知'} 不受支持`);
      const scripts = (options?.signInputs ?? []).map(({index, sighashType}) => {
        ensure(Number.isInteger(index) && index >= 0 && sighashType === 1, 'KASTLE_SIGN_OPTION');
        return {inputIndex: index, signType: 'All'}; // no scriptHex: a plain P2PK Schnorr signature for the listed input
      });
      return k.signTx(network, txJsonString, scripts);
    } : undefined,
    on: (event, handler) => k.on?.(event, handler),
    removeListener: (event, handler) => k.removeListener?.(event, handler),
  });
  shims.set(k, shim);
  return shim;
}
