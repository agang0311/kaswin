/** Synthetic adapter facts: these tests exercise archive/indexer behavior, not chain acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileArchive} from '../../scripts/indexer/archive.mjs';
import {RollingIndexer} from '../../scripts/indexer/indexer.mjs';
import {buildGenesis,buildAction} from './transactions.mjs';
import {profile,fund,OWNER,PRICE,FEE} from './fixtures.mjs';
import {redeem} from './profile.mjs';
import {referenceTxId} from '../../scripts/core/lib/transaction.js';
import {TN10} from '../../scripts/chain/tn10.mjs';
async function harness(t) {
 const dir=await mkdtemp(join(tmpdir(),'rolling-index-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const facts=new Map(),archive=new FileArchive(dir),nodeAdapter={async authenticateAccepted(id){return facts.get(id);},async authenticateReversal(){return {removed:true,networkGenesis:TN10.genesis};}};
 const indexer=new RollingIndexer({archive,profile,networkGenesis:TN10.genesis,nodeAdapter});
 return {indexer,facts,archive};
}
function entry(d,extras={}) {return {accepted:true,networkGenesis:TN10.genesis,transaction:d.transaction,utxoDaa:2000n,currentDaa:2000n,
 position:{acceptingBlockHash:'ab'.repeat(32)},funds:d.inputUtxos,assertCurrent(){},release(){},...extras};}
test('synthetic accepted lineage indexes genesis, BUY, CLOSE and terminal refund, with idempotence and reversal',async t=>{
 const h=await harness(t),f=fund(1,10n*PRICE,OWNER),g=buildGenesis(profile,OWNER,{ticketPrice:PRICE,ticketCap:10,minTickets:3,closeEligibleDaa:1000n},{funds:[f],fee:FEE,budgets:[10]});
 const gid=referenceTxId(g.transaction);h.facts.set(gid,entry(g));let view=await h.indexer.ingest(gid,{},'0');
 assert.equal(view.revision,'1');assert.equal((await h.indexer.ingest(gid,{},'0')).revision,'1');
 let previous=g,previousId=gid,previousView=view;
 for(const action of ['BUY','CLOSE','REFUND_SELF']) {
  const s=previous.transition.next,manager={outpoint:{transactionId:previousId,index:0},value:previous.transaction.outputs[0].value,spk:previous.transaction.outputs[0].scriptPublicKey,
   cid:g.cid,origin:g.origin,redeemScript:redeem(s,profile),utxoDaa:2000n,currentDaa:2000n};
  const funds=[fund(10+Number(view.revision),10n*PRICE,OWNER)],op={action,actorKey:OWNER,quantity:1};
  const d=buildAction(manager,profile,op,{funds,fee:FEE,budgets:[300,10]}),id=referenceTxId(d.transaction);
  h.facts.set(id,entry(d,{manager,targets:[],funds}));previousView=view;view=await h.indexer.ingest(id,{},view.revision);previous=d;previousId=id;
 }
 assert.equal(view.terminal,'REFUNDED');assert.equal(view.manager,null);assert.deepEqual(view.frozen,[]);
 const reverted=await h.indexer.revert(g.cid,view.acceptance.instance,view.revision);
 assert.equal(reverted.manager.outpoint.transactionId,previousView.manager.outpoint.transactionId);assert.equal(reverted.terminal,null);
 const reaccepted=await h.indexer.ingest(previousId,{},reverted.revision);assert.equal(reaccepted.terminal,'REFUNDED');assert.equal(reaccepted.revision,'6');
});
test('block inclusion without authenticated acceptance cannot publish a round',async t=>{
 const h=await harness(t),g=buildGenesis(profile,OWNER,{ticketPrice:PRICE,ticketCap:3,minTickets:3,closeEligibleDaa:1000n},{funds:[fund(1,10n*PRICE,OWNER)],fee:FEE,budgets:[10]});
 const id=referenceTxId(g.transaction);h.facts.set(id,entry(g,{accepted:false,includedInBlock:true}));
 await assert.rejects(h.indexer.ingest(id,{},'0'),/NODE_ACCEPTANCE_REQUIRED/);assert.equal(await h.archive.getRound(TN10.genesis,profile.id,g.cid),null);
});
test('invalidated read scope cannot publish even an otherwise valid genesis',async t=>{
 const h=await harness(t),g=buildGenesis(profile,OWNER,{ticketPrice:PRICE,ticketCap:3,minTickets:3,closeEligibleDaa:1000n},{funds:[fund(1,10n*PRICE,OWNER)],fee:FEE,budgets:[10]});
 const id=referenceTxId(g.transaction);h.facts.set(id,entry(g,{assertCurrent(){throw new Error('READ_VIEW_CHANGED');}}));
 await assert.rejects(h.indexer.ingest(id,{},'0'),/READ_VIEW_CHANGED/);assert.equal(await h.archive.getRound(TN10.genesis,profile.id,g.cid),null);
});
