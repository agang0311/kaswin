/** Exact decimal helpers. Amounts are bigint sompi; no Number arithmetic touches money. */
import {check} from '../../scripts/core.mjs';
export const SOMPI=100000000n;
/** Decimal TKAS text -> sompi (at most 8 decimals, no sign, no exponent, no thousands separators). */
export function parseTkas(text) {
  check(typeof text==='string'&&/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,8})?$/.test(text.trim()),'AMOUNT_FORMAT');
  const [a,b='']=text.trim().split('.');return BigInt(a)*SOMPI+BigInt(b.padEnd(8,'0'));
}
export function formatTkas(v) {
  check(typeof v==='bigint','AMOUNT_TYPE');
  const neg=v<0n,a=neg?-v:v,frac=(a%SOMPI).toString().padStart(8,'0').replace(/0+$/,'');
  return (neg?'-':'')+(a/SOMPI).toString()+(frac?'.'+frac:'');
}
/** Non-negative decimal integer text -> bigint (DAA, counts). */
export function parseUint(text,max=(1n<<63n)-1n) {
  check(typeof text==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(text.trim())&&BigInt(text.trim())<=max,'UINT_FORMAT');return BigInt(text.trim());
}
export const shortHash=(h,a=10,b=8)=>!h?'—':h.length<=a+b+1?h:`${h.slice(0,a)}…${h.slice(-b)}`;
/** ~10 DAA/s on TN10; display only. */
export function daaDuration(delta) {
  const s=Number(delta<0n?-delta:delta)/10|0;
  if(s<60)return `${s} 秒`;if(s<3600)return `${Math.floor(s/60)} 分 ${s%60} 秒`;
  if(s<86400)return `${Math.floor(s/3600)} 小时 ${Math.floor(s%3600/60)} 分`;return `${Math.floor(s/86400)} 天 ${Math.floor(s%86400/3600)} 小时`;
}
