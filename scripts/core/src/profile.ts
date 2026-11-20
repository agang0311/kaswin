/** Candidate artifact authentication, not production approval. TypeScript port of experiments/rolling/profile.mjs.
 * No network or compiler invocation. The SHA-256 implementation is injected (the core never reaches into the wallet layer).
 * Source candidate; NOT_RUN. */
import {ascii,cat,check,hex,same,unhex} from './bytes.js';
import {blake2b256} from './hashes.js';
import {templateHash,scriptFor} from './script.js';
import {covenantId,p2sh,type Outpoint,type Spk} from './covenant-id.js';
import {MODULES,ZERO,DEPOSIT,initial,encode,decode,managerValue,type Module,type State,type ManagerState,type RoundConfig} from './state.js';
export {scriptFor,templateHash};
// Official 1.0.1 package source revision; ABI metadata still reports compiler_version 0.1.0.
export const COMPILER_COMMIT='a17db2c7c95cf9f12f8e1264b21f32a8552af8df';
export const COMPILER_PACKAGE_VERSION='1.0.1';
export type AbiParam=readonly [name:string,kind:string,width?:number];
export const ABI:Readonly<Record<Module,readonly AbiParam[]>>={
  sales:[['action','int'],['originTxId','fixed_bytes',32],['originIndex','int'],['ownTailBytes','int'],['nextTail','bytes'],['data','bytes']],
  sealed:[['action','int'],['ownTailBytes','int'],['nextTail','bytes'],['data','bytes']],
  win:[['action','int'],['ownTailBytes','int'],['targetSizes','bytes']],
  refund:[['action','int'],['ownTailBytes','int'],['targetSizes','bytes']],
  frozen:[['managerRedeemBytes','int'],['managerTailBytes','int']],
};
export type Sha256=(data:Uint8Array)=>Uint8Array;
export interface Trust {artifactSha256:string;sourceSha256:string;}
export interface Frame {tail:Uint8Array;templateHash:string;dispatchTag:string;sourceSha256:string;artifactSha256?:string|undefined;}
export interface Profile {id:string;compilerCommit:string;frames:Record<Module,Frame>;status:'UNVALIDATED';}
/** Authenticated manager UTXO as the caller read it from the node; the redeem script is re-derived and compared. */
export interface ManagerContext {
  cid:string;origin:Outpoint;outpoint:Outpoint;value:bigint;spk:Spk;redeemScript:Uint8Array;utxoDaa:bigint;currentDaa:bigint;
}
const contractName=(m:Module):string=>'KaswinRolling'+m[0]!.toUpperCase()+m.slice(1);
const sha=(sha256:Sha256,text:string):string=>hex(sha256(new TextEncoder().encode(text)));
function bytes(v:unknown):Uint8Array {
  if(typeof v==='string')return unhex(v.replace(/^0x/,''));
  check(Array.isArray(v)&&v.every(n=>Number.isInteger(n)&&n>=0&&n<=255),'ARTIFACT_BYTES');return Uint8Array.from(v as number[]);
}
interface ArtifactParam {name:string;type?:{kind?:string;len?:number}}
export function parseFrame(module:Module,artifactText:string,trust:Trust,sha256:Sha256):Frame {
  check((MODULES as readonly string[]).includes(module)&&trust,'TRUST_REQUIRED');
  unhex(trust.artifactSha256,32);unhex(trust.sourceSha256,32);
  check(sha(sha256,artifactText)===trust.artifactSha256,'ARTIFACT_DIGEST');
  const doc=JSON.parse(artifactText);check(doc.schema_version===1&&doc.compiler_version==='0.1.0','ARTIFACT_VERSION');
  const c=doc.contracts?.[contractName(module)];check(c?.runtime_state?.fields?.length===1&&c.runtime_state.fields[0].name==='ledger','ARTIFACT_STATE');
  const a=c.compiled,raw=bytes(a.bytecode),span=a.state_span;
  check(span.offset===1&&Number.isSafeInteger(span.len)&&span.len>0&&span.len<raw.length-1&&raw[0]===0x6b,'ARTIFACT_FRAME');
  const tail=raw.slice(1+span.len),hash=templateHash(tail);check(hash===hex(bytes(a.template_hash)),'ARTIFACT_TEMPLATE_HASH');
  const e=c.entries?.spend,spec=ABI[module];
  check(e?.params?.length===spec.length&&e.params.every((p:ArtifactParam,i:number)=>{
    const x=spec[i]!;return p.name===x[0]&&p.type?.kind===x[1]&&(x[1]!=='fixed_bytes'||p.type?.len===x[2]);}),'ARTIFACT_ABI');
  unhex(e.dispatch_tag,4);
  return {tail,templateHash:hash,dispatchTag:e.dispatch_tag as string,sourceSha256:trust.sourceSha256,artifactSha256:trust.artifactSha256};
}
export function profileId(frames:Record<Module,Frame>):string {
  for(const m of MODULES){
    const f=frames?.[m];check(f&&templateHash(f.tail)===f.templateHash,'PROFILE_FRAME');
    unhex(f.sourceSha256,32);unhex(f.dispatchTag,4);
  }
  check(new Set(MODULES.map(m=>frames[m].templateHash)).size===5,'TEMPLATE_COLLISION');
  return hex(blake2b256(cat(ascii('KASWIN_ROLLING_PROFILE_V1'),...MODULES.flatMap(m=>[
    unhex(frames[m].sourceSha256,32),unhex(frames[m].templateHash,32),unhex(frames[m].dispatchTag,4)]))));
}
export function loadCandidateProfile(artifactTexts:Record<Module,string>,trustedPins:Record<Module,Trust>,sha256:Sha256):Profile {
  const frames=Object.fromEntries(MODULES.map(m=>[m,parseFrame(m,artifactTexts[m],trustedPins[m],sha256)])) as Record<Module,Frame>;
  return {id:profileId(frames),compilerCommit:COMPILER_COMMIT,frames,status:'UNVALIDATED'};
}
interface ProfileSnap {
  id:string;compilerCommit:string;status:string;
  tails:readonly Uint8Array[];templateHashes:readonly string[];sourceSha256s:readonly string[];dispatchTags:readonly string[];
}
const VERIFIED_PROFILES=new WeakMap<Profile,ProfileSnap>();
export function assertProfile(p:Profile):void {
  check(p?.compilerCommit===COMPILER_COMMIT&&p.status==='UNVALIDATED','CANDIDATE_PROFILE');
  const snap=VERIFIED_PROFILES.get(p);
  if(snap&&snap.id===p.id&&snap.compilerCommit===p.compilerCommit&&snap.status===p.status){
    let ok=true;
    for(let i=0;i<MODULES.length;i++){
      const m=MODULES[i]!,f=p.frames?.[m];
      if(!f||f.templateHash!==snap.templateHashes[i]||f.sourceSha256!==snap.sourceSha256s[i]||f.dispatchTag!==snap.dispatchTags[i]||!(f.tail instanceof Uint8Array)||!same(f.tail,snap.tails[i]!)){ok=false;break;}
    }
    if(ok)return;
  }
  check(profileId(p.frames)===p.id,'PROFILE_CONTENT_CHANGED');
  VERIFIED_PROFILES.set(p,{
    id:p.id,compilerCommit:p.compilerCommit,status:p.status,
    tails:MODULES.map(m=>p.frames[m].tail.slice()),
    templateHashes:MODULES.map(m=>p.frames[m].templateHash),
    sourceSha256s:MODULES.map(m=>p.frames[m].sourceSha256),
    dispatchTags:MODULES.map(m=>p.frames[m].dispatchTag),
  });
}
export function redeem(s:State,p:Profile):Uint8Array {assertProfile(p);return scriptFor(encode(s),p.frames[s.module].tail);}
export function scriptHash(s:State,p:Profile):string {return hex(blake2b256(redeem(s,p)));}
/** The covenant id a genesis of this round would carry: origin outpoint + the initial sales ledger of the same config. */
export function rootId(origin:Outpoint,s:RoundConfig,p:Profile):string {
  const raw=redeem(initial(s.ownerKey,s),p);
  return covenantId(origin,[{index:0,value:DEPOSIT,spk:p2sh(hex(blake2b256(raw)))}]);
}
export function identify(raw:Uint8Array,p:Profile):State {
  assertProfile(p);check(raw instanceof Uint8Array&&raw.length<=250000&&raw[0]===0x6b,'REDEEM_FRAME');
  const m=MODULES.find(name=>{const tail=p.frames[name].tail;return raw.length>tail.length&&same(raw.slice(-tail.length),tail);});
  check(m,'UNSUPPORTED_TEMPLATE');
  let len:number,at:number;
  if(raw[1]!>=1&&raw[1]!<=75){len=raw[1]!;at=2;}
  else if(raw[1]===0x4c){len=raw[2]!;at=3;check(len>75,'NONCANONICAL_PUSH');}
  else{check(raw[1]===0x4d&&raw.length>=4,'LEDGER_PUSH');len=raw[2]!+256*raw[3]!;at=4;check(len>255,'NONCANONICAL_PUSH');}
  check(at+len+p.frames[m].tail.length===raw.length,'REDEEM_LENGTH');
  const s=decode(m,raw.slice(at,at+len));check(same(scriptFor(encode(s),p.frames[s.module].tail),raw),'NONCANONICAL_REDEEM');return s;
}
export function verifyManager(x:ManagerContext,p:Profile):ManagerState {
  assertProfile(p);unhex(x.cid,32);check(x.cid!==ZERO,'CID_ZERO');
  check(typeof x.utxoDaa==='bigint'&&x.utxoDaa>=0n&&typeof x.currentDaa==='bigint'&&x.currentDaa>=x.utxoDaa,'DAA_CONTEXT');
  const s=identify(x.redeemScript,p);check(s.module!=='frozen','MANAGER_ROLE');
  check(rootId(x.origin,s,p)===x.cid,'GENESIS_CID');
  const spk=p2sh(hex(blake2b256(x.redeemScript)));
  check(x.spk?.version===spk.version&&x.spk?.script===spk.script,'MANAGER_SPK');
  check(x.value===managerValue(s),'MANAGER_VALUE');return s;
}
/** Trusted local version registry; unknown profiles never fall back to the old codec. */
export class ProfileRouter<T> {
  readonly #entries=new Map<string,T>();
  register(id:string,adapter:T):void {unhex(id,32);check(!this.#entries.has(id)&&adapter,'PROFILE_REGISTRATION');this.#entries.set(id,adapter);}
  resolve(id:string):T {unhex(id,32);check(this.#entries.has(id),'UNSUPPORTED_PROFILE');return this.#entries.get(id)!;}
}
