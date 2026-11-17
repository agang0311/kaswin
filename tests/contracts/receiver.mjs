/** Public reward receiver normalization; never requests a key or a signature. NOT_RUN. */
import {decodeAddress,encodeAddress,addressToSpk} from '../../scripts/wallet/address.mjs';
import {check,hex,unhex} from './state.mjs';
export function rewardReceiver(address,{addressPrefix,configuredGenesis,connectedGenesis}) {
  unhex(configuredGenesis,32);unhex(connectedGenesis,32);
  check(configuredGenesis===connectedGenesis,'NETWORK_GENESIS_MISMATCH');
  check(typeof address==='string'&&typeof addressPrefix==='string','REWARD_ADDRESS');
  const decoded=decodeAddress(address.trim(),addressPrefix);
  check(decoded.version===0&&decoded.payload.length===32,'SCHNORR_P2PK_REQUIRED');
  const canonical=encodeAddress(0,decoded.payload,addressPrefix);
  check(canonical===address.trim().toLowerCase(),'NONCANONICAL_REWARD_ADDRESS');
  const spk=addressToSpk(canonical,addressPrefix);
  return {address:canonical,publicKey:hex(decoded.payload),scriptPublicKey:spk,ownershipProven:false};
}
export function signingRequirement(draft) {
  check(Array.isArray(draft.authorizedInputIndices),'SIGNING_INPUTS');
  return {walletSignatureRequired:draft.authorizedInputIndices.length>0,
    inputIndices:[...draft.authorizedInputIndices],sighashType:'ALL',
    submitReady:false,reason:'ROLLING_PROFILE_AND_BUDGET_NOT_VALIDATED'};
}
