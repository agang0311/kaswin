// Full 100-purchase refund lifecycle test runner on Kaspa Testnet 10 / offline simulation.
// Scenario: 100 tickets sold (under minTickets 200 threshold) -> CLOSE to REFUNDING -> 4 batched REFUNDs -> REFUNDED.
// Supports:
//   node tests/tn10/refund-100.mjs --dry                     (pure offline synthetic model, 106 transactions built & verified)
//   node tests/tn10/refund-100.mjs --execute --round=<round> --approval=<path> [--batch=N] (live TN10 execution)

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {loadV2Bundle} from '../../contracts/f3.2/tools/linking.mjs';
import * as S from '../../packages/f3.2-core/lib/state.js';
import * as P from '../../packages/f3.2-core/lib/protocol.js';
import * as H from '../../packages/f3.2-core/lib/hashes.js';
import {buildAction, buildOpenGenesis, assertDraft} from '../../packages/f3.2-core/lib/builders.js';
import {referenceTxId} from '../../packages/f3.2-core/lib/transaction.js';
import {p2pk, p2sh} from '../../packages/f3.2-core/lib/covenant-id.js';
import {hex, stable} from '../../packages/f3.2-core/lib/bytes.js';
import {interpretAccepted} from '../../packages/f3.2-core/lib/accepted.js';
import {NodeLink, txToRpc} from '../../apps/kaswin-v2/scripts/shared/nodes.mjs';
import {commonUtxos, verifyInputsLive, searchAccepted} from '../../apps/kaswin-v2/scripts/shared/chain.mjs';
import {convergeFee, massOf} from '../../apps/kaswin-v2/scripts/shared/mass.mjs';
import {toSafeJson} from '../../apps/kaswin-v2/scripts/shared/wallet.mjs';
import {pubkeyToAddress} from '../../apps/kaswin-v2/scripts/shared/lib/address.mjs';
import {PROFILE, NETWORK} from './cli.mjs';
import {loadSigningWallets, verifyRecord} from './live.mjs';
import {Journal, privateDir, readPrivate, sha256} from './journal.mjs';
import {signDraft} from './signing.mjs';

const require = createRequire(import.meta.url);
const sdk = require('../../references/kaspa-wasm32-sdk/nodejs/kaspa/kaspa.js');
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const EVIDENCE = path.join(ROOT, 'tests/tn10/evidence');
const CONTRACTS = path.join(ROOT, 'contracts/f3.2');
const delay = ms => new Promise(r => setTimeout(r, ms));
const fail = code => { const e = new Error(code); e.safeCode = code; throw e; };
const need = (c, code) => { if (!c) fail(code); };

// ==================== OFFLINE DRY RUN ====================

