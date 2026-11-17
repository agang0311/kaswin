/** Candidate artifact authentication, not production approval. No network or compiler invocation. */
import {sha256} from '../../scripts/wallet/sha256.mjs';
import {ascii, same} from '../../scripts/core/lib/bytes.js';
import {blake2b256} from '../../scripts/core/lib/hashes.js';
import {templateHash, scriptFor} from '../../scripts/core/lib/state.js';
import {covenantId, p2sh} from '../../scripts/core/lib/covenant-id.js';
import {MODULES, ZERO, DEPOSIT, initial, encode, decode, managerValue, check, cat, hex, unhex} from './state.mjs';
export {scriptFor, templateHash};
// Official 1.0.1 package source revision; ABI metadata still reports compiler_version 0.1.0.
export const COMPILER_COMMIT='a17db2c7c95cf9f12f8e1264b21f32a8552af8df';
export const COMPILER_PACKAGE_VERSION='1.0.1';
export const ABI={
  sales:[['action','int'],['originTxId','fixed_bytes',32],['originIndex','int'],['ownTailBytes','int'],['nextTail','bytes'],['data','bytes']],
  sealed:[['action','int'],['ownTailBytes','int'],['nextTail','bytes'],['data','bytes']],
  win:[['action','int'],['ownTailBytes','int'],['targetSizes','bytes']],
  refund:[['action','int'],['ownTailBytes','int'],['targetSizes','bytes']],
  frozen:[['managerRedeemBytes','int'],['managerTailBytes','int']],
};
const contractName=m=>'KaswinRolling'+m[0].toUpperCase()+m.slice(1);
const sha=text=>hex(sha256(new TextEncoder().encode(text)));
function bytes(v) {
  if(typeof v==='string') return unhex(v.replace(/^0x/,''));
  check(Array.isArray(v)&&v.every(n=>Number.isInteger(n)&&n>=0&&n<=255),'ARTIFACT_BYTES'); return Uint8Array.from(v);
}
export function parseFrame(module,artifactText,trust) {
  check(MODULES.includes(module)&&trust,'TRUST_REQUIRED');
  unhex(trust.artifactSha256,32); unhex(trust.sourceSha256,32);
  check(sha(artifactText)===trust.artifactSha256,'ARTIFACT_DIGEST');
  const doc=JSON.parse(artifactText); check(doc.schema_version===1&&doc.compiler_version==='0.1.0','ARTIFACT_VERSION');
  const c=doc.contracts?.[contractName(module)]; check(c?.runtime_state?.fields?.length===1&&c.runtime_state.fields[0].name==='ledger','ARTIFACT_STATE');
  const a=c.compiled, raw=bytes(a.bytecode), span=a.state_span;
  check(span.offset===1&&Number.isSafeInteger(span.len)&&span.len>0&&span.len<raw.length-1&&raw[0]===0x6b,'ARTIFACT_FRAME');
  const tail=raw.slice(1+span.len), hash=templateHash(tail); check(hash===hex(bytes(a.template_hash)),'ARTIFACT_TEMPLATE_HASH');
  const e=c.entries?.spend, spec=ABI[module];
  check(e?.params?.length===spec.length && e.params.every((p,i)=>p.name===spec[i][0]&&p.type?.kind===spec[i][1]&&
    (spec[i][1]!=='fixed_bytes'||p.type.len===spec[i][2])),'ARTIFACT_ABI');
  unhex(e.dispatch_tag,4);
  return {tail,templateHash:hash,dispatchTag:e.dispatch_tag,sourceSha256:trust.sourceSha256,artifactSha256:trust.artifactSha256};
}
export function profileId(frames) {
  for(const m of MODULES) {
    const f=frames?.[m]; check(f&&templateHash(f.tail)===f.templateHash,'PROFILE_FRAME');
    unhex(f.sourceSha256,32); unhex(f.dispatchTag,4);
  }
  check(new Set(MODULES.map(m=>frames[m].templateHash)).size===5,'TEMPLATE_COLLISION');
  return hex(blake2b256(cat(ascii('KASWIN_ROLLING_PROFILE_V1'),...MODULES.flatMap(m=>[
    unhex(frames[m].sourceSha256,32),unhex(frames[m].templateHash,32),unhex(frames[m].dispatchTag,4)]))));
}
export function loadCandidateProfile(artifactTexts,trustedPins) {
  const frames=Object.fromEntries(MODULES.map(m=>[m,parseFrame(m,artifactTexts[m],trustedPins[m])]));
  return {id:profileId(frames),compilerCommit:COMPILER_COMMIT,frames,status:'UNVALIDATED'};
}
export function assertProfile(p) {
  check(p?.compilerCommit===COMPILER_COMMIT&&p.status==='UNVALIDATED','CANDIDATE_PROFILE');
  check(profileId(p.frames)===p.id,'PROFILE_CONTENT_CHANGED');
}
export function redeem(s,p) {assertProfile(p); return scriptFor(encode(s),p.frames[s.module].tail);}
export function scriptHash(s,p) {return hex(blake2b256(redeem(s,p)));}
export function rootId(origin,s,p) {
  const raw=redeem(initial(s.ownerKey,s),p);
  return covenantId(origin,[{index:0,value:DEPOSIT,spk:p2sh(hex(blake2b256(raw)))}]);
}
export function identify(raw,p) {
  assertProfile(p); check(raw instanceof Uint8Array&&raw.length<=250000&&raw[0]===0x6b,'REDEEM_FRAME');
  const m=MODULES.find(name=>{const tail=p.frames[name].tail; return raw.length>tail.length&&same(raw.slice(-tail.length),tail);});
  check(m,'UNSUPPORTED_TEMPLATE');
  let len,at;
  if(raw[1]>=1&&raw[1]<=75) {len=raw[1];at=2;}
  else if(raw[1]===0x4c) {len=raw[2];at=3;check(len>75,'NONCANONICAL_PUSH');}
  else {check(raw[1]===0x4d&&raw.length>=4,'LEDGER_PUSH');len=raw[2]+256*raw[3];at=4;check(len>255,'NONCANONICAL_PUSH');}
  check(at+len+p.frames[m].tail.length===raw.length,'REDEEM_LENGTH');
  const s=decode(m,raw.slice(at,at+len)); check(same(redeem(s,p),raw),'NONCANONICAL_REDEEM'); return s;
}
export function verifyManager(x,p) {
  assertProfile(p); unhex(x.cid,32); check(x.cid!==ZERO,'CID_ZERO');
  check(typeof x.utxoDaa==='bigint'&&x.utxoDaa>=0n&&typeof x.currentDaa==='bigint'&&x.currentDaa>=x.utxoDaa,'DAA_CONTEXT');
  const s=identify(x.redeemScript,p); check(s.module!=='frozen','MANAGER_ROLE');
  check(rootId(x.origin,s,p)===x.cid,'GENESIS_CID');
  const spk=p2sh(hex(blake2b256(x.redeemScript)));
  check(x.spk?.version===spk.version&&x.spk?.script===spk.script,'MANAGER_SPK');
  check(x.value===managerValue(s),'MANAGER_VALUE'); return s;
}
/** Trusted local version registry; unknown profiles never fall back to the old codec. */
export class ProfileRouter {
  #entries=new Map();
  register(id,adapter) {unhex(id,32);check(!this.#entries.has(id)&&adapter,'PROFILE_REGISTRATION');this.#entries.set(id,adapter);}
  resolve(id) {unhex(id,32);check(this.#entries.has(id),'UNSUPPORTED_PROFILE');return this.#entries.get(id);}
}
