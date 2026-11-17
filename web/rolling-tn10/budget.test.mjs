import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fixture,fund,profile,PRICE,FEE} from '../../experiments/rolling/fixtures.mjs';
import {buildAction,buildGenesis} from '../../scripts/rolling/core.mjs';
import {runEngine} from '../../experiments/rolling/engine-gate.mjs';
import {actionBudgets,FUNDING_INPUT_BUDGET,managerBoundUnits} from './budget.mjs';
import {openMemoryWallet} from './wallet.mjs';

const SECRET=createHash('sha256').update('rolling-tn10-budget-test-key').digest('hex');
const W=openMemoryWallet(SECRET);

test('budget model covers every action deterministically with positive bounds and fixed funding budget',()=>{
  const funds=[fund(5,10n*PRICE,W.key)];
  assert.deepEqual(actionBudgets('GENESIS',{funds}),[FUNDING_INPUT_BUDGET]);
  const fBuy=fixture({module:'sales',cnt:2,local:255});
  const bBuy=actionBudgets('BUY',{manager:fBuy.manager,state:fBuy.s,funds});
  assert.equal(bBuy.length,2);assert.ok(bBuy[0]>50&&bBuy[0]<=120);assert.equal(bBuy[1],FUNDING_INPUT_BUDGET);
  const bPay=actionBudgets('PAY_OLD',{manager:fixture({module:'win',cnt:17,local:3,p:0}).manager,state:fixture({module:'win',cnt:17,local:3,p:0}).s,targets:Array(16).fill({})});
  assert.equal(bPay.length,17);assert.ok(bPay[0]>=100&&bPay[1]>=10);
  assert.throws(()=>managerBoundUnits('UNKNOWN',{state:fBuy.s}),/BUDGET_ACTION_UNKNOWN/);
});

const engineTest=(name,fn)=>test(name,{skip:!process.env.KASWIN_VM_BIN,timeout:120000},fn);

engineTest('REAL ENGINE: calibrated local actionBudgets pass limited kaswin-rolling-vm across all 8 action paths',async()=>{
  const cases=[
    [fixture({module:'sales',cnt:0,local:0}),{action:'BUY',quantity:1},[fund(1,10n*PRICE,W.key)]],
    [fixture({module:'sales',cnt:16,local:255}),{action:'BUY',quantity:1},[fund(2,10n*PRICE,W.key)]],
    [fixture({module:'sales',cnt:3,local:10,minTickets:3}),{action:'CLOSE'},[fund(3,10n*PRICE,W.key)]],
    [fixture({module:'sales',cnt:0,local:2,minTickets:5}),{action:'CLOSE'},[fund(4,10n*PRICE,W.key)]],
    [fixture({module:'sealed',cnt:2,local:5,currentDaa:2000n+432000n}),{action:'TIMEOUT'},[fund(5,10n*PRICE,W.key)]],
    [fixture({module:'win',cnt:17,local:3,p:0}),{action:'PAY_OLD'},[]],
    [fixture({module:'win',cnt:17,local:3,p:17}),{action:'PAY_SELF'},[]],
    [fixture({module:'refund',cnt:3,local:3,r:0,c:224}),{action:'REFUND_OLD'},[]],
    [fixture({module:'refund',cnt:3,local:35,r:3,c:0}),{action:'REFUND_SELF'},[fund(6,10n*PRICE,W.key)]],
    [fixture({module:'refund',cnt:3,local:5,r:3,c:0}),{action:'REFUND_SELF'},[fund(7,10n*PRICE,W.key)]],
  ];
  for(const [f,op,funds] of cases){
    const targets=op.action==='PAY_OLD'?f.targets.slice(0,16):op.action==='REFUND_OLD'?f.targets.slice(0,1):[];
    const fee=op.action.startsWith('PAY')?10_000_000n:2_000_000n;
    const budgets=actionBudgets(op.action,{manager:f.manager,state:f.s,targets,funds,op});
    const draft=buildAction(f.manager,profile,{...op,actorKey:W.key},{targets,funds,fee,budgets});
    if(draft.authorizedInputIndices.length)await W.sign(draft);
    const res=runEngine(draft,{limited:true});
    assert.ok(res.inputs.every(x=>x.ok&&x.limitedOk),`${op.action} failed VM`);
  }
  const gf=[fund(8,10n*PRICE,W.key)];
  const gDraft=buildGenesis(profile,W.key,{ticketPrice:PRICE,ticketCap:10,minTickets:3,closeEligibleDaa:5000n},{funds:gf,fee:FEE,budgets:actionBudgets('GENESIS',{funds:gf})});
  await W.sign(gDraft);
  const gRes=runEngine(gDraft,{limited:true});
  assert.ok(gRes.inputs.every(x=>x.ok&&x.limitedOk));
});
