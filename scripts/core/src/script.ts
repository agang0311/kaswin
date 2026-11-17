/** Shared Kaspa script framing and ScriptNum primitives, independent of a contract Profile. */
import {cat,check,fromLe,hex,le} from './bytes.js';
import {blake3,domainHash} from './blake3.js';

export function templateHash(tail:Uint8Array):string {
  check(tail[0]===0x6c,'TEMPLATE_BOUNDARY');
  return hex(blake3(cat(le(1n,8),new Uint8Array([0x6b]),le(BigInt(tail.length),8),tail)));
}
export function pushBytes(b:Uint8Array):Uint8Array {
  const n=b.length;check(n<=0x7fffffff,'PUSH_LIMIT');
  return cat(n===0?new Uint8Array([0]):n<=75?new Uint8Array([n]):n<=255?new Uint8Array([0x4c,n]):n<=65535?cat(new Uint8Array([0x4d]),le(BigInt(n),2)):cat(new Uint8Array([0x4e]),le(BigInt(n),4)),b);
}
export function scriptFor(ledger:Uint8Array,tail:Uint8Array):Uint8Array {
  check(tail[0]===0x6c,'TEMPLATE_BOUNDARY');return cat(new Uint8Array([0x6b]),pushBytes(ledger),tail);
}
export function pushInt(n:bigint):Uint8Array {
  check(n>=0n&&n<1n<<63n,'SCRIPT_NUMBER');if(n===0n)return new Uint8Array([0]);if(n<=16n)return new Uint8Array([0x50+Number(n)]);
  const a:number[]=[];while(n){a.push(Number(n&255n));n>>=8n;}if(a[a.length-1]!&128)a.push(0);return pushBytes(new Uint8Array(a));
}
export function scriptPushes(bytes:Uint8Array):Uint8Array[] {
  check(bytes.length<=250000,'WITNESS_SIZE');
  const out:Uint8Array[]=[];let i=0;
  while(i<bytes.length){
    const op=bytes[i++]!;let n:number;
    if(op===0){out.push(new Uint8Array());continue;}
    if(op===0x4f){out.push(Uint8Array.of(0x81));continue;}
    if(op>=0x51&&op<=0x60){out.push(Uint8Array.of(op-0x50));continue;}
    if(op<=75)n=op;
    else {
      check(op>=0x4c&&op<=0x4e,'NON_PUSH_WITNESS');
      const width=op===0x4c?1:op===0x4d?2:4;
      check(i+width<=bytes.length,'PUSH_HEADER');n=Number(fromLe(bytes.slice(i,i+width)));i+=width;
    }
    check(i+n<=bytes.length,'PUSH_TRUNCATED');out.push(bytes.slice(i,i+n));i+=n;
  }
  return out;
}
/** SIL int ABI: signed ScriptNum, at most eight bytes. */
export function scriptNumber(bytes:Uint8Array):bigint {
  check(bytes.length<=8,'SCRIPT_NUMBER_LENGTH');if(!bytes.length)return 0n;
  const negative=(bytes.at(-1)!&128)!==0,copy=bytes.slice();copy[copy.length-1]=copy.at(-1)!&127;
  const n=fromLe(copy);return negative?-n:n;
}
export function targetSeqOf(opening:Uint8Array):string {
  check(opening.length===240,'PASS_A_LENGTH');
  const branch=(a:Uint8Array,b:Uint8Array)=>domainHash('SeqCommitmentMerkleBranchHash',cat(a,b));
  const seq=(base:number,parent:Uint8Array)=>branch(parent,branch(opening.slice(base,base+32),
    branch(domainHash('SeqCommitMergesetContext',opening.slice(base+64,base+88)),opening.slice(base+32,base+64))));
  return hex(seq(32,seq(152,opening.slice(120,152))));
}
