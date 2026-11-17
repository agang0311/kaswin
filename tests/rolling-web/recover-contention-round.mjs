// Resume the exact existing signed contention intent on the local TN10 node, then settle that same CID through the real page.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {RollingPage} from './harness.mjs';
import {acquireWalletLock} from './lock.mjs';
import {loadDeploymentProfile} from '../../experiments/rolling/deployment-profile.mjs';
import {runEngine} from '../../experiments/rolling/engine-gate.mjs';
import {authenticateIntent} from '../../web/rolling-tn10/intent.mjs';
import {verifyInputsLive} from '../../scripts/chain/chain.mjs';
import {openEvidenceRpc,roundReady,saveJson,absentEvidence,acceptanceEvidence,executeAction,finalizedRound} from './evidence.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../output/rolling-runs'),arg=(k,d)=>process.argv.find(x=>x.startsWith(`--${k}=`))?.slice(k.length+3)??d;
const run=path.resolve(arg('run','')),role=arg('role','b2'),caseName=arg('case','cross-node-1');
if(!process.argv.includes('--execute')||path.dirname(run)!==root||!run.endsWith('-contention')||role!=='b2'||caseName!=='cross-node-1')throw new Error('EXISTING_ROUND_RECOVERY_SCOPE');
const c=JSON.parse(fs.readFileSync(path.join(run,'result.json'),'utf8')).cases.find(x=>x.kind==='cross-node'&&x.attempt===1),dir=path.join(run,caseName,'local-original-recovery');fs.mkdirSync(dir,{recursive:true});
if(!c?.cid||!c.cleanupRecoveredOriginal)throw new Error('ORIGINAL_RECOVERY_RECORD_REQUIRED');
acquireWalletLock(root,role,'existing original contention recovery');
const report={scope:'SAME_SIGNED_INTENT_LOCAL_NODE_RECOVERY_THEN_SAME_CID_SETTLEMENT',cid:c.cid,originalTxid:c.cleanupRecoveredOriginal,startedAt:new Date().toISOString()};
const page=new RollingPage({url:'https://cd311.cn:888/www/rolling-tn10/',profileDir:path.join(run,caseName,`profile-${role}`),log:console.log}),rpc=await openEvidenceRpc();
const prior=path.join(dir,'report.json');if(fs.existsSync(prior))fs.copyFileSync(prior,path.join(dir,`report.previous-${Date.now()}.json`));
try{
 await page.open();await page.p.waitForFunction(()=>document.getElementById('nodeChip')?.textContent.includes('已连接'),null,{timeout:30000});
 await page.setNode('wss://cd311.cn:888/www/rolling-tn10/node');await page.connect(role,{publicOnly:true});
 let r=await roundReady(page,()=>true,60000);if(r.cid!==c.cid)throw new Error('RECOVERY_CID');if(!fs.existsSync(path.join(dir,'before.json')))saveJson(path.join(dir,'before.json'),r);
 if(r.intent){
  if(r.intent.txid!==report.originalTxid)throw new Error('ORIGINAL_TXID_CHANGED');
  await authenticateIntent(r.intent,await loadDeploymentProfile());report.originalWireDigest=r.intent.wireDigest;
  const e=runEngine(r.intent.draft,{accessor:r.intent.accessor,limited:true});saveJson(path.join(dir,'original-real-engine.json'),e);
  const observed=await absentEvidence(rpc,r.intent.txid,c.cursor);report.initialObservation=observed;
  if(!observed.accepted&&!observed.inMempool){if(!observed.complete)throw new Error('ORIGINAL_ACCEPTANCE_UNKNOWN');await verifyInputsLive(rpc,r.intent.draft.inputUtxos,{allowDaaDrift:true});await page.clickAct('recover');}
  else await page.clickAct('track');
  r=await roundReady(page,x=>!x.intent&&x.receipts.some(t=>t.txid===report.originalTxid),180000);
 }
 const original=r.receipts.find(x=>x.txid===report.originalTxid);if(!original)throw new Error('ORIGINAL_RECEIPT_REQUIRED');
 report.originalAccepted=await acceptanceEvidence(rpc,original.txid,{block:original.acceptingBlock,cursor:c.cursor});
 await page.connect(role);
 if(!r.terminal)({round:r}=await executeAction(page,'CLOSE',{log:console.log,timeout:360000}));
 for(let n=0;!r.terminal&&n<5;n++)({round:r}=await executeAction(page,'REFUND_SELF',{log:console.log,timeout:360000}));
 const v=await finalizedRound(page,rpc,{cursor:c.cursor,dir,log:console.log});if(v.round.cid!==c.cid||v.round.terminal!=='REFUNDED')throw new Error('RECOVERY_FINAL_STATE');
 report.terminal=v.round.terminal;report.transactions=v.evidence.length;report.feeSompi=v.round.fees.toString();report.completed=true;report.finishedAt=new Date().toISOString();saveJson(path.join(dir,'report.json'),report);console.log(JSON.stringify({recovered:report.originalTxid,terminal:report.terminal,transactions:report.transactions}));
}catch(e){report.error=String(e.code??e.safeCode??e.message);saveJson(path.join(dir,'report.json'),report);console.error(report.error);process.exitCode=1;}
finally{await page.close_();rpc.close();}
