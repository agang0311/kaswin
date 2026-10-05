/** Public historical signed transaction receipts only; NEVER reads wallets/keys or signs/submits. */
import fs from 'node:fs/promises';
import {referenceTxId} from '../scripts/shared/core.mjs';
import assert from 'node:assert/strict';
export async function historyRecord(step='BUY1') {
 const path=new URL(`./fixtures/${step}-public.json`,import.meta.url);
 const receipt=JSON.parse(await fs.readFile(path,'utf8')),s=receipt.signedTransaction;
 const spk=text=>({version:parseInt(text.slice(0,4),16),script:text.slice(4)});
 const t={version:s.version,subnetworkId:s.subnetworkId,payload:s.payload,lockTime:BigInt(s.lockTime),gas:BigInt(s.gas),storageMass:BigInt(s.storageMass),
  inputs:s.inputs.map(i=>({previousOutpoint:{transactionId:i.transactionId,index:i.index},sequence:BigInt(i.sequence),computeBudget:i.computeBudget,signatureScript:i.signatureScript})),
  outputs:s.outputs.map(o=>({value:BigInt(o.value),scriptPublicKey:spk(o.scriptPublicKey),covenant:o.covenant??null}))};
 assert.equal(referenceTxId(t),receipt.txid);
 return {txid:receipt.txid,cid:receipt.cid,createdAt:Date.parse(receipt.createdAt),status:'UNKNOWN',accepted:false,action:'BUY',fee:BigInt(receipt.feeSompi),
  anchors:[],cursors:{},inputs:t.inputs.map(i=>i.previousOutpoint),outputs:t.outputs.map((o,index)=>({index,value:o.value,role:index===0?'STATE':'CHANGE',covenant:o.covenant?.covenantId??null,mine:false,address:null})),
  signed:structuredClone(t),draft:{transaction:t,authorizedInputIndices:[1]}};
}
/** DTO shaped like pinned kaspa-rest-server GET /transactions/{id}; empty payload is null as observed live 2026-10-04. */
export function restDTO(record, accepting = 'cc'.repeat(32), blue = 1) {
 const t=record.signed;
 return {transaction_id:record.txid,version:t.version,subnetwork_id:t.subnetworkId,payload:t.payload===''?null:t.payload,is_accepted:true,accepting_block_hash:accepting,accepting_block_blue_score:blue,
  inputs:t.inputs.map((i,index)=>({transaction_id:record.txid,index,previous_outpoint_hash:i.previousOutpoint.transactionId,previous_outpoint_index:String(i.previousOutpoint.index),signature_script:i.signatureScript,compute_budget:i.computeBudget})),
  outputs:t.outputs.map((o,index)=>({transaction_id:record.txid,index,amount:o.value,script_public_key:o.scriptPublicKey.script,covenant_id:o.covenant?.covenantId??null,covenant_authorizing_input:o.covenant?.authorizingInput??null}))};
}
