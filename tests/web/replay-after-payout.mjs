// Read-only follow-up for the already-authorized 17-shard experiment; no wallet, signing or submit path.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {replay} from '../contracts/tn10-replay.mjs';
const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const campaign=path.join(base,'tests/output/rolling-campaign');
const runDirectory=path.join(base,'tests/contracts/artifacts/tn10/batch-payout-1794724070138');
const outputDirectory=path.join(base,'tests/contracts/artifacts/tn10-index/campaign-payout-20261115');
const statusFile=path.join(campaign,'payout-replay-watch.json');
const status={scope:'READ_ONLY_NODE_REVALIDATION_NOT_FINALITY',runDirectory,outputDirectory,startedAt:new Date().toISOString(),stage:'WAITING_FOR_PAID'};
const save=()=>fs.writeFileSync(statusFile,JSON.stringify(status,null,1)+'\n',{mode:0o600});
try {
 save();const deadline=Date.now()+6*60*60*1000;
 for(;;){
  const s=JSON.parse(fs.readFileSync(path.join(runDirectory,'state.json'),'utf8'));
  if(s.terminal==='PAID'&&s.receipts.every(r=>r.finalized===true)){
   if(s.buys!==4353||s.bought!==4355||s.step!==4359||s.receipts.length!==4359||s.manager||s.frozen.length||s.intent)throw new Error('PAYOUT_FINAL_SHAPE');
   status.stage='REVALIDATING';status.cid=s.cid;status.receipts=s.receipts.length;save();break;
  }
  if(Date.now()>deadline)throw new Error('PAYOUT_REPLAY_WAIT_TIMEOUT');
  await new Promise(r=>setTimeout(r,15000));
 }
 const summary=await replay({runDirectory,outputDirectory}),row=summary.rounds[0];
 if(summary.rounds.length!==1||row.round.cid!==status.cid||row.round.terminal!=='PAID'||row.receipts.length!==4359||new Set(row.receipts.map(r=>r.txid)).size!==4359)throw new Error('PAYOUT_REPLAY_RESULT');
 status.stage='COMPLETE';status.verifiedAt=summary.verifiedAt;status.indexStatus=summary.status;save();
 console.log(JSON.stringify(status));
}catch(e){status.stage='FAILED';status.error=String(e.code??e.safeCode??e.message);save();console.error(status.error);process.exitCode=1;}
