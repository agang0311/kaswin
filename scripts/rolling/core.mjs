/** Runtime facade for the generated Rolling TypeScript core.
 * Keep the legacy experiments/rolling API, including its synchronous hash/address calls.
 * Generated lib files must be built explicitly; importing this module never invokes a build.
 */
import {sha256} from '../wallet/sha256.mjs';
import {decodeAddress,encodeAddress,addressToSpk} from '../wallet/address.mjs';
import {parseFrame as parseFrameCore,loadCandidateProfile as loadCandidateProfileCore} from './core/lib/profile.js';
import {rewardReceiver as rewardReceiverCore} from './core/lib/receiver.js';

// state.js also re-exports the seven byte helpers forwarded by the legacy state.mjs.
// Explicit wrappers below supply the dependencies required by the TypeScript-only API.
export * from './core/lib/index.js';

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
