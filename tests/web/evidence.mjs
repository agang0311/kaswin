/** Browser-only execution helpers plus read-only acceptance evidence for the non-TIMEOUT TN10 campaign.
 * Transactions are prepared/signed/sent ONLY through RollingPage's real UI. Exports contain public witnesses, never wallet secrets.
 * Amounts and fees are bigint/decimal strings; a DOM terminal label alone never passes a scenario. */
import fs from 'node:fs';
import path from 'node:path';
import {decodeTagged,encodeTagged} from '../../scripts/store/codec.mjs';
import {connectTN10} from '../../scripts/round/prepare.mjs';
import {acceptedAt,searchAccepted,mempoolEntry} from '../../scripts/chain/chain.mjs';
import {unhex} from '../../scripts/core.mjs';

export const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export const key=o=>`${o.transactionId}:${o.index}`;
const unpackReceipt=rc=>{
  if(!Array.isArray(rc))return rc;
  if(rc.length===2)return {txid:rc[0],action:'BUY',accepted:true,candidate:false,finalized:true,feeSompi:rc[1]};
  if(rc.length===3||(rc.length===4&&typeof rc[3]==='string'))return {txid:rc[0],action:rc[1],accepted:true,candidate:false,finalized:true,feeSompi:rc[2],...(rc[3]!=null?{acceptingBlock:rc[3]}:{})};
  return rc;
};
const txTransientMass=t=>{
  let size=94n+BigInt(unhex(t.payload??'').length);
  for(const i of t.inputs)size+=54n+BigInt(unhex(i.signatureScript).length);
  for(const o of t.outputs)size+=18n+BigInt(unhex(o.scriptPublicKey.script).length)+(o.covenant?34n:0n);
  return (4n*size).toString();
};
export async function readRound(page) {
  const r=decodeTagged(await page.exportRoundText());
  return Array.isArray(r?.receipts)?{...r,receipts:r.receipts.map(unpackReceipt)}:r;
}
export function saveJson(file,data) {fs.writeFileSync(file,encodeTagged(data),{mode:0o600});}
export async function openEvidenceRpc(url='ws://127.0.0.1:18210') {return connectTN10([url]);}
export async function stableCursor(rpc,back=300) {
  let at=(await rpc.call('getSink')).sink;
  for(let i=0;i<back;i++)at=(await rpc.call('getBlock',{hash:at,includeTransactions:false})).block.verboseData.selectedParentHash;
  return at;
}
export async function roundReady(page,predicate=round=>!round.intent,timeout=180000) {
  const until=Date.now()+timeout;let last;
  const exportReadySel='#view [data-act=export], #view [data-act=moreRound]:not([disabled])';
  while(Date.now()<until) {
    if(!await page.p.locator('#modal[open]').count()) {
      if(!await page.p.locator(exportReadySel).count()) {
        const card=page.p.locator('[data-open]').first();
        if(await card.count())await card.click({force:true,timeout:2000}).catch(()=>{});
      }
      if(await page.p.locator(exportReadySel).count()) {
        last=await readRound(page);
        if(last.halted)throw new Error(`ROUND_HALTED ${last.halted}`);
        if(last.intent?.status==='REJECTED')throw new Error(`NODE_REJECTED ${last.intent.txid} ${last.intent.nodeError??''}`);
        if(predicate(last))return last;
      }
    }
    await pause(400);
  }
  throw new Error(`ROUND_WAIT_TIMEOUT ${last?.intent?.status??'no-state'}`);
}
export async function waitActionQuote(page,action,timeout=240000) {
  if(action==='TIMEOUT')throw new Error('TIMEOUT_RESERVED_FOR_MANUAL_TEST');
  const until=Date.now()+timeout;
  while(Date.now()<until) {
    if(await page.quoteText())return;
    if(!await page.p.locator('#modal[open]').count()&&await page.enabled(action))await page.clickAct(action,1);
    const toast=await page.toastText();
    if(/余额不足|测试币不够|状态已被别人推进|本机记录已过期/.test(toast))throw new Error(`PREPARE_FAILED ${toast}`);
    await pause(200);
  }
  throw new Error(`QUOTE_TIMEOUT ${action}`);
}
export async function quoteId(page) {
  const txid=await page.p.locator('#modal[open]').evaluate(dialog=>{
    const dt=[...dialog.querySelectorAll('dt')].find(x=>x.textContent.trim()==='交易 ID');
    return dt?.nextElementSibling?.textContent.trim()??null;
  });
  if(!/^[0-9a-f]{64}$/.test(txid??''))throw new Error('QUOTE_TXID_MISSING');
  return txid;
}
export async function sendQuote(page,action,{log=()=>{}}={}) {
  const txid=await quoteId(page);
  // Remove only old toast DOM before the next operation so a previous rejection cannot be mistaken for this send's result.
  await page.p.evaluate(()=>{for(const id of ['toasts','mToasts'])document.getElementById(id)?.replaceChildren();});
  await page.clickSend();const sent=await page.sendResult();
  log(`${action} ${txid} ${sent.status}`);
  if(sent.status!=='SUBMITTED')throw new Error(`SEND_${sent.status} ${action} ${txid} ${sent.toasts.join(' ')}`);
  const round=await roundReady(page,r=>!r.intent&&r.receipts.some(x=>x.txid===txid));
  return {txid,round};
}
export async function executeAction(page,action,options={}) {
  const before=await roundReady(page),step=before.step;
  await waitActionQuote(page,action,options.timeout);
  const result=await sendQuote(page,action,options);
  if(result.round.step!==step+1)throw new Error('STEP_DID_NOT_ADVANCE_ONCE');
  return result;
}
export async function acceptanceEvidence(rpc,txid,{block=null,cursor,timeout=120000,minDepth=100n}={}) {
  const until=Date.now()+timeout;let lastError;
  while(Date.now()<until) {
    try {
      if(!block){const found=await searchAccepted(rpc,txid,cursor);block=found.accepting;if(!block){await pause(300);continue;}}
      const virtualDaa=await rpc.currentDaa(),ev=await acceptedAt(rpc,txid,block),depth=virtualDaa-ev.acceptingDaa;
      if(depth<minDepth){await pause(400);continue;}
      if(ev.inputs.some(x=>x===null))throw new Error('ACCEPTED_SPENT_INPUT_MISSING');
      const fee=ev.inputs.reduce((n,x)=>n+x.value,0n)-ev.tx.outputs.reduce((n,x)=>n+x.value,0n);
      return {txid,accepted:true,acceptingBlock:block,acceptingDaa:ev.acceptingDaa.toString(),checkedAt:new Date().toISOString(),depth:depth.toString(),
        computeMass:ev.computeMass?.toString()??null,storageMass:ev.tx.storageMass.toString(),transientMass:txTransientMass(ev.tx),feeSompi:fee.toString(),
        inputs:ev.tx.inputs.map((i,n)=>({outpoint:key(i.previousOutpoint),covenantId:ev.inputs[n].covenantId,valueSompi:ev.inputs[n].value.toString()})),
        outputs:ev.tx.outputs.map((o,index)=>({index,valueSompi:o.value.toString(),covenantId:o.covenant?.covenantId??null}))};
    } catch(e) {
      lastError=e;const code=e.code??e.safeCode??e.message;
      if(!['NOT_CHAIN','REORG','NOT_ACCEPTED','ACCEPTANCE_MOVED','SINK_BEHIND','RPC_TIMEOUT','READ_VIEW_CHANGED'].includes(code))throw e;
      block=null;await pause(300);
    }
  }
  throw new Error(`ACCEPTANCE_TIMEOUT ${txid} ${lastError?.message??''}`);
}
export async function finalizedRound(page,rpc,{cursor,dir,log=()=>{}}) {
  const round=await roundReady(page,r=>!r.intent&&r.pending.length===0,180000);
  if(!round.terminal)throw new Error('ROUND_NOT_TERMINAL');
  saveJson(path.join(dir,'round.json'),round);
  const evidence=[];
  for(const receipt of round.receipts) {
    const ev=await acceptanceEvidence(rpc,receipt.txid,{block:receipt.acceptingBlock,cursor});
    if(ev.feeSompi!==receipt.feeSompi)throw new Error('ACTUAL_FEE_DIFFERS_FROM_PAGE');
    ev.action=receipt.action;ev.transientMass=receipt.transientMass??ev.transientMass;
    evidence.push(ev);saveJson(path.join(dir,'acceptance.json'),evidence);
  }
  log(`ACCEPTED >=100 DAA: ${evidence.length} transactions, terminal ${round.terminal}`);
  return {round,evidence};
}
export async function absentEvidence(rpc,txid,cursor) {
  for(let retries=0;;retries++)try{
    const found=await searchAccepted(rpc,txid,cursor);
    return {txid,accepted:!!found.accepting,complete:found.complete,inMempool:!!await mempoolEntry(rpc,txid),cursorRetries:retries};
  }catch(e){
    const c=e.code??e.safeCode??e.message;
    if(c!=='CURSOR_REORG'||retries>=3)throw e;
    // Restart the same bounded range; moving its beginning to the tip could miss a real acceptance.
    await pause(300);
  }
}
