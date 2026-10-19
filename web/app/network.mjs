// Selectable Web network (TN10 or Kaspa mainnet). The build guard still forbids importing
// chain/networks.mjs (the CLI catalog); only the two per-network data modules are allowed.
import {TN10} from '../../scripts/chain/tn10.mjs';
import {MAINNET} from '../../scripts/chain/mainnet.mjs';

export const NETWORKS = Object.freeze({tn10: TN10, mainnet: MAINNET});
export const NETWORK_KEYS = Object.freeze(Object.keys(NETWORKS));
export const DEFAULT_KEY = 'tn10';
const KEY = 'kaswin-v2:network';
export const networkOf = key => NETWORKS[key] ?? NETWORKS[DEFAULT_KEY];
/** Persisted selection; an unknown/absent value falls back to TN10. Not a security decision. */
export function loadNetworkKey() {
  try { const v = localStorage.getItem(KEY); return NETWORK_KEYS.includes(v) ? v : DEFAULT_KEY; } catch { return DEFAULT_KEY; }
}
export function saveNetworkKey(key) {
  if (!NETWORK_KEYS.includes(key)) return false;
  try { localStorage.setItem(KEY, key); return true; } catch { return false; }
}
