/** Kaswin Rolling core facade. Pure primitives and the fixed Rolling API share one generated TypeScript library.
 * Importing this module never builds, connects to a node or opens a wallet. */
import {sha256} from './wallet/sha256.mjs';
import {decodeAddress,encodeAddress,addressToSpk} from './wallet/address.mjs';
import {parseFrame as parseFrameCore,loadCandidateProfile as loadCandidateProfileCore} from './core/lib/profile.js';
import {rewardReceiver as rewardReceiverCore} from './core/lib/receiver.js';

// state.js also re-exports the seven byte helpers forwarded by the legacy state.mjs.
// Explicit wrappers below supply the dependencies required by the TypeScript-only API.
export * from './core/lib/index.js';
export {ascii,same,stable,kasToSompi,sompiToKas} from './core/lib/bytes.js';
export {referenceTxId} from './core/lib/transaction.js';
export {p2pk,p2sh,covenantId} from './core/lib/covenant-id.js';
export {blake2b256} from './core/lib/hashes.js';
export {IndexedStore} from './core/lib/persistence.js';
export {REGISTRATION_SOMPI} from './core/lib/registry.js';
export {UserError,ensure,hash32,errorText,HASH} from './errors.mjs';

const addressCodec={decodeAddress,encodeAddress,addressToSpk};

/** @param {import('./core/lib/state.js').Module} module
 * @param {string} artifactText
 * @param {import('./core/lib/profile.js').Trust} trust
 */
export function parseFrame(module,artifactText,trust) {
  return parseFrameCore(module,artifactText,trust,sha256);
}

/** @param {Record<import('./core/lib/state.js').Module,string>} artifactTexts
 * @param {Record<import('./core/lib/state.js').Module,import('./core/lib/profile.js').Trust>} trustedPins
 */
export function loadCandidateProfile(artifactTexts,trustedPins) {
  return loadCandidateProfileCore(artifactTexts,trustedPins,sha256);
}

/** @param {string} address
 * @param {import('./core/lib/receiver.js').ReceiverContext} context
 */
export function rewardReceiver(address,context) {
  return rewardReceiverCore(address,context,addressCodec);
}
