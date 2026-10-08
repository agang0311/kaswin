import test from 'node:test';
import assert from 'node:assert/strict';
import {roundFacts,plannedActions,cardStep,walletFlow,planSummary,txStatus} from '../visual/view.mjs';
const detail=(phase=1)=>({terminal:null,utxoDaa:'1000',state:{phase,sold:2,purchaseCount:1,cursor:0,config:{ticketPrice:'100000001',ticketCap:3,purchaseCap:256,minTickets:3,closeEligibleDaa:'900'}}});
test('summary-only is unknown, not zero; terminal zero is not prize',()=>{
 assert.equal(roundFacts({value:'0',terminal:'PAID'}),null);
 assert.match(cardStep({terminal:'PAID'},null).text,/接受交易输出/);
 assert.equal(roundFacts(detail()).pool,200000002n);
});
test('time enables close but does not stop buy; unknown DAA never guessed',()=>{
 assert.equal(plannedActions(detail())[1].available,null);
 const a=plannedActions(detail(),1000n);assert.equal(a[0].available,true);assert.equal(a[1].available,true);assert.equal(a[1].outcome,'REFUNDING');
 const d=detail();d.state.purchaseCount=256;assert.equal(plannedActions(d)[0].available,false);assert.equal(plannedActions(d)[1].available,true);
});
test('draw and timeout DAA boundaries; partial refunds',()=>{
 for(const [daa,draw,timeout] of [[1099n,false,false],[1100n,true,false],[432999n,true,false],[433000n,true,true]]) { const a=plannedActions(detail(2),daa);assert.equal(a[0].available,draw);assert.equal(a[1].available,timeout); }
 const d=detail(5);d.state.purchaseCount=33;d.state.cursor=32;assert.equal(plannedActions(d)[0].size,1);
});
test('exact wallet flow uses authorized inputs; sums all own outputs',()=>{
 const p={draft:{authorizedInputIndices:[1],inputUtxos:[{value:999999999999n},{value:10000000000000001n}]},outputs:[{value:10000000000000000n,mine:true},{value:10n,mine:true}]};
 assert.deepEqual(walletFlow(p),{spent:10000000000000001n,received:10000000000000010n,net:9n});
});
test('all six action descriptions, acceptance and archived limits explicit',()=>{
 const base={fee:123n,before:{sold:2},after:{sold:3,phase:2},request:{registry:true},winner:{ticket:3}};
 for(const action of ['GENESIS','BUY','CLOSE','DRAW_AND_PAY','TIMEOUT_REFUND','REFUND']) assert.ok(planSummary({...base,action}).length>20);
 assert.match(txStatus('UNKNOWN').meaning,/时间久/);assert.match(txStatus('ACCEPTED').meaning,/不代表不可逆/);assert.match(txStatus('ARCHIVED').meaning,/不证明/);
});
