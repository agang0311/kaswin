// Settle the two known historical SALES rounds using buyer2 as executor, through the published page only.
// No new round is created. New receipts are counted separately from the historical receipts already in TN10-EVIDENCE.
import fs from 'node:fs';
import path from 'node:path';
import {RollingPage} from './harness.mjs';
import {acquireWalletLock} from './lock.mjs';
import {decodeTagged} from '../../scripts/store/codec.mjs';
import {saveJson,openEvidenceRpc,stableCursor,roundReady,executeAction,finalizedRound,pause} from './evidence.mjs';
const ROOT=process.cwd(),DIR=path.join(ROOT,'tests/output/rolling-campaign/legacy-recovery');
const rounds=[['race-diffnode-1794645315173','10125025065a89764e41b13c1885ba8a4a56cb2a1f198fdd0a2fb9ee2a71cef4','REFUNDED'],['race-1794645526814','71c28b54bbdb81c11f0cef81b4639c58216b49f52f533f3ef5aab243652f7b99','PAID']];
const stamp=new Date().toISOString().replace(/[:.]/g,'-'),RUN=path.join(ROOT,'tests/output/rolling-runs',`${stamp}-settle-legacy`);
acquireWalletLock(path.join(ROOT,'tests/output/rolling-runs'),'b2','settle historical open rounds');fs.mkdirSync(RUN,{recursive:true});
const log=(...args)=>{const text=`${new Date().toISOString()} ${args.join(' ')}`;console.log(text);fs.appendFileSync(path.join(RUN,'run.log'),text+'\n');};
const report={schema:'ROLLING_LEGACY_SETTLEMENT_1',run:RUN,results:[]},save=()=>saveJson(path.join(RUN,'result.json'),report);
const rpc=await openEvidenceRpc();
try {
 for(const [name,cid,expected] of rounds) {
  const dir=path.join(RUN,name);fs.mkdirSync(dir,{recursive:true});
  const text=fs.readFileSync(path.join(DIR,name+'.json'),'utf8'),before=decodeTagged(text);
  if(before.cid!==cid||before.intent||before.terminal)throw new Error('LEGACY_RECORD_SCOPE');
  const page=new RollingPage({url:process.env.KASWIN_TEST_URL??'http://127.0.0.1:8080/',profileDir:path.join(dir,'profile-b2'),log});
  const result={name,cid,pass:false,priorTransactions:before.receipts.length,priorFeeSompi:before.fees.toString()};report.results.push(result);save();
  try {
   await page.open();await page.setNode(process.env.KASWIN_TEST_NODE??'ws://127.0.0.1:18210');await page.connect('b2');await page.joinText(text);
   let round=await roundReady(page);const cursor=await stableCursor(rpc);
   ({round}=await executeAction(page,'CLOSE',{log}));
   let steps=0;const deadline=Date.now()+600000;
   while(!round.terminal&&steps<12&&Date.now()<deadline) {
    const state=await page.state(),action=['DRAW','PAY_OLD','PAY_SELF','REFUND_OLD','REFUND_SELF'].find(a=>state.acts.includes(a));
    if(!action){await pause(500);round=await roundReady(page);continue;}
    ({round}=await executeAction(page,action,{log}));steps++;
   }
   const done=await finalizedRound(page,rpc,{cursor,dir,log});
   result.terminal=done.round.terminal;result.addedTransactions=done.round.receipts.length-before.receipts.length;
   result.addedFeeSompi=(done.round.fees-before.fees).toString();result.newTxids=done.evidence.slice(before.receipts.length).map(e=>e.txid);
   result.pass=result.terminal===expected;await page.shot(dir,'final');
   if(!result.pass)throw new Error('UNEXPECTED_LEGACY_TERMINAL');
  }catch(e){result.error=String(e.message).slice(0,700);save();throw e;}
  finally{await page.close_();save();}
 }
}finally{rpc.close();save();}
log(`all legacy rounds settled; evidence=${RUN}`);
