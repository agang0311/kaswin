/** Offline real-VM (kaspa-txscript 2.1.0) computeBudget, mass, and fee audit for Kaswin kUSDT v2.
 * Uses only synthetic deterministic test keys; never touches real keys, nodes, or broadcasts.
 * Usage (via tester): KASWIN_VM_BIN=/root/kaspa/references/toolchains/rolling-vm-target/release/kaswin-rolling-vm node tests/contracts/kusdt-v2-vm-audit.mjs
 */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {blake2b256, convergeFee, hex, massOf, p2sh, unhex} from '../../scripts/core.mjs';
import {MAINNET} from '../../scripts/chain/mainnet.mjs';
import {openMemoryWallet, verifyOrdinarySignatures} from '../../scripts/wallet/wallet.mjs';
import {
  DECISION,
  DRAW_DELAY_DAA,
  FEE_CAP,
  KCC20_OWNER_SCHEME,
  KUSDT_V2_TEMPLATE_ORDER,
  KUSDT_V2_VERSION,
  MAINNET_KUSDT_CID,
  STAGE,
} from '../../scripts/protocols/kusdt-v2/constants.mjs';
import {kcc20RedeemAndSpk} from '../../scripts/protocols/kusdt-v2/codec.mjs';
import {encodeKusdtV2State, loadKusdtV2Profile, redeemForState} from '../../scripts/protocols/kusdt-v2/profile.mjs';
import {createKusdtV2Adapter, kusdtDrawSample, resolveKusdtDrawWinner} from '../../scripts/protocols/kusdt-v2.mjs';
import {drawOp as buildSyntheticDrawOp} from './fixtures.mjs';
import {runEngine} from './engine-gate.mjs';

const ARTIFACTS_DIR = join(process.cwd(), 'contracts/kusdt-v2/artifacts');
const KCC20_TEMPLATE_PATH = '/root/kaspa/references/kaspire-wallet/crates/kaspa_secure_core/src/kcc20_standard_template.json';
const KCC20_SUFFIX = Uint8Array.from(
  Buffer.from(JSON.parse(readFileSync(KCC20_TEMPLATE_PATH, 'utf8')).suffix, 'hex'),
);

const keyHex = label => createHash('sha256').update(`kusdt-v2-vm-audit:${label}`).digest('hex');
const MGR_CID = keyHex('mgr-cid');
const PRICE = 1_000_000n;
const ZERO32 = '00'.repeat(32);

const artifacts = {};
for (const name of KUSDT_V2_TEMPLATE_ORDER) {
  artifacts[name] = JSON.parse(readFileSync(join(ARTIFACTS_DIR, `${name}.json`), 'utf8'));
}
const profile = loadKusdtV2Profile(artifacts);
const adapter = createKusdtV2Adapter({profile, kcc20Suffix: KCC20_SUFFIX});

const w1 = openMemoryWallet('33'.repeat(32), {prefix: MAINNET.addressPrefix});
const w2 = openMemoryWallet('44'.repeat(32), {prefix: MAINNET.addressPrefix});
const w3 = openMemoryWallet('55'.repeat(32), {prefix: MAINNET.addressPrefix});

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

const fmtKas = sompi => (Number(sompi) / 1e8).toFixed(6);

