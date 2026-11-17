// Clear an existing losing intent through the real page after independent negative evidence. No signing or submit is allowed.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {RollingPage} from './harness.mjs';
import {acquireWalletLock} from './lock.mjs';
import {loadDeploymentProfile} from '../../experiments/rolling/deployment-profile.mjs';
import {authenticateIntent} from '../../web/rolling-tn10/intent.mjs';
import {mempoolEntry} from '../../scripts/chain/chain.mjs';
import {openEvidenceRpc,readRound,roundReady,saveJson,absentEvidence,pause} from './evidence.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../output/rolling-runs');
const arg=(name,d)=>process.argv.find(x=>x.startsWith(`--${name}=`))?.slice(name.length+3)??d;
const run=path.resolve(arg('run','')),caseName=arg('case','cross-node-1'),role=arg('role','b2'),match=/^(three-buy|close|buy-close|cross-node)-([1-8])$/.exec(caseName);
if(path.dirname(run)!==root||!run.endsWith('-contention')||!match||!['creator','b1','b2'].includes(role))throw new Error('RECOVERY_SCOPE');
const original=JSON.parse(fs.readFileSync(path.join(run,'result.json'),'utf8')).cases.find(x=>x.kind===match[1]&&x.attempt===Number(match[2]));
if(!original?.cid)throw new Error('RECOVERY_CASE_MISSING');
const connection=original.actualConnections.find(x=>x.role===role);if(!connection)throw new Error('RECOVERY_NODE_MISSING');
const readNode=arg('read-node',connection.url),knownNeverForwarded=original.barrierAborted&&original.lateUnforwardedFrames?.[role]>0&&!original.actors.some(x=>x.role===role&&x.forwarded);
if(readNode!==connection.url&&(!knownNeverForwarded||readNode!=='wss://cd311.cn:888/www/rolling-tn10/node'))throw new Error('READ_NODE_SWITCH_SCOPE');
acquireWalletLock(root,role,'existing contention discard only');
const dir=path.join(run,caseName),reportFile=path.join(dir,`discard-recovery-${role}.json`),report={scope:'EXISTING_INTENT_DISCARD_ONLY_NO_SIGNING_OR_BROADCAST',cid:original.cid,role,node:connection.url,startedAt:new Date().toISOString(),attempts:[]};
if(fs.existsSync(reportFile))fs.copyFileSync(reportFile,reportFile.replace('.json',`.previous-${Date.now()}.json`));
let blocked=0,originalRpc;const page=new RollingPage({url:'https://cd311.cn:888/www/rolling-tn10/',profileDir:path.join(dir,`profile-${role}`),submitGate:()=>{blocked++;},log:console.log}),rpc=await openEvidenceRpc();
try{
 await page.open();await page.p.waitForFunction(()=>document.getElementById('nodeChip')?.textContent.includes('已连接'),null,{timeout:30000});
 await page.setNode(readNode);await page.connect(role,{publicOnly:true});
 report.uiReadNode=readNode;report.knownNeverForwarded=!!knownNeverForwarded;
 originalRpc=await openEvidenceRpc(connection.url);const info=await originalRpc.call('getInfo');if(info.p2pId!==connection.p2pId)throw new Error('ORIGINAL_NODE_IDENTITY_CHANGED');
 report.originalNodeP2pId=info.p2pId;report.remoteProofTransport='fresh read-only connection to the same original p2pId';
 let r=await roundReady(page,()=>true,60000);if(r.cid!==original.cid)throw new Error('RECOVERY_CID');
 const intent=r.intent;if(!intent)throw new Error('NO_EXISTING_INTENT');await authenticateIntent(intent,await loadDeploymentProfile());
 report.txid=intent.txid;report.originalWireDigest=intent.wireDigest;saveJson(path.join(dir,`before-discard-${role}.json`),r);
 const deadline=Date.now()+240000;
 while(Date.now()<deadline){
  const negative=await absentEvidence(rpc,intent.txid,original.cursor),remotePresent=!!await mempoolEntry(originalRpc,intent.txid);
  if(negative.accepted)throw new Error('ORIGINAL_INTENT_ACCEPTED');
  const discardEnabled=await page.enabled('discard'),called=negative.complete&&!negative.inMempool&&!remotePresent&&discardEnabled;
  if(called)await page.clickAct('discard');
  await pause(1000);r=await readRound(page);
  report.attempts.push({at:new Date().toISOString(),negative,remotePresent,discardEnabled,called,pendingStatus:r.intent?.status??null,toast:await page.toastText(),actions:await page.actions(),logs:(await page.logLines()).slice(0,8)});saveJson(reportFile,report);
  if(!r.intent){report.cleared=true;break;}
  if(r.intent.txid!==intent.txid||r.intent.wireDigest!==intent.wireDigest)throw new Error('ORIGINAL_INTENT_CHANGED');
  await pause(1500);
 }
 if(!report.cleared)throw new Error('DISCARD_DID_NOT_COMPLETE');
 await page.joinText(fs.readFileSync(path.join(dir,'round.json'),'utf8'));r=await readRound(page);
 if(r.cid!==original.cid||r.intent||r.terminal!==original.terminal)throw new Error('FINAL_STATE_IMPORT');
 if(blocked)throw new Error('UNEXPECTED_SUBMISSION_ATTEMPT_BLOCKED');
 report.finalTerminal=r.terminal;report.importedFinalState=true;report.blockedSubmissions=blocked;report.finishedAt=new Date().toISOString();saveJson(reportFile,report);console.log(JSON.stringify({cleared:true,txid:report.txid,terminal:r.terminal,blocked}));
}catch(e){report.error=String(e.code??e.safeCode??e.message);report.blockedSubmissions=blocked;saveJson(reportFile,report);console.error(report.error);process.exitCode=1;}
finally{await page.close_();rpc.close();originalRpc?.close();}
