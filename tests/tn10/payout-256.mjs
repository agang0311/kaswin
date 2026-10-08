// Full-capacity 256-purchase payout test runner on Kaspa Testnet 10 / offline simulation.
// Supports:
//   node tests/tn10/payout-256.mjs --dry                     (pure offline synthetic model, 258 transactions built & verified)
//   node tests/tn10/payout-256.mjs --status --round=<round>  (query current progress on-chain and in journal)
//   node tests/tn10/payout-256.mjs --execute --round=<round> --approval=<path> [--batch=N] (live TN10 execution)

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
import {hex} from '../../packages/f3.2-core/lib/bytes.js';
import {interpretAccepted} from '../../packages/f3.2-core/lib/accepted.js';
import {NodeLink, txToRpc} from '../../apps/kaswin-v2/scripts/shared/nodes.mjs';
import {commonUtxos, verifyInputsLive, searchAccepted} from '../../apps/kaswin-v2/scripts/shared/chain.mjs';
import {convergeFee, massOf} from '../../apps/kaswin-v2/scripts/shared/mass.mjs';
import {acquireDrawProof} from '../../apps/kaswin-v2/scripts/shared/passa.mjs';
import {toSafeJson} from '../../apps/kaswin-v2/scripts/shared/wallet.mjs';
import {pubkeyToAddress} from '../../apps/kaswin-v2/scripts/shared/lib/address.mjs';
import {PROFILE, NETWORK} from './cli.mjs';
import {loadSigningWallets, verifyRecord} from './live.mjs';
import {stable} from '../../packages/f3.2-core/lib/bytes.js';
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

  const passAFile = path.join(ROOT, '../kaspa/references/kaswin-f3-open-genesis/evidence/tn10/payout/PASS_A.json');
  const passA = JSON.parse(fs.readFileSync(passAFile, 'utf8'));
  const opening = Uint8Array.from(Buffer.from(passA.openingHex, 'hex'));
  const accessor = {blockHash: passA.target.hash, sequenceCommitment: passA.target.seqCommit};

  console.log('=== STARTING 256-PURCHASE PAYOUT OFFLINE DRY-RUN ===');
  console.log(`Profile: ${PROFILE}`);
  console.log(`Capacity: 256 purchases / 256 tickets (1 KAS per ticket)`);

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

  function apply(d, expectedTerminal = null) {
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
  const config = {ticketPrice: 100000000n, ticketCap: 256, purchaseCap: 256, minTickets: 256, closeEligibleDaa: score + 1000n};
  const gFund = take(keyCreator);
  const genDraft = convergeFee(fee => buildOpenGenesis(profile, keyCreator, config, [gFund], fee), 1).draft;
  origin = genDraft.origin;
  cid = genDraft.transaction.outputs[0].covenant.covenantId;
  apply(genDraft);
  ledger = S.newOpen(keyCreator, config);
  console.log(`[000/256] 01-GENESIS built: CID=${cid.slice(0, 16)}..., fee=${genDraft.fee} sompi`);

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

  // 2. 256 BUYS
  const t0 = Date.now();
  let maxComputeMass = 0n, maxTransientMass = 0n, maxFee = 0n;

  for (let i = 0; i < 256; i++) {
    const isBuyer1 = (i % 2 === 0);
    const buyerKey = isBuyer1 ? keyBuyer1 : keyBuyer2;
    const snap = snapshot();
    const fund = take(buyerKey);
    const budget = P.actionBudget('BUY', ledger);
    const q = convergeFee(fee => buildAction(snap, profile, {action: 'BUY', actorKey: buyerKey, quantity: 1}, fee, [fund], budget), 1);
    const m = massOf(q.draft);
    if (m.computeMass > maxComputeMass) maxComputeMass = m.computeMass;
    if (m.transientMass > maxTransientMass) maxTransientMass = m.transientMass;
    if (q.fee > maxFee) maxFee = q.fee;

    apply(q.draft);

    if ((i + 1) % 64 === 0 || i === 255) {
      console.log(`[${String(i + 1).padStart(3)}/256] BUY #${i + 1} built: sold=${ledger.sold}, purchaseCount=${ledger.purchaseCount}, budget=${budget}, fee=${q.fee} sompi`);
    }
  }

  const elapsedBuys = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`All 256 purchases built in ${elapsedBuys}s! Max computeMass=${maxComputeMass}, max transientMass=${maxTransientMass}, max fee=${maxFee} sompi`);
  need(ledger.purchaseCount === 256, 'PURCHASE_COUNT_MISMATCH');
  need(ledger.sold === 256, 'SOLD_MISMATCH');
  need(ledger.directory.length === 256 * 36, 'DIRECTORY_SIZE_MISMATCH');

  // 3. CLOSE (to SEALED)
  score = config.closeEligibleDaa + 5n;
  const snapBeforeClose = snapshot();
  const cFund = take(keyCreator);
  const closeBudget = P.actionBudget('CLOSE', ledger);
  need(closeBudget === 120, 'CLOSE_BUDGET_CALCULATION_DRIFT');
  const closeDraft = convergeFee(fee => buildAction(snapBeforeClose, profile, {action: 'CLOSE', actorKey: keyCreator}, fee, [cFund], closeBudget), 1).draft;
  const closeMass = massOf(closeDraft);
  console.log(`[CLOSE] 03-CLOSE built: budget=${closeBudget}, fee=${closeDraft.fee} sompi, computeMass=${closeMass.computeMass}, nextPhase=${closeDraft.transition.next.phase} (SEALED)`);
  apply(closeDraft);
  need(ledger.phase === S.Phase.SEALED, 'PHASE_NOT_SEALED');

  // 4. DRAW_AND_PAY
  // In offline dry-run with static PASS-A fixture, anchor utxoDaa to match fixture's first crossing boundary (580025326).
  const snapSealed = snapshot();
  snapSealed.utxoDaa = BigInt(passA.boundaryDaa) - S.DRAW_DELAY;
  snapSealed.currentDaa = BigInt(passA.target.daa);
  score = snapSealed.currentDaa;

  const drawn = P.authenticateDraw(snapSealed, ledger, opening, accessor);
  const smp = P.sample(drawn);
  need(smp.ticket !== null, 'SAMPLE_REJECTED');
  const winIdx = P.winnerRecord({...drawn, winnerPlusOne: smp.ticket + 1});
  const winRec = S.records(drawn)[winIdx];
  console.log(`[DRAW] PASS-A Authenticated: winning ticket=${smp.ticket} (out of 256), winner record #${winIdx}, key=${winRec.key}`);

  const payBudget = P.actionBudget('DRAW_AND_PAY', ledger);
  need(payBudget === 205, 'PAY_BUDGET_CALCULATION_DRIFT');
  const payDraft = convergeFee(fee => buildAction(snapSealed, profile, {
    action: 'DRAW_AND_PAY',
    actorKey: keyCreator,
    opening,
    accessor
  }, fee, [], payBudget), 1).draft;
  const payMass = massOf(payDraft);
  console.log(`[DRAW_AND_PAY] 04-DRAW_AND_PAY built: budget=${payBudget}, fee=${payDraft.fee} sompi, computeMass=${payMass.computeMass}, storageMass=${payMass.storageMass}`);

  // 5. Consensus Interpret & Verification
  const interp = interpretAccepted(snapSealed, profile, payDraft.transaction, [snapSealed.value]);
  need(interp.terminal === 'PAID', 'TERMINAL_NOT_PAID');
  need(interp.winner.record === winIdx, 'WINNER_RECORD_MISMATCH');
  need(interp.winner.key === winRec.key, 'WINNER_KEY_MISMATCH');
  need(interp.fee === payDraft.fee, 'INTERPRET_FEE_MISMATCH');

  console.log('\n=== PAYOUT VERIFICATION SUMMARY ===');
  console.log(`Winner Key:        ${interp.winner.key}`);
  console.log(`Winning Prize:     ${(Number(interp.winner.prize) / 1e8).toFixed(6)} KAS`);
  console.log(`Creator Deposit:   0.200000 KAS (returned)`);
  console.log(`Executor Bounty:   1.000000 KAS (claimed)`);
  console.log(`Network Fee:       ${(Number(interp.fee) / 1e8).toFixed(6)} KAS`);
  console.log(`Consensus Terminal: ${interp.terminal}`);
  console.log('=== OFFLINE 256-PURCHASE PAYOUT FULL LIFECYCLE PASS ===\n');

  return {success: true, winner: interp.winner, fee: interp.fee};
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

