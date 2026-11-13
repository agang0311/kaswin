// Offline kaspa-redteam baseline emitter (format kaspa-redteam/baseline/1, see references/kaspa-redteam/BASELINE.md).
//
// Builds honest Kaswin V2.0.2 transactions with the production builders (scripts/core.mjs) against the pinned
// Profile in contracts/, signs the funding inputs with deterministic THROWAWAY keys and declares made-up funding
// coins. Nothing touches a node: such a file can never be broadcast, and no wallet in tests/web/wallets is read.
//
// One file per contract, because --baseline is single-contract and one transaction rejected "as given" aborts
// the whole file. DRAW_AND_PAY goes to its own file sealed-draw.baseline.json: upstream redteam passes no
// SeqCommitAccessor (OpChainblockSeqCommit is an InvalidOpcode), so that file needs the local patch on branch
// kaswin-seqcommit of references/kaspa-redteam, which reads the `seqCommitments` the file declares.
//
//   node tests/redteam/baseline.mjs [--out=DIR]      # default tests/output/redteam/<timestamp>/
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {loadBundle} from '../../scripts/contract/bundle.mjs';
import {S, hex, unhex, le, cat, buildAction, buildOpenGenesis, referenceTxId, p2pk, drawWinner} from '../../scripts/core.mjs';
import {domainHash} from '../../scripts/core/lib/blake3.js';
import {schnorrSighash} from '../../scripts/wallet/sighash.mjs';
import {schnorrSign, xonlyPubkey} from '../../scripts/wallet/schnorr.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outArg = process.argv.find(a => a.startsWith('--out='));