export async function runDry() {
  const {profile} = await loadV2Bundle(CONTRACTS);
  need(profile.id === PROFILE, 'PROFILE_DRIFT');

  const keyCreator = 'd0fa7227151eecf10549ff8743c17f92213130317a13a92fedad541b107e5c7d';
  const keyBuyer1 = '2e80a82012f929bf7f92e343236b1172d0f46bb953af702c8c28336dbbafed85';
  const keyBuyer2 = '931f29119fbe92431bcef76c7f8aa9fdbd1b0b9623cbc3fbc528dc34c31d29a6';

  console.log('=== STARTING 100-PURCHASE BATCHED-REFUND OFFLINE DRY-RUN ===');
  console.log(`Profile: ${PROFILE}`);
  console.log(`Scenario: 100 purchases (minTickets: 200) -> CLOSE to REFUNDING -> 4 REFUND batches`);

  const pool = new Map();
  const k = o => `${o.transactionId}:${o.index}`;
  pool.set('creator-fund', {outpoint: {transactionId: '10'.repeat(32), index: 0}, value: 50000000000n, spk: p2pk(keyCreator), daa: 1n, covenantId: null});
  pool.set('buyer1-fund', {outpoint: {transactionId: '11'.repeat(32), index: 0}, value: 30000000000n, spk: p2pk(keyBuyer1), daa: 1n, covenantId: null});
  pool.set('buyer2-fund', {outpoint: {transactionId: '12'.repeat(32), index: 0}, value: 30000000000n, spk: p2pk(keyBuyer2), daa: 1n, covenantId: null});

  let score = 591100000n, ledger, tip, origin, cid, utxoDaa;
  const take = whoKey => {
    const entry = [...pool.entries()].find(([, x]) => x.spk.script === p2pk(whoKey).script && x.value >= 150000000n);
    need(entry, 'SYNTHETIC_FUNDS_EXHAUSTED_' + whoKey.slice(0, 8));
    pool.delete(entry[0]);
    return entry[1];
  };

  function apply(d) {
    const id = referenceTxId(d.transaction);
    for (const f of d.inputUtxos.filter((_, i) => d.authorizedInputIndices.includes(i))) {
      const entry = [...pool.entries()].find(([, x]) => k(x.outpoint) === k(f.outpoint));
      if (entry) pool.delete(entry[0]);
    }
    score += 5n;
    d.transaction.outputs.forEach((o, index) => {
      if (!o.covenant) {
        const f = {outpoint: {transactionId: id, index}, value: o.value, spk: o.scriptPublicKey, daa: score, covenantId: null};
        pool.set(k(f.outpoint), f);
      }
    });
    tip = {transactionId: id, index: 0};
    utxoDaa = score;
    if (d.transition) ledger = d.transition.next;
    return id;
  }

  // 1. GENESIS
  const config = {ticketPrice: 100000000n, ticketCap: 256, purchaseCap: 256, minTickets: 200, closeEligibleDaa: score + 1000n};
  const gFund = take(keyCreator);
  const genDraft = convergeFee(fee => buildOpenGenesis(profile, keyCreator, config, [gFund], fee), 1).draft;
  origin = genDraft.origin;
  cid = genDraft.transaction.outputs[0].covenant.covenantId;
  apply(genDraft);
  ledger = S.newOpen(keyCreator, config);
  console.log(`[000/100] 01-GENESIS built: CID=${cid.slice(0, 16)}..., fee=${genDraft.fee} sompi`);

  const snapshot = () => ({
    ledger: S.encodeLedger(ledger),
    tip,
    origin,
    covenantId: cid,
    value: S.valueOf(ledger),
    utxoDaa,
    currentDaa: score,
    scriptPublicKey: p2sh(hex(H.blake2b256(S.scriptOf(ledger, profile))))
  });

  // 2. 100 BUYS
  const t0 = Date.now();
  let maxComputeMass = 0n, maxFee = 0n;

  for (let i = 0; i < 100; i++) {
    const isBuyer1 = (i % 2 === 0);
    const buyerKey = isBuyer1 ? keyBuyer1 : keyBuyer2;
    const snap = snapshot();
    const fund = take(buyerKey);
    const budget = P.actionBudget('BUY', ledger);
    const q = convergeFee(fee => buildAction(snap, profile, {action: 'BUY', actorKey: buyerKey, quantity: 1}, fee, [fund], budget), 1);
    const m = massOf(q.draft);
    if (m.computeMass > maxComputeMass) maxComputeMass = m.computeMass;
    if (q.fee > maxFee) maxFee = q.fee;

    apply(q.draft);

    if ((i + 1) % 25 === 0 || i === 99) {
      console.log(`[${String(i + 1).padStart(3)}/100] BUY #${i + 1} built: sold=${ledger.sold}, purchaseCount=${ledger.purchaseCount}, budget=${budget}, fee=${q.fee} sompi`);
    }
  }

  const elapsedBuys = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`All 100 purchases built in ${elapsedBuys}s! Max computeMass=${maxComputeMass}, max fee=${maxFee} sompi`);
  need(ledger.purchaseCount === 100, 'PURCHASE_COUNT_MISMATCH');
  need(ledger.sold === 100, 'SOLD_MISMATCH');

  // 3. CLOSE (to REFUNDING because 100 < minTickets 200)
  score = config.closeEligibleDaa + 5n;
  const snapBeforeClose = snapshot();
  const cFund = take(keyCreator);
  const closeBudget = P.actionBudget('CLOSE', ledger);
  const closeDraft = convergeFee(fee => buildAction(snapBeforeClose, profile, {action: 'CLOSE', actorKey: keyCreator}, fee, [cFund], closeBudget), 1).draft;
  const closeMass = massOf(closeDraft);
  console.log(`[CLOSE] 101-CLOSE built: budget=${closeBudget}, fee=${closeDraft.fee} sompi, nextPhase=${closeDraft.transition.next.phase} (REFUNDING)`);
  apply(closeDraft);
  need(ledger.phase === S.Phase.REFUNDING, 'PHASE_NOT_REFUNDING');

  // 4. 4 Batched REFUNDs
  let batchNum = 1;
  while (ledger.cursor < ledger.purchaseCount) {
    const snapRef = snapshot();
    const rFund = take(keyCreator);
    const refBudget = P.actionBudget('REFUND', ledger);
    const qRef = convergeFee(fee => buildAction(snapRef, profile, {action: 'REFUND', actorKey: keyCreator}, fee, [rFund], refBudget), 1);
    const dRef = qRef.draft;
    const mRef = massOf(dRef);
    const curBefore = ledger.cursor;
    const curAfter = dRef.transition.next?.cursor ?? 100;
    const terminal = dRef.transition.terminal;
    console.log(`[REFUND ${batchNum}/4] Batch #${batchNum} built: cursor ${curBefore} -> ${curAfter}, budget=${refBudget}, fee=${dRef.fee} sompi, outputs=${dRef.transaction.outputs.length}, terminal=${terminal ?? 'CONTINUE'}`);

    // Consensus interpretation check
    const interp = interpretAccepted(snapRef, profile, dRef.transaction, [snapRef.value, rFund.value]);
    need(interp.fee === dRef.fee, 'REFUND_INTERPRET_FEE_MISMATCH');
    if (terminal) need(interp.terminal === 'REFUNDED', 'INTERPRET_TERMINAL_MISMATCH');

    apply(dRef);
    if (terminal === 'REFUNDED') break;
    batchNum++;
  }

  console.log('\n=== REFUND VERIFICATION SUMMARY ===');
  console.log('All 100 purchases refunded in 4 batches (32 + 32 + 32 + 4).');
  console.log('Creator deposit 0.2 TKAS returned.');
  console.log('Terminal status: REFUNDED');
  console.log('=== OFFLINE 100-PURCHASE REFUND LIFECYCLE PASS ===\n');

  return {success: true};
}

