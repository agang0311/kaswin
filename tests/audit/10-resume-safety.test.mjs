import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Journal, json} from '../tn10/journal.mjs';
import {PROFILE, NETWORK} from '../tn10/cli.mjs';
import {parseCapacityArgs, prepareResume, selectedChainAnchor} from '../tn10/resume-safety.mjs';
const approval = {schema:'KASWIN_TN10_APPROVAL_1',profileId:PROFILE,networkGenesis:NETWORK,scenario:'refund',round:'r',authorizationReference:'unit-only',maxTotalFeeSompi:'20',walletKeys:{creator:'11'.repeat(32),buyer1:'22'.repeat(32),buyer2:'33'.repeat(32)}};
function fixture(fn) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'kaswin-resume-')); const j=new Journal(root);j.lock();
 try {j.start('r',{schema:'KASWIN_TN10_RUN_2',profileId:PROFILE,networkGenesis:NETWORK,approval});fn(j,root);} finally {j.unlock();fs.rmSync(root,{recursive:true,force:true});}
}
function step(j) {
 const txid='44'.repeat(32),u={outpoint:{transactionId:'55'.repeat(32),index:0},value:100n},transaction={inputs:[{previousOutpoint:u.outpoint}],outputs:[{value:90n}]};
 const hash=j.persist('r','01-GENESIS',{profileId:PROFILE,networkGenesis:NETWORK,draft:{txid,fee:10n,inputUtxos:[u],transaction},signed:transaction});
 j.accepted('r','01-GENESIS',{schema:'KASWIN_TN10_ACCEPTED_2',status:'ACCEPTED',profileId:PROFILE,networkGenesis:NETWORK,txid,intentSha256:hash,actualFeeSompi:10n,inputContext:[u],transaction,terminal:null});
}
test('capacity CLI is strict and modes cannot be combined',()=>{
 assert.equal(parseCapacityArgs([],100).mode,'dry');
 for(const args of [['--dry','--execute'],['--status'],['--dry','--batch=1'],['--execute','--round=r','--approval=/tmp/a','--batch=2junk']])assert.throws(()=>parseCapacityArgs(args,100));
});
test('resume sums historic fees, retains inputs, rejects expanded approval',()=>fixture(j=>{
 step(j);const r=prepareResume(j,'r',approval);assert.equal(r.totalFee,10n);assert.equal(r.used.size,1);assert.equal(r.latestStep,'01-GENESIS');
 assert.throws(()=>prepareResume(j,'r',{...approval,maxTotalFeeSompi:'30'}),/RESUME_APPROVAL_SCOPE/);
}));
test('pending intent and orphan record fail closed before wallet loading',()=>fixture((j,root)=>{
 step(j);fs.unlinkSync(path.join(root,'r/01-GENESIS-accepted.json'));assert.throws(()=>prepareResume(j,'r',approval));
 fs.unlinkSync(path.join(root,'r/01-GENESIS-intent.json'));assert.throws(()=>prepareResume(j,'r',approval),/ORPHANED_EVIDENCE/);
}));
test('tampered accepted fee cannot reset the round budget',()=>fixture((j,root)=>{
 step(j);const file=path.join(root,'r/01-GENESIS-accepted.json'),r=JSON.parse(fs.readFileSync(file));r.actualFeeSompi='1';fs.writeFileSync(file,json(r));
 assert.throws(()=>prepareResume(j,'r',approval),/RECEIPT_VALUE_MISMATCH/);
}));
test('another unfinished round blocks resume',()=>fixture(j=>{
 step(j);j.start('other',{schema:'KASWIN_TN10_RUN_2'});assert.throws(()=>prepareResume(j,'r',approval));
}));
test('selected-chain anchor must match requested hash and cannot exhaust into success',async()=>{
 const hash='aa'.repeat(32);
 const rpc={call:async(method)=>method==='getSink'?{sink:hash}:{block:{header:{hash},verboseData:{isChainBlock:false,selectedParentHash:hash}}}};
 await assert.rejects(selectedChainAnchor(rpc),/SELECTED_CHAIN_ANCHOR_NOT_FOUND/);
 rpc.call=async()=>({block:{header:{hash:'bb'.repeat(32)},verboseData:{isChainBlock:true}}});await assert.rejects(selectedChainAnchor(rpc,hash),/ANCHOR_HASH_MISMATCH/);
 rpc.call=async()=>({block:{header:{hash},verboseData:{isChainBlock:true}}});assert.equal(await selectedChainAnchor(rpc,hash),hash);
});