async function auditCase(name, buildFn, {signer = w1, accessor = null} = {}) {
  // 1) Build with fixed small fee (100_000n) to measure VM exact minBudget regardless of mass/fee limits
  const raw = buildFn(100_000n);
  await signer.sign(raw.draft);
  await verifyOrdinarySignatures(raw.draft);

  const curBudgets = raw.draft.transaction.inputs.map(i => i.computeBudget);
  const vmUnlimited = runEngine(raw.draft, {limited: false, accessor});
  const vmMinBudgets = vmUnlimited.inputs.map(x => x.minBudget);
  const underBudgetInputs = vmMinBudgets
    .map((minB, idx) => ({idx, cur: curBudgets[idx], min: minB}))
    .filter(x => x.cur < x.min);

  // Check current budgets under limited: true
  let curVmOk = true;
  let curVmErr = null;
  try {
    runEngine(raw.draft, {limited: true, accessor});
  } catch (e) {
    curVmOk = false;
    curVmErr = e?.message ?? String(e);
  }

  // Quote current-budget mass & converged fee at feerate = '1' (relayFloor) AND '100' (live mainnet getFeeEstimate!)
  const curMass = massOf(raw.draft);
  let curFee = null;
  let curFeeMainnet100 = null;
  let curLimitErr = null;
  try {
    const conv = convergeFee(f => buildFn(f).draft, '1', {cap: FEE_CAP});
    curFee = conv.fee;
    const conv100 = convergeFee(f => buildFn(f).draft, '100', {cap: FEE_CAP});
    curFeeMainnet100 = conv100.fee;
  } catch (e) {
    curLimitErr = e?.code ?? e?.message ?? String(e);
  }

  // Build tight-budget (+2 safety margin per input, min 2) version and verify limited: true on real VM!
  const tightBudgets = vmMinBudgets.map(b => Math.max(2, b + 2));
  const tightRaw = buildFn(100_000n);
  tightRaw.draft.transaction.inputs.forEach((inp, idx) => { inp.computeBudget = tightBudgets[idx]; });
  await signer.sign(tightRaw.draft);
  await verifyOrdinarySignatures(tightRaw.draft);
  let tightVmOk = true;
  try {
    runEngine(tightRaw.draft, {limited: true, accessor});
  } catch {
    tightVmOk = false;
  }
  const tightMass = massOf(tightRaw.draft);
  let tightFee = null;
  let tightLimitErr = null;
  try {
    const convTight = convergeFee(f => {
      const b = buildFn(f);
      b.draft.transaction.inputs.forEach((inp, idx) => { inp.computeBudget = tightBudgets[idx]; });
      return b.draft;
    }, '1', {cap: FEE_CAP});
    tightFee = convTight.fee;
  } catch (e) {
    tightLimitErr = e?.code ?? e?.message ?? String(e);
  }

  const curOver = [];
  if (curMass.computeMass > 500000n) curOver.push('compute>500k');
  if (curMass.transientMass > 1000000n) curOver.push('transient>1M');
  if (curMass.storageMass > 500000n) curOver.push('storage>500k');
  if (curMass.relayFloor > FEE_CAP) curOver.push('fee>0.5KAS');

  const tightOver = [];
  if (tightMass.computeMass > 500000n) tightOver.push('compute>500k');
  if (tightMass.transientMass > 1000000n) tightOver.push('transient>1M');
  if (tightMass.storageMass > 500000n) tightOver.push('storage>500k');
  if (tightMass.relayFloor > FEE_CAP) tightOver.push('fee>0.5KAS');

  return {
    name,
    inOut: `${raw.draft.transaction.inputs.length}/${raw.draft.transaction.outputs.length}`,
    size: Number(curMass.size),
    curBudgets: curBudgets.join('+'),
    vmMinBudgets: vmMinBudgets.join('+'),
    sumCurB: curBudgets.reduce((a, b) => a + b, 0),
    sumMinB: vmMinBudgets.reduce((a, b) => a + b, 0),
    curVmOk: curVmOk && underBudgetInputs.length === 0,
    underBudgetInputs,
    tightVmOk,
    curCompute: Number(curMass.computeMass),
    tightCompute: Number(tightMass.computeMass),
    transient: Number(curMass.transientMass),
    normTrans: Number(curMass.normalizedTransient),
    storage: Number(curMass.storageMass),
    curFeeKas: curFee != null ? fmtKas(curFee) : `ERR:${curLimitErr}`,
    curFeeMainnet100Kas: curFeeMainnet100 != null ? fmtKas(curFeeMainnet100) : `ERR:${curLimitErr}`,
    tightFeeKas: tightFee != null ? fmtKas(tightFee) : `ERR:${tightLimitErr}`,
    savePct: curFee != null && tightFee != null && curFee > 0n
      ? `${((Number(curFee - tightFee) / Number(curFee)) * 100).toFixed(1)}%`
      : '-',
    curOver: curOver.join(','),
    tightOver: tightOver.join(','),
    curVmErr,
  };
}

const rows = [];

