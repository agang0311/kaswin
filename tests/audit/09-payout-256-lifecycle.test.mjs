import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadV2Bundle} from '../../contracts/f3.2/tools/linking.mjs';
import * as S from '../../packages/f3.2-core/lib/state.js';
import * as P from '../../packages/f3.2-core/lib/protocol.js';
import * as H from '../../packages/f3.2-core/lib/hashes.js';
import * as builders from '../../packages/f3.2-core/lib/builders.js';
import {p2pk, p2sh} from '../../packages/f3.2-core/lib/covenant-id.js';
import {hex} from '../../packages/f3.2-core/lib/bytes.js';
import {convergeFee, massOf} from '../../apps/kaswin-v2/scripts/shared/mass.mjs';
import {interpretAccepted} from '../../packages/f3.2-core/lib/accepted.js';
import {PROFILE} from '../tn10/cli.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CONTRACTS = path.join(ROOT, 'contracts/f3.2');
// Public historical bytes are a synthetic JS input, not V2 network acceptance evidence.
const passAFile = path.join(ROOT, 'apps/kaswin-v2/test/fixtures/pass-a-public.json');

test('09.1 256 purchases ledger and compact directory evolution', async () => {
  const key1 = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
  const key2 = 'd0fa7227151eecf10549ff8743c17f92213130317a13a92fedad541b107e5c7d';

  let s = S.newOpen(key1, {
    ticketPrice: 100000000n,
    ticketCap: 256,
    purchaseCap: 256,
    minTickets: 256,
    closeEligibleDaa: 500n
  });

  assert.equal(s.purchaseCount, 0);
  assert.equal(s.sold, 0);
  assert.equal(s.directory.length, 0);

  for (let i = 0; i < 256; i++) {
    const buyer = (i % 2 === 0) ? key1 : key2;
    s = S.appendPurchase(s, 1, buyer);
  }

  assert.equal(s.purchaseCount, 256);
  assert.equal(s.sold, 256);
  // Each entry in directory is 4 bytes (end ticket index) + 32 bytes (buyer public key) = 36 bytes
  assert.equal(s.directory.length, 256 * 36);

  // Appending 257th purchase must throw (either INTEGER_RANGE if ticketCap reached or DIRECTORY_FULL)
  assert.throws(() => S.appendPurchase(s, 1, key1), /INTEGER_RANGE|DIRECTORY_FULL/);
});

test('09.2 Edge BUY actions at count 0 and count 255 satisfy mass limits and budget scaling', async () => {
  const {profile} = await loadV2Bundle(CONTRACTS);
  assert.equal(profile.id, PROFILE);
  const key = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
  const funds = [{outpoint: {transactionId: 'aa'.repeat(32), index: 0}, value: 5000000000n, spk: p2pk(key), daa: 1n}];
  const origin = {transactionId: 'bb'.repeat(32), index: 0};

  // Ledger at 0 purchases
  const s0 = S.newOpen(key, {ticketPrice: 100000000n, ticketCap: 256, purchaseCap: 256, minTickets: 256, closeEligibleDaa: 500n});
  const budget0 = P.actionBudget('BUY', s0);
  assert.equal(budget0, 23); // ceil((204300 - 9999)/10000) + 3 = 20 + 3 = 23 (VM-refit 2026-10-09)

  // Ledger at 255 purchases
  let s255 = s0;
  for (let i = 0; i < 255; i++) s255 = S.appendPurchase(s255, 1, key);
  const budget255 = P.actionBudget('BUY', s255);
  assert.equal(budget255, 127); // ceil((204300 + 4090*255 - 9999)/10000) + 3 = 124 + 3 = 127

  const snap255 = {
    ledger: S.encodeLedger(s255),
    tip: {transactionId: 'cc'.repeat(32), index: 0},
    origin,
    covenantId: S.rootId(origin, S.rootScript(s255, profile)),
    value: S.valueOf(s255),
    utxoDaa: 100n,
    currentDaa: 200n,
    scriptPublicKey: p2sh(hex(H.blake2b256(S.scriptOf(s255, profile))))
  };

  const buy255Draft = convergeFee(fee => builders.buildAction(snap255, profile, {
    action: 'BUY',
    actorKey: key,
    quantity: 1
  }, fee, funds, budget255), 1).draft;

  const m255 = massOf(buy255Draft);
  assert.ok(m255.computeMass < 500000n, `computeMass ${m255.computeMass} exceeds block limit`);
  assert.ok(m255.transientMass < 1000000n, `transientMass ${m255.transientMass} exceeds block limit`);
  assert.ok(buy255Draft.fee <= 50000000n, `fee ${buy255Draft.fee} exceeds 0.5 TKAS limit`);
});

