/** Public reward receiver normalization; never requests a key or a signature. TypeScript port of experiments/rolling/receiver.mjs.
 * The address codec is injected (scripts/wallet/address.mjs provides a compatible one), so the core stays wallet-free. Source candidate; NOT_RUN. */
import {check,hex,unhex} from './bytes.js';
import type {Spk} from './covenant-id.js';

export interface AddressCodec {
  decodeAddress(address:string,expectedPrefix:string|null):{version:number;payload:Uint8Array};
  encodeAddress(version:number,payload:Uint8Array,prefix:string):string;
  addressToSpk(address:string,expectedPrefix:string|null):Spk;
}
export interface ReceiverContext {addressPrefix:string;configuredGenesis:string;connectedGenesis:string;}
export interface RewardReceiver {address:string;publicKey:string;scriptPublicKey:Spk;ownershipProven:false;}
export function rewardReceiver(address:string,{addressPrefix,configuredGenesis,connectedGenesis}:ReceiverContext,codec:AddressCodec):RewardReceiver {
  unhex(configuredGenesis,32);unhex(connectedGenesis,32);
  check(configuredGenesis===connectedGenesis,'NETWORK_GENESIS_MISMATCH');
  check(typeof address==='string'&&typeof addressPrefix==='string','REWARD_ADDRESS');
  const decoded=codec.decodeAddress(address.trim(),addressPrefix);
  check(decoded.version===0&&decoded.payload.length===32,'SCHNORR_P2PK_REQUIRED');
  const canonical=codec.encodeAddress(0,decoded.payload,addressPrefix);
  check(canonical===address.trim().toLowerCase(),'NONCANONICAL_REWARD_ADDRESS');
  const spk=codec.addressToSpk(canonical,addressPrefix);
  return {address:canonical,publicKey:hex(decoded.payload),scriptPublicKey:spk,ownershipProven:false};
}
export interface SigningRequirement {
  walletSignatureRequired:boolean;inputIndices:number[];sighashType:'ALL';submitReady:false;reason:'ROLLING_PROFILE_AND_BUDGET_NOT_VALIDATED';
}
export function signingRequirement(draft:{authorizedInputIndices:readonly number[]}):SigningRequirement {
  check(Array.isArray(draft.authorizedInputIndices),'SIGNING_INPUTS');
  return {walletSignatureRequired:draft.authorizedInputIndices.length>0,
    inputIndices:[...draft.authorizedInputIndices],sighashType:'ALL',
    submitReady:false,reason:'ROLLING_PROFILE_AND_BUDGET_NOT_VALIDATED'};
}