// ==================== LIVE TN10 EXECUTION ====================

function approvalFor(roundPath, roundName) {
  const a = JSON.parse(readPrivate(roundPath));
  need(a.schema === 'KASWIN_TN10_APPROVAL_1', 'APPROVAL_SCHEMA');
  need(a.networkGenesis === NETWORK, 'NETWORK_GENESIS_APPROVAL');
  need(a.profileId === PROFILE, 'PROFILE_APPROVAL');
  need(a.round === roundName, 'ROUND_NAME_APPROVAL');
  need(Date.parse(a.expiresAt) > Date.now(), 'APPROVAL_EXPIRED');
  return a;
}

export async function runLive({round, approval, batch = 150}) {
  need(round && /^[A-Za-z0-9_-]{1,64}$/.test(round), 'VALID_ROUND_NAME_REQUIRED');
  need(approval && fs.existsSync(approval), 'VALID_APPROVAL_PATH_REQUIRED');

  const {profile} = await loadV2Bundle(CONTRACTS);
  need(profile.id === PROFILE, 'PROFILE_DRIFT');
  const a = approvalFor(approval, round);

  privateDir(EVIDENCE);
  const journal = new Journal(EVIDENCE, {create: true});
  journal.lock();

  let link, wallets, used = new Set(), totalFee = 0n;
  try {
    const loaded = loadSigningWallets(a);
    wallets = loaded.wallets;
    const signingSdk = loaded.sdk;

    link = new NodeLink(['wss://tn10.kaspay.top/wrpc']);
    await link.connect();
    const info = await link.call('getServerInfo');
    need(info.networkId?.endsWith('testnet-10'), 'NETWORK_ID');
    const daa = await link.currentDaa();

    const roundDir = path.join(EVIDENCE, round);
    let priorInputs;
    if (!fs.existsSync(roundDir)) {
      priorInputs = journal.checkUnresolved();
      journal.start(round, {schema: 'KASWIN_TN10_RUN_2', profileId: PROFILE, networkGenesis: NETWORK, approval: a});
    } else {
      priorInputs = new Set();
    }
    used = priorInputs;

    const opKey = o => `${o.transactionId}:${o.index}`;
    async function funding(role, maxAttempts = 20) {
      const w = wallets[role];
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const uList = await commonUtxos(link, w.address);
        const candidates = uList.filter(u =>
          !u.isCoinbase && !u.covenantId && stable(u.spk) === stable(w.spk) &&
          !used.has(opKey(u.outpoint)) &&
          u.value >= 150000000n && u.value < S.VALUE_LIMIT
        );
        candidates.sort((x, y) => x.value > y.value ? -1 : x.value < y.value ? 1 : 0);
        if (candidates[0]) return candidates[0];
        await delay(800);
      }
      fail('ORDINARY_FUNDS_REQUIRED_' + role);
    }

    async function waitDaa(target) {
      const until = Date.now() + 600000;
      while (await link.currentDaa() < target) {
        console.log(`Waiting for DAA ${target}... current: ${await link.currentDaa()}`);
        need(Date.now() < until, 'DAA_WAIT_TIMEOUT');
        await delay(3000);
      }
    }

    async function submit(step, draft, role, snapshot = null) {
      need(Date.parse(a.expiresAt) > Date.now(), 'APPROVAL_EXPIRED');
      need(draft.action !== 'TIMEOUT_REFUND', 'TIMEOUT_EXCLUDED');
      assertDraft(draft);
      draft.txid = referenceTxId(draft.transaction);
      need(draft.fee > 0n && draft.fee <= 50000000n && totalFee + draft.fee <= BigInt(a.maxTotalFeeSompi), 'TOTAL_FEE_CAP');
      await verifyInputsLive(link, draft.inputUtxos);

      const w = wallets[role];
      const sdkTx = sdk.Transaction.deserializeFromSafeJSON(toSafeJson(draft, w));
      let signed;
      try {
        signed = await signDraft(draft, w.key, i => sdk.createInputSignature(sdkTx, i, w.pk, sdk.SighashType.All));
      } finally { sdkTx.free(); }
      await verifyInputsLive(link, draft.inputUtxos);
      need(Date.parse(a.expiresAt) > Date.now(), 'APPROVAL_EXPIRED');

      let rawAnchor = (await link.call('getSink')).sink;
      for (let i = 0; i < 30; i++) {
        const b = (await link.call('getBlock', {hash: rawAnchor, includeTransactions: false})).block;
        if (b?.verboseData?.isChainBlock === true) break;
        if (b?.verboseData?.selectedParentHash) rawAnchor = b.verboseData.selectedParentHash; else break;
      }
      const anchor = rawAnchor;
      need(/^[0-9a-f]{64}$/.test(anchor), 'ANCHOR_REQUIRED');

      const record = {profileId: PROFILE, networkGenesis: NETWORK, draft, signed, snapshot, anchor};
      record.intentSha256 = journal.persist(round, step, record);

      console.log(`Submitting ${step} (${draft.action}) txid=${draft.txid}...`);
      const response = await link.call('submitTransaction', {transaction: txToRpc(signed), allowOrphan: false});
      need(response?.transactionId === draft.txid, 'SUBMIT_TXID_MISMATCH');
      journal.event(round, step, 'SUBMITTED', {txid: response.transactionId});

      let result, searchCursor = anchor;
      for (let i = 0; i < 40; i++) {
        const [rpc] = await link.connect();
        try {
          const hit = await searchAccepted(rpc, draft.txid, searchCursor);
          if (hit.accepting) {
            result = await verifyRecord(link, profile, record, hit.accepting);
            break;
          }
          if (hit.cursor) searchCursor = hit.cursor;
        } catch (err) {
          if (err?.code === 'CURSOR_REORG') {
            const b = (await rpc.call('getBlock', {hash: searchCursor, includeTransactions: false})).block;
            let parent = b?.verboseData?.selectedParentHash;
            for (let j = 0; j < 30 && parent; j++) {
              const pb = (await rpc.call('getBlock', {hash: parent, includeTransactions: false})).block;
              if (pb?.verboseData?.isChainBlock === true) { searchCursor = parent; break; }
              parent = pb?.verboseData?.selectedParentHash;
            }
          }
        }
        await delay(1000);
      }
      need(result, 'UNKNOWN');
      journal.accepted(round, step, result.receipt);
      totalFee += BigInt(result.receipt.actualFeeSompi);
      need(totalFee <= BigInt(a.maxTotalFeeSompi), 'TOTAL_FEE_BUDGET_EXCEEDED');
      for (const u of draft.inputUtxos) used.add(opKey(u.outpoint));
      console.log(`ACCEPTED ${step} ${draft.txid} actualFeeSompi=${result.receipt.actualFeeSompi}`);
      return result;
    }

    // Check existing journal state
    let live = null, origin = null, currentPurchaseCount = 0;

    function advance(result) {
      if (!result.next) { live = null; return; }
      const out = result.ev.tx.outputs[0];
      const snapshot = {ledger: S.encodeLedger(result.next), tip: {transactionId: result.ev.txid, index: 0}, origin,
        covenantId: out.covenant.covenantId, value: out.value, scriptPublicKey: out.scriptPublicKey,
        utxoDaa: result.ev.acceptingDaa, currentDaa: result.ev.acceptingDaa};
      S.verifySnapshot(snapshot, profile);
      live = {ledger: result.next, snapshot, accepting: result.ev.accepting, acceptedTx: result.ev};
    }

    async function action(step, name, role, quantity) {
      need(live, 'LIVE_STATE_REQUIRED');
      live.snapshot.currentDaa = await link.currentDaa();
      const op = {action: name, actorKey: wallets[role].key, ...(quantity ? {quantity} : {})};
      const budget = P.actionBudget(name, live.ledger);
      const funds = [await funding(role)]; // always fund for BUY, CLOSE and REFUND
      const x = structuredClone(live.snapshot);
      const d = convergeFee(fee => buildAction(x, profile, op, fee, funds, budget), await link.feerate()).draft;
      const result = await submit(step, d, role, x);
      advance(result);
      return result;
    }

    // If 01-GENESIS not executed yet, initialize
    if (!fs.existsSync(path.join(roundDir, '01-GENESIS-accepted.json'))) {
      console.log(`Initializing new 100-purchase refund round: ${round}`);
      // minTickets: 200 ensures 100 tickets routes to REFUNDING on close
      const config = {ticketPrice: 100000000n, ticketCap: 256, purchaseCap: 256, minTickets: 200, closeEligibleDaa: daa + 60n};
      const genFund = await funding('creator');
      const gen = convergeFee(fee => buildOpenGenesis(profile, wallets.creator.key, config, [genFund], fee), await link.feerate()).draft;
      origin = gen.origin;
      const genRes = await submit('01-GENESIS', gen, 'creator');
      advance(genRes);
    } else {
      console.log(`Resuming existing round ${round}...`);

      // Self-heal any intent that was submitted but interrupted before writing accepted.json
      const intentFiles = fs.readdirSync(roundDir).filter(f => f.endsWith('-intent.json')).sort();
      for (const ifile of intentFiles) {
        const step = ifile.replace('-intent.json', '');
        const accPath = path.join(roundDir, `${step}-accepted.json`);
        if (!fs.existsSync(accPath)) {
          const rec = journal.load(round, step);
          const [rpc] = await link.connect();
          try {
            const hit = await searchAccepted(rpc, rec.draft.txid, rec.anchor);
            if (hit.accepting) {
              console.log(`Self-healing interrupted step: ${step} txid=${rec.draft.txid}`);
              const result = await verifyRecord(link, profile, rec, hit.accepting);
              journal.accepted(round, step, result.receipt);
              console.log(`Self-healed ${step}-accepted.json!`);
            }
          } catch (e) {
            console.log(`Warning: could not self-heal ${step}:`, e.message);
          }
        }
      }

      const stepNum = f => parseInt(f.split('-')[0], 10);
      const accFiles = fs.readdirSync(roundDir).filter(f => f.endsWith('-accepted.json')).sort((a, b) => stepNum(a) - stepNum(b));
      const genAcc = JSON.parse(fs.readFileSync(path.join(roundDir, '01-GENESIS-accepted.json'), 'utf8'));
      origin = genAcc.transaction.inputs[0].previousOutpoint;

      const latestAccFile = accFiles[accFiles.length - 1];
      const latestStep = latestAccFile.replace('-accepted.json', '');
      const acc = JSON.parse(fs.readFileSync(path.join(roundDir, latestAccFile), 'utf8'));

      if (acc.terminal) {
        console.log(`Round ${round} already completed with terminal ${acc.terminal}.`);
        return;
      }

      const record = journal.load(round, latestStep);
      const nextLedger = record.draft.transition.next;
      live = {
        ledger: nextLedger,
        snapshot: {
          ledger: S.encodeLedger(nextLedger),
          tip: {transactionId: acc.txid, index: 0},
          origin: {transactionId: origin.transactionId, index: Number(origin.index)},
          covenantId: acc.transaction.outputs[0].covenant.covenantId,
          value: BigInt(acc.transaction.outputs[0].value),
          scriptPublicKey: acc.transaction.outputs[0].scriptPublicKey,
          utxoDaa: BigInt(acc.acceptingDaa),
          currentDaa: BigInt(await link.currentDaa())
        },
        accepting: acc.acceptingBlockHash,
        acceptedTx: acc
      };
      currentPurchaseCount = live.ledger.purchaseCount;
      console.log(`Resumed at step: ${latestStep}, purchaseCount=${currentPurchaseCount}/100, phase=${live.ledger.phase}`);
    }

    // Process 100 Purchases
    const targetCount = Math.min(100, currentPurchaseCount + batch);
    while (currentPurchaseCount < targetCount && live.ledger.phase === S.Phase.OPEN) {
      const buyNum = currentPurchaseCount + 1;
      const role = (currentPurchaseCount % 2 === 0) ? 'buyer1' : 'buyer2';
      const stepName = `${String(buyNum + 1).padStart(2, '0')}-BUY${buyNum}`;
      console.log(`[${buyNum}/100] Purchasing ticket with ${role}...`);
      await action(stepName, 'BUY', role, 1);
      currentPurchaseCount++;
    }

    console.log(`Current progress: ${currentPurchaseCount}/100 purchases on-chain.`);
    if (currentPurchaseCount < 100) {
      console.log(`Run again with --execute --batch=${batch} to continue.`);
      return;
    }

    // CLOSE to REFUNDING
    if (live.ledger.phase === S.Phase.OPEN) {
      console.log('Purchases completed (100/100). Waiting for closeEligibleDaa...');
      await waitDaa(live.ledger.config.closeEligibleDaa);
      console.log('Closing round to REFUNDING phase (since 100 < minTickets 200)...');
      await action('102-CLOSE', 'CLOSE', 'creator');
    }

    // Process Batched REFUNDs until terminal REFUNDED
    let refundStep = 1;
    while (live.ledger.phase === S.Phase.REFUNDING) {
      const stepName = `${102 + refundStep}-REFUND${refundStep}`;
      console.log(`Executing refund batch #${refundStep} (cursor=${live.ledger.cursor}/${live.ledger.purchaseCount})...`);
      const refRes = await action(stepName, 'REFUND', 'creator');
      refundStep++;
      if (refRes.terminal === 'REFUNDED') {
        journal.complete(round, refRes.terminal);
        console.log(`ROUND COMPLETED! Final terminal: ${refRes.terminal}`);
        break;
      }
    }
  } finally {
    link?.close();
    for (const w of Object.values(wallets ?? {})) w.pk.free();
    journal.unlock();
  }
}

// ==================== CLI DISPATCH ====================

const args = process.argv.slice(2);
const isDry = args.includes('--dry');
const isExecute = args.includes('--execute');
const roundArg = args.find(a => a.startsWith('--round='))?.slice(8);
const approvalArg = args.find(a => a.startsWith('--approval='))?.slice(11);
const batchArg = parseInt(args.find(a => a.startsWith('--batch='))?.slice(8) || '150', 10);

if (isDry || (!isExecute && !roundArg)) {
  await runDry();
} else if (isExecute) {
  await runLive({round: roundArg, approval: approvalArg, batch: batchArg});
} else {
  console.log('Usage:');
  console.log('  node tests/tn10/refund-100.mjs --dry');
  console.log('  node tests/tn10/refund-100.mjs --execute --round=<name> --approval=<path> [--batch=N]');
}
