/** Expand one source stage; intentionally does NOT compile, test, approve or broadcast.
 * Usage: node experiments/rolling/prepare-sources.mjs win
 *        node experiments/rolling/prepare-sources.mjs sealed --pins /path/to/trusted-pins.json
 * Pins: {win:{templateHash:<nonzero hex>}, refund:{templateHash:...}, ...}.
 * Use hashes from independently checked compiler output, never a remote indexer.
 */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(fileURLToPath(import.meta.url)),args=process.argv.slice(2),module=args.shift();
if(!['win','refund','sealed','frozen','sales'].includes(module)) throw new Error('Expected one module: win/refund/sealed/frozen/sales');
let pins={};
if(args.length) {
  if(args.length!==2||args[0]!=='--pins') throw new Error('Only --pins <trusted-pins.json> is supported');
  pins=JSON.parse(await readFile(args[1],'utf8'));
}
let source=await readFile(join(root,'contracts',module+'.sil.in'),'utf8');
if(source.includes('{{COMMON}}')) source=source.replace('{{COMMON}}',await readFile(join(root,'contracts','common.sil.inc'),'utf8'));
/** Little-endian field readers as stack-neutral expressions. SilverScript inlines every function and keeps its bindings
 * until the enclosing block ends, so decoding helpers would exhaust the 244-item consensus stack. OpSubstr itself fails on
 * a negative or out-of-range slice. U63 is signed: callers must require the decoded value to be non-negative. */
const READERS={U16:2,U32:4,U63:8};
function splitArgs(text) {
  const out=[]; let depth=0,start=0;
  for(let i=0;i<text.length;i++) {
    if('([{'.includes(text[i])) depth++; else if(')]}'.includes(text[i])) depth--;
    else if(text[i]===','&&depth===0) {out.push(text.slice(start,i).trim());start=i+1;}
  }
  out.push(text.slice(start).trim()); return out;
}
function expandReaders(text) {
  for(;;) {
    const m=/\b(U16|U32|U63)\(/.exec(text); if(!m) return text;
    let depth=1,i=m.index+m[0].length; const from=i;
    for(;i<text.length&&depth>0;i++) {if(text[i]==='(') depth++; else if(text[i]===')') depth--;}
    if(depth!==0) throw new Error('Unbalanced '+m[1]+' macro');
    const [bytes,at,...extra]=splitArgs(text.slice(from,i-1)); if(!bytes||!at||extra.length) throw new Error(m[1]+' expects (bytes, offset)');
    const n=READERS[m[1]], body=bytes+'.slice('+at+', ('+at+') + '+n+')';
    text=text.slice(0,m.index)+'OpBin2Num('+body+(n===8?'':' + byte[](0x00)')+')'+text.slice(i);
  }
}
source=expandReaders(source);
source=source.replace(/\{\{([A-Z]+)_HASH\}\}/g,(_,name)=>{
  const hash=pins[name.toLowerCase()]?.templateHash;
  if(typeof hash!=='string'||!/^[0-9a-f]{64}$/.test(hash)||/^0+$/.test(hash)) throw new Error('Missing nonzero trusted template hash: '+name);
  return hash;
});
if(source.includes('{{')) throw new Error('Unresolved source placeholder');
const out=join(root,'generated');await mkdir(out,{recursive:true});
await writeFile(join(out,module+'.sil'),source,{flag:'wx'});
console.log('Prepared '+module+'.sil; compilation and all validation NOT_RUN');
