// Remaining authorized non-TIMEOUT runs after the first contention attempt was safely closed and its losing intent cleared.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {requireCampaignCapacity} from './known-rounds.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),dir=path.join(root,'tests/output/rolling-campaign'),file=path.join(dir,'finish.json');
const status=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{schema:'ROLLING_CAMPAIGN_FINISH_1',startedAt:new Date().toISOString(),crossNode:null,roundRace:null,fundsConflict:null};
const save=()=>fs.writeFileSync(file,JSON.stringify(status,null,1)+'\n',{mode:0o600});
const phases=[
 ['roundRace','finish-round-race',['tests/rolling-web/round-double-spend.mjs'],1],
 ['fundsConflict','finish-funds-conflict',['tests/rolling-web/double-spend.mjs','--phases=1,2,3','--attempts=2'],2],
 ['crossNode','finish-cross-node',['tests/rolling-web/contention.mjs','--cases=cross-node','--attempts=4'],1],
];
try{
 for(const [field,name,args,slots] of phases){
  if(status[field]?.code===0)continue;
  if(status[field])throw new Error(`${field}_REQUIRES_ORIGINAL_PROFILE_RECOVERY`);
  const capacity=await requireCampaignCapacity(slots);
  status[field]={startedAt:new Date().toISOString(),knownActiveBefore:capacity.slotCount};save();
  const fd=fs.openSync(path.join(dir,`${name}.log`),'a',0o600),child=spawn(process.execPath,args,{cwd:root,env:{...process.env,KASWIN_VM_BIN:'/root/kaspa/references/toolchains/rolling-vm-target/release/kaswin-rolling-vm'},stdio:['ignore',fd,fd]});
  fs.closeSync(fd);fs.writeFileSync(path.join(dir,`${name}.pid`),String(child.pid)+'\n');
  const ended=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',(code,signal)=>resolve({code,signal}));});
  status[field]={...status[field],...ended,finishedAt:new Date().toISOString()};save();
  if(ended.code!==0)throw new Error(`${field}_FAILED_STOP_DEPENDENCIES`);
 }
 status.completed=true;status.finishedAt=new Date().toISOString();save();
}catch(e){status.error=String(e.code??e.safeCode??e.message);save();console.error(status.error);process.exitCode=1;}
