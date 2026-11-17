import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fixture,fund,profile,PRICE,FEE} from './fixtures.mjs';
import {buildAction,buildGenesis} from './transactions.mjs';
import {measuredBudgets,runEngine} from './engine-gate.mjs';
import {loadDeploymentProfile,TN10_PROFILE_ID} from './deployment-profile.mjs';
import {schnorrSign,xonlyPubkey} from '../../scripts/wallet/schnorr.mjs';
import {schnorrSighash} from '../../scripts/wallet/sighash.mjs';
import {hex} from './state.mjs';
const secret=createHash('sha256').update('kaswin-engine-gate-public-test-key').digest(),key=hex(xonlyPubkey(secret));
function sign(d) {for(const i of d.authorizedInputIndices)d.transaction.inputs[i].signatureScript='41'+hex(schnorrSign(secret,schnorrSighash(d.transaction,d.inputUtxos,i)))+'01';return d;}
const engineTest=(name,fn)=>test(name,{skip:!process.env.KASWIN_VM_BIN},fn);
test('deployment loader binds actual artifacts to the authorized rolling Profile',async()=>assert.equal((await loadDeploymentProfile()).id,TN10_PROFILE_ID));
engineTest('genesis ordinary input passes real engine; changed signed output fails',()=>{
 const d=buildGenesis(profile,key,{ticketPrice:PRICE,ticketCap:3,minTickets:3,closeEligibleDaa:1000n},{funds:[fund(1,10n*PRICE,key)],fee:FEE,budgets:[10]});
 sign(d);assert.equal(runEngine(d,{limited:true}).inputs[0].usedScriptUnits,100001);
 d.transaction.outputs[1].value--;assert.throws(()=>runEngine(d,{limited:true}),/ENGINE/);
});
engineTest('BUY measures covenant budget and validates every signed input under committed limits',()=>{
 const f=fixture({module:'sales'}),opts={funds:[fund(2,10n*PRICE,key)],fee:FEE,budgets:[65535,65535]},op={action:'BUY',quantity:1,actorKey:key};
 let d=buildAction(f.manager,profile,op,opts);opts.budgets=measuredBudgets(d);assert.equal(opts.budgets[1],10);
 d=sign(buildAction(f.manager,profile,op,opts));assert.equal(runEngine(d,{limited:true}).inputs.length,2);
 d.transaction.inputs[0].computeBudget=0;assert.throws(()=>runEngine(d,{limited:true}),/ENGINE/);
});
engineTest('N=256 empty manager can settle the final payout and refund shard',()=>{
 for(const action of ['PAY_OLD','REFUND_OLD']) {
  const payout=action==='PAY_OLD',f=fixture({module:payout?'win':'refund',cnt:256,local:0,p:240,r:255,c:224});
  const op={action,actorKey:key},targets=payout?f.targets.slice(240):f.targets.slice(255);
  const opts={targets,fee:50000000n,budgets:Array(1+targets.length).fill(65535)};
  let d=buildAction(f.manager,profile,op,opts);opts.budgets=measuredBudgets(d);d=buildAction(f.manager,profile,op,opts);
  assert.equal(d.transition.terminal,payout?'PAID':'REFUNDED');assert.ok(runEngine(d,{limited:true}).inputs.every(x=>x.limitedOk));
 }
});
engineTest('permissionless payout needs no ordinary signature and still validates in real engine',()=>{
 const f=fixture({module:'win',local:3});const op={action:'PAY_SELF',actorKey:key};let opts={fee:FEE,budgets:[65535]};
 let d=buildAction(f.manager,profile,op,opts);opts.budgets=measuredBudgets(d);d=buildAction(f.manager,profile,op,opts);
 assert.deepEqual(d.authorizedInputIndices,[]);assert.equal(runEngine(d,{limited:true}).inputs.length,1);
 d.transaction.outputs[0].scriptPublicKey.script='20'+'ff'.repeat(32)+'ac';assert.throws(()=>runEngine(d,{limited:true}),/ENGINE/);
});