// 1. CREATE_ROUND (with & without registry)
rows.push(await auditCase('GENESIS (no registry)', fee => adapter.prepareOperation({
  action: 'CREATE_ROUND', creatorPk: w1.key, price: PRICE, closeDaa: 700_005_000n,
  fundingUtxos: [kasUtxo('gen-1', w1)], changeSpk: w1.spk, fee,
})));
rows.push(await auditCase('GENESIS (+registry)', fee => adapter.prepareOperation({
  action: 'CREATE_ROUND', creatorPk: w1.key, price: PRICE, closeDaa: 700_005_000n,
  fundingUtxos: [kasUtxo('gen-2', w1)], changeSpk: w1.spk, registrySpk: w3.spk, fee,
})));

// 2. OPEN_SHARD (0, 7, 255 opened shards; 1 vs actual 3 KCC-20 inputs consumed!)
for (const [label, opened, kCount] of [
  ['OPEN_SHARD (sh=0, 1 kcc20)', 0, 1],
  ['OPEN_SHARD (sh=7, 1 kcc20)', 7, 1],
  ['OPEN_SHARD (sh=255, 1 kcc20)', 255, 1],
  ['OPEN_SHARD (sh=255, 3 kcc20)', 255, 3],
]) {
  const existing = Array.from({length: opened}, (_, i) => makeShard(i, STAGE.S_OPEN, 1));
  const mgr = makeManagerOpen(opened, 0, existing);
  const perCell = kCount === 1 ? 2_000_000n : 400_000n; // 3 * 400k = 1.2M >= 1M -> forces all 3 KCC-20 inputs!
  const kUtxos = Array.from({length: kCount}, (_, j) => {
    const cell = kcc20RedeemAndSpk({amount: perCell, owner: w1.key, ownerScheme: 0, borrowScheme: j === 0 ? 1 : 0}, KCC20_SUFFIX);
    return {outpoint: {transactionId: keyHex(`os-k-${opened}-${kCount}-${j}`), index: 0}, value: 200_000_000n, spk: cell.scriptPubKey, daa: 700_000_000n, utxoDaa: 700_000_000n, covenantId: MAINNET_KUSDT_CID, amount: perCell, redeem: cell.redeem};
  });
  rows.push(await auditCase(label, fee => adapter.prepareOperation({
    action: 'OPEN_SHARD', managerUtxo: mgr, managerCid: MGR_CID, buyerPk: w1.key, qty: 1, price: PRICE,
    buyerKasUtxos: [kasUtxo(`os-kas-${opened}-${kCount}`, w1)], buyerKcc20Utxos: kUtxos, kcc20Suffix: KCC20_SUFFIX, changeSpk: w1.spk, fee,
  })));
}

// 3. BUY (rc=1, rc=64, rc=255; 1 vs actual 2 buyer KCC-20 inputs consumed!)
for (const [label, rc, kCount] of [
  ['BUY (rc=1->2, 1 kcc20)', 1, 1],
  ['BUY (rc=64->65, 1 kcc20)', 64, 1],
  ['BUY (rc=255->256 MAX, 1 kcc20)', 255, 1],
  ['BUY (rc=255->256 MAX, 2 kcc20)', 255, 2],
]) {
  const sh = makeShard(0, STAGE.S_OPEN, rc, w1);
  const vault = kcc20RedeemAndSpk({amount: BigInt(rc) * PRICE, owner: sh.shardCid, ownerScheme: KCC20_OWNER_SCHEME.OWNER_COVENANT_ID}, KCC20_SUFFIX);
  const vaultUtxo = {outpoint: {transactionId: keyHex(`buy-v-${rc}`), index: 2}, value: 200_000_000n, spk: vault.scriptPubKey, daa: 700_000_000n, utxoDaa: 700_000_000n, covenantId: MAINNET_KUSDT_CID, amount: BigInt(rc) * PRICE, redeem: vault.redeem};
  const perCell = kCount === 1 ? 2_000_000n : 600_000n; // 2 * 600k = 1.2M >= 1M -> forces both buyer KCC-20 inputs!
  const kUtxos = Array.from({length: kCount}, (_, j) => {
    const cell = kcc20RedeemAndSpk({amount: perCell, owner: w2.key, ownerScheme: 0, borrowScheme: 0}, KCC20_SUFFIX);
    return {outpoint: {transactionId: keyHex(`buy-k-${rc}-${kCount}-${j}`), index: 0}, value: 200_000_000n, spk: cell.scriptPubKey, daa: 700_000_000n, utxoDaa: 700_000_000n, covenantId: MAINNET_KUSDT_CID, amount: perCell, redeem: cell.redeem};
  });
  rows.push(await auditCase(label, fee => adapter.prepareOperation({
    action: 'BUY', shardUtxo: sh, shardCid: sh.shardCid, vaultUtxo, buyerPk: w2.key, qty: 1, price: PRICE,
    buyerKasUtxos: [kasUtxo(`buy-kas-${rc}-${kCount}`, w2)], buyerKcc20Utxos: kUtxos, kcc20Suffix: KCC20_SUFFIX, changeSpk: w2.spk, fee,
  }), {signer: w2}));
}

