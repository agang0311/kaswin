/** Compile the five rolling templates with the pinned SilverScript compiler, in dependency order.
 * Usage: node experiments/rolling/compile.mjs
 * Offline: expands sources (prepare-sources.mjs), runs silverc, and records actual template hashes in artifacts/local-pins.json.
 * Refuses to run if the compiler binary does not match toolchain.json. Does not run tests, a VM, a node or signing.
 * Generated sources and artifacts are git-ignored and are removed and rebuilt from scratch on every run. */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url)),kaswinRoot=resolve(here,'../..');
const tool=JSON.parse(await readFile(join(here,'toolchain.json'),'utf8'));
const silverc=resolve(kaswinRoot,tool.binaryPath);
if(!existsSync(silverc)) throw new Error('Pinned silverc is not installed: '+tool.binaryPath);
const binarySha=createHash('sha256').update(await readFile(silverc)).digest('hex');
if(binarySha!==tool.compilerBinarySha256) throw new Error('silverc does not match toolchain.json');
// Dependency order: a template can only be bound to hashes of templates compiled before it.
const ORDER=['win','refund','sealed','frozen','sales'];
const CTOR_BYTES={win:93,refund:63,sealed:59,sales:59,frozen:9217};
const generated=join(here,'generated'),artifacts=join(here,'artifacts'),pinsPath=join(artifacts,'local-pins.json');
await rm(generated,{recursive:true,force:true});await mkdir(artifacts,{recursive:true});
for(const m of ORDER) await rm(join(artifacts,m+'.json'),{force:true});
await rm(pinsPath,{force:true});
const pins={};
for(const m of ORDER) {
  // Template hash and code tail do not depend on the initial state, so a zero ledger of the real width is used.
  await writeFile(join(artifacts,m+'.ctor.json'),JSON.stringify([{kind:'bytes',value:new Array(CTOR_BYTES[m]).fill(0)}]));
  const prep=['prepare-sources.mjs',m,...(Object.keys(pins).length?['--pins',pinsPath]:[])];
  execFileSync('node',prep.map((a,i)=>i===0?join(here,a):a),{stdio:['ignore','ignore','inherit']});
  execFileSync(silverc,[join(generated,m+'.sil'),'--constructor-args',join(artifacts,m+'.ctor.json'),'-o',join(artifacts,m+'.json')],{stdio:['ignore','inherit','inherit']});
  const compiled=Object.values(JSON.parse(await readFile(join(artifacts,m+'.json'),'utf8')).contracts)[0].compiled;
  pins[m]={templateHash:Buffer.from(compiled.template_hash).toString('hex')};
  await writeFile(pinsPath,JSON.stringify(pins,null,1)+'\n');
  console.log(m.padEnd(7),'bytecode',String(compiled.bytecode.length).padStart(6),'tail',String(compiled.bytecode.length-1-compiled.state_span.len).padStart(6),'template',pins[m].templateHash);
}
