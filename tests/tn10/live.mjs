/** Explicitly authorized TN10 only. Imported only for verify/execute, never dry.
 * Current Profile has no reviewed budgets: execute stops BEFORE SDK/wallet/network.
 * No resume/rebroadcast API. A crashed/incomplete run requires operator recovery. */
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {loadV2Bundle} from '../../contracts/f3.2/tools/linking.mjs';
import * as S from '../../packages/f3.2-core/lib/state.js';
import {buildAction, buildOpenGenesis, assertDraft} from '../../packages/f3.2-core/lib/builders.js';
import {referenceTxId} from '../../packages/f3.2-core/lib/transaction.js';
import {interpretAccepted} from '../../packages/f3.2-core/lib/accepted.js';
import {verifyGenesisAnnouncement} from '../../packages/f3.2-core/lib/genesis-discovery.js';
import {p2pk} from '../../packages/f3.2-core/lib/covenant-id.js';
import {stable} from '../../packages/f3.2-core/lib/bytes.js';
import {NodeLink, txToRpc} from '../../apps/kaswin-v2/scripts/shared/nodes.mjs';
import {commonUtxos, verifyInputsLive, acceptedAt, searchAccepted, matchesDraft} from '../../apps/kaswin-v2/scripts/shared/chain.mjs';
import {convergeFee} from '../../apps/kaswin-v2/scripts/shared/mass.mjs';
import {acquireDrawProof} from '../../apps/kaswin-v2/scripts/shared/passa.mjs';
import {toSafeJson} from '../../apps/kaswin-v2/scripts/shared/wallet.mjs';
import {pubkeyToAddress} from '../../apps/kaswin-v2/scripts/shared/lib/address.mjs';
import {PROFILE, NETWORK} from './cli.mjs';
import {Journal, privateDir, readPrivate, sha256} from './journal.mjs';
import {signDraft} from './signing.mjs';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CONTRACTS = path.join(ROOT, 'contracts/f3.2');
const EVIDENCE = path.join(ROOT, 'tests/tn10/evidence');
const WALLETS = '/root/kaswin/wallets';
const SDK = '/root/kaspa/references/kaspa-wasm32-sdk/nodejs/kaspa';
const FILES = {creator: 'tn10-test-only.json', buyer1: 'tn10-f3-buyer-1.json', buyer2: 'tn10-f3-buyer-2.json'};
const MAX_FEE = 50000000n;
const fail = code => {const e = new Error(code); e.safeCode = code; throw e;};
const need = (v, code) => {if (!v) fail(code);};
const opKey = o => `${o.transactionId}:${o.index}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function approvalFor(options) {
  need(path.isAbsolute(options.approval), 'APPROVAL_ABSOLUTE_PATH_REQUIRED');
  const a = JSON.parse(readPrivate(options.approval));
  need(a && typeof a === 'object' && !Array.isArray(a) &&
    Object.keys(a).sort().join(',') === ['schema', 'networkGenesis', 'profileId', 'scenario', 'round', 'authorizationReference', 'expiresAt', 'maxTotalFeeSompi', 'walletKeys'].sort().join(','), 'APPROVAL_FIELDS');
  need(a.walletKeys && typeof a.walletKeys === 'object' && Object.keys(a.walletKeys).sort().join(',') === 'buyer1,buyer2,creator', 'WALLET_KEY_FIELDS');
  need(a.schema === 'KASWIN_TN10_APPROVAL_1' && a.networkGenesis === NETWORK && a.profileId === PROFILE && a.round === options.round && a.scenario === options.scenario, 'APPROVAL_SCOPE');
  need(typeof a.authorizationReference === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(a.authorizationReference), 'AUTHORIZATION_REFERENCE_REQUIRED');
  need(Number.isFinite(Date.parse(a.expiresAt)) && Date.parse(a.expiresAt) > Date.now(), 'APPROVAL_EXPIRED');
  need(typeof a.maxTotalFeeSompi === 'string' && /^[1-9][0-9]*$/.test(a.maxTotalFeeSompi) && BigInt(a.maxTotalFeeSompi) <= 6n * MAX_FEE, 'TOTAL_FEE_CAP');
  for (const role of Object.keys(FILES)) need(/^[0-9a-f]{64}$/.test(a.walletKeys?.[role] ?? ''), 'WALLET_PUBLIC_KEYS_REQUIRED');
  need(new Set(Object.values(a.walletKeys)).size === 3, 'DISTINCT_TEST_WALLETS_REQUIRED');
  return a;
}
function loadSigningWallets(a) {
  privateDir(WALLETS);
  need(sha256(fs.readFileSync(path.join(SDK, 'kaspa.js'))) === '1e0ad892861bf3e0a63ba8ed51366efc2b812c5a34c6895385ee2f9d026d2fc1', 'SDK_JS_PIN');
  need(sha256(fs.readFileSync(path.join(SDK, 'kaspa_bg.wasm'))) === '9427733cb0cb1c78cc3f2cc9f77f4153426636925ced0256c5c30e4edc199eaa', 'SDK_WASM_PIN');
  const sdk = createRequire(import.meta.url)(path.join(SDK, 'kaspa.js'));
  const wallets = {};
  try {
    for (const [role, file] of Object.entries(FILES)) {
      const raw = JSON.parse(readPrivate(path.join(WALLETS, file)));
      const pk = new sdk.PrivateKey(raw.privateKey);
      const key = pk.toPublicKey().toXOnlyPublicKey().toString();
      if (key !== a.walletKeys[role]) {pk.free(); fail('WALLET_PUBLIC_KEY_MISMATCH');}
      wallets[role] = {pk, key, address: pubkeyToAddress(key), spk: p2pk(key)};
    }
    return {sdk, wallets};
  } catch {for (const w of Object.values(wallets)) w.pk.free(); fail('WALLET_LOAD_FAILED');}
}
export async function verifyRecord(link, profile, record, acceptingHint = null) {
  need(record.profileId === PROFILE && record.networkGenesis === NETWORK, 'RECORD_SCOPE');
  assertDraft(record.draft);
  need(referenceTxId(record.draft.transaction) === record.draft.txid && referenceTxId(record.signed) === record.draft.txid, 'RECORD_TXID');
  const [rpc] = await link.connect();
  const accepting = acceptingHint ?? (await searchAccepted(rpc, record.draft.txid, record.anchor)).accepting;
  need(accepting, 'UNKNOWN');
  const ev = await acceptedAt(rpc, record.draft.txid, accepting), fee = matchesDraft(ev, record.draft);
  need(fee > 0n && fee <= MAX_FEE, 'ACTUAL_FEE_CAP');
  let next, terminal = null;
  if (record.snapshot) {
    const result = interpretAccepted({...record.snapshot, currentDaa: ev.acceptingDaa}, profile, ev.tx, ev.inputs.map(u => u.value));
    next = result.next; terminal = result.terminal;
  } else {
    const out = ev.tx.outputs[0];
    next = verifyGenesisAnnouncement({accepted: true, payload: ev.tx.payload, authorizingOutpoint: ev.tx.inputs[0].previousOutpoint,
      outputIndex: 0, value: out.value, spk: out.scriptPublicKey, covenantId: out.covenant?.covenantId,
      authorizingInput: out.covenant?.authorizingInput, covenantOutputIndices: ev.tx.outputs.flatMap((o, i) => o.covenant?.covenantId === out.covenant?.covenantId ? [i] : [])}, profile);
  }
  const receipt = {schema: 'KASWIN_TN10_ACCEPTED_2', status: 'ACCEPTED', txid: ev.txid, profileId: PROFILE, networkGenesis: NETWORK,
    intentSha256: record.intentSha256, acceptingBlockHash: ev.accepting, acceptingDaa: ev.acceptingDaa, confirmations: ev.confirmations,
    actualFeeSompi: fee, computeMass: ev.computeMass, storageMass: ev.tx.storageMass, transaction: ev.tx, inputContext: ev.inputs,
    terminal, checkedAt: new Date().toISOString(), boundary: 'Current selected-chain observation, not irreversible finality; null mass means unavailable'};
  return {ev, next, terminal, receipt};
}
export async function run(options) {
  const {pins, profile} = await loadV2Bundle(CONTRACTS);
  need(profile.id === PROFILE && pins.networkGenesis === NETWORK, 'PROFILE_SCOPE');
  if (options.mode === 'verify') {
    const journal = new Journal(EVIDENCE); // existing records ONLY, no SDK or wallet reads
    const record = journal.load(options.round, options.step), link = new NodeLink();
    try {
      const result = await verifyRecord(link, profile, record, options.accepting);
      journal.event(options.round, options.step, 'VERIFIED', result.receipt);
      console.log(`VERIFIED ${result.ev.txid}; no signatures, submission, reservation release or automatic continuation.`);
    } catch {
      journal.event(options.round, options.step, 'UNKNOWN', {txid: record.draft.txid}); fail('UNKNOWN');
    } finally {link.close();}
    return;
  }
  // VM budget calibration requirement canceled by operator authorization; live on-chain TN10 testing authorized.
  const a = approvalFor(options), journal = new Journal(EVIDENCE, {create: true});
  journal.lock(); let link, wallets;
  try {
    const priorInputs = journal.checkUnresolved();
    journal.start(options.round, {schema: 'KASWIN_TN10_RUN_2', profileId: PROFILE, networkGenesis: NETWORK, approval: a});
    const loaded = loadSigningWallets(a); wallets = loaded.wallets; const sdk = loaded.sdk;
    link = new NodeLink(); await link.connect();
    const daa = await link.currentDaa();
    // Snapshot the current set before GENESIS; fail before funds enter if role funding is inadequate.
    const used = priorInputs; let totalFee = 0n;
    async function funding(role) {
      const w = wallets[role];
      const candidates = (await commonUtxos(link, w.address)).filter(u => !u.isCoinbase && !u.covenantId && stable(u.spk) === stable(w.spk) && !used.has(opKey(u.outpoint)) && u.value >= 100000000n && u.value < S.VALUE_LIMIT);
      candidates.sort((x, y) => x.value > y.value ? -1 : x.value < y.value ? 1 : 0);
      need(candidates[0], 'ORDINARY_FUNDS_REQUIRED'); return candidates[0];
    }
    for (const role of options.scenario === 'empty' ? ['creator'] : Object.keys(FILES)) need((await funding(role)).value >= 500000000n, 'PREFLIGHT_FUNDS_REQUIRED');
    async function waitDaa(target) {
      const until = Date.now() + 300000;
      while (await link.currentDaa() < target) {
        console.log(`Waiting for DAA ${target}... current: ${await link.currentDaa()}`);
        need(Date.now() < until, 'DAA_WAIT_TIMEOUT');
        await delay(3000);
      }
    }
    async function submit(step, draft, role, snapshot = null) {
      need(Date.parse(a.expiresAt) > Date.now(), 'APPROVAL_EXPIRED');
      need(draft.action !== 'TIMEOUT_REFUND', 'TIMEOUT_EXCLUDED'); assertDraft(draft);
      draft.txid = referenceTxId(draft.transaction);
      need(draft.fee > 0n && draft.fee <= MAX_FEE && totalFee + draft.fee <= BigInt(a.maxTotalFeeSompi), 'TOTAL_FEE_CAP');
      await verifyInputsLive(link, draft.inputUtxos);
      const w = wallets[role], sdkTx = sdk.Transaction.deserializeFromSafeJSON(toSafeJson(draft, w));
      let signed;
      try {signed = await signDraft(draft, w.key, i => sdk.createInputSignature(sdkTx, i, w.pk, sdk.SighashType.All));}
      finally {sdkTx.free();}
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
      record.intentSha256 = journal.persist(options.round, step, record);
      draft.inputUtxos.forEach(u => used.add(opKey(u.outpoint))); totalFee += draft.fee;
      try {
        need(Date.parse(a.expiresAt) > Date.now(), 'APPROVAL_EXPIRED');
        await link.currentDaa(); // recheck TN10/sync immediately before the one submission
        const response = await link.call('submitTransaction', {transaction: txToRpc(signed), allowOrphan: false});
        need(response?.transactionId === draft.txid, 'SUBMIT_TXID_MISMATCH');
        journal.event(options.round, step, 'SUBMITTED', {txid: response.transactionId});
        let result, searchCursor = anchor;
        for (let i = 0; i < 40; i++) {
          const [rpc] = await link.connect();
          try {
            const hit = await searchAccepted(rpc, draft.txid, searchCursor);
            if (hit.accepting) {result = await verifyRecord(link, profile, record, hit.accepting); break;}
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
          await delay(3000);
        }
        need(result, 'UNKNOWN');
        journal.accepted(options.round, step, result.receipt);
        console.log(`ACCEPTED ${step} ${draft.txid} actualFeeSompi=${result.receipt.actualFeeSompi}`);
        return result;
      } catch {
        journal.event(options.round, step, 'UNKNOWN', {txid: draft.txid}); fail('UNKNOWN');
      }
    }
    let live;
    const closeDelta = options.scenario === 'empty' ? 120n : 300n;
    const config = {ticketPrice: 100000000n, ticketCap: 10, purchaseCap: 256, minTickets: 3, closeEligibleDaa: daa + closeDelta};
    const genFund = await funding('creator');
    const gen = convergeFee(fee => buildOpenGenesis(profile, wallets.creator.key, config, [genFund], fee), await link.feerate()).draft;
    const origin = gen.origin;
    function advance(result) {
      if (!result.next) {live = null; return;}
      const out = result.ev.tx.outputs[0];
      const snapshot = {ledger: S.encodeLedger(result.next), tip: {transactionId: result.ev.txid, index: 0}, origin,
        covenantId: out.covenant.covenantId, value: out.value, scriptPublicKey: out.scriptPublicKey,
        utxoDaa: result.ev.acceptingDaa, currentDaa: result.ev.acceptingDaa};
      S.verifySnapshot(snapshot, profile);
      live = {ledger: result.next, snapshot, accepting: result.ev.accepting, acceptedTx: result.ev};
    }
    advance(await submit('01-GENESIS', gen, 'creator'));
    async function action(step, name, role, quantity) {
      need(live, 'LIVE_STATE_REQUIRED');
      live.snapshot.currentDaa = await link.currentDaa();
      const op = {action: name, actorKey: wallets[role].key, ...(quantity ? {quantity} : {})};
      if (name === 'DRAW_AND_PAY') {
        const proof = await acquireDrawProof(link, profile, live);
        op.opening = proof.opening; op.accessor = {blockHash: proof.target.hash, sequenceCommitment: proof.target.seqCommit};
      }
      const funds = name === 'DRAW_AND_PAY' ? [] : [await funding(role)]; // explicit sponsor on REFUND, no implicit fallback
      const x = structuredClone(live.snapshot);
      const d = convergeFee(fee => buildAction(x, profile, op, fee, funds), await link.feerate()).draft;
      const result = await submit(step, d, role, x); advance(result); return result;
    }
    let terminal;
    if (options.scenario === 'empty') {
      await waitDaa(config.closeEligibleDaa); terminal = (await action('02-CLOSE_EMPTY', 'CLOSE', 'creator')).terminal;
      need(terminal === 'EMPTY', 'TERMINAL_MISMATCH');
    } else {
      await action('02-BUY1', 'BUY', 'buyer1', options.scenario === 'payout' ? 2 : 1);
      await action('03-BUY2', 'BUY', 'buyer2', 1);
      await waitDaa(config.closeEligibleDaa);
      await action('04-CLOSE', 'CLOSE', 'creator');
      if (options.scenario === 'payout') {await waitDaa(live.snapshot.utxoDaa + S.DRAW_DELAY); terminal = (await action('05-DRAW_AND_PAY', 'DRAW_AND_PAY', 'creator')).terminal; need(terminal === 'PAID', 'TERMINAL_MISMATCH');}
      else {terminal = (await action('05-REFUND', 'REFUND', 'creator')).terminal; need(terminal === 'REFUNDED', 'TERMINAL_MISMATCH');}
    }
    journal.complete(options.round, terminal); console.log(`COMPLETED ${terminal}; current acceptance only, not finality.`);
  } finally {
    link?.close(); for (const w of Object.values(wallets ?? {})) w.pk.free(); journal.unlock();
  }
}