// 4. EMPTY_CLOSE
{
  const mgr0 = makeManagerOpen(0, 0, []);
  rows.push(await auditCase('EMPTY_CLOSE', fee => adapter.prepareOperation({
    action: 'EMPTY_CLOSE', managerUtxo: mgr0, managerCid: MGR_CID,
    fundingUtxos: [kasUtxo('ec-kas', w1)], changeSpk: w1.spk, fee,
  })));
}

// 5. COLLECT_BATCH (small, 8x1, 8x64, 8x256, 256-shard mid & final x k=8/4/2/1 full 256-rc shards!)
for (const [label, opened, cursor, k, rc] of [
  ['COLLECT (2sh, k=2, rc=2)', 2, 0, 2, 2],
  ['COLLECT (8sh, k=8, rc=1)', 8, 0, 8, 1],
  ['COLLECT (8sh, k=8, rc=64)', 8, 0, 8, 64],
  ['COLLECT (8sh, k=8, rc=256)', 8, 0, 8, 256],
  ['COLLECT (256sh, mid k=8, rc=256)', 256, 0, 8, 256],
  ['COLLECT (256sh, final k=8, rc=256 MAX)', 256, 248, 8, 256],
  ['COLLECT (256sh, final k=4, rc=256)', 256, 252, 4, 256],
  ['COLLECT (256sh, final k=2, rc=256)', 256, 254, 2, 256],
  ['COLLECT (256sh, final k=1, rc=256)', 256, 255, 1, 256],
]) {
  const openShards = Array.from({length: opened}, (_, i) => makeShard(i, i < cursor ? STAGE.S_FROZEN : STAGE.S_OPEN, i < cursor ? 1 : rc));
  const mgr = makeManagerOpen(opened, cursor, openShards);
  const batch = openShards.slice(cursor, cursor + k);
  rows.push(await auditCase(label, fee => adapter.prepareOperation({
    action: 'COLLECT_BATCH', managerUtxo: mgr, managerCid: MGR_CID, shardUtxos: batch,
    fundingUtxos: [kasUtxo(`cb-${opened}-${cursor}-${k}-${rc}`, w1)], changeSpk: w1.spk, fee,
  })));
}

// 6. DRAW (2sh/rc=2, 8sh/rc=256, 64sh/rc=256, 128sh/rc=256, 256sh/rc=256 MAX)
for (const [label, opened, rc] of [
  ['DRAW (2sh, rc=2)', 2, 2],
  ['DRAW (8sh, rc=256)', 8, 256],
  ['DRAW (64sh, rc=256)', 64, 256],
  ['DRAW (128sh, rc=256)', 128, 256],
  ['DRAW (256sh, rc=256 MAX)', 256, 256],
]) {
  const frozenShards = Array.from({length: opened}, (_, i) => makeShard(i, STAGE.S_FROZEN, rc));
  const mgr = makeManagerSealed(frozenShards);
  const syn = buildSyntheticDrawOp({manager: {utxoDaa: mgr.utxoDaa}}, 7);
  const sample = kusdtDrawSample({
    cid: MGR_CID, outpoint: mgr.outpoint, utxoDaa: mgr.utxoDaa,
    currentDaa: mgr.utxoDaa + DRAW_DELAY_DAA + 20n, totalTickets: mgr.state.totalTickets,
    proof: syn.proof, accessor: syn.accessor,
  });
  const win = resolveKusdtDrawWinner(mgr.state, frozenShards.map(s => ({shardCid: s.shardCid, stage: STAGE.S_FROZEN, redeem: s.redeem, frozenRedeem: s.redeem})), sample.ticket, profile);
  rows.push(await auditCase(label, fee => adapter.prepareOperation({
    action: 'DRAW', managerUtxo: mgr, managerCid: MGR_CID,
    passAProof: syn.proof, shardIndex: win.shardIndex, recordIndex: win.recordIndex, frozenShardState: win.frozenShardState,
    fundingUtxos: [kasUtxo(`dr-${opened}-${rc}`, w1)], changeSpk: w1.spk, fee,
  }), {accessor: syn.accessor}));
}

