/** Share links for round state: `#join=<code>`. The code carries the same data as "export round state", gzip-compressed and
 * base64url-encoded. It is DATA ONLY: importing it never authenticates anything; the page verifies the live UTXOs before every action. */
const PREFIX={gz:'kwr1.',plain:'kwr0.'} as const;
const bad=(code: string): Error=>Object.assign(new Error(code),{code});
const b64u=(bytes: Uint8Array): string=>{let s='';for(const b of bytes)s+=String.fromCharCode(b);return btoa(s).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');};
const unb64u=(text: string): Uint8Array=>{
  if(!/^[A-Za-z0-9_-]*$/.test(text))throw bad('SHARE_FORMAT');
  const s=atob(text.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-text.length%4)%4));return Uint8Array.from(s,c=>c.charCodeAt(0));
};
export const MAX_SHARE_TEXT=2_000_000;
/** Reads the transformed stream incrementally and aborts past `limit`: a hostile link cannot inflate into memory first. */
async function pipe(bytes: Uint8Array,stream: ReadableWritablePair<Uint8Array,Uint8Array>,limit=MAX_SHARE_TEXT): Promise<Uint8Array> {
  const reader=new Blob([bytes as BlobPart]).stream().pipeThrough(stream).getReader(),parts: Uint8Array[]=[];let size=0;
  for(;;){
    const {done,value}=await reader.read();if(done)break;
    size+=value.length;if(size>limit){await reader.cancel();throw new Error('x');}
    parts.push(value);
  }
  const out=new Uint8Array(size);let at=0;for(const c of parts){out.set(c,at);at+=c.length;}return out;
}
export async function makeShare(text: string): Promise<string> {
  const bytes=new TextEncoder().encode(text);
  if(typeof CompressionStream==='function')return PREFIX.gz+b64u(await pipe(bytes,new CompressionStream('gzip')));
  return PREFIX.plain+b64u(bytes);
}
/** Accepts a full link, a bare code, or the raw round-state JSON; returns the round-state text. */
export async function parseShare(input: unknown): Promise<string> {
  const t=String(input??'').trim();
  if(!t)throw bad('SHARE_EMPTY');
  if(t.startsWith('{'))return t;
  const code=t.includes('#join=')?t.slice(t.indexOf('#join=')+6):t;
  try {
    if(code.startsWith(PREFIX.gz)){
      if(typeof DecompressionStream!=='function')throw new Error('x');
      const out=await pipe(unb64u(code.slice(PREFIX.gz.length)),new DecompressionStream('gzip'));
      return new TextDecoder('utf-8',{fatal:true}).decode(out);
    }
    if(code.startsWith(PREFIX.plain))return new TextDecoder('utf-8',{fatal:true}).decode(unb64u(code.slice(PREFIX.plain.length)));
  } catch(e) {if((e as {code?:string}|null)?.code)throw e;}
  throw bad('SHARE_FORMAT');
}
