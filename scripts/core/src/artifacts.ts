/** Load trusted build OUTPUTS, never use registry-provided artifact metadata as trust. */
import {check,hex,unhex} from './bytes.js';
import {MODULES,templateHash,profileId,assertCompatibleProfile,COMPILER_COMMIT,type Profile,type Module,type Frame} from './state.js';
export {COMPILER_COMMIT} from './state.js';
const names={open:'KaswinOpen',sealed:'KaswinSealed',refunding:'KaswinRefunding'};
function object(x:unknown):Record<string,unknown>{check(x!==null&&typeof x==='object'&&!Array.isArray(x),'ARTIFACT_OBJECT');return x as Record<string,unknown>;}
function bytes(x:unknown):Uint8Array {if(typeof x==='string')return unhex(x.replace(/^0x/,''));check(Array.isArray(x)&&x.every(b=>Number.isInteger(b)&&b>=0&&b<=255),'ARTIFACT_BYTES');return new Uint8Array(x);}
const ABI_SPECS:Record<Module,{names:string[];types:{kind:string;len?:number}[]}>={
 open:{
  names:['action','originTxId','originIndex','programTailBytes','nextTail','data','actorPk','fee'],
  types:[{kind:'int'},{kind:'fixed_bytes',len:32},{kind:'int'},{kind:'int'},{kind:'bytes'},{kind:'bytes'},{kind:'pubkey'},{kind:'int'}]
 },
 sealed:{
  names:['action','programTailBytes','nextTail','data','actorPk','fee'],
  types:[{kind:'int'},{kind:'int'},{kind:'bytes'},{kind:'bytes'},{kind:'pubkey'},{kind:'int'}]
 },
 refunding:{
  names:['action','programTailBytes','nextTail','data','actorPk','fee'],
  types:[{kind:'int'},{kind:'int'},{kind:'bytes'},{kind:'bytes'},{kind:'pubkey'},{kind:'int'}]
 }
};
/** Structural parser only; ABI/hash validity is NOT approval for the KW21 codec. */
export function parseCompiledFrame(module:Module,doc:unknown,sourceSha256:string):Frame {
 unhex(sourceSha256,32);const d=object(doc);check(d.schema_version===1&&d.compiler_version==='0.1.0','ARTIFACT_VERSION');
 const c=object(object(d.contracts)[names[module]]),rt=object(c.runtime_state),fields=rt.fields;check(Array.isArray(fields)&&fields.length===1&&object(fields[0]).name==='ledger','ARTIFACT_STATE');
 const a=object(c.compiled),script=bytes(a.bytecode),span=object(a.state_span);check(span.offset===1&&Number.isSafeInteger(span.len),'ARTIFACT_FRAME');
 const len=span.len as number;check(script[0]===0x6b&&len>0&&len<script.length-1,'ARTIFACT_FRAME');
 const tail=script.slice(1+len);check(tail[0]===0x6c,'ARTIFACT_FRAME');const hash=templateHash(tail);check(hash===hex(bytes(a.template_hash)),'ARTIFACT_HASH');
 const entry=object(object(c.entries).spend),params=entry.params;
 const spec=ABI_SPECS[module];
 check(Array.isArray(params)&&params.length===spec.names.length&&params.every((x,i)=>object(x).name===spec.names[i]),'ENTRY_ABI_CHANGED');
 check(params.every((x,i)=>{const t=object(object(x).type),e=spec.types[i]!;return t.kind===e.kind&&(e.kind!=='fixed_bytes'||t.len===e.len);}),'ENTRY_ABI_TYPE_CHANGED');
 check(typeof entry.dispatch_tag==='string','ARTIFACT_TAG');unhex(entry.dispatch_tag,4);
 return {tail,templateHash:hash,dispatchTag:entry.dispatch_tag,sourceSha256};
}
export function makeProfile(frames:Record<Module,Frame>):Profile {
 const p={id:profileId(frames),frames,compilerCommit:COMPILER_COMMIT};
 assertCompatibleProfile(p);return p;
}
export async function loadTrustedProfile(inputs:Record<Module,{text:string;expectedArtifactSha256:string;sourceSha256:string}>):Promise<Profile> {
 const frames={} as Record<Module,Frame>;
 for(const m of MODULES){const x=inputs[m];unhex(x.expectedArtifactSha256,32);const actual=hex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(x.text))));check(actual===x.expectedArtifactSha256,'ARTIFACT_NOT_TRUSTED');frames[m]=parseCompiledFrame(m,JSON.parse(x.text),x.sourceSha256);}
 return makeProfile(frames);
}