// 7. REROLL (2sh & 256sh MAX)
for (const [label, opened] of [['REROLL (2sh)', 2], ['REROLL (256sh MAX)', 256]]) {
  const frozenShards = Array.from({length: opened}, (_, i) => makeShard(i, STAGE.S_FROZEN, 2));
  const mgr = makeManagerSealed(frozenShards);
  rows.push(await auditCase(label, fee => adapter.prepareOperation({
    action: 'REROLL', managerUtxo: mgr, managerCid: MGR_CID,
    fundingUtxos: [kasUtxo(`rr-${opened}`, w1)], changeSpk: w1.spk, fee,
  })));
}

// 8. DISPATCH_BATCH (PAYOUT small, 8x256, 256sh mid & final x k=8/4 full 256-rc; REFUND 2x1)
for (const [label, opened, cursor, k, rc, dec] of [
  ['DISPATCH PAYOUT (2sh, k=2, rc=2)', 2, 0, 2, 2, DECISION.PAYOUT],
  ['DISPATCH PAYOUT (8sh, k=8, rc=256)', 8, 0, 8, 256, DECISION.PAYOUT],
  ['DISPATCH PAYOUT (256sh, mid k=8, rc=256)', 256, 0, 8, 256, DECISION.PAYOUT],
  ['DISPATCH PAYOUT (256sh, final k=8, rc=256 MAX)', 256, 248, 8, 256, DECISION.PAYOUT],
  ['DISPATCH PAYOUT (256sh, final k=4, rc=256)', 256, 252, 4, 256, DECISION.PAYOUT],
  ['DISPATCH REFUND (2sh, k=2, rc=1)', 2, 0, 2, 1, DECISION.REFUND],
]) {
  const frozenShards = Array.from({length: opened}, (_, i) => makeShard(i, STAGE.S_FROZEN, i < cursor ? 1 : rc));
  const mgr = makeManagerDispatch(frozenShards, cursor, dec);
  const batch = frozenShards.slice(cursor, cursor + k);
  rows.push(await auditCase(label, fee => adapter.prepareOperation({
    action: 'DISPATCH_BATCH', managerUtxo: mgr, managerCid: MGR_CID, frozenShardUtxos: batch,
    fundingUtxos: [kasUtxo(`db-${opened}-${cursor}-${k}-${rc}-${dec}`, w1)], changeSpk: w1.spk, fee,
  })));
}

// 9. PAYOUT_EXECUTOR & PAYOUT_SELF
{
  const shCid = keyHex('po-sh');
  const sPayRedeem = redeemForState({
    stage: STAGE.S_PAYOUT, version: KUSDT_V2_VERSION, firstBuyerPk: w1.key,
    winnerPk: w2.key, managerCid: MGR_CID, shardTickets: 256, vaultAmount: 256n * PRICE,
  }, profile);
  const vault = kcc20RedeemAndSpk({amount: 256n * PRICE, owner: shCid, ownerScheme: KCC20_OWNER_SCHEME.OWNER_COVENANT_ID}, KCC20_SUFFIX);
  const shUtxo = {outpoint: {transactionId: keyHex('po-op'), index: 1}, value: 200_000_000n, daa: 700_006_500n, redeem: sPayRedeem};
  const vUtxo = {outpoint: {transactionId: keyHex('po-vop'), index: 2}, value: 200_000_000n, spk: vault.scriptPubKey, daa: 700_006_500n, utxoDaa: 700_006_500n, covenantId: MAINNET_KUSDT_CID, amount: 256n * PRICE, redeem: vault.redeem};
  rows.push(await auditCase('PAYOUT_EXECUTOR (256 tkt)', fee => adapter.prepareOperation({
    action: 'PAYOUT_EXECUTOR', shardUtxo: shUtxo, shardCid: shCid, vaultUtxo: vUtxo, executorPk: w3.key,
    fundingUtxos: [kasUtxo('pe-kas', w3)], kcc20Suffix: KCC20_SUFFIX, changeSpk: w3.spk, fee,
  }), {signer: w3}));
  rows.push(await auditCase('PAYOUT_SELF (256 tkt)', fee => adapter.prepareOperation({
    action: 'PAYOUT_SELF', shardUtxo: shUtxo, shardCid: shCid, vaultUtxo: vUtxo,
    fundingUtxos: [kasUtxo('ps-kas', w2)], kcc20Suffix: KCC20_SUFFIX, changeSpk: w2.spk, fee,
  }), {signer: w2}));
}

