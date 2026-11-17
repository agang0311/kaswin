/** Per-transaction real-engine gate for the TN10 experiment. No signing, RPC or fixture imports. */
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {check} from '../../scripts/core.mjs';
export function engineCase(draft,{execute,accessor=null,limited=false}={}) {
  const t=draft.transaction;
  return {name:'deployment',expect:'pass',limited,execute:execute??t.inputs.map((_,i)=>i),
    seq:accessor?[{blockHash:accessor.blockHash,commitment:accessor.sequenceCommitment}]:[],
    tx:{version:t.version,lockTime:String(t.lockTime),subnetworkId:t.subnetworkId,gas:String(t.gas),payload:t.payload,
      inputs:t.inputs.map(i=>({txid:i.previousOutpoint.transactionId,index:i.previousOutpoint.index,sigscript:i.signatureScript,sequence:String(i.sequence),computeBudget:i.computeBudget})),
      outputs:t.outputs.map(o=>({value:String(o.value),spkVersion:o.scriptPublicKey.version,spk:o.scriptPublicKey.script,covenant:o.covenant??null}))},
    utxos:draft.inputUtxos.map(u=>({value:String(u.value),spkVersion:u.spk.version,spk:u.spk.script,daa:String(u.utxoDaa??u.daa),covenantId:u.covenantId??u.cid??null}))};
}
export function runEngine(draft,options={}) {
  const bin=process.env.KASWIN_VM_BIN;check(bin,'KASWIN_VM_BIN_REQUIRED');
  const pin=JSON.parse(readFileSync(new URL('./engine-pin.json',import.meta.url),'utf8'));
  const digest=data=>createHash('sha256').update(data).digest('hex');
  check(digest(readFileSync(bin))===pin.binarySha256,'ENGINE_BINARY_PIN');
  for(const [name,sha] of Object.entries(pin.sourceFiles))check(digest(readFileSync(new URL(name,import.meta.url)))===sha,'ENGINE_SOURCE_PIN');
  const dir=mkdtempSync(join(tmpdir(),'kaswin-engine-'));
  try {
    const input=join(dir,'input.ndjson'),output=join(dir,'output.ndjson'),c=engineCase(draft,options);
    writeFileSync(input,JSON.stringify(c)+'\n',{mode:0o600});
    const r=spawnSync(bin,[input,output],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
    check(!r.error&&r.status===0,'ENGINE_PROCESS_FAILED');
    const rows=readFileSync(output,'utf8').trim().split('\n');check(rows.length===1,'ENGINE_RESULT_COUNT');
    const result=JSON.parse(rows[0]);check(result.name==='deployment'&&!result.contextError&&result.matches,'ENGINE_REJECTED');
    check(result.inputs.length===c.execute.length&&result.inputs.every((x,i)=>x.input===c.execute[i]&&x.ok&&(!options.limited||x.limitedOk)),'ENGINE_INPUT_COVERAGE');
    return result;
  } finally {rmSync(dir,{recursive:true,force:true});}
}
/** Ordinary Schnorr inputs are measured in the final signed pass; manager/frozen inputs are measured before signing. */
export function measuredBudgets(draft,accessor=null) {
  const auth=new Set(draft.authorizedInputIndices),execute=draft.transaction.inputs.flatMap((_,i)=>auth.has(i)?[]:[i]);
  const budgets=draft.transaction.inputs.map(()=>10);
  if(execute.length) for(const x of runEngine(draft,{execute,accessor}).inputs) budgets[x.input]=x.minBudget+1;
  return budgets;
}
