/** Lossless JSON for local round state: bigint -> {$bigint}, bytes -> {$bytes}. Decoding is strict about tag shape;
 * the decoded value is still UNTRUSTED data and must be validated by the caller. */
import {hex,unhex,check} from '../core.mjs';
export const MAX_STATE_TEXT=64_000_000;
export const encodeTagged=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?{$bigint:v.toString()}:v instanceof Uint8Array?{$bytes:hex(v)}:v);
const reviveTagged=v=>{
  if(v&&typeof v==='object'&&!Array.isArray(v)) {
    const keys=Object.keys(v);
    if(keys.length===1&&keys[0]==='$bigint'){check(typeof v.$bigint==='string'&&/^(0|[1-9][0-9]{0,30})$/.test(v.$bigint),'STATE_BIGINT');return BigInt(v.$bigint);}
    if(keys.length===1&&keys[0]==='$bytes'){check(typeof v.$bytes==='string','STATE_BYTES');return unhex(v.$bytes);}
  }
  return v;
};
export function decodeTaggedValue(v) {
  const r=reviveTagged(v);
  if(r!==v||r===null||typeof r!=='object')return r;
  if(Array.isArray(r))return r.map(decodeTaggedValue);
  const out={};
  for(const [k,val] of Object.entries(r))out[k]=decodeTaggedValue(val);
  return out;
}
export function decodeTagged(text) {
  check(typeof text==='string'&&text.length<=MAX_STATE_TEXT,'STATE_TEXT_SIZE');
  let value;
  try {
    value=JSON.parse(text,(_,v)=>reviveTagged(v));
  } catch(e) {const code=typeof e?.code==='string'?e.code:'STATE_PARSE';throw Object.assign(new Error(code),{code});}
  return value;
}
