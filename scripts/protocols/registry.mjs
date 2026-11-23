/** Multi-covenant ProtocolAdapter contract and registry (routed by profileId).
 * Platform code (wallet, chain, store, intent, UI shell) interacts with protocols through this registry
 * so adding a new covenant version (e.g. kUSDT parallel shards) does not disturb existing rounds. */
import {check} from '../core.mjs';

const HASH64=/^[0-9a-f]{64}$/;
export const UNIVERSAL_PHASES=Object.freeze(['OPEN','CLOSING','SEALED','SETTLING','DONE','REFUNDING']);
export const ASSET_KINDS=Object.freeze(['KAS','KCC20']);
export const ASSET_DELTA_ROLES=Object.freeze(['NET','REFUNDABLE_DEPOSIT','CARRIER','FEE']);

export function kasAsset(net=null) {
  return Object.freeze({kind:'KAS',symbol:net?.unit??'KAS',decimals:8,tokenCovenantId:null});
}

export function validateAssetDescriptor(asset,code='PROTOCOL_ASSET') {
  check(asset&&typeof asset==='object',code);
  check(ASSET_KINDS.includes(asset.kind),code);
  check(typeof asset.symbol==='string'&&asset.symbol.length>=1&&asset.symbol.length<=16,code);
  check(Number.isInteger(asset.decimals)&&asset.decimals>=0&&asset.decimals<=18,code);
  if(asset.kind==='KAS') check(asset.tokenCovenantId==null,code);
  else check(typeof asset.tokenCovenantId==='string'&&HASH64.test(asset.tokenCovenantId),code);
  return asset;
}

export function validateProtocolAdapter(adapter) {
  check(adapter&&typeof adapter==='object','PROTOCOL_ADAPTER_INVALID');
  check(typeof adapter.id==='string'&&/^[a-z0-9][a-z0-9-]{0,63}$/.test(adapter.id),'PROTOCOL_ADAPTER_ID');
  check(typeof adapter.name==='string'&&adapter.name.length>=1&&adapter.name.length<=64,'PROTOCOL_ADAPTER_NAME');
  check(typeof adapter.profileId==='string'&&HASH64.test(adapter.profileId),'PROTOCOL_ADAPTER_PROFILE_ID');
  check(typeof adapter.assetFor==='function','PROTOCOL_ADAPTER_ASSET');
  check(adapter.capabilities&&typeof adapter.capabilities==='object','PROTOCOL_ADAPTER_CAPABILITIES');
  for(const fn of ['emptyRound','validateRound','roundFromText','roundToText','availableActions',
    'prepareOperation','signAndRecord','authenticateIntent','submitIntent',
    'verifyIndexedSnapshot','materializeIndexedDocument','syncRound','toRoundSummary']) {
    check(typeof adapter[fn]==='function',`PROTOCOL_ADAPTER_METHOD:${fn}`);
  }
  return adapter;
}

/** Format a minimal-unit bigint amount with an asset descriptor (e.g. KAS=8, kUSDT=6). */
export function formatAssetAmount(amount,asset,{maxFrac=4}={}) {
  const n=typeof amount==='bigint'?amount:BigInt(amount);
  const decimals=asset?.decimals??8;
  const neg=n<0n,abs=neg?-n:n;
  if(decimals===0)return (neg?'-':'')+abs.toString();
  const base=10n**BigInt(decimals);
  const whole=abs/base,fracRaw=(abs%base).toString().padStart(decimals,'0');
  const trimmed=fracRaw.slice(0,Math.min(decimals,maxFrac)).replace(/0+$/,'');
  return (neg?'-':'')+whole.toString()+(trimmed?'.'+trimmed:'');
}

export function createProtocolRegistry(adapters,{defaultCreateProfileId=null}={}) {
  check(Array.isArray(adapters)&&adapters.length>=1,'PROTOCOL_REGISTRY_EMPTY');
  const byProfile=new Map(),byId=new Map();
  for(const raw of adapters) {
    const adapter=validateProtocolAdapter(raw);
    check(!byProfile.has(adapter.profileId),'PROTOCOL_DUPLICATE_PROFILE');
    check(!byId.has(adapter.id),'PROTOCOL_DUPLICATE_ID');
    byProfile.set(adapter.profileId,adapter);
    byId.set(adapter.id,adapter);
  }
  const createDefault=defaultCreateProfileId
    ?byProfile.get(defaultCreateProfileId)
    :[...byProfile.values()].find(a=>a.capabilities.canCreate===true)??null;
  check(createDefault&&createDefault.capabilities.canCreate===true,'PROTOCOL_DEFAULT_CREATE');
  return Object.freeze({
    list(){return [...byProfile.values()];},
    profileIds(){return [...byProfile.keys()];},
    has(profileId){return typeof profileId==='string'&&byProfile.has(profileId);},
    get(profileId){return typeof profileId==='string'?byProfile.get(profileId)??null:null;},
    getById(id){return typeof id==='string'?byId.get(id)??null:null;},
    require(profileId){
      const hit=typeof profileId==='string'?byProfile.get(profileId):null;
      check(hit,'UNSUPPORTED_PROFILE');
      return hit;
    },
    defaultForCreate(){return createDefault;},
  });
}