// 10. CLAIM_REFUND (1-record final, 2-record partial + final)
{
  const shCid = keyHex('cr-sh-2');
  const sRef2 = redeemForState({
    stage: STAGE.S_REFUND, version: KUSDT_V2_VERSION, firstBuyerPk: w1.key,
    price: PRICE, claimedMask: 0, records: [{cumTickets: 1, buyerPk: w1.key}, {cumTickets: 2, buyerPk: w2.key}],
  }, profile);
  const v2 = kcc20RedeemAndSpk({amount: 2n * PRICE, owner: shCid, ownerScheme: KCC20_OWNER_SCHEME.OWNER_COVENANT_ID}, KCC20_SUFFIX);
  rows.push(await auditCase('CLAIM_REFUND (2rc, partial)', fee => adapter.prepareOperation({
    action: 'CLAIM_REFUND',
    shardUtxo: {outpoint: {transactionId: keyHex('cr2-op'), index: 1}, value: 200_000_000n, daa: 700_006_500n, redeem: sRef2},
    shardCid: shCid,
    vaultUtxo: {outpoint: {transactionId: keyHex('cr2-vop'), index: 2}, value: 200_000_000n, spk: v2.scriptPubKey, daa: 700_006_500n, utxoDaa: 700_006_500n, covenantId: MAINNET_KUSDT_CID, amount: 2n * PRICE, redeem: v2.redeem},
    recIdx: 0, fundingUtxos: [kasUtxo('cr2-kas', w1)], kcc20Suffix: KCC20_SUFFIX, changeSpk: w1.spk, fee,
  }), {signer: w1}));

  const sRefFinal = redeemForState({
    stage: STAGE.S_REFUND, version: KUSDT_V2_VERSION, firstBuyerPk: w1.key,
    price: PRICE, claimedMask: 1, records: [{cumTickets: 1, buyerPk: w1.key}, {cumTickets: 2, buyerPk: w2.key}],
  }, profile);
  const v1 = kcc20RedeemAndSpk({amount: PRICE, owner: shCid, ownerScheme: KCC20_OWNER_SCHEME.OWNER_COVENANT_ID}, KCC20_SUFFIX);
  rows.push(await auditCase('CLAIM_REFUND (2rc, final)', fee => adapter.prepareOperation({
    action: 'CLAIM_REFUND',
    shardUtxo: {outpoint: {transactionId: keyHex('cr2f-op'), index: 1}, value: 200_000_000n, daa: 700_006_500n, redeem: sRefFinal},
    shardCid: shCid,
    vaultUtxo: {outpoint: {transactionId: keyHex('cr2f-vop'), index: 2}, value: 200_000_000n, spk: v1.scriptPubKey, daa: 700_006_500n, utxoDaa: 700_006_500n, covenantId: MAINNET_KUSDT_CID, amount: PRICE, redeem: v1.redeem},
    recIdx: 1, fundingUtxos: [kasUtxo('cr2f-kas', w2)], kcc20Suffix: KCC20_SUFFIX, changeSpk: w2.spk, fee,
  }), {signer: w2}));
}

console.log(JSON.stringify(rows, null, 2));
w1.close(); w2.close(); w3.close();
