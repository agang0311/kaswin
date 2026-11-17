// Continue the authorized non-TIMEOUT campaign after independent jobs release their wallets.
// No signing logic here: each child is an explicitly scoped existing runner. Every phase is checkpointed.
import fs from 'node:fs';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {requireCampaignCapacity} from './known-rounds.mjs';
const ROOT=process.cwd(),DIR=path.join(ROOT,'tests/output/rolling-campaign');
const BIN='/root/kaspa/references/toolchains/rolling-vm-target/release/kaswin-rolling-vm';
const initial={schema:'ROLLING_CAMPAIGN_FOLLOWUPS_2',startedAt:new Date().toISOString(),publication:null,smoke:null,refund:null,singleBatch:null,finalSuite:null,contention:null,roundRace:null,fundsConflict:null};
const saved=fs.existsSync(path.join(DIR,'followups.json'))?JSON.parse(fs.readFileSync(path.join(DIR,'followups.json'),'utf8')):null;
const status=saved?.schema===initial.schema?saved:initial;
if(status.error){(status.previousErrors??=[]).push({error:status.error,at:status.finishedAt});delete status.error;delete status.finishedAt;}
const save=()=>fs.writeFileSync(path.join(DIR,'followups.json'),JSON.stringify(status,null,2)+'\n');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const alive=pid=>{try{return fs.readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1][0]!=='Z';}catch{return false;}};
const waitPid=async file=>{const pid=Number(fs.readFileSync(path.join(DIR,file),'utf8'));while(alive(pid))await pause(1000);};
const run=(name,args)=>new Promise((resolve,reject)=>{
 const log=fs.openSync(path.join(DIR,`${name}.log`),'a');
 const child=spawn(process.execPath,args,{cwd:ROOT,env:{...process.env,KASWIN_VM_BIN:BIN},stdio:['ignore',log,log]});
 fs.closeSync(log);fs.writeFileSync(path.join(DIR,`${name}.pid`),String(child.pid)+'\n');
 child.on('error',reject);child.on('exit',(code,signal)=>resolve({code,signal,finishedAt:new Date().toISOString()}));
});
const phase=async(field,name,args,{resumeArgs=null,slots=1}={})=>{
 if(status[field]?.code===0)return;
 const prior=status[field];
 if(prior) {
  if(!resumeArgs||typeof prior.code!=='number')throw new Error(`${field.toUpperCase()}_REQUIRES_RECOVERY; inspect its original pid/log`);
  const pidFile=path.join(DIR,`${name}.pid`);if(fs.existsSync(pidFile)&&alive(Number(fs.readFileSync(pidFile,'utf8'))))throw new Error('ORIGINAL_PHASE_STILL_RUNNING');
 }
 const capacity=await requireCampaignCapacity(slots);
 status[field]={startedAt:new Date().toISOString(),knownActiveBefore:capacity.slotCount,...(prior?{resumeSameRun:true,previousExecution:prior}:{})};save();
 Object.assign(status[field],await run(name,resumeArgs??args));save();
 if(status[field].code!==0)throw new Error(`${field.toUpperCase()}_FAILED; preserve and settle the original durable run`);
};
const refundResume=()=>{
 if(status.refund?.code!==1)return {resumeArgs:null,slots:1};
 let dir;
 for(const line of fs.readFileSync(path.join(DIR,'three-shard-refund.log'),'utf8').split('\n'))try{const row=JSON.parse(line);if(row.run)dir=path.resolve(row.run);}catch{}
 if(!dir||path.dirname(dir)!==path.join(ROOT,'tests/contracts/artifacts/tn10'))throw new Error('REFUND_RESUME_PATH');
 const state=JSON.parse(fs.readFileSync(path.join(dir,'state.json'),'utf8'));
 if(state.scenario!=='three-shard-refund'||state.lane!=='B')throw new Error('REFUND_RESUME_SCOPE');
 return {resumeArgs:['tests/contracts/tn10-run.mjs','--execute',`--resume=${dir}`,'--lane=B','--max-steps=1000','--poll-ms=250'],slots:state.manager||state.intent?0:1};
};
const publishCandidate=()=>{
 const dir=path.join(ROOT,'dist'),candidate='/tmp/kaswin-rolling-campaign-candidate',sha=blob=>createHash('sha256').update(blob).digest('hex');
 const html=path.join(dir,'index.html'),manifest=path.join(dir,'build-manifest.json');
 const old=fs.readFileSync(html),oldManifest=fs.readFileSync(manifest),oldHash=sha(old),next=fs.readFileSync(path.join(candidate,'index.html')),nextHash=sha(next);
 const archive=path.join(dir,'archive',`rolling-tn10-${oldHash.slice(0,8)}`);
 if(oldHash===nextHash)return {sha256:nextHash,alreadyPublished:true};
 for(const [file,content] of [[archive+'.html',old],[archive+'.manifest.json',oldManifest]]){
  if(fs.existsSync(file)){if(sha(fs.readFileSync(file))!==sha(content))throw new Error('ARCHIVE_CONFLICT');}
  else fs.writeFileSync(file,content,{flag:'wx'});
 }
 const install=(source,target)=>{const temp=target+`.campaign-${process.pid}`;fs.copyFileSync(source,temp);fs.renameSync(temp,target);};
 install(path.join(candidate,'index.html'),html);install(path.join(candidate,'build-manifest.json'),manifest);
 try {
  const online=execFileSync('curl',['-fsS','--max-time','25','https://cd311.cn:888/www/rolling-tn10/'],{maxBuffer:1024*1024});
  if(sha(online)!==nextHash)throw new Error('PUBLISHED_HASH_MISMATCH');
  const info=JSON.parse(execFileSync('curl',['-fsS','--max-time','25','https://cd311.cn:888/www/rolling-tn10/api/info'],{encoding:'utf8'}));
  if(info.network!=='testnet-10'||!info.readOnly||info.holdsKeys||info.signs||info.broadcasts)throw new Error('SERVICE_SCOPE_MISMATCH');
  return {sha256:nextHash,previousSha256:oldHash,archive,pageBytes:next.length,info,at:new Date().toISOString()};
 } catch(e){fs.writeFileSync(html,old);fs.writeFileSync(manifest,oldManifest);throw e;}
};
try {
 save();
 await waitPid('browser-suite.pid');
 const log=fs.readFileSync(path.join(DIR,'browser-suite.log'),'utf8');
 if(!log.includes('complete: passed=6, failed=0, requested=6'))throw new Error('BROWSER_SUITE_NOT_COMPLETE_OR_FAILED; stop and recover its profile first');
 if(!status.publication){status.publication=publishCandidate();save();}
 await phase('smoke','candidate-smoke',['tests/web/scenarios.mjs','--scenarios=3,4','--role=b2']);
 await phase('refund','three-shard-refund',['tests/contracts/tn10-run.mjs','--execute','--scenario=three-shard-refund','--lane=B','--max-steps=1000','--poll-ms=250'],refundResume());
 await phase('singleBatch','candidate-single-batch',['tests/web/scenarios.mjs','--scenarios=3','--buys=1','--quantity=3','--role=b2']);
 await phase('finalSuite','candidate-final-suite',['tests/web/scenarios.mjs','--scenarios=1,2,5,6','--role=b2']);
 await waitPid('batch-payout.pid');
 const batchDir=fs.readFileSync(path.join(DIR,'batch-run-path.txt'),'utf8').trim();
 const batch=JSON.parse(fs.readFileSync(path.join(batchDir,'state.json'),'utf8'));
 if(batch.terminal!=='PAID'||batch.receipts.some(r=>r.finalized!==true))throw new Error('BATCH_PAYOUT_NOT_FINAL; resume same run before further wallet use');
 await phase('contention','contention',['tests/web/contention.mjs','--cases=three-buy,close,buy-close,cross-node','--attempts=4']);
 await phase('roundRace','candidate-round-double-spend',['tests/web/round-double-spend.mjs']);
 await phase('fundsConflict','candidate-funds-conflict',['tests/web/double-spend.mjs','--phases=1,2,3','--attempts=2'],{slots:2});
 status.finishedAt=new Date().toISOString();save();
} catch(e) {status.error=String(e.message);status.finishedAt=new Date().toISOString();save();console.error(status.error);process.exitCode=1;}
