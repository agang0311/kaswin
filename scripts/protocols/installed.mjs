/** Runtime factory registry of installed covenant protocols.
 * Pure ESM (usable in both Node.js tests and the browser bundle): to plug a new covenant into Kaswin,
 * register its artifact bundle in build/protocol-bundles.mjs and its ProtocolAdapter factory in PROTOCOL_FACTORIES
 * below — web/ stays completely untouched. */
import {profileFromData} from '../contract/profile-data.mjs';
import {unhex} from '../core.mjs';
import {createProtocolRegistry} from './registry.mjs';
import {createRollingV1Adapter} from './rolling-v1.mjs';
import {loadKusdtV2Profile} from './kusdt-v2/profile.mjs';
import {createKusdtV2Adapter} from './kusdt-v2.mjs';

export const PROTOCOL_FACTORIES = Object.freeze({
  'rolling-v1': bundle => {
    const profile = profileFromData(bundle.profileData);
    if (bundle.expectedProfileId && profile.id !== bundle.expectedProfileId) throw new Error('PROFILE_ID');
    return createRollingV1Adapter({profile});
  },
  'kusdt-v2': bundle => {
    const profile = loadKusdtV2Profile(bundle.artifacts, {
      kusdtCid: bundle.pins.kusdtCid,
      expectedHashes: bundle.pins.templates,
    });
    if (bundle.expectedProfileId && profile.id !== bundle.expectedProfileId) throw new Error('PROFILE_ID');
    return createKusdtV2Adapter({
      profile,
      kusdtCid: bundle.pins.kusdtCid,
      kcc20Suffix: unhex(bundle.kcc20SuffixHex),
    });
  },
});

export function buildProtocolRegistryFromBundles(bundles, opts = {}) {
  const adapters = bundles.map(b => {
    const factory = PROTOCOL_FACTORIES[b.id];
    if (!factory) throw new Error(`UNKNOWN_PROTOCOL_BUNDLE:${b.id}`);
    return factory(b);
  });
  return createProtocolRegistry(adapters, opts);
}
