/** Compile the five Rolling templates with the pinned SilverScript compiler, in dependency order.
 * Usage: node build/compile-contracts.mjs [--out-dir <dir>]
 * Offline: expands sources (prepare-sources.mjs), runs silverc, and records actual template hashes in artifacts/template-pins.json.
 * Refuses to run if the compiler binary does not match contracts/toolchain.json. Does not run tests, a VM, a node or signing. */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url)),kaswinRoot=resolve(here,'..'),contractsDir=join(kaswinRoot,'contracts');
const args=process.argv.slice(2);
let outDir=contractsDir;
if(args.length) {
  if(args.length!==2||args[0]!=='--out-dir') throw new Error('Usage: node build/compile-contracts.mjs [--out-dir <dir>]');
  outDir=resolve(args[1]);
}
const tool=JSON.parse(await readFile(join(contractsDir,'toolchain.json'),'utf8'));
const silverc=resolve(kaswinRoot,tool.binaryPath);
if(!existsSync(silverc)) throw new Error('Pinned silverc is not installed: '+tool.binaryPath);
const binarySha=createHash('sha256').update(await readFile(silverc)).digest('hex');
if(binarySha!==tool.compilerBinarySha256) throw new Error('silverc does not match contracts/toolchain.json');
// Dependency order: a template can only be bound to hashes of templates compiled before it.
const ORDER=['win','refund','sealed','frozen','sales'];
const CTOR_BYTES={win:93,refund:63,sealed:59,sales:59,frozen:9217};
const artifacts=join(outDir,'artifacts'),pinsPath=join(artifacts,'template-pins.json');
await mkdir(artifacts,{recursive:true});
for(const m of ORDER) await rm(join(artifacts,m+'.json'),{force:true});
await rm(pinsPath,{force:true});
const pins={};
for(const m of ORDER) {
  const ctorPath=join(artifacts,m+'.ctor.json');
  await writeFile(ctorPath,JSON.stringify([{kind:'bytes',value:new Array(CTOR_BYTES[m]).fill(0)}]));
  const prep=[join(here,'prepare-sources.mjs'),m,'--out-dir',outDir,...(Object.keys(pins).length?['--pins',pinsPath]:[])];
  execFileSync('node',prep,{stdio:['ignore','ignore','inherit']});
  execFileSync(silverc,[join(outDir,m+'.sil'),'--constructor-args',ctorPath,'-o',join(artifacts,m+'.json')],{stdio:['ignore','inherit','inherit']});
  await rm(ctorPath,{force:true});
  const compiled=Object.values(JSON.parse(await readFile(join(artifacts,m+'.json'),'utf8')).contracts)[0].compiled;
  pins[m]={templateHash:Buffer.from(compiled.template_hash).toString('hex')};
  await writeFile(pinsPath,JSON.stringify(pins,null,1)+'\n');
  console.log(m.padEnd(7),'bytecode',String(compiled.bytecode.length).padStart(6),'tail',String(compiled.bytecode.length-1-compiled.state_span.len).padStart(6),'template',pins[m].templateHash);
}