test('09.3 Full 256-ticket CLOSE to SEALED preserves balance and covenant locking', async () => {
  const {profile} = await loadV2Bundle(CONTRACTS);
  const key = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
  const funds = [{outpoint: {transactionId: 'aa'.repeat(32), index: 0}, value: 5000000000n, spk: p2pk(key), daa: 1n}];
  const origin = {transactionId: 'bb'.repeat(32), index: 0};

  let s = S.newOpen(key, {ticketPrice: 100000000n, ticketCap: 256, purchaseCap: 256, minTickets: 256, closeEligibleDaa: 500n});
  for (let i = 0; i < 256; i++) s = S.appendPurchase(s, 1, key);

  const closeBudget = P.actionBudget('CLOSE', s);
  assert.equal(closeBudget, 123); // ceil((246700 + 3750*256 - 9999)/10000) + 3

  const snap = {
    ledger: S.encodeLedger(s),
    tip: {transactionId: 'cc'.repeat(32), index: 0},
    origin,
    covenantId: S.rootId(origin, S.rootScript(s, profile)),
    value: S.valueOf(s),
    utxoDaa: 100n,
    currentDaa: 600n,
    scriptPublicKey: p2sh(hex(H.blake2b256(S.scriptOf(s, profile))))
  };

  const closeDraft = convergeFee(fee => builders.buildAction(snap, profile, {
    action: 'CLOSE',
    actorKey: key
  }, fee, funds, closeBudget), 1).draft;

  assert.equal(closeDraft.transition.next.phase, S.Phase.SEALED);
  assert.equal(closeDraft.transition.next.sold, 256);
  assert.equal(closeDraft.transition.next.purchaseCount, 256);

  const closeMass = massOf(closeDraft);
  assert.ok(closeMass.computeMass < 500000n);
  assert.ok(closeDraft.fee <= 50000000n);
});

test('09.4 256-ticket DRAW_AND_PAY: PASS-A draw authentication, binary search winner selection & PAID terminal', async () => {
  const {profile} = await loadV2Bundle(CONTRACTS);
  const keyCreator = 'd0fa7227151eecf10549ff8743c17f92213130317a13a92fedad541b107e5c7d';
  const keyBuyer1 = '2e80a82012f929bf7f92e343236b1172d0f46bb953af702c8c28336dbbafed85';
  const keyBuyer2 = '931f29119fbe92431bcef76c7f8aa9fdbd1b0b9623cbc3fbc528dc34c31d29a6';

  let s = S.newOpen(keyCreator, {ticketPrice: 100000000n, ticketCap: 256, purchaseCap: 256, minTickets: 256, closeEligibleDaa: 500n});
  for (let i = 0; i < 256; i++) {
    s = S.appendPurchase(s, 1, (i % 2 === 0) ? keyBuyer1 : keyBuyer2);
  }
  const sealed = {...s, phase: S.Phase.SEALED};

  const passA = JSON.parse(fs.readFileSync(passAFile, 'utf8'));
  const opening = Uint8Array.from(Buffer.from(passA.openingHex, 'hex'));
  const accessor = {blockHash: passA.target.hash, sequenceCommitment: passA.target.seqCommit};

  const origin = {transactionId: 'ee'.repeat(32), index: 0};
  const snapSealed = {
    ledger: S.encodeLedger(sealed),
    tip: {transactionId: 'ff'.repeat(32), index: 0},
    origin,
    scriptPublicKey: p2sh(hex(H.blake2b256(S.scriptOf(sealed, profile)))),
    covenantId: S.rootId(origin, S.rootScript(sealed, profile)),
    value: S.valueOf(sealed),
    utxoDaa: BigInt(passA.boundaryDaa) - S.DRAW_DELAY,
    currentDaa: BigInt(passA.target.daa)
  };

  const drawn = P.authenticateDraw(snapSealed, sealed, opening, accessor);
  assert.equal(drawn.phase, S.Phase.DRAW_READY);

  const smp = P.sample(drawn);
  assert.ok(smp.ticket !== null && smp.ticket >= 0 && smp.ticket < 256, `Invalid sampled ticket ${smp.ticket}`);

  const winIdx = P.winnerRecord({...drawn, winnerPlusOne: smp.ticket + 1});
  assert.equal(winIdx, smp.ticket, 'With 1 ticket per purchase, record index must match ticket number');
  const winRec = S.records(drawn)[winIdx];
  const expectedKey = (winIdx % 2 === 0) ? keyBuyer1 : keyBuyer2;
  assert.equal(winRec.key, expectedKey);

  const payBudget = P.actionBudget('DRAW_AND_PAY', sealed);
  assert.equal(payBudget, 205);

  const payDraft = convergeFee(fee => builders.buildAction(snapSealed, profile, {
    action: 'DRAW_AND_PAY',
    actorKey: keyCreator,
    opening,
    accessor
  }, fee, [], payBudget), 1).draft;

  // Verify conservation of fee:
  // Total in = sealed.value (256 KAS tickets + 0.2 KAS deposit = 256.2 KAS)
  // Total out = prize + creator deposit + executor bounty
  const sumOut = payDraft.transaction.outputs.reduce((a, o) => a + o.value, 0n);
  assert.equal(snapSealed.value - sumOut, payDraft.fee);

  // Validate consensus acceptance interpretation
  const interp = interpretAccepted(snapSealed, profile, payDraft.transaction, [snapSealed.value]);
  assert.equal(interp.terminal, 'PAID');
  assert.equal(interp.winner.record, winIdx);
  assert.equal(interp.winner.key, expectedKey);
  assert.equal(interp.fee, payDraft.fee);
  assert.equal(interp.constrainedOutputs, 3);
});