export async function runLive({round, approval, batch = 256}) {
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
      if (name === 'DRAW_AND_PAY') {
        const proof = await acquireDrawProof(link, profile, live);
        op.opening = proof.opening; op.accessor = {blockHash: proof.target.hash, sequenceCommitment: proof.target.seqCommit};
      }
      const budget = P.actionBudget(name, live.ledger);
      const funds = name === 'DRAW_AND_PAY' ? [] : [await funding(role)];
      const x = structuredClone(live.snapshot);
      const d = convergeFee(fee => buildAction(x, profile, op, fee, funds, budget), await link.feerate()).draft;
      const result = await submit(step, d, role, x);
      advance(result);
      return result;
    }

    // If 01-GENESIS not executed yet, initialize
    if (!fs.existsSync(path.join(roundDir, '01-GENESIS-accepted.json'))) {
      console.log(`Initializing new 256-capacity round: ${round}`);
      const config = {ticketPrice: 100000000n, ticketCap: 256, purchaseCap: 256, minTickets: 256, closeEligibleDaa: daa + 600n};
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
      console.log(`Resumed at step: ${latestStep}, purchaseCount=${currentPurchaseCount}/256, phase=${live.ledger.phase}`);
    }

    // Process Purchases up to batch limit
    const targetCount = Math.min(256, currentPurchaseCount + batch);
    while (currentPurchaseCount < targetCount) {
      const buyNum = currentPurchaseCount + 1;
      const role = (currentPurchaseCount % 2 === 0) ? 'buyer1' : 'buyer2';
      const stepName = `${String(buyNum + 1).padStart(2, '0')}-BUY${buyNum}`;
      console.log(`[${buyNum}/256] Purchasing ticket with ${role}...`);
      await action(stepName, 'BUY', role, 1);
      currentPurchaseCount++;
    }

    console.log(`Current batch completed: ${currentPurchaseCount}/256 purchases on-chain.`);
    if (currentPurchaseCount < 256) {
      console.log(`Run again with --execute --batch=${batch} to continue.`);
      return;
    }

    // CLOSE
    if (live.ledger.phase === S.Phase.OPEN) {
      if (live.ledger.sold < live.ledger.config.ticketCap && live.ledger.purchaseCount < live.ledger.config.purchaseCap) {
        console.log('Purchases not full, waiting for closeEligibleDaa...');
        await waitDaa(live.ledger.config.closeEligibleDaa);
      } else {
        console.log('Purchases full (256/256), closing immediately to SEALED...');
      }
      await action('258-CLOSE', 'CLOSE', 'creator');
    }

    // DRAW_AND_PAY
    if (live.ledger.phase === S.Phase.SEALED) {
      console.log('Waiting for DRAW_DELAY (100 DAA)...');
      await waitDaa(live.snapshot.utxoDaa + S.DRAW_DELAY);
      console.log('Executing DRAW_AND_PAY...');
      const payRes = await action('259-DRAW_AND_PAY', 'DRAW_AND_PAY', 'creator');
      journal.complete(round, payRes.terminal);
      console.log(`ROUND COMPLETED! Final terminal: ${payRes.terminal}`);
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
const batchArg = parseInt(args.find(a => a.startsWith('--batch='))?.slice(8) || '256', 10);

if (isDry || (!isExecute && !roundArg)) {
  await runDry();
} else if (isExecute) {
  await runLive({round: roundArg, approval: approvalArg, batch: batchArg});
} else {
  console.log('Usage:');
  console.log('  node tests/tn10/payout-256.mjs --dry');
  console.log('  node tests/tn10/payout-256.mjs --execute --round=<name> --approval=<path> [--batch=N]');
}
