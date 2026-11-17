// Read-only recovery of the two historical open browser rounds. Existing accepted transactions are interpreted from node Full data.
// No keys, signing, broadcast, new intents or replacement transactions. Output records are later imported through the real page.
import fs from 'node:fs';
import path from 'node:path';
import {decodeTagged} from '../../scripts/store/codec.mjs';
import {advanceRound,settleCandidate,validateRound} from '../../scripts/round/round.mjs';
import {loadDeploymentProfile} from '../../scripts/contract/bundle.mjs';
import {quoteMass} from '../contracts/mass.mjs';
import {acceptedAt,searchAccepted,matchesDraft} from '../../scripts/chain/chain.mjs';
import {parseSpk} from '../../scripts/chain/nodes.mjs';
import {liveRound} from '../../scripts/round/prepare.mjs';
import {openEvidenceRpc,saveJson} from './evidence.mjs';
const ROOT=process.cwd(),OUT=path.join(ROOT,'tests/output/rolling-campaign/legacy-recovery');fs.mkdirSync(OUT,{recursive:true});
const old=path.join(ROOT,'tests/contracts/artifacts/tn10-browser'),read=file=>decodeTagged(fs.readFileSync(file,'utf8'));
const profile=await loadDeploymentProfile(),rpc=await openEvidenceRpc(),report={schema:'ROLLING_LEGACY_NODE_RECOVERY_1',records:[]};
const view=async(txid,block)=>{
 const observedVirtualDaa=await rpc.currentDaa(),ev=await acceptedAt(rpc,txid,block),depth=observedVirtualDaa-ev.acceptingDaa;
 if(depth<100n||ev.inputs.some(x=>!x))throw new Error('LEGACY_ACCEPTANCE_CONTEXT_MISSING');
 const actualFee=ev.inputs.reduce((n,x)=>n+x.value,0n)-ev.tx.outputs.reduce((n,x)=>n+x.value,0n);
 return {ev,depth,receipt:{txid,tx:ev.tx,acceptingBlock:block,acceptingDaa:ev.acceptingDaa,observedVirtualDaa,actualFee,nodeComputeMass:ev.computeMass,storageMass:ev.tx.storageMass,candidate:false}};
};
const finalize=async round=>{
 let r=round;
 for(const p of [...(r.pending??[])]) {
  const v=await view(p.txid,p.acceptingBlock);matchesDraft(v.ev,p.intent.draft);
  r=settleCandidate(r,p.txid,{depth:v.depth});
 }
 return r;
};
try {
 let initial=await finalize(read(path.join(old,'race-diffnode-1794645315173/round-after-genesis.json')));
 const summary=read(path.join(old,'race-diffnode-1794645315173/race-1-result.json')).buyer1.round;
 const txid=summary.receipts.find(r=>r.action==='BUY').txid;
 const start=initial.receipts.find(r=>r.action==='GENESIS').acceptingBlock;
 // One bounded page around the old known genesis, not an unbounded negative-acceptance search.
 const found=await searchAccepted(rpc,txid,start,{pages:1,sinkLagLimit:2000000n});
 if(!found.accepting)throw new Error('LEGACY_BUY_NOT_FOUND_IN_BOUNDED_PAGE');
 const v=await view(txid,found.accepting),inputs=v.ev.inputs.map((u,i)=>({outpoint:v.ev.tx.inputs[i].previousOutpoint,value:u.value,spk:parseSpk(u.spk),daa:u.daa,utxoDaa:u.daa,currentDaa:v.receipt.observedVirtualDaa,covenantId:u.covenantId,isCoinbase:false}));
 inputs[0]={...initial.manager,...inputs[0]};
 const draft={transaction:v.ev.tx,inputUtxos:inputs,authorizedInputIndices:inputs.flatMap((u,i)=>u.covenantId?[]:[i]),fee:v.receipt.actualFee},mass=quoteMass(draft);
 if(mass.storageMass!==v.ev.tx.storageMass)throw new Error('LEGACY_STORAGE_MASS_MISMATCH');
 // This is interpreter context for an already accepted transaction, not a signed intent to send.
 const context={action:'BUY',quantity:summary.bought,targetCount:0,draft,mass,accessor:null};
 const recovered=advanceRound(initial,context,v.receipt,profile);
 validateRound(recovered,profile);await liveRound(rpc,recovered,profile);
 saveJson(path.join(OUT,'race-diffnode-1794645315173.json'),recovered);
 report.records.push({run:'race-diffnode-1794645315173',cid:recovered.cid,buys:recovered.buys,manager:recovered.manager.outpoint,recoveredTx:txid,acceptingBlock:found.accepting,depth:v.depth.toString(),feeSompi:v.receipt.actualFee.toString(),computeMass:v.ev.computeMass?.toString(),storageMass:v.ev.tx.storageMass.toString(),transientMass:mass.transientMass.toString()});
 const second=await finalize(read(path.join(old,'race-1794645526814/state-3-tickets.json')));
 validateRound(second,profile);await liveRound(rpc,second,profile);
 saveJson(path.join(OUT,'race-1794645526814.json'),second);
 report.records.push({run:'race-1794645526814',cid:second.cid,buys:second.buys,manager:second.manager.outpoint,oldCandidatesNowNodeRechecked:true});
 saveJson(path.join(OUT,'report.json'),report);console.log(JSON.stringify(report));
}finally{rpc.close();}