const OUT = outArg ? path.resolve(outArg.slice(6))
  : path.join(ROOT, 'tests/output/redteam', new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z'));

const {profile: P} = await loadBundle(path.join(ROOT, 'contracts'));

// Deterministic throwaway keys. Labelled so nobody mistakes them for funded wallets.
const keyOf = role => {
  const sk = createHash('sha256').update(`kaswin-redteam-throwaway-key:${role}`).digest();
  return {role, sk: new Uint8Array(sk), pk: hex(xonlyPubkey(new Uint8Array(sk)))};
};
const K = {owner: keyOf('owner'), b1: keyOf('buyer-1'), b2: keyOf('buyer-2'), exec: keyOf('executor')};

const FEE = 1_000_000n;            // 0.01 TKAS; consensus judge applies no relay policy
const PRICE = 100_000_000n;
const D0 = 600_000_000n;           // DAA of the genesis block (TN10-like magnitude)
const STEP = 20n;                  // DAA between consecutive transactions

let fakeSeq = 0;
/** A made-up confirmed P2PK coin; its outpoint only has to be unique within the file. */
function coin(key, value) {
  const txid = createHash('sha256').update(`kaswin-redteam-funding:${++fakeSeq}`).digest('hex');
  return {outpoint: {transactionId: txid, index: 0}, value, spk: p2pk(key.pk), daa: D0 - 1000n, covenantId: null};
}

function sign(draft, signer) {
  const tx = draft.transaction, utxos = draft.inputUtxos.map(u => ({value: u.value, spk: u.spk}));
  for (const i of draft.authorizedInputIndices) {
    tx.inputs[i].signatureScript = '41' + hex(schnorrSign(signer.sk, schnorrSighash(tx, utxos, i))) + '01';
  }
  return tx;
}

const spkHex = spk => spk.version.toString(16).padStart(4, '0') + spk.script;
const dec = v => v.toString();

/** Library DTO -> rusty-kaspa Transaction JSON (bytes as hex, amounts as decimal strings). */
function baselineTx(draft, {path: name, pov, signer}) {
  const t = draft.transaction;
  return {
    path: name,
    targets: [0],
    daaScore: dec(pov),
    tx: {
      version: t.version,
      inputs: t.inputs.map(i => ({
        previousOutpoint: {transactionId: i.previousOutpoint.transactionId, index: i.previousOutpoint.index},
        signatureScript: i.signatureScript, sequence: dec(i.sequence), computeBudget: i.computeBudget,
      })),
      outputs: t.outputs.map(o => ({
        value: dec(o.value), scriptPublicKey: spkHex(o.scriptPublicKey),
        covenant: o.covenant ? {authorizingInput: o.covenant.authorizingInput, covenantId: o.covenant.covenantId} : null,
      })),
      lockTime: dec(t.lockTime), subnetworkId: t.subnetworkId, gas: 0, payload: t.payload,
    },
    utxos: draft.inputUtxos.map(u => ({
      amount: dec(u.value), scriptPublicKey: spkHex(u.spk), blockDaaScore: dec(u.daa),
      isCoinbase: false, covenantId: u.covenantId ?? null,
    })),
    // Not read by the tool; kept so a reader can audit what each entry claims to be.
    note: {signer: signer?.role ?? null, action: draft.action, fee: dec(draft.fee), terminal: draft.transition?.terminal ?? null},
  };
}

/** One round, advanced in memory. Each step returns the baseline entry of the transaction it built. */
class Round {
  constructor({cap, min, closeAfter = 600n, label}) {
    this.label = label;
    this.config = {ticketPrice: PRICE, ticketCap: cap, purchaseCap: 256, minTickets: min, closeEligibleDaa: D0 + closeAfter};
    const g = buildOpenGenesis(P, K.owner.pk, this.config, [coin(K.owner, 10n * PRICE)], FEE, null);
    sign(g, K.owner);
    const out = g.transaction.outputs[0];
    this.daa = D0;
    this.x = {
      ledger: S.encodeLedger(S.newOpen(K.owner.pk, this.config)), tip: {transactionId: referenceTxId(g.transaction), index: 0},
      origin: g.origin, covenantId: out.covenant.covenantId, value: out.value, scriptPublicKey: out.scriptPublicKey,
      utxoDaa: D0, currentDaa: D0,
    };
  }
  step(action, signer, {quantity, pov, fund = 0n, name} = {}) {
    pov ??= this.daa + STEP;
    this.x.currentDaa = pov;
    const op = {action, actorKey: signer.pk, ...(quantity ? {quantity} : {})};
    const funds = fund > 0n ? [coin(signer, fund)] : [];
    const d = buildAction(this.x, P, op, FEE, funds);
    sign(d, signer);
    const entry = baselineTx(d, {path: name ?? `${this.label}:${action}`, pov, signer});
    const t = d.transition;
    if (t.next) {
      const out = d.transaction.outputs[0];
      this.x = {...this.x, ledger: S.encodeLedger(t.next), tip: {transactionId: referenceTxId(d.transaction), index: 0},
        value: out.value, scriptPublicKey: out.scriptPublicKey, utxoDaa: pov};
    } else this.x = null;
    this.daa = pov;
    return entry;
  }
  buy(who, qty, name) { return this.step('BUY', who, {quantity: qty, fund: BigInt(qty) * PRICE + FEE + PRICE, name}); }
  /** Timed close waits for closeEligibleDaa; a sold-out close passes `now` to prove the lock is bypassed. */
  close(name, {now = false} = {}) {
    const due = this.config.closeEligibleDaa > this.daa ? this.config.closeEligibleDaa : this.daa;
    const pov = now ? this.daa + STEP : due + STEP;
    if (now && pov >= this.config.closeEligibleDaa) throw Error(`${this.label}: sold-out close must land before closeEligibleDaa`);
    return this.step('CLOSE', K.exec, {pov, fund: FEE + PRICE, name});
  }
}

/** Same opening formula as sealed.sil openSeq / protocol.js (BLAKE3 keyed domains). */
function openSeq(proof, base, parent) {
  const ctx = domainHash('SeqCommitMergesetContext', proof.slice(base + 64, base + 88));
  const pc = domainHash('SeqCommitmentMerkleBranchHash', cat(ctx, proof.slice(base + 32, base + 64)));
  const root = domainHash('SeqCommitmentMerkleBranchHash', cat(proof.slice(base, base + 32), pc));
  return domainHash('SeqCommitmentMerkleBranchHash', cat(parent, root));
}
const filler = (tag, n) => new Uint8Array(createHash('sha256').update(tag).digest()).slice(0, n);
/** A synthetic PASS-A opening whose target block first crosses the draw boundary. Its sequence commitment is
 *  declared in the baseline for the patched judge; nothing here claims such a block exists on any chain. */
function syntheticOpening(r, salt) {
  const boundary = r.x.utxoDaa + S.DRAW_DELAY, o = new Uint8Array(240);
  o.set(filler(`target-hash:${salt}`, 32), 0);                 // target block hash
  o.set(filler(`target-a:${salt}`, 32), 32); o.set(filler(`target-b:${salt}`, 32), 64);
  o.set(le(7n, 8), 96); o.set(le(boundary, 8), 104); o.set(le(1_000_000n, 8), 112);   // target: ?, DAA, blue score
  o.set(filler(`grandparent-seq:${salt}`, 32), 120);
  o.set(filler(`parent-a:${salt}`, 32), 152); o.set(filler(`parent-b:${salt}`, 32), 184);
  o.set(le(7n, 8), 216); o.set(le(boundary - 1n, 8), 224); o.set(le(999_999n, 8), 232); // parent: ?, DAA, blue score
  const t = openSeq(o, 32, openSeq(o, 152, o.slice(120, 152)));
  return {opening: o, accessor: {blockHash: hex(o.slice(0, 32)), sequenceCommitment: hex(t)}};
}
const seqCommitments = {};
/** DRAW_AND_PAY from a SEALED round. Retries the salt until the single sample is not rejected. */
function draw(r, name) {
  const pov = r.x.utxoDaa + S.DRAW_DELAY + STEP;
  for (let salt = 0; salt < 16; salt++) {
    const {opening, accessor} = syntheticOpening(r, `${r.label}:${salt}`);
    try { drawWinner({...r.x, currentDaa: pov}, S.decodeLedger(r.x.ledger), opening, accessor); }
    catch (e) { if (String(e.message).includes('SAMPLE_REJECTED')) continue; throw e; }
    seqCommitments[accessor.blockHash] = accessor.sequenceCommitment;
    r.x.currentDaa = pov;
    const d = buildAction(r.x, P, {action: 'DRAW_AND_PAY', actorKey: K.exec.pk, opening, accessor}, FEE, []);
    const entry = baselineTx(d, {path: name, pov, signer: null});
    r.x = null;
    return entry;
  }
  throw Error(`${r.label}: every synthetic opening was sample-rejected`);
}

const files = {open: [], sealed: [], 'sealed-draw': [], refunding: []};

// R1 empty: zero sales, timed close returns the deposit to the owner.
{
  const r = new Round({cap: 10, min: 3, label: 'R1-empty'});
  files.open.push(r.close('close:empty->EMPTY'));
}
// R3 payout shape: sold out (cap 3), close before closeEligibleDaa -> SEALED (time lock bypass).
{
  const r = new Round({cap: 3, min: 3, label: 'R3-soldout'});
  files.open.push(r.buy(K.b1, 2, 'buy:first-record'));
  files.open.push(r.buy(K.b2, 1, 'buy:sell-out'));
  files.open.push(r.close('close:sold-out->SEALED(no-wait)', {now: true}));
  files['sealed-draw'].push(draw(r, 'draw-and-pay:sold-out->PAID'));
}
// R5 standard payout: 3 records over 10 tickets, timed close -> SEALED -> DRAW_AND_PAY.
{
  const r = new Round({cap: 10, min: 3, label: 'R5-payout'});
  r.buy(K.b1, 1); r.buy(K.b2, 1); r.buy(K.b1, 1);
  r.close();
  files['sealed-draw'].push(draw(r, 'draw-and-pay:timed->PAID'));
}
// R4 timeout: 3 of 10 sold, timed close -> SEALED, never drawn, TIMEOUT_REFUND after 432000 DAA, one final batch.
{
  const r = new Round({cap: 10, min: 3, label: 'R4-timeout'});
  r.buy(K.b1, 2); r.buy(K.b2, 1);
  files.open.push(r.close('close:timed->SEALED'));
  const pov = r.x.utxoDaa + BigInt(S.TIMEOUT_DELAY) + STEP;
  files.sealed.push(r.step('TIMEOUT_REFUND', K.exec, {pov, fund: FEE + PRICE, name: 'timeout:SEALED->REFUNDING'}));
  files.refunding.push(r.step('REFUND', K.exec, {name: 'refund:single-final-batch->REFUNDED'}));
}
// R2 under minimum: 33 records (100 needed), timed close -> REFUNDING, batch of 32 then the final batch of 1.
{
  const r = new Round({cap: 100, min: 100, label: 'R2-under-min'});
  for (let i = 0; i < 33; i++) {
    const e = r.buy(i % 2 ? K.b2 : K.b1, 1);
    if (i === 32) files.open.push({...e, path: 'buy:record-33'});
  }
  files.open.push(r.close('close:timed->REFUNDING'));
  files.refunding.push(r.step('REFUND', K.exec, {name: 'refund:batch-1-of-2(32,cursor->32)'}));
  files.refunding.push(r.step('REFUND', K.exec, {name: 'refund:batch-2-of-2(final)->REFUNDED'}));
}

fs.mkdirSync(OUT, {recursive: true});
// Keys are listed only where the listed role is the attacker's seat (BASELINE.md "Which keys to list"). On import
// the tool rewrites every output paying a listed key to its own attacker address (import.rs parse_outputs), so a
// file whose covenant pins payouts to those keys (REFUND pays the recorded buyers and actorPk) must list none:
// its as-given check would fail. State-only refunds carry no signature anyway. The owner key is never listed.
// The page's sponsored REFUND (one executor P2PK input) cannot be imported at all: the tool swaps that funding
// coin for its own and also redirects outputs paying the coin's address, which is the pinned actorPk payout.
// DRAW_AND_PAY pays actorPk (the executor) a pinned FINALIZER output, so the draw file lists none either.
const KEYS = {open: [K.b1, K.b2, K.exec], sealed: [K.exec], 'sealed-draw': [], refunding: []};
const manifest = {format: 'kaswin-redteam-baseline-manifest/1', profile: P.id, generatedAt: new Date().toISOString(),
  throwawayKeys: Object.fromEntries(Object.values(K).map(k => [k.role, k.pk])), files: {}};
for (const [m, list] of Object.entries(files)) {
  const doc = {format: 'kaspa-redteam/baseline/1', daaScore: dec(D0), pastMedianTime: '1793500000000',
    keys: KEYS[m].map(k => hex(k.sk)), ...(m === 'sealed-draw' ? {seqCommitments} : {}), transactions: list};
  const file = path.join(OUT, `${m}.baseline.json`);
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  manifest.files[m] = {file: path.basename(file), keys: KEYS[m].map(k => k.role), transactions: list.map(t => t.path)};
  console.log(`${m}: ${list.length} 笔 -> ${file}`);
  for (const t of list) console.log(`  ${t.path}  inputs=${t.tx.inputs.length} outputs=${t.tx.outputs.length} lockTime=${t.tx.lockTime} daa=${t.daaScore}`);
}
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`manifest -> ${path.join(OUT, 'manifest.json')}`);
