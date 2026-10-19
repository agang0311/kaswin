/** V2.0.2 runtime boundary. Import is side-effect-free; old lib/pins cannot authorize new operations.
 * Candidate compilation uses low-level codec/hash functions separately, never this approval path. */
import pins from '../../contracts/pins.json' with {type: 'json'};
import * as State from '../core/lib/state.js';
import {failure} from '../chain/operation.mjs';

export const CONTRACT_VERSION = 'V2.0.2';
const approved = /^[0-9a-f]{64}$/.test(State.APPROVED_PROFILE_ID ?? '') &&
  State.CONTRACT_VERSION === CONTRACT_VERSION && pins.contractVersion === CONTRACT_VERSION &&
  pins.profileId === State.APPROVED_PROFILE_ID && pins.compilerCommit === State.COMPILER_COMMIT &&
  pins.approvalStatus !== 'UNAPPROVED_CANDIDATE';
// Never attach the V2.0.2 label to a historical Profile or use it as the new journal namespace.
export const PROFILE_ID = approved ? State.APPROVED_PROFILE_ID : '';
export const CONTRACT_TAG = approved ? `kaswin-${CONTRACT_VERSION.toLowerCase()}@${PROFILE_ID.slice(0, 16)}`
  : `kaswin-${CONTRACT_VERSION.toLowerCase()}@UNAPPROVED`;
export function requireRuntimeVersion() {
  if (!approved) throw failure('V202_RUNTIME_NOT_READY');
}
export function requireRuntimeProfile(profile) {
  requireRuntimeVersion();
  State.assertCompatibleProfile(profile); // recheck mutable frames/content on EVERY operation
}
