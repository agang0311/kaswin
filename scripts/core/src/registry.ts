import {check,unhex} from './bytes.js';
import type {Spk} from './covenant-id.js';

/** Optional ordinary registration payment: client/indexer policy, never covenant authorization.
 * V2.0.2 retains the 0.2 KAS/TKAS policy; archived V2 used 0.05 independently. */
export const REGISTRATION_SOMPI=20_000_000n;
// Network-specific registry addresses/scripts belong to chain/{tn10,mainnet}.mjs.
export function checkRegistrySpk(spk:Spk):Spk {
 check(spk!==null&&Number.isInteger(spk.version)&&spk.version>=0&&spk.version<=65535,'REGISTRY_VERSION');
 check(typeof spk.script==='string'&&spk.script.length>0&&spk.script.length<=2000000,'REGISTRY_SCRIPT');unhex(spk.script);
 return {version:spk.version,script:spk.script.toLowerCase()};
}
