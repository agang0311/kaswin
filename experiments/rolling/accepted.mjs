/** Interpret already accepted rolling transactions. Caller must authenticate node acceptance,
 * every spent UTXO and PASS-A accessor; this module is not a consensus VM. */
import {scriptPushes,scriptNumber} from '../../scripts/core/lib/accepted.js';
import {stable,same} from '../../scripts/core/lib/bytes.js';
import {outpointKey,validateTransaction} from '../../scripts/core/lib/transaction.js';
import {p2sh} from '../../scripts/core/lib/covenant-id.js';
import {blake2b256} from '../../scripts/core/lib/hashes.js';
import {ABI,identify,verifyManager} from './profile.mjs';
import {ACTION,transition} from './transactions.mjs';
import {check,hex,unhex,fromLe,ZERO,VALUE_LIMIT} from './state.mjs';
export function decodeSpend(signatureScript,p) {
  const pushes=scriptPushes(unhex(signatureScript)),raw=pushes.at(-1);check(raw,'EMPTY_WITNESS');
  const state=identify(raw,p),frame=p.frames[state.module],spec=ABI[state.module];
  check(pushes.length===spec.length+2&&hex(pushes.at(-2))===frame.dispatchTag,'WITNESS_ABI');
  const args={};spec.forEach(([name,type,width],i)=>{
    const b=pushes[i];if(type==='int') {const n=scriptNumber(b);check(n>=0n,'NEGATIVE_ARGUMENT');args[name]=n;}
    else {if(width)check(b.length===width,'ARGUMENT_LENGTH');args[name]=b;}
  });
  return {state,args,raw};
}
function paymentKey(spk) {
  check(spk?.version===0&&/^20[0-9a-f]{64}ac$/.test(spk.script),'P2PK_PAYMENT');return spk.script.slice(2,66);
}
export function interpretAccepted({manager,targets=[],funds=[],transaction:tx,accessor},p) {
  validateTransaction(tx);check(tx.version===1&&tx.inputs.length>=1&&tx.inputs.length<=17,'ROLLING_TRANSACTION');
  const s=verifyManager(manager,p),w=decodeSpend(tx.inputs[0]?.signatureScript,p),a=w.args;
  check(same(w.raw,manager.redeemScript),'SPENT_MANAGER');
  const action=Object.keys(ACTION).find(k=>BigInt(ACTION[k])===a.action);check(action,'UNSUPPORTED_ACTION');
  check(a.ownTailBytes===BigInt(p.frames[s.module].tail.length),'TAIL_LENGTH');
  const contexts=[manager,...targets,...funds];check(contexts.length===tx.inputs.length,'INPUT_CONTEXT');
  check(new Set(contexts.map(f=>outpointKey(f.outpoint))).size===contexts.length,'DUPLICATE_INPUT');
  contexts.forEach((f,i)=>{
    check(outpointKey(f.outpoint)===outpointKey(tx.inputs[i].previousOutpoint),'INPUT_OUTPOINT');
    check(typeof f.value==='bigint'&&f.value>0n&&f.value<=VALUE_LIMIT,'INPUT_VALUE');
  });
  funds.forEach(f=>check((!f.cid||f.cid===ZERO)&&(!f.covenantId||f.covenantId===ZERO),'FUNDING_CID'));
  if(s.module==='sales')check(hex(a.originTxId)===manager.origin.transactionId&&a.originIndex===BigInt(manager.origin.index),'ORIGIN');
  const external=funds.reduce((v,f)=>v+f.value,0n),fee=contexts.reduce((v,f)=>v+f.value,0n)-tx.outputs.reduce((v,o)=>v+o.value,0n);
  const last=tx.outputs.at(-1);check(last,'OUTPUTS');
  // No chosen output when the only output is a manager/creator; actor is then unused.
  const actorKey=last.covenant?ZERO:paymentKey(last.scriptPublicKey);
  const op={action,actorKey,accessor};
  if(action==='BUY') {check(a.data?.length===36,'BUY_DATA');op.quantity=Number(fromLe(a.data.slice(0,4)));op.buyerKey=hex(a.data.slice(4));}
  if(action==='DRAW') {
    check(a.data?.length>=248,'DRAW_DATA');op.proof=a.data.slice(0,240);op.j=Number(fromLe(a.data.slice(240,242)));op.i=Number(fromLe(a.data.slice(242,244)));
    const n=Number(fromLe(a.data.slice(244,248)));check(a.data.length===248+n,'DRAW_PREIMAGE_LENGTH');op.winningRedeem=a.data.slice(248);
  }
  const t=transition(manager,p,op,targets,fee,external);
  if(t.externalCost!==null)check(funds.length>=1&&funds.length<=8,'FUNDING_COUNT');
  else if(action==='REFUND_SELF')check(funds.length<=8,'FUNDING_COUNT');else check(funds.length===0,'FUNDING_COUNT');
  if(s.module==='sales'||s.module==='sealed')check(same(a.data,t.data)&&same(a.nextTail,t.nextTail),'ACTION_WITNESS');
  else {
    check(a.targetSizes.length===targets.length*4,'TARGET_LENGTHS');
    targets.forEach((f,i)=>check(fromLe(a.targetSizes.slice(i*4,i*4+4))===BigInt(f.redeemScript.length),'TARGET_LENGTH'));
  }
  targets.forEach((f,i)=>{
    const fw=decodeSpend(tx.inputs[i+1].signatureScript,p);check(fw.state.module==='frozen'&&same(fw.raw,f.redeemScript),'FROZEN_WITNESS');
    check(fw.args.managerRedeemBytes===BigInt(manager.redeemScript.length)&&fw.args.managerTailBytes===BigInt(p.frames[s.module].tail.length),'MANAGER_LOCATOR');
    check(stable(f.spk)===stable(p2sh(hex(blake2b256(fw.raw)))),'FROZEN_P2SH');
  });
  const expected=t.outputs.map(({value,scriptPublicKey,covenant})=>({value,scriptPublicKey,covenant}));
  const actual=tx.outputs.map(o=>({...o,covenant:o.covenant??null}));check(stable(expected)===stable(actual),'OUTPUT_EFFECTS');
  // Node establishes the actual absolute/relative maturity; metadata cannot override it.
  return {action,fee,next:t.next,terminal:t.terminal,outputs:t.outputs,origin:manager.origin,cid:manager.cid,
    status:'INTERPRETATION_REQUIRES_NODE_ACCEPTANCE'};
}
