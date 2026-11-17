/** Lossless JSON for local round state: bigint -> {$bigint}, bytes -> {$bytes}. Decoding is strict about tag shape;
 * the decoded value is still UNTRUSTED data and must be validated by the caller. */
import {hex,unhex,check} from '../../scripts/rolling/core.mjs';
export const MAX_STATE_TEXT=12_000_000;
export const encodeTagged=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?{$bigint:v.toString()}:v instanceof Uint8Array?{$bytes:hex(v)}:v,2)+'\n';
export function decodeTagged(text) {
  check(typeof text==='string'&&text.length<=MAX_STATE_TEXT,'STATE_TEXT_SIZE');
  let value;
  try {
    value=JSON.parse(text,(_,v)=>{
      if(v&&typeof v==='object'&&!Array.isArray(v)) {
        const keys=Object.keys(v);
        if(keys.length===1&&keys[0]==='$bigint'){check(typeof v.$bigint==='string'&&/^(0|[1-9][0-9]{0,30})$/.test(v.$bigint),'STATE_BIGINT');return BigInt(v.$bigint);}
        if(keys.length===1&&keys[0]==='$bytes'){check(typeof v.$bytes==='string','STATE_BYTES');return unhex(v.$bytes);}
      }
      return v;
    });
  } catch(e) {const code=typeof e?.code==='string'?e.code:'STATE_PARSE';throw Object.assign(new Error(code),{code});}
  return value;
}
