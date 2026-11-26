// Offline kaspa-redteam baselines for Kaswin kUSDT v2 (Profile 39a29f4e…).
//
// Reuses the exact transaction builders and synthetic fixtures from tests/contracts/kusdt-v2-vm-audit.mjs
// and scripts/protocols/kusdt-v2.mjs against the compiled artifacts in contracts/kusdt-v2/artifacts/.
// Uses only deterministic throwaway test keys; never touches real keys, nodes, or broadcasts.
//
//   node tests/redteam/kusdt-v2-baseline.mjs [--out=DIR]
//
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {blake2b256, covenantId, hex, p2sh} from '../../scripts/core.mjs';
import {MAINNET} from '../../scripts/chain/mainnet.mjs';
import {openMemoryWallet, verifyOrdinarySignatures} from '../../scripts/wallet/wallet.mjs';
import {
  DECISION,
  DRAW_DELAY_DAA,
  KCC20_OWNER_SCHEME,
  KUSDT_V2_TEMPLATE_ORDER,
  KUSDT_V2_VERSION,
  MAINNET_KUSDT_CID,
  STAGE,
} from '../../scripts/protocols/kusdt-v2/constants.mjs';
import {kcc20RedeemAndSpk} from '../../scripts/protocols/kusdt-v2/codec.mjs';
import {encodeKusdtV2State, loadKusdtV2Profile, redeemForState} from '../../scripts/protocols/kusdt-v2/profile.mjs';
import {createKusdtV2Adapter, kusdtDrawSample, resolveKusdtDrawWinner} from '../../scripts/protocols/kusdt-v2.mjs';
import {drawOp as buildSyntheticDrawOp} from '../contracts/fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outArg = process.argv.find(a => a.startsWith('--out='));
const OUT = outArg
  ? path.resolve(outArg.slice(6))
  : path.join(ROOT, 'tests/output/redteam', new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z'), 'kusdt-v2');

const ARTIFACTS_DIR = path.join(ROOT, 'contracts/kusdt-v2/artifacts');
const KCC20_SUFFIX = Uint8Array.from(
  Buffer.from(JSON.parse(fs.readFileSync(path.join(ARTIFACTS_DIR, 'kcc20-suffix.json'), 'utf8')).suffixHex, 'hex'),
);

const keyHex = label => createHash('sha256').update(`kusdt-v2-redteam:${label}`).digest('hex');
const PRICE = 1_000_000n;
const ZERO32 = '00'.repeat(32);
const AUDIT_ORIGIN = {transactionId: keyHex('audit-origin'), index: 0};
const FEE = 100_000n;

const artifacts = {};
for (const name of KUSDT_V2_TEMPLATE_ORDER) {
  artifacts[name] = JSON.parse(fs.readFileSync(path.join(ARTIFACTS_DIR, `${name}.json`), 'utf8'));
}
const profile = loadKusdtV2Profile(artifacts);
const adapter = createKusdtV2Adapter({profile, kcc20Suffix: KCC20_SUFFIX});

const w1 = openMemoryWallet('33'.repeat(32), {prefix: MAINNET.addressPrefix});
const w2 = openMemoryWallet('44'.repeat(32), {prefix: MAINNET.addressPrefix});
const w3 = openMemoryWallet('55'.repeat(32), {prefix: MAINNET.addressPrefix});

const MGR_CID = covenantId(AUDIT_ORIGIN, [{
  index: 0,
  value: 400_000_000n,
  spk: p2sh(hex(blake2b256(redeemForState({
    stage: STAGE.M_OPEN, version: KUSDT_V2_VERSION, creatorPk: w1.key,
    price: PRICE, closeDaa: 700_005_000n, openedCount: 0, cursor: 0, totalTickets: 0, entries: [],
  }, profile)))),
}]);

const spkHex = spk => spk.version.toString(16).padStart(4, '0') + spk.script;
const dec = v => v.toString();

function kasUtxo(label, wallet, value = 2_000_000_000n, daa = 700_000_000n) {
  return {
    outpoint: {transactionId: keyHex(label), index: 0},
    value,
    spk: wallet.spk,
    daa,
    utxoDaa: daa,
    covenantId: null,
  };
}

function makeShard(idx, stage, rc, buyerWallet = w1) {
  const shardCid = keyHex(`sh-${stage}-${idx}-${rc}`);
  const records = Array.from({length: rc}, (_, r) => ({
    cumTickets: r + 1,
    buyerPk: r % 2 === 0 ? buyerWallet.key : w2.key,
  }));
  const state = {
    stage,
    version: KUSDT_V2_VERSION,
    managerCid: MGR_CID,
    firstBuyerPk: buyerWallet.key,
    price: PRICE,
    records,
  };
  const redeem = redeemForState(state, profile);
  const spk = p2sh(hex(blake2b256(redeem)));
  const stateBytes = encodeKusdtV2State(state);
  const ledgerHash = hex(blake2b256(stateBytes));
  return {
    shardCid,
    state,
    redeem,
    spk,
    ledgerHash,
    tickets: rc,
    outpoint: {transactionId: keyHex(`sh-op-${stage}-${idx}-${rc}`), index: 1},
    value: 200_000_000n,
    daa: 700_000_000n,
    utxoDaa: 700_000_000n,
    covenantId: shardCid,
  };
}

function makeManagerOpen(openedCount, cursor, shards) {
  const entries = Array.from({length: openedCount}, (_, i) => {
    const sh = shards[i];
    if (i < cursor) {
      return {shardCid: sh.shardCid, ledgerHash: sh.ledgerHash, cumTickets: (i + 1) * sh.tickets};
    }
    return {shardCid: sh.shardCid, ledgerHash: ZERO32, cumTickets: 0};
  });
  const totalTickets = cursor > 0 ? entries[cursor - 1].cumTickets : 0;
  const state = {
    stage: STAGE.M_OPEN,
    version: KUSDT_V2_VERSION,
    creatorPk: w1.key,
    price: PRICE,
    closeDaa: 700_005_000n,
    openedCount,
    cursor,
    totalTickets,
    entries,
  };
  const redeem = redeemForState(state, profile);
  const spk = p2sh(hex(blake2b256(redeem)));
  return {
    state,
    redeem,
    spk,
    outpoint: {transactionId: keyHex(`mgr-open-${openedCount}-${cursor}`), index: 0},
    value: 400_000_000n,
    daa: 700_000_000n,
    utxoDaa: 700_000_000n,
    covenantId: MGR_CID,
  };
}

function makeManagerSealed(shards) {
  let cum = 0;
  const entries = shards.map(sh => {
    cum += sh.tickets;
    return {shardCid: sh.shardCid, ledgerHash: sh.ledgerHash, cumTickets: cum};
  });
  const state = {
    stage: STAGE.M_SEALED,
    version: KUSDT_V2_VERSION,
    creatorPk: w1.key,
    price: PRICE,
    closeDaa: 700_005_000n,
    openedCount: shards.length,
    cursor: 0,
    totalTickets: cum,
    entries,
  };
  const redeem = redeemForState(state, profile);
  const spk = p2sh(hex(blake2b256(redeem)));
  return {
    state,
    redeem,
    spk,
    outpoint: {transactionId: keyHex(`mgr-sealed-${shards.length}`), index: 0},
    value: 400_000_000n,
    daa: 700_005_100n,
    utxoDaa: 700_005_100n,
    covenantId: MGR_CID,
  };
}

function makeManagerDispatch(shards, cursor, decision) {
  const totalTickets = shards.reduce((s, sh) => s + sh.tickets, 0);
  const state = {
    stage: STAGE.M_DISPATCH,
    version: KUSDT_V2_VERSION,
    creatorPk: w1.key,
    price: PRICE,
    closeDaa: 700_005_000n,
    openedCount: shards.length,
    cursor,
    totalTickets,
    decision,
    reserved: 0,
    winnerPk: decision === DECISION.PAYOUT ? w2.key : ZERO32,
    shardCids: shards.map(s => s.shardCid),
  };
  const redeem = redeemForState(state, profile);
  const spk = p2sh(hex(blake2b256(redeem)));
  return {
    state,
    redeem,
    spk,
    outpoint: {transactionId: keyHex(`mgr-disp-${shards.length}-${cursor}-${decision}`), index: 0},
    value: 400_000_000n,
    daa: 700_006_000n,
    utxoDaa: 700_006_000n,
    covenantId: MGR_CID,
  };
}

const files = {
  m_open: [],
  s_open: [],
  m_sealed: [],
  m_dispatch: [],
  s_frozen: [],
  s_payout: [],
  s_refund: [],
};
const seqCommitments = {};

async function toEntry(name, built, {signer = w1, targets = [0], accessor = null} = {}) {
  const {draft} = built;
  await signer.sign(draft);
  await verifyOrdinarySignatures(draft);
  const t = draft.transaction;
  const maxUtxoDaa = draft.inputUtxos.reduce((m, u) => {
    const d = BigInt(u.utxoDaa ?? u.daa ?? 0);
    return d > m ? d : m;
  }, 0n);
  const minDaa = maxUtxoDaa + 432_000n;
  const entryDaa = (BigInt(t.lockTime) > minDaa ? BigInt(t.lockTime) : minDaa) + 10n;
  if (accessor) seqCommitments[accessor.blockHash] = accessor.sequenceCommitment;
  return {
    path: name,
    targets,
    daaScore: dec(entryDaa),
    tx: {
      version: t.version,
      inputs: t.inputs.map(i => ({
        previousOutpoint: {transactionId: i.previousOutpoint.transactionId, index: i.previousOutpoint.index},
        signatureScript: i.signatureScript,
        sequence: dec(i.sequence),
        computeBudget: i.computeBudget ?? 0,
      })),
      outputs: t.outputs.map(o => ({
        value: dec(o.value),
        scriptPublicKey: spkHex(o.scriptPublicKey),
        covenant: o.covenant ? {authorizingInput: o.covenant.authorizingInput, covenantId: o.covenant.covenantId} : null,
      })),
      lockTime: dec(t.lockTime),
      subnetworkId: t.subnetworkId,
      gas: 0,
      payload: t.payload,
    },
    utxos: draft.inputUtxos.map(u => ({
      amount: dec(u.value),
      scriptPublicKey: spkHex(u.spk),
      blockDaaScore: dec(u.utxoDaa ?? u.daa),
      isCoinbase: false,
      covenantId: u.covenantId ?? null,
    })),
  };
}

// 1. m_open: OPEN_SHARD, EMPTY_CLOSE, COLLECT_BATCH (also feeds s_open COLLECT)
for (const [label, opened, kCount] of [
  ['open_shard:sh=0,1_kcc20', 0, 1],
  ['open_shard:sh=7,1_kcc20', 7, 1],
  ['open_shard:sh=255,3_kcc20', 255, 3],
]) {
  const existing = Array.from({length: opened}, (_, i) => makeShard(i, STAGE.S_OPEN, 1));
  const mgr = makeManagerOpen(opened, 0, existing);
  const perCell = kCount === 1 ? 2_000_000n : 400_000n;
  const kUtxos = Array.from({length: kCount}, (_, j) => {
    const cell = kcc20RedeemAndSpk({amount: perCell, owner: w1.key, ownerScheme: 0, borrowScheme: j === 0 ? 1 : 0}, KCC20_SUFFIX);
    return {
      outpoint: {transactionId: keyHex(`os-k-${opened}-${kCount}-${j}`), index: 0},
      value: 200_000_000n, spk: cell.scriptPubKey, daa: 700_000_000n, utxoDaa: 700_000_000n,
      covenantId: MAINNET_KUSDT_CID, amount: perCell, redeem: cell.redeem,
    };
  });
  const built = adapter.prepareOperation({
    action: 'OPEN_SHARD', managerUtxo: mgr, managerCid: MGR_CID, origin: AUDIT_ORIGIN,
    buyerPk: w1.key, qty: 1, price: PRICE,
    buyerKasUtxos: [kasUtxo(`os-kas-${opened}-${kCount}`, w1)],
    buyerKcc20Utxos: kUtxos, kcc20Suffix: KCC20_SUFFIX, changeSpk: w1.spk, fee: FEE,
  });
  files.m_open.push(await toEntry(label, built));
}

{
  const mgr0 = makeManagerOpen(0, 0, []);
  const built = adapter.prepareOperation({
    action: 'EMPTY_CLOSE', managerUtxo: mgr0, managerCid: MGR_CID, origin: AUDIT_ORIGIN,
    fundingUtxos: [kasUtxo('ec-kas', w1)], changeSpk: w1.spk, fee: FEE,
  });
  files.m_open.push(await toEntry('empty_close', built));
}

for (const [label, opened, cursor, k, rc] of [
  ['collect:2sh,k=2,rc=2', 2, 0, 2, 2],
  ['collect:8sh,k=8,rc=64', 8, 0, 8, 64],
  ['collect:256sh,mid_k=8,rc=256', 256, 0, 8, 256],
  ['collect:256sh,final_k=8,rc=256', 256, 248, 8, 256],
  ['collect:256sh,final_k=1,rc=256', 256, 255, 1, 256],
]) {
  const openShards = Array.from({length: opened}, (_, i) => makeShard(i, i < cursor ? STAGE.S_FROZEN : STAGE.S_OPEN, i < cursor ? 1 : rc));
  const mgr = makeManagerOpen(opened, cursor, openShards);
  const batch = openShards.slice(cursor, cursor + k);
  const builtMgr = adapter.prepareOperation({
    action: 'COLLECT_BATCH', managerUtxo: mgr, managerCid: MGR_CID, origin: AUDIT_ORIGIN,
    shardUtxos: batch, fundingUtxos: [kasUtxo(`cb-${opened}-${cursor}-${k}-${rc}`, w1)],
    changeSpk: w1.spk, fee: FEE,
  });
  files.m_open.push(await toEntry(label, builtMgr));

  const builtShard = adapter.prepareOperation({
    action: 'COLLECT_BATCH', managerUtxo: mgr, managerCid: MGR_CID, origin: AUDIT_ORIGIN,
    shardUtxos: batch, fundingUtxos: [kasUtxo(`cb-${opened}-${cursor}-${k}-${rc}`, w1)],
    changeSpk: w1.spk, fee: FEE,
  });
  files.s_open.push(await toEntry(label, builtShard, {targets: [1]}));
}

// 2. s_open: BUY
for (const [label, rc, kCount] of [
  ['buy:rc=1->2,1_kcc20', 1, 1],
  ['buy:rc=64->65,1_kcc20', 64, 1],
  ['buy:rc=255->256,2_kcc20', 255, 2],
]) {
  const sh = makeShard(0, STAGE.S_OPEN, rc, w1);
  const vault = kcc20RedeemAndSpk({amount: BigInt(rc) * PRICE, owner: sh.shardCid, ownerScheme: KCC20_OWNER_SCHEME.OWNER_COVENANT_ID}, KCC20_SUFFIX);
  const vaultUtxo = {
    outpoint: {transactionId: keyHex(`buy-v-${rc}`), index: 2}, value: 200_000_000n,
    spk: vault.scriptPubKey, daa: 700_000_000n, utxoDaa: 700_000_000n,
    covenantId: MAINNET_KUSDT_CID, amount: BigInt(rc) * PRICE, redeem: vault.redeem,
  };
  const perCell = kCount === 1 ? 2_000_000n : 600_000n;
  const kUtxos = Array.from({length: kCount}, (_, j) => {
    const cell = kcc20RedeemAndSpk({amount: perCell, owner: w2.key, ownerScheme: 0, borrowScheme: 0}, KCC20_SUFFIX);
    return {
      outpoint: {transactionId: keyHex(`buy-k-${rc}-${kCount}-${j}`), index: 0}, value: 200_000_000n,
      spk: cell.scriptPubKey, daa: 700_000_000n, utxoDaa: 700_000_000n,
      covenantId: MAINNET_KUSDT_CID, amount: perCell, redeem: cell.redeem,
    };
  });
  const built = adapter.prepareOperation({
    action: 'BUY', shardUtxo: sh, shardCid: sh.shardCid, vaultUtxo, buyerPk: w2.key, qty: 1, price: PRICE,
    buyerKasUtxos: [kasUtxo(`buy-kas-${rc}-${kCount}`, w2)],
    buyerKcc20Utxos: kUtxos, kcc20Suffix: KCC20_SUFFIX, changeSpk: w2.spk, fee: FEE,
  });
  files.s_open.push(await toEntry(label, built, {signer: w2}));
}

// 3. m_sealed: DRAW + REROLL
for (const [label, opened, rc] of [
  ['draw:2sh,rc=2', 2, 2],
  ['draw:8sh,rc=256', 8, 256],
  ['draw:256sh,rc=256', 256, 256],
]) {
  const frozenShards = Array.from({length: opened}, (_, i) => makeShard(i, STAGE.S_FROZEN, rc));
  const mgr = makeManagerSealed(frozenShards);
  const syn = buildSyntheticDrawOp({manager: {utxoDaa: mgr.utxoDaa}}, 7);
  const sample = kusdtDrawSample({
    cid: MGR_CID, outpoint: mgr.outpoint, utxoDaa: mgr.utxoDaa,
    currentDaa: mgr.utxoDaa + DRAW_DELAY_DAA + 20n, totalTickets: mgr.state.totalTickets,
    proof: syn.proof, accessor: syn.accessor,
  });
  const win = resolveKusdtDrawWinner(
    mgr.state,
    frozenShards.map(s => ({shardCid: s.shardCid, stage: STAGE.S_FROZEN, redeem: s.redeem, frozenRedeem: s.redeem})),
    sample.ticket,
    profile,
  );
  const built = adapter.prepareOperation({
    action: 'DRAW', managerUtxo: mgr, managerCid: MGR_CID,
    passAProof: syn.proof, shardIndex: win.shardIndex, recordIndex: win.recordIndex,
    frozenShardState: win.frozenShardState,
    fundingUtxos: [kasUtxo(`dr-${opened}-${rc}`, w1)], changeSpk: w1.spk, fee: FEE,
  });
  files.m_sealed.push(await toEntry(label, built, {accessor: syn.accessor}));
}

for (const [label, opened] of [['reroll:2sh', 2], ['reroll:256sh', 256]]) {
  const frozenShards = Array.from({length: opened}, (_, i) => makeShard(i, STAGE.S_FROZEN, 2));
  const mgr = makeManagerSealed(frozenShards);
  const built = adapter.prepareOperation({
    action: 'REROLL', managerUtxo: mgr, managerCid: MGR_CID,
    fundingUtxos: [kasUtxo(`rr-${opened}`, w1)], changeSpk: w1.spk, fee: FEE,
  });
  files.m_sealed.push(await toEntry(label, built));
}

// 4. m_dispatch & s_frozen: DISPATCH_BATCH (PAYOUT & REFUND)
for (const [label, opened, cursor, k, rc, decision] of [
  ['dispatch_payout:2sh,k=2,rc=2', 2, 0, 2, 2, DECISION.PAYOUT],
  ['dispatch_payout:256sh,mid_k=8,rc=256', 256, 0, 8, 256, DECISION.PAYOUT],
  ['dispatch_payout:256sh,final_k=8,rc=256', 256, 248, 8, 256, DECISION.PAYOUT],
  ['dispatch_refund:2sh,k=2,rc=1', 2, 0, 2, 1, DECISION.REFUND],
  ['dispatch_refund:1sh,k=1,rc=2', 1, 0, 1, 2, DECISION.REFUND],
]) {
  const frozenShards = Array.from({length: opened}, (_, i) => makeShard(i, STAGE.S_FROZEN, i < cursor ? 1 : rc));
  const mgr = makeManagerDispatch(frozenShards, cursor, decision);
  const batch = frozenShards.slice(cursor, cursor + k);
  const builtMgr = adapter.prepareOperation({
    action: 'DISPATCH_BATCH', managerUtxo: mgr, managerCid: MGR_CID, frozenShardUtxos: batch,
    fundingUtxos: [kasUtxo(`db-${opened}-${cursor}-${k}-${rc}-${decision}`, w1)],
    changeSpk: w1.spk, fee: FEE,
  });
  files.m_dispatch.push(await toEntry(label, builtMgr));

  const builtSh = adapter.prepareOperation({
    action: 'DISPATCH_BATCH', managerUtxo: mgr, managerCid: MGR_CID, frozenShardUtxos: batch,
    fundingUtxos: [kasUtxo(`db-${opened}-${cursor}-${k}-${rc}-${decision}`, w1)],
    changeSpk: w1.spk, fee: FEE,
  });
  files.s_frozen.push(await toEntry(label, builtSh, {targets: [1]}));
}

// 5. s_payout: PAYOUT_EXECUTOR & PAYOUT_SELF
{
  const shCid = keyHex('po-sh');
  const sPayRedeem = redeemForState({
    stage: STAGE.S_PAYOUT, version: KUSDT_V2_VERSION, firstBuyerPk: w1.key,
    winnerPk: w2.key, managerCid: MGR_CID, shardTickets: 256, vaultAmount: 256n * PRICE,
  }, profile);
  const vault = kcc20RedeemAndSpk({amount: 256n * PRICE, owner: shCid, ownerScheme: KCC20_OWNER_SCHEME.OWNER_COVENANT_ID}, KCC20_SUFFIX);
  const shUtxo = {outpoint: {transactionId: keyHex('po-op'), index: 1}, value: 200_000_000n, daa: 700_006_500n, redeem: sPayRedeem};
  const vUtxo = {
    outpoint: {transactionId: keyHex('po-vop'), index: 2}, value: 200_000_000n,
    spk: vault.scriptPubKey, daa: 700_006_500n, utxoDaa: 700_006_500n,
    covenantId: MAINNET_KUSDT_CID, amount: 256n * PRICE, redeem: vault.redeem,
  };
  files.s_payout.push(await toEntry('payout_executor:256_tkt', adapter.prepareOperation({
    action: 'PAYOUT_EXECUTOR', shardUtxo: shUtxo, shardCid: shCid, vaultUtxo: vUtxo, executorPk: w3.key,
    fundingUtxos: [kasUtxo('pe-kas', w3)], kcc20Suffix: KCC20_SUFFIX, changeSpk: w3.spk, fee: FEE,
  }), {signer: w3}));
  files.s_payout.push(await toEntry('payout_self:256_tkt', adapter.prepareOperation({
    action: 'PAYOUT_SELF', shardUtxo: shUtxo, shardCid: shCid, vaultUtxo: vUtxo,
    fundingUtxos: [kasUtxo('ps-kas', w2)], kcc20Suffix: KCC20_SUFFIX, changeSpk: w2.spk, fee: FEE,
  }), {signer: w2}));
}

// 6. s_refund: CLAIM_REFUND (1rc final, 2rc partial, 2rc final)
{
  const shCid1 = keyHex('cr-sh-1');
  const sRef1 = redeemForState({
    stage: STAGE.S_REFUND, version: KUSDT_V2_VERSION, firstBuyerPk: w1.key,
    price: PRICE, claimedMask: 0, records: [{cumTickets: 1, buyerPk: w1.key}],
  }, profile);
  const v1Single = kcc20RedeemAndSpk({amount: PRICE, owner: shCid1, ownerScheme: KCC20_OWNER_SCHEME.OWNER_COVENANT_ID}, KCC20_SUFFIX);
  files.s_refund.push(await toEntry('claim_refund:1rc_final', adapter.prepareOperation({
    action: 'CLAIM_REFUND',
    shardUtxo: {outpoint: {transactionId: keyHex('cr1-op'), index: 1}, value: 200_000_000n, daa: 700_006_500n, redeem: sRef1},
    shardCid: shCid1,
    vaultUtxo: {
      outpoint: {transactionId: keyHex('cr1-vop'), index: 2}, value: 200_000_000n,
      spk: v1Single.scriptPubKey, daa: 700_006_500n, utxoDaa: 700_006_500n,
      covenantId: MAINNET_KUSDT_CID, amount: PRICE, redeem: v1Single.redeem,
    },
    recIdx: 0, fundingUtxos: [kasUtxo('cr1-kas', w1)], kcc20Suffix: KCC20_SUFFIX, changeSpk: w1.spk, fee: FEE,
  }), {signer: w1}));

  const shCid2 = keyHex('cr-sh-2');
  const sRef2 = redeemForState({
    stage: STAGE.S_REFUND, version: KUSDT_V2_VERSION, firstBuyerPk: w1.key,
    price: PRICE, claimedMask: 0, records: [{cumTickets: 1, buyerPk: w1.key}, {cumTickets: 2, buyerPk: w2.key}],
  }, profile);
  const v2 = kcc20RedeemAndSpk({amount: 2n * PRICE, owner: shCid2, ownerScheme: KCC20_OWNER_SCHEME.OWNER_COVENANT_ID}, KCC20_SUFFIX);
  files.s_refund.push(await toEntry('claim_refund:2rc_partial', adapter.prepareOperation({
    action: 'CLAIM_REFUND',
    shardUtxo: {outpoint: {transactionId: keyHex('cr2-op'), index: 1}, value: 200_000_000n, daa: 700_006_500n, redeem: sRef2},
    shardCid: shCid2,
    vaultUtxo: {
      outpoint: {transactionId: keyHex('cr2-vop'), index: 2}, value: 200_000_000n,
      spk: v2.scriptPubKey, daa: 700_006_500n, utxoDaa: 700_006_500n,
      covenantId: MAINNET_KUSDT_CID, amount: 2n * PRICE, redeem: v2.redeem,
    },
    recIdx: 0, fundingUtxos: [kasUtxo('cr2-kas', w1)], kcc20Suffix: KCC20_SUFFIX, changeSpk: w1.spk, fee: FEE,
  }), {signer: w1}));

  const sRefFinal = redeemForState({
    stage: STAGE.S_REFUND, version: KUSDT_V2_VERSION, firstBuyerPk: w1.key,
    price: PRICE, claimedMask: 1, records: [{cumTickets: 1, buyerPk: w1.key}, {cumTickets: 2, buyerPk: w2.key}],
  }, profile);
  const v1 = kcc20RedeemAndSpk({amount: PRICE, owner: shCid2, ownerScheme: KCC20_OWNER_SCHEME.OWNER_COVENANT_ID}, KCC20_SUFFIX);
  files.s_refund.push(await toEntry('claim_refund:2rc_final', adapter.prepareOperation({
    action: 'CLAIM_REFUND',
    shardUtxo: {outpoint: {transactionId: keyHex('cr2f-op'), index: 1}, value: 200_000_000n, daa: 700_006_500n, redeem: sRefFinal},
    shardCid: shCid2,
    vaultUtxo: {
      outpoint: {transactionId: keyHex('cr2f-vop'), index: 2}, value: 200_000_000n,
      spk: v1.scriptPubKey, daa: 700_006_500n, utxoDaa: 700_006_500n,
      covenantId: MAINNET_KUSDT_CID, amount: PRICE, redeem: v1.redeem,
    },
    recIdx: 1, fundingUtxos: [kasUtxo('cr2f-kas', w2)], kcc20Suffix: KCC20_SUFFIX, changeSpk: w2.spk, fee: FEE,
  }), {signer: w2}));
}

w1.close();
w2.close();
w3.close();

fs.mkdirSync(OUT, {recursive: true});
const manifest = {
  format: 'kaswin-kusdt-v2-redteam-baseline-manifest/1',
  profileId: profile.id,
  generatedAt: new Date().toISOString(),
  files: {},
};
for (const [m, list] of Object.entries(files)) {
  if (!list.length) continue;
  const doc = {
    format: 'kaspa-redteam/baseline/1',
    daaScore: '700500000',
    pastMedianTime: '1793500000000',
    ...(m === 'm_sealed' && Object.keys(seqCommitments).length ? {seqCommitments} : {}),
    transactions: list,
  };
  const file = path.join(OUT, `${m}.baseline.json`);
  fs.writeFileSync(file, JSON.stringify(doc, null, 1) + '\n');
  manifest.files[m] = {file: path.basename(file), transactions: list.length, paths: list.map(t => t.path)};
  console.log(`${m}: ${list.length} 笔 -> ${file}`);
}
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
console.log(`manifest -> ${path.join(OUT, 'manifest.json')}`);
