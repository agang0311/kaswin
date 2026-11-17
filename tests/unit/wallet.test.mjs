import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fixture,fund,profile,PRICE,FEE} from '../contracts/fixtures.mjs';
import {buildAction} from '../contracts/transactions.mjs';
import {openMemoryWallet,publicRecipient,verifyOrdinarySignatures,isSignature} from '../../scripts/wallet/wallet.mjs';
import {pubkeyToAddress} from '../../scripts/wallet/address.mjs';
import {schnorrSign,schnorrVerify} from '../../scripts/wallet/schnorr.mjs';
import {schnorrSighash} from '../../scripts/wallet/sighash.mjs';
import {unhex} from '../contracts/state.mjs';

const SECRET=createHash('sha256').update('rolling-tn10-wallet-test-key').digest('hex');
const draftFor=w=>{const f=fixture({module:'sales'});return buildAction(f.manager,profile,{action:'BUY',quantity:1,actorKey:w.key},{funds:[fund(3,10n*PRICE,w.key)],fee:FEE,budgets:[10,10]});};
test('signs every ordinary input with SIGHASH_ALL and verifies locally; covenant input untouched',async()=>{
  const w=openMemoryWallet(SECRET),d=draftFor(w);
  assert.equal(w.address,pubkeyToAddress(w.key,'kaspatest'));assert.ok(w.address.startsWith('kaspatest:'));
  const before=d.transaction.inputs[0].signatureScript;
  await w.sign(d);
  assert.ok(isSignature(d.transaction.inputs[1].signatureScript));assert.equal(d.transaction.inputs[0].signatureScript,before);
  await verifyOrdinarySignatures(d);
  const sig=unhex(d.transaction.inputs[1].signatureScript.slice(2,130)),hash=schnorrSighash(d.transaction,d.inputUtxos.map(u=>({value:u.value,spk:u.spk})),1);
  assert.equal(await schnorrVerify(unhex(w.key),hash,sig),true);
  // any changed output invalidates the signature check
  d.transaction.outputs.at(-1).value--;
  await assert.rejects(()=>verifyOrdinarySignatures(d),/SIGNATURE_INVALID/);
  w.close();
});
test('refuses re-signing, foreign inputs, fee over cap and a closed wallet; errors never contain the key',async()=>{
  const w=openMemoryWallet(SECRET),other=openMemoryWallet(createHash('sha256').update('another').digest('hex'));
  const d=draftFor(w);await w.sign(d);
  await assert.rejects(()=>w.sign(d),/SIGNER_ALREADY_SIGNED/);
  await assert.rejects(()=>other.sign(draftFor(w)),/SIGNER_INPUT_SCOPE/);
  const big=draftFor(w);big.fee=60000000n;await assert.rejects(()=>w.sign(big),/SIGNER_FEE_SCOPE/);
  w.close();assert.equal(w.closed,true);await assert.rejects(()=>w.sign(draftFor(other)),/WALLET_CLOSED/);
  for(const bad of [SECRET.slice(2),SECRET+'00','zz'.repeat(32),'',null,'00'.repeat(32),'ff'.repeat(32)]) {
    assert.throws(()=>openMemoryWallet(bad),e=>!String(e.message+e.stack).includes(SECRET)&&/KEY_/.test(e.message));
  }
  assert.ok(!Object.values(w).some(v=>typeof v==='string'&&v.includes(SECRET)));
  assert.ok(!JSON.stringify(Object.keys(w)).includes('secret'));
});
test('tampered or missing signatures are rejected by the structural verifier',async()=>{
  const w=openMemoryWallet(SECRET),d=draftFor(w);await w.sign(d);
  const t=structuredClone(d);t.transaction.inputs[1].signatureScript='41'+'00'.repeat(64)+'01';
  await assert.rejects(()=>verifyOrdinarySignatures(t),/SIGNATURE_INVALID/);
  const u=structuredClone(d);u.transaction.inputs[1].signatureScript='';
  await assert.rejects(()=>verifyOrdinarySignatures(u),/SIGNATURE_CONTEXT/);
  const g=schnorrSign(unhex(SECRET),new Uint8Array(32));assert.equal(g.length,64);
  w.close();
});
test('public recipient has no signing capability and only P2PK TN10 addresses',async()=>{
  const w=openMemoryWallet(SECRET),r=publicRecipient(w.address);
  assert.equal(r.key,w.key);assert.equal(r.kind,'public');
  const f=fixture({module:'win',local:3}),d=buildAction(f.manager,profile,{action:'PAY_SELF',actorKey:r.key},{fee:FEE,budgets:[10]});
  await r.sign(d);assert.deepEqual(d.authorizedInputIndices,[]);
  await assert.rejects(()=>r.sign(draftFor(w)),/PERMISSIONLESS_SIGNATURE_SCOPE/);
  assert.throws(()=>publicRecipient('kaspa:qzf372g3n7lfyscmemmkclu2487m6xctjc3uhslmc55dcdxrr556v963skl4p'));
  assert.throws(()=>publicRecipient('not an address'));
  w.close();
});
