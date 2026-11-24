/** Offline unit tests for Kaswin kUSDT v2 Phase 2 ProtocolAdapter, codec, profile loader, round summary, and tx builders. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {
  CLOSE_DAA_MAX,
  DECISION,
  FEE_CAP,
  FROZEN_MAINNET_TEMPLATE_HASHES,
  KCC20_OWNER_SCHEME,
  KUSDT_V2_PROTOCOL_ID,
  KUSDT_V2_TEMPLATE_ORDER,
  KUSDT_V2_VERSION,
  MAINNET_KUSDT_CID,
  MAX_ACTIVE_OPEN_SHARDS,
  MAX_RECORDS_PER_SHARD,
  PRICE_MAX,
  STAGE,
} from '../../scripts/protocols/kusdt-v2/constants.mjs';
import {verifyKusdtV2GenesisRoot} from '../../scripts/protocols/kusdt-v2/round.mjs';
import {statusAfterFailure} from '../../scripts/tracking/intent.mjs';
import {RpcError} from '../../scripts/chain/nodes.mjs';
import {classifyRejection} from '../../scripts/tracking/conflict.mjs';
import {
  decodeKcc20State,
  decodeManagerState,
  decodeShardState,
  encodeKcc20State,
  encodeManagerDispatchState,
  encodeManagerOpenOrSealedState,
  encodeShardOpenOrFrozenState,
  encodeShardPayoutState,
  encodeShardRefundState,
  kcc20RedeemAndSpk,
  verifyKcc20Suffix,
} from '../../scripts/protocols/kusdt-v2/codec.mjs';
import {
  loadKusdtV2Profile,
  redeemForState,
  verifyKusdtV2Redeem,
} from '../../scripts/protocols/kusdt-v2/profile.mjs';
import {
  createKusdtV2Adapter,
  discoverOwnerKcc20Utxos,
  isBuyableOpenShard,
  isMutableStandaloneShard,
  kusdtDrawSample,
  kusdtV2WatchTargets,
  prepareBatchWithStepDown,
  resolveKusdtDrawWinner,
  selectKcc20Cells,
  verifyKusdtDrawReceipt,
} from '../../scripts/protocols/kusdt-v2.mjs';
import {encodeKusdtV2State} from '../../scripts/protocols/kusdt-v2/profile.mjs';
import {DRAW_DELAY_DAA, REROLL_TIMEOUT_DAA} from '../../scripts/protocols/kusdt-v2/constants.mjs';
import {drawOp as buildSyntheticDrawOp} from '../contracts/fixtures.mjs';
import {createRollingV1Adapter} from '../../scripts/protocols/rolling-v1.mjs';
import {createProtocolRegistry, validateProtocolAdapter} from '../../scripts/protocols/registry.mjs';
import {createController} from '../../scripts/round/controller.mjs';
import {createIndexerClient} from '../../scripts/round/indexer-client.mjs';
import {RoundStore, MemoryStore, sanitizeDiscoveredRound} from '../../scripts/store/round-store.mjs';
import {decodeKusdtV2GenesisPayload} from '../../scripts/protocols/kusdt-v2/tx.mjs';
import {MAINNET} from '../../scripts/chain/mainnet.mjs';
import {TN10} from '../../scripts/chain/tn10.mjs';
import {openMemoryWallet, verifyOrdinarySignatures} from '../../scripts/wallet/wallet.mjs';
import {extensionSafeJson, openExtensionWallet} from '../../scripts/wallet/extension-wallet.mjs';
import {openKaspireWallet} from '../../scripts/wallet/kaspire-wallet.mjs';
import {parseJson, jsonText} from '../../scripts/chain/json.mjs';
import {blake2b256, covenantId, hex, p2pk, p2sh} from '../../scripts/core.mjs';
import {spkToAddress} from '../../scripts/wallet/address.mjs';
import {profile as rollingProfile} from '../contracts/fixtures.mjs';
import {runEngine} from '../contracts/engine-gate.mjs';

const ARTIFACTS_DIR = join(process.cwd(), 'contracts/kusdt-v2/artifacts');
const KCC20_TEMPLATE_PATH = '/root/kaspa/references/kaspire-wallet/crates/kaspa_secure_core/src/kcc20_standard_template.json';

function loadArtifacts() {
  const out = {};
  for (const name of KUSDT_V2_TEMPLATE_ORDER) {
    out[name] = JSON.parse(readFileSync(join(ARTIFACTS_DIR, `${name}.json`), 'utf8'));
  }
  return out;
}

const KCC20_SUFFIX = Uint8Array.from(
  Buffer.from(JSON.parse(readFileSync(KCC20_TEMPLATE_PATH, 'utf8')).suffix, 'hex'),
);

const keyHex = label => createHash('sha256').update(`kusdt-v2-unit:${label}`).digest('hex');
const CREATOR_PK = keyHex('creator');
const BUYER1_PK = keyHex('buyer1');
const BUYER2_PK = keyHex('buyer2');
const EXEC_PK = keyHex('executor');
const MGR_CID = keyHex('mgr-cid');
const SHARD_CID = keyHex('shard-cid');
const ZERO32 = '00'.repeat(32);

test('loadKusdtV2Profile loads all 7 artifacts, verifies frozen hashes, and rejects tampered hash', () => {
  const artifacts = loadArtifacts();
  const v2Profile = loadKusdtV2Profile(artifacts);
  assert.equal(v2Profile.id, FROZEN_MAINNET_TEMPLATE_HASHES.m_open);
  assert.equal(v2Profile.kusdtCid, MAINNET_KUSDT_CID);
  for (const name of KUSDT_V2_TEMPLATE_ORDER) {
    assert.equal(v2Profile.frames[name].templateHash, FROZEN_MAINNET_TEMPLATE_HASHES[name]);
  }
  assert.throws(
    () => loadKusdtV2Profile(artifacts, {expectedHashes: {...FROZEN_MAINNET_TEMPLATE_HASHES, m_open: '00'.repeat(32)}}),
    /KUSDT_V2_HASH_MISMATCH:m_open/,
  );
});

test('createKusdtV2Adapter coexists with createRollingV1Adapter in createProtocolRegistry and round-trips round/summary', () => {
  const v2Profile = loadKusdtV2Profile(loadArtifacts());
  const v1 = createRollingV1Adapter({profile: rollingProfile});
  const v2 = createKusdtV2Adapter({profile: v2Profile});
  validateProtocolAdapter(v2);

  const reg = createProtocolRegistry([v1, v2], {defaultCreateProfileId: v1.profileId});
  assert.equal(reg.list().length, 2);
  assert.equal(reg.require(v1.profileId), v1);
  assert.equal(reg.require(v2.profileId), v2);
  assert.equal(v2.id, KUSDT_V2_PROTOCOL_ID);
  assert.equal(v2.assetFor().kind, 'KCC20');
  assert.equal(v2.assetFor().symbol, 'kUSDT');
  assert.equal(v2.assetFor().decimals, 6);

  const mgrRedeem = redeemForState({
    stage: STAGE.M_OPEN,
    version: KUSDT_V2_VERSION,
    creatorPk: CREATOR_PK,
    price: 1_000_000n,
    closeDaa: 5000n,
    openedCount: 1,
    cursor: 0,
    totalTickets: 0,
    entries: [{shardCid: SHARD_CID, ledgerHash: ZERO32, cumTickets: 0}],
  }, v2Profile);

  const r = v2.emptyRound({
    cid: MGR_CID,
    settings: {creatorPk: CREATOR_PK, ticketPrice: 1_000_000n, closeDaa: 5000n},
  });
  r.manager = {
    outpoint: {transactionId: keyHex('tx-mgr'), index: 0},
    redeem: mgrRedeem,
  };
  r.shards = {
    [SHARD_CID]: {
      outpoint: {transactionId: keyHex('tx-sh'), index: 0},
      redeem: redeemForState({
        stage: STAGE.S_OPEN,
        version: KUSDT_V2_VERSION,
        managerCid: MGR_CID,
        firstBuyerPk: BUYER1_PK,
        price: 1_000_000n,
        records: [{cumTickets: 2, buyerPk: BUYER1_PK}],
      }, v2Profile),
    },
  };

  v2.validateRound(r);
  const text = v2.roundToText(r);
  const parsed = v2.roundFromText(text);
  assert.equal(parsed.cid, MGR_CID);
  assert.ok(parsed.shards[SHARD_CID]);

  const sum = v2.toRoundSummary(r);
  assert.equal(sum.protocolId, 'kusdt-v2');
  assert.equal(sum.phase, 'OPEN');
  assert.equal(sum.asset.kind, 'KCC20');
  assert.ok(v2.availableActions(r, 4999n).includes('OPEN_SHARD'));
  assert.deepEqual(v2.availableActions(r, 5000n), ['COLLECT_BATCH']);
});

test('all 7 kusdt-v2 states and 112B KCC20 state round-trip via codec and verifyKusdtV2Redeem', () => {
  const v2Profile = loadKusdtV2Profile(loadArtifacts());

  const states = [
    {
      stage: STAGE.M_OPEN, version: KUSDT_V2_VERSION, creatorPk: CREATOR_PK,
      price: 1_000_000n, closeDaa: 5000n, openedCount: 1, cursor: 0, totalTickets: 0,
      decision: 0, reserved: 0,
      entries: [{shardCid: SHARD_CID, ledgerHash: ZERO32, cumTickets: 0}],
    },
    {
      stage: STAGE.M_SEALED, version: KUSDT_V2_VERSION, creatorPk: CREATOR_PK,
      price: 1_000_000n, closeDaa: 5000n, openedCount: 1, cursor: 0, totalTickets: 3,
      decision: 0, reserved: 0,
      entries: [{shardCid: SHARD_CID, ledgerHash: keyHex('fh'), cumTickets: 3}],
    },
    {
      stage: STAGE.M_DISPATCH, version: KUSDT_V2_VERSION, creatorPk: CREATOR_PK,
      price: 1_000_000n, closeDaa: 5000n, openedCount: 1, cursor: 0, totalTickets: 3,
      decision: DECISION.PAYOUT, reserved: 0, winnerPk: BUYER1_PK, shardCids: [SHARD_CID],
    },
    {
      stage: STAGE.S_OPEN, version: KUSDT_V2_VERSION, managerCid: MGR_CID,
      firstBuyerPk: BUYER1_PK, price: 1_000_000n, recordCount: 1,
      records: [{cumTickets: 3, buyerPk: BUYER1_PK}],
    },
    {
      stage: STAGE.S_FROZEN, version: KUSDT_V2_VERSION, managerCid: MGR_CID,
      firstBuyerPk: BUYER1_PK, price: 1_000_000n, recordCount: 1,
      records: [{cumTickets: 3, buyerPk: BUYER1_PK}],
    },
    {
      stage: STAGE.S_PAYOUT, version: KUSDT_V2_VERSION, firstBuyerPk: BUYER1_PK,
      winnerPk: BUYER2_PK, vaultAmount: 3_000_000n, managerCid: MGR_CID, shardTickets: 3,
    },
    {
      stage: STAGE.S_REFUND, version: KUSDT_V2_VERSION, firstBuyerPk: BUYER1_PK,
      price: 1_000_000n, recordCount: 2, claimedMask: 1,
      records: [{cumTickets: 1, buyerPk: BUYER1_PK}, {cumTickets: 2, buyerPk: BUYER2_PK}],
    },
  ];

  for (const st of states) {
    const redeem = redeemForState(st, v2Profile);
    const verified = verifyKusdtV2Redeem(redeem, v2Profile);
    assert.deepEqual(verified.state, st);
  }

  // Direct codec checks
  assert.equal(decodeManagerState(encodeManagerOpenOrSealedState(states[0])).stage, STAGE.M_OPEN);
  assert.equal(decodeManagerState(encodeManagerDispatchState(states[2])).decision, DECISION.PAYOUT);
  assert.equal(decodeShardState(encodeShardOpenOrFrozenState(states[3])).stage, STAGE.S_OPEN);
  assert.equal(decodeShardState(encodeShardPayoutState(states[5])).vaultAmount, 3_000_000n);
  assert.equal(decodeShardState(encodeShardRefundState(states[6])).claimedMask, 1);

  // KCC20 112B state + suffix verification
  verifyKcc20Suffix(KCC20_SUFFIX);
  const kState = encodeKcc20State({
    amount: 5_000_000n,
    owner: SHARD_CID,
    ownerScheme: KCC20_OWNER_SCHEME.OWNER_COVENANT_ID,
  });
  assert.equal(kState.length, 112);
  const kDecoded = decodeKcc20State(kState);
  assert.equal(kDecoded.amount, 5_000_000n);
  assert.equal(kDecoded.owner, SHARD_CID);
  assert.equal(kDecoded.ownerScheme, KCC20_OWNER_SCHEME.OWNER_COVENANT_ID);
  const {redeem: kRedeem} = kcc20RedeemAndSpk({amount: 5_000_000n, owner: BUYER1_PK}, KCC20_SUFFIX);
  assert.equal(kRedeem.length, 34 + 112 + 3885);
});

test('prepareOperation builds all 11 kusdt-v2 actions with tx.version=1 and semantic assetDeltas roles', () => {
  const v2Profile = loadKusdtV2Profile(loadArtifacts());
  const adapter = createKusdtV2Adapter({profile: v2Profile});

  const kasFund = (label, value = 1_000_000_000n) => ({
    outpoint: {transactionId: keyHex(label), index: 0},
    value,
    spk: p2pk(BUYER1_PK),
    covenantId: null,
  });
  const kcc20Utxo = (label, amount = 10_000_000n) => ({
    outpoint: {transactionId: keyHex(label), index: 0},
    value: 200_000_000n,
    amount,
    covenantId: MAINNET_KUSDT_CID,
  });
  const changeSpk = p2pk(BUYER1_PK);
  const price = 1_000_000n;

  // 1. CREATE_ROUND (REFUNDABLE_DEPOSIT + FEE)
  const createOp = adapter.prepareOperation({
    action: 'CREATE_ROUND',
    creatorPk: CREATOR_PK,
    price,
    closeDaa: 5000n,
    fundingUtxos: [kasFund('cr-kas')],
    changeSpk,
    fee: 10_000n,
  });
  assert.equal(createOp.transaction.version, 1);
  assert.ok(createOp.assetDeltas.some(d => d.role === 'REFUNDABLE_DEPOSIT' && d.amount === -400_000_000n));
  assert.ok(createOp.assetDeltas.some(d => d.role === 'FEE' && d.amount === -10_000n));

  // 2. OPEN_SHARD (NET + REFUNDABLE_DEPOSIT + FEE)
  const mOpenRedeem = redeemForState({
    stage: STAGE.M_OPEN, version: KUSDT_V2_VERSION, creatorPk: CREATOR_PK,
    price, closeDaa: 5000n, openedCount: 0, cursor: 0, totalTickets: 0, entries: [],
  }, v2Profile);
  const testOrigin = {transactionId: keyHex('unit-origin'), index: 0};
  const openOp = adapter.prepareOperation({
    action: 'OPEN_SHARD',
    managerUtxo: {outpoint: {transactionId: keyHex('m-open'), index: 0}, redeem: mOpenRedeem},
    managerCid: MGR_CID,
    origin: testOrigin,
    buyerPk: BUYER1_PK,
    qty: 2,
    price,
    buyerKasUtxos: [kasFund('os-kas')],
    buyerKcc20Utxos: [kcc20Utxo('os-kcc20')],
    kcc20Suffix: KCC20_SUFFIX,
    changeSpk,
    fee: 25_000n,
  });
  assert.equal(openOp.transaction.version, 1);
  assert.ok(openOp.assetDeltas.some(d => d.role === 'NET' && d.amount === -2_000_000n && d.asset.kind === 'KCC20'));
  assert.ok(openOp.assetDeltas.some(d => d.role === 'REFUNDABLE_DEPOSIT' && d.amount === -400_000_000n));
  assert.ok(openOp.assetDeltas.some(d => d.role === 'FEE' && d.amount === -25_000n));

  // 3. BUY
  const sOpenRedeem = redeemForState({
    stage: STAGE.S_OPEN, version: KUSDT_V2_VERSION, managerCid: MGR_CID,
    firstBuyerPk: BUYER1_PK, price, records: [{cumTickets: 2, buyerPk: BUYER1_PK}],
  }, v2Profile);
  const buyOp = adapter.prepareOperation({
    action: 'BUY',
    shardUtxo: {outpoint: {transactionId: keyHex('s-open'), index: 0}, redeem: sOpenRedeem},
    shardCid: SHARD_CID,
    vaultUtxo: kcc20Utxo('s-vault', 2_000_000n),
    buyerPk: BUYER2_PK,
    qty: 1,
    price,
    buyerKasUtxos: [kasFund('buy-kas')],
    buyerKcc20Utxos: [kcc20Utxo('buy-kcc20')],
    kcc20Suffix: KCC20_SUFFIX,
    changeSpk,
    fee: 20_000n,
  });
  assert.equal(buyOp.transaction.version, 1);
  assert.ok(buyOp.assetDeltas.some(d => d.role === 'NET' && d.amount === -1_000_000n));

  // 4. EMPTY_CLOSE
  const emptyCloseOp = adapter.prepareOperation({
    action: 'EMPTY_CLOSE',
    managerUtxo: {outpoint: {transactionId: keyHex('m-ec'), index: 0}, redeem: mOpenRedeem},
    origin: testOrigin,
    fundingUtxos: [kasFund('ec-kas')],
    changeSpk,
  });
  assert.equal(emptyCloseOp.transaction.version, 1);
  assert.equal(emptyCloseOp.transaction.lockTime, 5000n);

  // 5. COLLECT_BATCH
  const mOpen1Redeem = redeemForState({
    stage: STAGE.M_OPEN, version: KUSDT_V2_VERSION, creatorPk: CREATOR_PK,
    price, closeDaa: 5000n, openedCount: 1, cursor: 0, totalTickets: 0,
    entries: [{shardCid: SHARD_CID, ledgerHash: ZERO32, cumTickets: 0}],
  }, v2Profile);
  const sOpen3Redeem = redeemForState({
    stage: STAGE.S_OPEN, version: KUSDT_V2_VERSION, managerCid: MGR_CID,
    firstBuyerPk: BUYER1_PK, price, records: [{cumTickets: 3, buyerPk: BUYER1_PK}],
  }, v2Profile);
  const collectOp = adapter.prepareOperation({
    action: 'COLLECT_BATCH',
    managerUtxo: {outpoint: {transactionId: keyHex('m-cb'), index: 0}, redeem: mOpen1Redeem},
    managerCid: MGR_CID,
    origin: testOrigin,
    shardUtxos: [{outpoint: {transactionId: keyHex('s-cb'), index: 0}, shardCid: SHARD_CID, redeem: sOpen3Redeem}],
    fundingUtxos: [kasFund('cb-kas')],
    changeSpk,
  });
  assert.equal(collectOp.transaction.version, 1);

  // 6. DRAW
  const sFrozenStateObj = {
    stage: STAGE.S_FROZEN, version: KUSDT_V2_VERSION, managerCid: MGR_CID,
    firstBuyerPk: BUYER1_PK, price, records: [{cumTickets: 3, buyerPk: BUYER1_PK}],
  };
  const mSealedRedeem = redeemForState({
    stage: STAGE.M_SEALED, version: KUSDT_V2_VERSION, creatorPk: CREATOR_PK,
    price, closeDaa: 5000n, openedCount: 1, cursor: 0, totalTickets: 3,
    entries: [{shardCid: SHARD_CID, ledgerHash: keyHex('fh'), cumTickets: 3}],
  }, v2Profile);
  const drawOp = adapter.prepareOperation({
    action: 'DRAW',
    managerUtxo: {outpoint: {transactionId: keyHex('m-dr'), index: 0}, redeem: mSealedRedeem},
    managerCid: MGR_CID,
    passAProof: new Uint8Array(240),
    shardIndex: 0,
    recordIndex: 0,
    frozenShardState: sFrozenStateObj,
    fundingUtxos: [kasFund('dr-kas')],
    changeSpk,
  });
  assert.equal(drawOp.transaction.version, 1);

  // 7. REROLL
  const rerollOp = adapter.prepareOperation({
    action: 'REROLL',
    managerUtxo: {outpoint: {transactionId: keyHex('m-rr'), index: 0}, redeem: mSealedRedeem},
    managerCid: MGR_CID,
    fundingUtxos: [kasFund('rr-kas')],
    changeSpk,
  });
  assert.equal(rerollOp.transaction.version, 1);

  // 8. DISPATCH_BATCH
  const mDispatchRedeem = redeemForState({
    stage: STAGE.M_DISPATCH, version: KUSDT_V2_VERSION, creatorPk: CREATOR_PK,
    price, closeDaa: 5000n, openedCount: 1, cursor: 0, totalTickets: 3,
    decision: DECISION.PAYOUT, winnerPk: BUYER1_PK, shardCids: [SHARD_CID],
  }, v2Profile);
  const sFrozenRedeem = redeemForState({
    stage: STAGE.S_FROZEN, version: KUSDT_V2_VERSION, managerCid: MGR_CID,
    firstBuyerPk: BUYER1_PK, price, records: [{cumTickets: 3, buyerPk: BUYER1_PK}],
  }, v2Profile);
  const dispatchOp = adapter.prepareOperation({
    action: 'DISPATCH_BATCH',
    managerUtxo: {outpoint: {transactionId: keyHex('m-db'), index: 0}, redeem: mDispatchRedeem},
    managerCid: MGR_CID,
    frozenShardUtxos: [{outpoint: {transactionId: keyHex('s-db'), index: 0}, shardCid: SHARD_CID, redeem: sFrozenRedeem}],
    fundingUtxos: [kasFund('db-kas')],
    changeSpk,
  });
  assert.equal(dispatchOp.transaction.version, 1);

  // 9. PAYOUT_EXECUTOR (NET + CARRIER + FEE)
  const sPayoutRedeem = redeemForState({
    stage: STAGE.S_PAYOUT, version: KUSDT_V2_VERSION, firstBuyerPk: BUYER1_PK,
    winnerPk: BUYER2_PK, vaultAmount: 3_000_000n, managerCid: MGR_CID, shardTickets: 3,
  }, v2Profile);
  const payExecOp = adapter.prepareOperation({
    action: 'PAYOUT_EXECUTOR',
    shardUtxo: {outpoint: {transactionId: keyHex('s-pe'), index: 0}, redeem: sPayoutRedeem},
    vaultUtxo: kcc20Utxo('v-pe', 3_000_000n),
    executorPk: EXEC_PK,
    fundingUtxos: [kasFund('pe-kas')],
    kcc20Suffix: KCC20_SUFFIX,
    changeSpk,
    fee: 15_000n,
  });
  assert.equal(payExecOp.transaction.version, 1);
  assert.ok(payExecOp.assetDeltas.some(d => d.role === 'CARRIER' && d.amount === -300_000_000n));

  // 10. PAYOUT_SELF
  const paySelfOp = adapter.prepareOperation({
    action: 'PAYOUT_SELF',
    shardUtxo: {outpoint: {transactionId: keyHex('s-ps'), index: 0}, redeem: sPayoutRedeem},
    vaultUtxo: kcc20Utxo('v-ps', 3_000_000n),
    vaultAmount: 3_000_000n,
    fundingUtxos: [kasFund('ps-kas')],
    kcc20Suffix: KCC20_SUFFIX,
    changeSpk,
    fee: 15_000n,
  });
  assert.equal(paySelfOp.transaction.version, 1);
  assert.ok(paySelfOp.assetDeltas.some(d => d.role === 'CARRIER' && d.amount === -150_000_000n));

  // 11. CLAIM_REFUND
  const sRefundRedeem = redeemForState({
    stage: STAGE.S_REFUND, version: KUSDT_V2_VERSION, firstBuyerPk: BUYER1_PK,
    price, recordCount: 2, claimedMask: 0,
    records: [{cumTickets: 1, buyerPk: BUYER1_PK}, {cumTickets: 2, buyerPk: BUYER2_PK}],
  }, v2Profile);
  const claimOp = adapter.prepareOperation({
    action: 'CLAIM_REFUND',
    shardUtxo: {outpoint: {transactionId: keyHex('s-cr'), index: 0}, redeem: sRefundRedeem},
    shardCid: SHARD_CID,
    vaultUtxo: kcc20Utxo('v-cr', 2_000_000n),
    recIdx: 0,
    refundAmount: 1_000_000n,
    fundingUtxos: [kasFund('cr-ref-kas')],
    kcc20Suffix: KCC20_SUFFIX,
    changeSpk,
    fee: 15_000n,
  });
  assert.equal(claimOp.transaction.version, 1);
  assert.ok(claimOp.assetDeltas.some(d => d.role === 'NET' && d.amount === 1_000_000n && d.asset.kind === 'KCC20'));
  assert.ok(claimOp.assetDeltas.some(d => d.role === 'CARRIER' && d.amount === -150_000_000n));
});

test('kusdt-v2 CREATE_ROUND builds signable draft with feerate convergence, valid extensionSafeJson, and txToRpc submitProtocolTx wire', async () => {
  const v2Profile = loadKusdtV2Profile(loadArtifacts());
  const adapter = createKusdtV2Adapter({profile: v2Profile});
  const secret = keyHex('submit-protocol-tx-secret');
  const mem = openMemoryWallet(secret);
  const prepared = adapter.prepareOperation({
    action: 'CREATE_ROUND',
    creatorPk: mem.key,
    price: 1_000_000n,
    closeDaa: 5000n,
    fundingUtxos: [{
      outpoint: {transactionId: keyHex('live-kas-utxo'), index: 0},
      value: 1_000_000_000n,
      spk: mem.spk,
      daa: 4000n,
      utxoDaa: 4000n,
      covenantId: null,
    }],
    changeSpk: mem.spk,
    registrySpk: TN10.registry.spk,
    feerate: '100',
  });

  assert.ok(prepared.draft);
  assert.deepEqual(prepared.draft.authorizedInputIndices, [0]);
  assert.equal(prepared.draft.inputUtxos.length, 1);
  assert.ok(prepared.fee >= 100_000n);
  assert.equal(prepared.draft.transaction.inputs[0].computeBudget, 10);
  assert.equal(typeof prepared.draft.transaction.storageMass, 'bigint');
  // 0.2 KAS registry output + 115B genesis payload
  assert.equal(prepared.transaction.outputs[1].value, 20_000_000n);
  assert.equal(prepared.transaction.outputs[1].scriptPublicKey.script, TN10.registry.spk.script);
  assert.equal(prepared.transaction.outputs[1].covenant, null);
  assert.equal(prepared.transaction.payload.length, 115 * 2);
  const decodedGenesis = decodeKusdtV2GenesisPayload(prepared.transaction.payload, v2Profile);
  assert.equal(decodedGenesis.creatorPk, mem.key);
  assert.equal(decodedGenesis.price, 1_000_000n);
  assert.equal(decodedGenesis.closeDaa, 5000n);
  assert.ok(prepared.assetDeltas.some(d => d.role === 'NET' && d.amount === -20_000_000n));

  // sanitizeDiscoveredRound must preserve kusdt-v2 metadata for explore plaza display
  const cleanDisc = sanitizeDiscoveredRound({
    cid: prepared.cid,
    protocolId: 'kusdt-v2',
    profileId: adapter.profileId,
    phase: 'OPEN',
    ticketsSold: 0,
    ticketPrice: '1000000',
    asset: adapter.assetFor(),
    protocolData: {openedCount: 0, cursor: 0, closeDaa: '5000', creatorPk: mem.key, shards: []},
  });
  assert.equal(cleanDisc.protocolId, 'kusdt-v2');
  assert.equal(cleanDisc.ticketsSold, 0);
  assert.equal(cleanDisc.ticketPrice, '1000000');
  assert.equal(cleanDisc.protocolData.closeDaa, '5000');

  // SafeJSON payload sent to Kaspire/KasWare must be valid JSON with no undefined placeholders
  const safeStr = extensionSafeJson(prepared.draft, mem);
  assert.ok(!safeStr.includes('undefined'));
  const safeObj = parseJson(safeStr);
  assert.equal(safeObj.version, 1);
  assert.equal(safeObj.inputs[0].utxo.blockDaaScore, '4000');
  assert.equal(safeObj.outputs[0].covenant.authorizingInput, 0);

  // Controller submitProtocolTx signs draft in-place, verifies signature, and submits RPC wire transaction
  const sent = [];
  const fakeRpc = {
    url: 'ws://offline.test',
    async currentDaa() { return 4000n; },
    async call(method, params) {
      sent.push({method, params});
      if (method === 'submitTransaction') return {transactionId: prepared.txid};
      return {};
    },
    close() {},
  };
  const ctl = createController({
    profile: rollingProfile,
    registry: createProtocolRegistry([createRollingV1Adapter({profile: rollingProfile}), adapter]),
    roundStore: new RoundStore(new MemoryStore()),
    connect: async () => fakeRpc,
    sleep: async () => {},
  });
  await ctl.connectNode(['ws://offline.test']);
  ctl.openWallet(secret);

  // Bare transaction without draft metadata must be rejected before RPC
  await assert.rejects(() => ctl.submitProtocolTx(prepared.transaction), /PROTOCOL_DRAFT_INVALID/);
  assert.equal(sent.length, 0);

  const txid = await ctl.submitProtocolTx(prepared);
  assert.equal(txid, prepared.txid);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'submitTransaction');
  assert.equal(sent[0].params.allowOrphan, false);
  const wire = sent[0].params.transaction;
  assert.equal(wire.version, 1);
  assert.equal(wire.inputs.length, 1);
  assert.match(wire.inputs[0].signatureScript, /^41[0-9a-f]{128}01$/);
  assert.equal(wire.inputs[0].computeBudget, 10);
  assert.equal(wire.inputs[0].sigOpCount, 0);
  assert.equal(typeof wire.outputs[0].scriptPublicKey, 'string');
  assert.equal(wire.outputs[0].covenant.covenantId, prepared.cid);
  assert.equal(wire.outputs[0].covenant.authorizingInput, 0);
  assert.doesNotThrow(() => jsonText(sent[0].params));

  // Adapter signAndRecord also signs a fresh prepared draft cleanly
  const prepared2 = adapter.prepareOperation({
    action: 'CREATE_ROUND',
    creatorPk: mem.key,
    price: 1_000_000n,
    closeDaa: 5000n,
    fundingUtxos: [{
      outpoint: {transactionId: keyHex('live-kas-utxo-2'), index: 0},
      value: 1_000_000_000n,
      spk: mem.spk,
      daa: 4000n,
      utxoDaa: 4000n,
      covenantId: null,
    }],
    changeSpk: mem.spk,
    feerate: '100',
  });
  const signedRes = await adapter.signAndRecord({wallet: mem, prepared: prepared2});
  assert.equal(signedRes.txid, prepared2.txid);
  assert.match(signedRes.transaction.inputs[0].signatureScript, /^41[0-9a-f]{128}01$/);
  mem.close();
});

test('kusdt-v2 GENESIS tracking, multi-profile indexer scope, and controller describe', async () => {
  const v2Profile = loadKusdtV2Profile(loadArtifacts());
  const adapter = createKusdtV2Adapter({profile: v2Profile, kcc20Suffix: KCC20_SUFFIX});
  const registry = createProtocolRegistry([createRollingV1Adapter({profile: rollingProfile}), adapter]);

  const secret = '11'.repeat(32);
  const mem = openMemoryWallet(secret, {prefix: TN10.addressPrefix});
  const prepared = adapter.prepareOperation({
    action: 'CREATE_ROUND',
    creatorPk: mem.key,
    price: 1_000_000n,
    closeDaa: 5000n,
    fundingUtxos: [{
      outpoint: {transactionId: keyHex('track-kas-utxo'), index: 0},
      value: 1_000_000_000n,
      spk: mem.spk,
      daa: 4000n,
      utxoDaa: 4000n,
      covenantId: null,
    }],
    changeSpk: mem.spk,
    feerate: '100',
  });
  const signed = await adapter.signAndRecord({wallet: mem, prepared});
  const mgrOut = prepared.transaction.outputs[0];

  // Multi-profile indexer client accepts kusdt-v2 roundDetail and rejects foreign profiles
  const indexerDetail = {
    schema: 1,
    network: TN10.networkId,
    genesisHash: TN10.genesis,
    profileId: v2Profile.id,
    protocolId: KUSDT_V2_PROTOCOL_ID,
    cid: prepared.cid,
    revision: '1',
    terminal: null,
    origin: prepared.transaction.inputs[0].previousOutpoint,
    manager: {
      outpoint: {transactionId: signed.txid, index: 0},
      value: '400000000',
      spk: mgrOut.scriptPublicKey,
      utxoDaa: '4050',
      redeemHex: hex(prepared.managerRedeem),
    },
    summary: {
      protocolId: KUSDT_V2_PROTOCOL_ID,
      profileId: v2Profile.id,
      ticketsSold: 0,
    },
    protocolData: {
      openedCount: 0,
      cursor: 0,
      closeDaa: '5000',
      creatorPk: mem.key,
      shards: [],
    },
  };
  const fetcher = async url => {
    if (url.endsWith('/info')) {
      return new Response(JSON.stringify({
        schema: 1, network: TN10.networkId, genesisHash: TN10.genesis,
        profileId: rollingProfile.id, readOnly: true, stale: false,
      }), {status: 200});
    }
    if (url.includes('/rounds?')) {
      return new Response(JSON.stringify({
        schema: 1, network: TN10.networkId, genesisHash: TN10.genesis,
        profileId: rollingProfile.id, stale: false, rounds: [],
      }), {status: 200});
    }
    if (url.endsWith(`/rounds/${prepared.cid}`)) {
      return new Response(JSON.stringify(indexerDetail), {status: 200});
    }
    if (url.endsWith(`/rounds/${'ff'.repeat(32)}`)) {
      return new Response(JSON.stringify({...indexerDetail, cid: 'ff'.repeat(32), profileId: 'ee'.repeat(32)}), {status: 200});
    }
    return new Response(JSON.stringify({error: 'NOT_FOUND'}), {status: 404});
  };
  const multiClient = createIndexerClient({
    baseUrl: 'https://indexer.example/tn10',
    fetchImpl: fetcher,
    networkId: TN10.networkId,
    genesisHash: TN10.genesis,
    profileId: rollingProfile.id,
    profileIds: registry.profileIds(),
  });
  const det = await multiClient.roundDetail(prepared.cid);
  assert.equal(det.profileId, v2Profile.id);
  await assert.rejects(() => multiClient.roundDetail('ff'.repeat(32)), /INDEXER_SCOPE/);

  // Unconfirmed GENESIS must NOT be prematurely marked accepted while node has no UTXO yet
  let mined = false;
  const fakeRpc = {
    url: 'ws://offline.test',
    async currentDaa() { return 4060n; },
    async call(method) {
      if (method === 'getUtxosByAddresses') {
        if (!mined) return {entries: []};
        return {
          entries: [{
            outpoint: {transactionId: signed.txid, index: 0},
            utxoEntry: {
              amount: '400000000',
              scriptPublicKey: `0000${mgrOut.scriptPublicKey.script}`,
              blockDaaScore: '4050',
              isCoinbase: false,
              covenantId: prepared.cid,
            },
          }],
        };
      }
      return {};
    },
    close() {},
  };

  const pendingRound = {
    cid: prepared.cid,
    profileId: v2Profile.id,
    source: 'created',
    terminal: null,
    halted: null,
    intent: {status: 'SUBMITTED', action: 'GENESIS', txid: signed.txid, profileId: v2Profile.id, draft: signed.draft},
    manager: {outpoint: {transactionId: signed.txid, index: 0}, value: 400_000_000n, spk: mgrOut.scriptPublicKey, utxoDaa: 0n, daaScore: 0n, covenantId: prepared.cid, redeemScript: prepared.managerRedeem},
    frozen: [],
    receipts: [{action: 'GENESIS', txid: signed.txid, feeSompi: String(prepared.fee), finalized: false}],
    pending: [],
    fees: prepared.fee,
    origin: prepared.transaction.inputs[0].previousOutpoint,
    settings: {ticketPrice: 1_000_000n, ticketCap: 65536, minTickets: 3, closeEligibleDaa: 5000n, closeDaa: 5000n, creatorPk: mem.key},
    bought: 0,
    step: 0,
    kusdt: {stage: STAGE.M_OPEN, price: 1_000_000n, closeDaa: 5000n, openedCount: 0, cursor: 0, totalTickets: 0, decision: 0, creatorPk: mem.key, winnerPk: null, nodeVerified: false, shards: []},
  };

  const trMempool = await adapter.trackRoundIntent({rpc: fakeRpc, indexer: null, round: pendingRound, net: TN10});
  assert.equal(trMempool.accepted, false);
  assert.equal(trMempool.round.intent?.action, 'GENESIS');
  assert.ok(trMempool.round.manager);
  assert.equal(trMempool.round.kusdt.nodeVerified, false);

  // Once mined on the node, trackRoundIntent confirms GENESIS, clears intent, sets step=1 & nodeVerified=true
  mined = true;
  const trMined = await adapter.trackRoundIntent({rpc: fakeRpc, indexer: multiClient, round: trMempool.round, net: TN10});
  assert.equal(trMined.accepted, true);
  assert.equal(trMined.round.intent, null);
  assert.equal(trMined.round.step, 1);
  assert.equal(trMined.round.kusdt.nodeVerified, true);
  assert.equal(trMined.round.receipts[0].finalized, true);
  assert.equal(trMined.round.manager?.utxoDaa, 4050n);

  // Self-heal a broken legacy record (manager: null, intent: null) via multi-profile indexer + live node UTXO check
  const storeMem = new MemoryStore();
  storeMem.persistent = true;
  const rs = new RoundStore(storeMem);
  await rs.create({...trMined.round, manager: null, receipts: [], kusdt: {...trMined.round.kusdt, nodeVerified: false}});
  const ctl = createController({
    profile: rollingProfile,
    registry,
    roundStore: rs,
    connect: async () => fakeRpc,
    fetcher,
    sleep: async () => {},
  });
  await ctl.connectNode(['ws://offline.test']);
  await ctl.checkIndexer('https://indexer.example/tn10');
  const syncRes = await ctl.syncRound(prepared.cid);
  assert.equal(syncRes.unchanged, false);
  const described = await ctl.describe(prepared.cid);
  assert.equal(described.facts.module, 'sales');
  assert.equal(described.actions.BUY.ok, true);
  assert.equal(described.round.kusdt.nodeVerified, true);
  assert.equal(described.round.receipts[0]?.action, 'GENESIS');
  assert.equal(described.round.receipts[0]?.txid, signed.txid);
  mem.close();
});

test('discoverOwnerKcc20Utxos authenticates Kascov/Kasvio cells on live node and signs via Kaspire & KasWare', async () => {
  const v2Profile = loadKusdtV2Profile(loadArtifacts());
  const adapter = createKusdtV2Adapter({profile: v2Profile, kcc20Suffix: KCC20_SUFFIX});
  const secret = '22'.repeat(32);
  const mem = openMemoryWallet(secret, {prefix: MAINNET.addressPrefix});
  const cell1 = kcc20RedeemAndSpk({amount: 1_500_000n, owner: mem.key, ownerScheme: 0, borrowScheme: 1}, KCC20_SUFFIX);
  const cell2 = kcc20RedeemAndSpk({amount: 800_000n, owner: mem.key, ownerScheme: 0, borrowScheme: 0}, KCC20_SUFFIX);
  const txid1 = keyHex('mainnet-cell-1'), txid2 = keyHex('mainnet-cell-2');

  const liveByScript = new Map([
    [cell1.scriptPubKey.script, [{
      outpoint: {transactionId: txid1, index: 0},
      utxoEntry: {amount: '300000000', scriptPublicKey: `0000${cell1.scriptPubKey.script}`, blockDaaScore: '600000100', isCoinbase: false, covenantId: MAINNET_KUSDT_CID},
    }]],
    [cell2.scriptPubKey.script, [{
      outpoint: {transactionId: txid2, index: 1},
      utxoEntry: {amount: '100000000', scriptPublicKey: `0000${cell2.scriptPubKey.script}`, blockDaaScore: '600000101', isCoinbase: false, covenantId: MAINNET_KUSDT_CID},
    }]],
  ]);

  const fakeRpc = {
    url: 'ws://mainnet.test',
    async currentDaa() { return 600000200n; },
    async call(method, params) {
      if (method === 'getUtxosByAddresses') {
        const entries = [];
        for (const [spk, list] of liveByScript.entries()) {
          // Match by decoding the address back or returning all entries whose address matches
          for (const e of list) {
            if (params.addresses.length) entries.push(e);
          }
        }
        return {entries};
      }
      if (method === 'getMempoolEntriesByAddresses') return {entries: []};
      return {};
    },
  };

  // 1. Kascov primary discovery (filters out minter/forged cells and verifies live UTXOs on node)
  const kascovFetcher = async url => {
    assert.ok(url.includes('kascov.io/data/mainnet/token/'));
    return new Response(JSON.stringify({
      network: 'mainnet',
      token_id: MAINNET_KUSDT_CID,
      owner: `00${mem.key}`,
      cells: [
        {outpoint: `${txid1}:0`, amount_str: '1500000', value_sompi: 300000000, is_minter: false, program_hex: hex(cell1.redeem), script_hex: cell1.scriptPubKey.script},
        {outpoint: `${txid2}:1`, amount_str: '800000', value_sompi: 100000000, is_minter: false, program_hex: hex(cell2.redeem), script_hex: cell2.scriptPubKey.script},
        // Forged/minter entries must be ignored
        {outpoint: `${keyHex('bad-minter')}:0`, amount_str: '99999999', value_sompi: 100000000, is_minter: true, program_hex: hex(cell1.redeem), script_hex: cell1.scriptPubKey.script},
      ],
    }), {status: 200});
  };
  const d1 = await discoverOwnerKcc20Utxos({rpc: fakeRpc, ownerPk: mem.key, kusdtCid: MAINNET_KUSDT_CID, kcc20Suffix: KCC20_SUFFIX, net: MAINNET, fetcher: kascovFetcher});
  assert.equal(d1.source, 'kascov');
  assert.equal(d1.cells.length, 2);
  assert.equal(selectKcc20Cells(d1.cells, 1_000_000n, 3).selected.length, 1);
  assert.equal(selectKcc20Cells(d1.cells, 1_000_000n, 3).selected[0].amount, 1_500_000n);
  assert.equal(selectKcc20Cells(d1.cells, 2_000_000n, 3).selected.length, 2);

  // 2. Kasvio fallback when Kascov is down (reconstructs borrowScheme=1 cell and verifies live on node)
  const fallbackFetcher = async url => {
    if (url.includes('kascov.io')) return new Response('unavailable', {status: 503});
    assert.ok(url.includes('kasvio.network/api/kcc20/v4/tokens/'));
    return new Response(JSON.stringify({
      meta: {network: 'mainnet'},
      data: {
        covenant_id: MAINNET_KUSDT_CID,
        owner_scheme: 0,
        owner_value: mem.key,
        outputs: [{txid: txid1, output_index: 0, balance_raw: '1500000', amount_sompi: '300000000'}],
      },
    }), {status: 200});
  };
  const d2 = await discoverOwnerKcc20Utxos({rpc: fakeRpc, ownerPk: mem.key, kusdtCid: MAINNET_KUSDT_CID, kcc20Suffix: KCC20_SUFFIX, net: MAINNET, fetcher: fallbackFetcher});
  assert.equal(d2.source, 'kasvio');
  assert.equal(d2.cells.length, 1);
  assert.equal(d2.cells[0].amount, 1_500_000n);

  // 3. Build OPEN_SHARD and verify BOTH Kaspire (native scripts) & KasWare (41<sig>01 splice) signing adapters!
  const mOpenRedeem = redeemForState({
    stage: STAGE.M_OPEN, version: KUSDT_V2_VERSION, creatorPk: CREATOR_PK,
    price: 1_000_000n, closeDaa: 600005000n, openedCount: 0, cursor: 0, totalTickets: 0, entries: [],
  }, v2Profile);
  const baseOpen = adapter.prepareOperation({
    action: 'OPEN_SHARD',
    managerUtxo: {outpoint: {transactionId: keyHex('mgr-live'), index: 0}, value: 400_000_000n, daa: 600000050n, redeem: mOpenRedeem},
    managerCid: MGR_CID,
    origin: {transactionId: keyHex('sig-origin'), index: 0},
    buyerPk: mem.key,
    qty: 1,
    price: 1_000_000n,
    buyerKasUtxos: [{outpoint: {transactionId: keyHex('kas-live'), index: 0}, value: 1_000_000_000n, spk: mem.spk, daa: 600000050n, utxoDaa: 600000050n, covenantId: null}],
    buyerKcc20Utxos: [d1.cells[0]],
    kcc20Suffix: KCC20_SUFFIX,
    changeSpk: mem.spk,
    feerate: '100',
  });
  assert.equal(baseOpen.scriptInputs.length, 1);
  assert.equal(baseOpen.scriptInputs[0].inputIndex, 2);

  // 3a. Simulate KasWare returning 41<64B>01 for both ordinary KAS input [1] and KCC-20 input [2]
  const draftForKasware = structuredClone(baseOpen.draft);
  const kaswareStub = {
    requestAccounts: async () => [mem.address],
    getAccounts: async () => [mem.address],
    getPublicKey: async () => mem.key,
    getNetwork: async () => MAINNET.kaswareNetwork,
    on: () => {},
    removeListener: () => {},
    signPskt: async ({txJsonString, options}) => {
      assert.deepEqual(options.signInputs.map(s => s.index).sort((a, b) => a - b), [1, 2]);
      const parsed = parseJson(txJsonString);
      // Sign with real memory key: ordinary P2PK produces 41<sig>01; simulate KasWare returning 41<sig>01 on input 2 too
      const ref = structuredClone(baseOpen.draft);
      await mem.sign(ref);
      const off = baseOpen.scriptInputs[0].signatureOffsets[0];
      const sig65 = ref.transaction.inputs[2].signatureScript.slice(off * 2, (off + 65) * 2);
      parsed.inputs[1].signatureScript = ref.transaction.inputs[1].signatureScript;
      parsed.inputs[2].signatureScript = '41' + sig65;
      return jsonText(parsed);
    },
  };
  const kw = await openExtensionWallet('kasware', {globals: {kasware: kaswareStub}, net: MAINNET});
  await kw.sign(draftForKasware);
  await verifyOrdinarySignatures(draftForKasware);
  kw.close();

  // 3b. Simulate Kaspire receiving normalized {psktTransactionJson, signInputs, scripts}
  const draftForKaspire = structuredClone(baseOpen.draft);
  let capturedKaspireParams = null;
  const fakeWcClient = {
    session: {
      getAll: () => [{
        topic: 'aa'.repeat(32),
        expiry: Math.floor(Date.now() / 1000) + 3600,
        namespaces: {kaspa: {chains: ['kaspa:mainnet'], accounts: [`kaspa:mainnet:${mem.address.split(':')[1]}`]}},
      }],
    },
    on: () => {},
    off: () => {},
    request: async ({request: req}) => {
      capturedKaspireParams = req.params;
      const parsed = parseJson(req.params.psktTransactionJson);
      const ref = structuredClone(baseOpen.draft);
      await mem.sign(ref);
      parsed.inputs[1].signatureScript = ref.transaction.inputs[1].signatureScript;
      parsed.inputs[2].signatureScript = ref.transaction.inputs[2].signatureScript;
      return {psktTransactionJson: jsonText(parsed)};
    },
  };
  const kp = await openKaspireWallet({client: fakeWcClient, net: MAINNET});
  await kp.sign(draftForKaspire);
  assert.equal(capturedKaspireParams.submitTransaction, false);
  assert.equal(capturedKaspireParams.scripts.length, 1);
  assert.equal(capturedKaspireParams.scripts[0].inputIndex, 2);
  assert.equal(capturedKaspireParams.scripts[0].scriptHex, '');
  assert.equal(capturedKaspireParams.scripts[0].expectedSighash, baseOpen.scriptInputs[0].expectedSighash);
  await verifyOrdinarySignatures(draftForKaspire);
  kp.close();
  mem.close();
});

test('real kaspa-txscript 2.1.0 VM executes kusdt-v2 OPEN_SHARD, BUY, PAYOUT, and CLAIM_REFUND with KCC-20 witnesses', {skip: !process.env.KASWIN_VM_BIN, timeout: 120000}, async () => {
  const v2Profile = loadKusdtV2Profile(loadArtifacts());
  const adapter = createKusdtV2Adapter({profile: v2Profile, kcc20Suffix: KCC20_SUFFIX});
  const secret1 = '33'.repeat(32), secret2 = '44'.repeat(32);
  const w1 = openMemoryWallet(secret1, {prefix: MAINNET.addressPrefix});
  const w2 = openMemoryWallet(secret2, {prefix: MAINNET.addressPrefix});
  const price = 1_000_000n;

  // 1. OPEN_SHARD with 2 buyer KCC-20 inputs (leader borrowScheme=1 + delegate borrowScheme=0) + kUSDT change
  const vmOrigin = {transactionId: keyHex('vm-origin'), index: 0};
  const mOpenRedeem = redeemForState({
    stage: STAGE.M_OPEN, version: KUSDT_V2_VERSION, creatorPk: CREATOR_PK,
    price, closeDaa: 5000n, openedCount: 0, cursor: 0, totalTickets: 0, entries: [],
  }, v2Profile);
  const vmMgrCid = covenantId(vmOrigin, [{index: 0, value: 400_000_000n, spk: p2sh(hex(blake2b256(mOpenRedeem)))}]);
  const b1c1 = kcc20RedeemAndSpk({amount: 1_200_000n, owner: w1.key, ownerScheme: 0, borrowScheme: 1}, KCC20_SUFFIX);
  const b1c2 = kcc20RedeemAndSpk({amount: 1_300_000n, owner: w1.key, ownerScheme: 0, borrowScheme: 0}, KCC20_SUFFIX);
  const openOp = adapter.prepareOperation({
    action: 'OPEN_SHARD',
    managerUtxo: {outpoint: {transactionId: keyHex('vm-mgr'), index: 0}, value: 400_000_000n, daa: 4000n, redeem: mOpenRedeem},
    managerCid: vmMgrCid,
    origin: vmOrigin,
    buyerPk: w1.key,
    qty: 2,
    price,
    buyerKasUtxos: [{outpoint: {transactionId: keyHex('vm-kas1'), index: 0}, value: 1_000_000_000n, spk: w1.spk, daa: 4000n, utxoDaa: 4000n, covenantId: null}],
    buyerKcc20Utxos: [
      {outpoint: {transactionId: keyHex('vm-k1'), index: 0}, value: 300_000_000n, spk: b1c1.scriptPubKey, daa: 4000n, utxoDaa: 4000n, covenantId: MAINNET_KUSDT_CID, amount: 1_200_000n, redeem: b1c1.redeem},
      {outpoint: {transactionId: keyHex('vm-k2'), index: 0}, value: 100_000_000n, spk: b1c2.scriptPubKey, daa: 4000n, utxoDaa: 4000n, covenantId: MAINNET_KUSDT_CID, amount: 1_300_000n, redeem: b1c2.redeem},
    ],
    kcc20Suffix: KCC20_SUFFIX,
    changeSpk: w1.spk,
    feerate: '100',
  });
  await w1.sign(openOp.draft);
  await verifyOrdinarySignatures(openOp.draft);
  runEngine(openOp.draft, {limited: true});

  // 1b. C-01 on-chain checkRoot defense: pre-seeded evil M_OPEN (openedCount=1 at genesis) MUST FAIL in real VM!
  const evilVmRedeem = redeemForState({
    stage: STAGE.M_OPEN, version: KUSDT_V2_VERSION, creatorPk: CREATOR_PK,
    price, closeDaa: 5000n, openedCount: 1, cursor: 0, totalTickets: 0,
    entries: [{shardCid: keyHex('evil-vm-sh'), ledgerHash: ZERO32, cumTickets: 0}],
  }, v2Profile);
  const evilVmCid = covenantId(vmOrigin, [{index: 0, value: 400_000_000n, spk: p2sh(hex(blake2b256(evilVmRedeem)))}]);
  const evilOpenOp = adapter.prepareOperation({
    action: 'OPEN_SHARD',
    managerUtxo: {outpoint: {transactionId: keyHex('vm-evil-mgr'), index: 0}, value: 400_000_000n, daa: 4000n, redeem: evilVmRedeem},
    managerCid: evilVmCid,
    origin: vmOrigin,
    buyerPk: w1.key,
    qty: 1,
    price,
    buyerKasUtxos: [{outpoint: {transactionId: keyHex('vm-kas1'), index: 0}, value: 1_000_000_000n, spk: w1.spk, daa: 4000n, utxoDaa: 4000n, covenantId: null}],
    buyerKcc20Utxos: [
      {outpoint: {transactionId: keyHex('vm-k1'), index: 0}, value: 300_000_000n, spk: b1c1.scriptPubKey, daa: 4000n, utxoDaa: 4000n, covenantId: MAINNET_KUSDT_CID, amount: 1_200_000n, redeem: b1c1.redeem},
    ],
    kcc20Suffix: KCC20_SUFFIX,
    changeSpk: w1.spk,
    feerate: '100',
  });
  await w1.sign(evilOpenOp.draft);
  assert.throws(() => runEngine(evilOpenOp.draft, {limited: true}), 'evil pre-seeded M_OPEN must be rejected by on-chain checkRoot');

  // 2. BUY on that shard (input 0: s_open, input 1: vault OWNER_COVENANT_ID leader, input 2: buyer2 P2PK_SCHNORR delegate)
  const shardRedeem1 = redeemForState(openOp.shardState, v2Profile);
  const vault1 = kcc20RedeemAndSpk({amount: 2_000_000n, owner: openOp.shardCid, ownerScheme: 4}, KCC20_SUFFIX);
  const b2c1 = kcc20RedeemAndSpk({amount: 2_000_000n, owner: w2.key, ownerScheme: 0, borrowScheme: 0}, KCC20_SUFFIX);
  const buyOp = adapter.prepareOperation({
    action: 'BUY',
    shardUtxo: {outpoint: {transactionId: openOp.txid, index: 1}, value: 200_000_000n, daa: 4010n, redeem: shardRedeem1},
    shardCid: openOp.shardCid,
    vaultUtxo: {outpoint: {transactionId: openOp.txid, index: 2}, value: 200_000_000n, spk: vault1.scriptPubKey, daa: 4010n, utxoDaa: 4010n, covenantId: MAINNET_KUSDT_CID, amount: 2_000_000n, redeem: vault1.redeem},
    buyerPk: w2.key,
    qty: 1,
    price,
    buyerKasUtxos: [{outpoint: {transactionId: keyHex('vm-kas2'), index: 0}, value: 500_000_000n, spk: w2.spk, daa: 4010n, utxoDaa: 4010n, covenantId: null}],
    buyerKcc20Utxos: [{outpoint: {transactionId: keyHex('vm-k3'), index: 0}, value: 100_000_000n, spk: b2c1.scriptPubKey, daa: 4010n, utxoDaa: 4010n, covenantId: MAINNET_KUSDT_CID, amount: 2_000_000n, redeem: b2c1.redeem}],
    kcc20Suffix: KCC20_SUFFIX,
    changeSpk: w2.spk,
    feerate: '100',
  });
  await w2.sign(buyOp.draft);
  await verifyOrdinarySignatures(buyOp.draft);
  runEngine(buyOp.draft, {limited: true});

  // 3. PAYOUT_EXECUTOR & PAYOUT_SELF (s_payout + vault OWNER_COVENANT_ID leader)
  const sPayoutRedeem = redeemForState({
    stage: STAGE.S_PAYOUT, version: KUSDT_V2_VERSION, firstBuyerPk: w1.key,
    winnerPk: w2.key, managerCid: MGR_CID, shardTickets: 3, vaultAmount: 3_000_000n,
  }, v2Profile);
  const vaultPayout = kcc20RedeemAndSpk({amount: 3_000_000n, owner: openOp.shardCid, ownerScheme: 4}, KCC20_SUFFIX);
  const payExecOp = adapter.prepareOperation({
    action: 'PAYOUT_EXECUTOR',
    shardUtxo: {outpoint: {transactionId: keyHex('vm-sp'), index: 0}, value: 200_000_000n, daa: 4200n, redeem: sPayoutRedeem},
    shardCid: openOp.shardCid,
    vaultUtxo: {outpoint: {transactionId: buyOp.txid, index: 1}, value: 200_000_000n, spk: vaultPayout.scriptPubKey, daa: 4200n, utxoDaa: 4200n, covenantId: MAINNET_KUSDT_CID, amount: 3_000_000n, redeem: vaultPayout.redeem},
    executorPk: w1.key,
    fundingUtxos: [{outpoint: {transactionId: keyHex('vm-kas3'), index: 0}, value: 1_000_000_000n, spk: w1.spk, daa: 4200n, utxoDaa: 4200n, covenantId: null}],
    kcc20Suffix: KCC20_SUFFIX,
    changeSpk: w1.spk,
    feerate: '100',
  });
  await w1.sign(payExecOp.draft);
  await verifyOrdinarySignatures(payExecOp.draft);
  runEngine(payExecOp.draft, {limited: true});

  const paySelfOp = adapter.prepareOperation({
    action: 'PAYOUT_SELF',
    shardUtxo: {outpoint: {transactionId: keyHex('vm-sp2'), index: 0}, value: 200_000_000n, daa: 4200n, redeem: sPayoutRedeem},
    shardCid: openOp.shardCid,
    vaultUtxo: {outpoint: {transactionId: buyOp.txid, index: 1}, value: 200_000_000n, spk: vaultPayout.scriptPubKey, daa: 4200n, utxoDaa: 4200n, covenantId: MAINNET_KUSDT_CID, amount: 3_000_000n, redeem: vaultPayout.redeem},
    fundingUtxos: [{outpoint: {transactionId: keyHex('vm-kas3b'), index: 0}, value: 1_000_000_000n, spk: w2.spk, daa: 4200n, utxoDaa: 4200n, covenantId: null}],
    kcc20Suffix: KCC20_SUFFIX,
    changeSpk: w2.spk,
    feerate: '100',
  });
  await w2.sign(paySelfOp.draft);
  await verifyOrdinarySignatures(paySelfOp.draft);
  runEngine(paySelfOp.draft, {limited: true});

  // 4. CLAIM_REFUND (2 records: first claim leaves 1 record + updated vault, second claim closes shard)
  const sRefundRedeem = redeemForState({
    stage: STAGE.S_REFUND, version: KUSDT_V2_VERSION, firstBuyerPk: w1.key,
    price, recordCount: 2, claimedMask: 0,
    records: [{cumTickets: 1, buyerPk: w1.key}, {cumTickets: 2, buyerPk: w2.key}],
  }, v2Profile);
  const vaultRef = kcc20RedeemAndSpk({amount: 2_000_000n, owner: openOp.shardCid, ownerScheme: 4}, KCC20_SUFFIX);
  const claim0 = adapter.prepareOperation({
    action: 'CLAIM_REFUND',
    shardUtxo: {outpoint: {transactionId: keyHex('vm-sr'), index: 0}, value: 200_000_000n, daa: 4300n, redeem: sRefundRedeem},
    shardCid: openOp.shardCid,
    vaultUtxo: {outpoint: {transactionId: keyHex('vm-vr'), index: 1}, value: 200_000_000n, spk: vaultRef.scriptPubKey, daa: 4300n, utxoDaa: 4300n, covenantId: MAINNET_KUSDT_CID, amount: 2_000_000n, redeem: vaultRef.redeem},
    recIdx: 0,
    fundingUtxos: [{outpoint: {transactionId: keyHex('vm-kas4'), index: 0}, value: 500_000_000n, spk: w1.spk, daa: 4300n, utxoDaa: 4300n, covenantId: null}],
    kcc20Suffix: KCC20_SUFFIX,
    changeSpk: w1.spk,
    feerate: '100',
  });
  await w1.sign(claim0.draft);
  await verifyOrdinarySignatures(claim0.draft);
  runEngine(claim0.draft, {limited: true});

  const sRefundRedeem2 = redeemForState({
    stage: STAGE.S_REFUND, version: KUSDT_V2_VERSION, firstBuyerPk: w1.key,
    price, recordCount: 2, claimedMask: 1,
    records: [{cumTickets: 1, buyerPk: w1.key}, {cumTickets: 2, buyerPk: w2.key}],
  }, v2Profile);
  const vaultRef2 = kcc20RedeemAndSpk({amount: 1_000_000n, owner: openOp.shardCid, ownerScheme: 4}, KCC20_SUFFIX);
  const claim1 = adapter.prepareOperation({
    action: 'CLAIM_REFUND',
    shardUtxo: {outpoint: {transactionId: claim0.txid, index: 0}, value: 200_000_000n, daa: 4310n, redeem: sRefundRedeem2},
    shardCid: openOp.shardCid,
    vaultUtxo: {outpoint: {transactionId: claim0.txid, index: 1}, value: 200_000_000n, spk: vaultRef2.scriptPubKey, daa: 4310n, utxoDaa: 4310n, covenantId: MAINNET_KUSDT_CID, amount: 1_000_000n, redeem: vaultRef2.redeem},
    recIdx: 1,
    fundingUtxos: [{outpoint: {transactionId: keyHex('vm-kas5'), index: 0}, value: 500_000_000n, spk: w2.spk, daa: 4310n, utxoDaa: 4310n, covenantId: null}],
    kcc20Suffix: KCC20_SUFFIX,
    changeSpk: w2.spk,
    feerate: '100',
  });
  await w2.sign(claim1.draft);
  await verifyOrdinarySignatures(claim1.draft);
  runEngine(claim1.draft, {limited: true});

  // 5. CLAIM_REFUND (1-record single-ticket shard: immediate final refund of 1 kUSDT + 4 KAS deposit)
  const sRefundSingleRedeem = redeemForState({
    stage: STAGE.S_REFUND, version: KUSDT_V2_VERSION, firstBuyerPk: w1.key,
    price, recordCount: 1, claimedMask: 0,
    records: [{cumTickets: 1, buyerPk: w1.key}],
  }, v2Profile);
  const vaultRefSingle = kcc20RedeemAndSpk({amount: 1_000_000n, owner: openOp.shardCid, ownerScheme: 4}, KCC20_SUFFIX);
  const claimSingle = adapter.prepareOperation({
    action: 'CLAIM_REFUND',
    shardUtxo: {outpoint: {transactionId: keyHex('vm-sr-1'), index: 1}, value: 200_000_000n, daa: 4320n, redeem: sRefundSingleRedeem},
    shardCid: openOp.shardCid,
    vaultUtxo: {outpoint: {transactionId: keyHex('vm-vr-1'), index: 2}, value: 200_000_000n, spk: vaultRefSingle.scriptPubKey, daa: 4320n, utxoDaa: 4320n, covenantId: MAINNET_KUSDT_CID, amount: 1_000_000n, redeem: vaultRefSingle.redeem},
    recIdx: 0,
    refundAmount: 1_000_000n,
    fundingUtxos: [{outpoint: {transactionId: keyHex('vm-kas6'), index: 2}, value: 47_365_278_600n, spk: w1.spk, daa: 4320n, utxoDaa: 4320n, covenantId: null}],
    kcc20Suffix: KCC20_SUFFIX,
    changeSpk: w1.spk,
    feerate: '100',
  });
  await w1.sign(claimSingle.draft);
  await verifyOrdinarySignatures(claimSingle.draft);
  runEngine(claimSingle.draft, {limited: true});

  w1.close();
  w2.close();
});

test('kusdt-v2 trackRoundIntent advances OPEN_SHARD & BUY immediately and syncRound catches up via REST + live node when KCI lags', async () => {
  const v2Profile = loadKusdtV2Profile(loadArtifacts());
  const adapter = createKusdtV2Adapter({profile: v2Profile, kcc20Suffix: KCC20_SUFFIX});
  const w1 = openMemoryWallet('55'.repeat(32), {prefix: MAINNET.addressPrefix});
  const w2 = openMemoryWallet('66'.repeat(32), {prefix: MAINNET.addressPrefix});
  const price = 1_000_000n;
  const genesisTxid = keyHex('genesis-lag-tx');

  const mOpenRedeem = redeemForState({
    stage: STAGE.M_OPEN, version: KUSDT_V2_VERSION, creatorPk: CREATOR_PK,
    price, closeDaa: 700005000n, openedCount: 0, cursor: 0, totalTickets: 0, entries: [],
  }, v2Profile);
  const mOpenSpk = p2sh(hex(blake2b256(mOpenRedeem)));
  const mOpenAddr = spkToAddress(mOpenSpk, MAINNET.addressPrefix);

  const cell1 = kcc20RedeemAndSpk({amount: 5_000_000n, owner: w1.key, ownerScheme: 0, borrowScheme: 1}, KCC20_SUFFIX);
  const openOp = adapter.prepareOperation({
    action: 'OPEN_SHARD',
    managerUtxo: {outpoint: {transactionId: genesisTxid, index: 0}, value: 400_000_000n, daa: 700000010n, redeem: mOpenRedeem},
    managerCid: MGR_CID,
    origin: {transactionId: keyHex('lag-origin'), index: 0},
    buyerPk: w1.key,
    qty: 1,
    price,
    buyerKasUtxos: [{outpoint: {transactionId: keyHex('lag-kas-1'), index: 0}, value: 1_000_000_000n, spk: w1.spk, daa: 700000010n, utxoDaa: 700000010n, covenantId: null}],
    buyerKcc20Utxos: [{outpoint: {transactionId: keyHex('lag-k1'), index: 0}, value: 300_000_000n, spk: cell1.scriptPubKey, daa: 700000010n, utxoDaa: 700000010n, covenantId: MAINNET_KUSDT_CID, amount: 5_000_000n, redeem: cell1.redeem}],
    kcc20Suffix: KCC20_SUFFIX,
    changeSpk: w1.spk,
    feerate: '100',
  });
  await w1.sign(openOp.draft);

  const newMgrRedeem = redeemForState(openOp.managerState, v2Profile);
  const newMgrSpk = p2sh(hex(blake2b256(newMgrRedeem)));
  const newMgrAddr = spkToAddress(newMgrSpk, MAINNET.addressPrefix);
  const s1Redeem = redeemForState(openOp.shardState, v2Profile);
  const s1Spk = p2sh(hex(blake2b256(s1Redeem)));
  const s1Addr = spkToAddress(s1Spk, MAINNET.addressPrefix);
  const vault1 = kcc20RedeemAndSpk({amount: 1_000_000n, owner: openOp.shardCid, ownerScheme: 4}, KCC20_SUFFIX);

  const cell2 = kcc20RedeemAndSpk({amount: 3_000_000n, owner: w2.key, ownerScheme: 0, borrowScheme: 0}, KCC20_SUFFIX);
  const buyOp = adapter.prepareOperation({
    action: 'BUY',
    shardUtxo: {outpoint: {transactionId: openOp.txid, index: 1}, value: 200_000_000n, daa: 700000020n, redeem: s1Redeem},
    shardCid: openOp.shardCid,
    vaultUtxo: {outpoint: {transactionId: openOp.txid, index: 2}, value: 200_000_000n, spk: vault1.scriptPubKey, daa: 700000020n, utxoDaa: 700000020n, covenantId: MAINNET_KUSDT_CID, amount: 1_000_000n, redeem: vault1.redeem},
    buyerPk: w2.key,
    qty: 2,
    price,
    buyerKasUtxos: [{outpoint: {transactionId: keyHex('lag-kas-2'), index: 0}, value: 500_000_000n, spk: w2.spk, daa: 700000020n, utxoDaa: 700000020n, covenantId: null}],
    buyerKcc20Utxos: [{outpoint: {transactionId: keyHex('lag-k2'), index: 0}, value: 200_000_000n, spk: cell2.scriptPubKey, daa: 700000020n, utxoDaa: 700000020n, covenantId: MAINNET_KUSDT_CID, amount: 3_000_000n, redeem: cell2.redeem}],
    kcc20Suffix: KCC20_SUFFIX,
    changeSpk: w2.spk,
    feerate: '100',
  });
  await w2.sign(buyOp.draft);

  const s2Redeem = redeemForState(buyOp.shardState, v2Profile);
  const s2Spk = p2sh(hex(blake2b256(s2Redeem)));
  const s2Addr = spkToAddress(s2Spk, MAINNET.addressPrefix);

  // Stale KCI stuck at revision 1 (genesis, openedCount=0, shards=[])
  const staleIndexer = {
    async roundDetail() {
      return {
        cid: MGR_CID,
        profileId: v2Profile.id,
        revision: '1',
        terminal: null,
        summary: {ticketsSold: 0},
        manager: {outpoint: {transactionId: genesisTxid, index: 0}, value: '400000000', spk: mOpenSpk, daaScore: '700000010', redeemHex: hex(mOpenRedeem)},
        protocolData: {openedCount: 0, cursor: 0, creatorPk: CREATOR_PK, closeDaa: '700005000', shards: []},
      };
    },
    async covenant(cid) {
      if (cid === MGR_CID) return {covenant: {outpoint: {transactionId: genesisTxid, index: 0}, value: '400000000', spk: mOpenSpk, daaScore: '700000010', redeemHex: hex(mOpenRedeem)}};
      throw new Error('NOT_FOUND');
    },
  };

  // Live UTXO map controlled by test
  const liveByAddr = new Map();
  const makeRpc = () => ({
    url: 'ws://mainnet.test',
    async currentDaa() { return 700000100n; },
    async call(method, params) {
      if (method === 'getUtxosByAddresses') {
        const entries = [];
        for (const a of params.addresses ?? []) {
          for (const e of (liveByAddr.get(a) ?? [])) entries.push(e);
        }
        return {entries};
      }
      return {};
    },
  });
  const utxoEntry = (txid, index, amount, spk, daa, covId) => ({
    outpoint: {transactionId: txid, index},
    utxoEntry: {amount: String(amount), scriptPublicKey: `0000${spk.script}`, blockDaaScore: String(daa), isCoinbase: false, covenantId: covId},
  });

  // 1. After OPEN_SHARD confirms on node, trackRoundIntent immediately advances even while KCI stays stale!
  liveByAddr.set(newMgrAddr, [utxoEntry(openOp.txid, 0, 400_000_000n, newMgrSpk, 700000020n, MGR_CID)]);
  liveByAddr.set(s1Addr, [utxoEntry(openOp.txid, 1, 200_000_000n, s1Spk, 700000020n, openOp.shardCid)]);
  const roundWithOpenIntent = {
    cid: MGR_CID,
    profileId: v2Profile.id,
    source: 'created',
    terminal: null,
    halted: null,
    step: 1,
    bought: 0,
    fees: 0n,
    frozen: [],
    pending: [],
    receipts: [{action: 'GENESIS', txid: genesisTxid, feeSompi: '10000', finalized: true}],
    manager: {outpoint: {transactionId: genesisTxid, index: 0}, value: 400_000_000n, spk: mOpenSpk, utxoDaa: 700000010n, daaScore: 700000010n, covenantId: MGR_CID, redeemScript: mOpenRedeem},
    settings: {ticketPrice: price, ticketCap: 65536, minTickets: 3, closeEligibleDaa: 700005000n, closeDaa: 700005000n, creatorPk: CREATOR_PK},
    kusdt: {stage: STAGE.M_OPEN, price, closeDaa: 700005000n, openedCount: 0, cursor: 0, totalTickets: 0, decision: 0, creatorPk: CREATOR_PK, winnerPk: null, nodeVerified: true, shards: []},
    intent: {
      status: 'SUBMITTED',
      action: 'OPEN_SHARD',
      txid: openOp.txid,
      profileId: v2Profile.id,
      draft: openOp.draft,
      nextManagerState: openOp.managerState,
      nextShardState: openOp.shardState,
      shardCid: openOp.shardCid,
    },
  };
  const tracked1 = await adapter.trackRoundIntent({rpc: makeRpc(), indexer: staleIndexer, round: roundWithOpenIntent, net: MAINNET});
  assert.equal(tracked1.accepted, true);
  assert.equal(tracked1.round.intent, null);
  assert.equal(tracked1.round.manager.outpoint.transactionId, openOp.txid);
  assert.equal(tracked1.round.kusdt.nodeVerified, true);
  assert.equal(tracked1.round.kusdt.openedCount, 1);
  assert.equal(tracked1.round.kusdt.totalTickets, 1);
  assert.equal(tracked1.round.bought, 1);
  assert.equal(tracked1.round.kusdt.shards.length, 1);
  assert.equal(tracked1.round.kusdt.shards[0].shardCid, openOp.shardCid);
  assert.equal(tracked1.round.kusdt.shards[0].tickets, 1);
  assert.equal(tracked1.round.kusdt.shards[0].records[0].buyerPk, w1.key);

  // 2. After BUY on existing shard #1 confirms, trackRoundIntent advances shard & totalTickets to 3 while KCI stays stale!
  liveByAddr.delete(s1Addr);
  liveByAddr.set(s2Addr, [utxoEntry(buyOp.txid, 0, 200_000_000n, s2Spk, 700000030n, openOp.shardCid)]);
  const roundWithBuyIntent = {
    ...tracked1.round,
    intent: {
      status: 'SUBMITTED',
      action: 'BUY',
      txid: buyOp.txid,
      profileId: v2Profile.id,
      draft: buyOp.draft,
      nextShardState: buyOp.shardState,
      shardCid: openOp.shardCid,
    },
  };
  const tracked2 = await adapter.trackRoundIntent({rpc: makeRpc(), indexer: staleIndexer, round: roundWithBuyIntent, net: MAINNET});
  assert.equal(tracked2.accepted, true);
  assert.equal(tracked2.round.kusdt.openedCount, 1);
  assert.equal(tracked2.round.kusdt.totalTickets, 3);
  assert.equal(tracked2.round.bought, 3);
  assert.equal(tracked2.round.kusdt.shards[0].outpoint.transactionId, buyOp.txid);
  assert.equal(tracked2.round.kusdt.shards[0].tickets, 3);
  assert.equal(tracked2.round.kusdt.shards[0].recordCount, 2);

  // 3. Fresh/stale browser starting at spent genesis M_OPEN catches up BOTH OPEN_SHARD and BUY via REST + live node!
  const txToRestDto = (txid, tx) => ({
    transaction_id: txid,
    is_accepted: true,
    inputs: tx.inputs.map((inp, idx) => ({
      index: idx,
      previous_outpoint_hash: inp.previousOutpoint.transactionId,
      previous_outpoint_index: inp.previousOutpoint.index,
      signature_script: inp.signatureScript,
    })),
    outputs: tx.outputs.map((out, idx) => ({
      index: idx,
      amount: Number(out.value),
      script_public_key: out.scriptPublicKey.script,
      covenant_id: out.covenant?.covenantId ?? null,
    })),
  });
  const restFetcher = async url => {
    if (url.includes(encodeURIComponent(mOpenAddr))) {
      return new Response(JSON.stringify([txToRestDto(openOp.txid, openOp.transaction)]), {status: 200});
    }
    if (url.includes(encodeURIComponent(s1Addr))) {
      return new Response(JSON.stringify([txToRestDto(buyOp.txid, buyOp.transaction)]), {status: 200});
    }
    return new Response(JSON.stringify([]), {status: 200});
  };
  const staleBrowserRound = {...roundWithOpenIntent, intent: null};
  const caught = await adapter.syncRound({rpc: makeRpc(), indexer: staleIndexer, round: staleBrowserRound, cid: MGR_CID, net: MAINNET, fetcher: restFetcher});
  assert.equal(caught.source, 'node');
  assert.equal(caught.round.kusdt.nodeVerified, true);
  assert.equal(caught.round.manager.outpoint.transactionId, openOp.txid);
  assert.equal(caught.round.kusdt.openedCount, 1);
  assert.equal(caught.round.kusdt.totalTickets, 3);
  assert.equal(caught.round.bought, 3);
  assert.equal(caught.round.kusdt.shards.length, 1);
  assert.equal(caught.round.kusdt.shards[0].shardCid, openOp.shardCid);
  assert.equal(caught.round.kusdt.shards[0].outpoint.transactionId, buyOp.txid);
  assert.equal(caught.round.kusdt.shards[0].tickets, 3);
  assert.equal(caught.round.kusdt.shards[0].recordCount, 2);

  // 4. Up-to-date indexer during M_OPEN (mgrSt.totalTickets=0, shard has 3 tickets) must NOT clobber totalTickets to 0!
  const freshIndexer = {
    async roundDetail() {
      return {
        cid: MGR_CID,
        profileId: v2Profile.id,
        revision: '3',
        terminal: null,
        summary: {ticketsSold: 3},
        manager: {outpoint: {transactionId: openOp.txid, index: 0}, value: '400000000', spk: newMgrSpk, daaScore: '700000020', redeemHex: hex(newMgrRedeem)},
        protocolData: {openedCount: 1, cursor: 0, creatorPk: CREATOR_PK, closeDaa: '700005000', shards: [{shardCid: openOp.shardCid, terminal: false, tickets: 3}]},
      };
    },
    async covenant(cid) {
      if (cid === openOp.shardCid) {
        return {covenant: {outpoint: {transactionId: buyOp.txid, index: 0}, value: '200000000', spk: s2Spk, daaScore: '700000030', redeemHex: hex(s2Redeem)}};
      }
      throw new Error('NOT_FOUND');
    },
  };
  const freshSync = await adapter.syncRound({rpc: makeRpc(), indexer: freshIndexer, round: null, cid: MGR_CID, net: MAINNET});
  assert.equal(freshSync.round.kusdt.nodeVerified, true);
  assert.equal(freshSync.round.kusdt.openedCount, 1);
  assert.equal(freshSync.round.kusdt.totalTickets, 3);
  assert.equal(freshSync.round.bought, 3);
  assert.equal(freshSync.round.kusdt.shards[0].tickets, 3);

  // 5. DISPATCH_BATCH destroying manager -> S_REFUND (no ZERO32 winnerKey, manager=null, nodeVerified=true) -> CLAIM_REFUND -> REFUNDED
  const sFrozenRedeem = redeemForState({
    stage: STAGE.S_FROZEN, version: KUSDT_V2_VERSION, managerCid: MGR_CID,
    firstBuyerPk: w1.key, price, records: [{cumTickets: 1, buyerPk: w1.key}],
  }, v2Profile);
  const sFrozenSpk = p2sh(hex(blake2b256(sFrozenRedeem)));
  const mDispatchRedeem = redeemForState({
    stage: STAGE.M_DISPATCH, version: KUSDT_V2_VERSION, creatorPk: CREATOR_PK,
    price, closeDaa: 700005000n, openedCount: 1, cursor: 0, totalTickets: 1,
    decision: DECISION.REFUND, reserved: 0, winnerPk: '00'.repeat(32),
    shardCids: [openOp.shardCid],
  }, v2Profile);
  const mDispatchSpk = p2sh(hex(blake2b256(mDispatchRedeem)));
  const collectTxid = keyHex('collect-1ticket');

  const dispatchOp = adapter.prepareOperation({
    action: 'DISPATCH_BATCH',
    managerUtxo: {outpoint: {transactionId: collectTxid, index: 0}, value: 400_000_000n, daa: 700006000n, redeem: mDispatchRedeem},
    managerCid: MGR_CID,
    frozenShardUtxos: [{outpoint: {transactionId: collectTxid, index: 1}, value: 200_000_000n, daa: 700006000n, redeem: sFrozenRedeem}],
    fundingUtxos: [{outpoint: {transactionId: keyHex('disp-kas'), index: 0}, value: 500_000_000n, spk: w1.spk, daa: 700006000n, utxoDaa: 700006000n, covenantId: null}],
    changeSpk: w1.spk,
    feerate: '100',
  });
  await w1.sign(dispatchOp.draft);
  const sRefundRedeem = redeemForState(dispatchOp.shardStates[0], v2Profile);
  const sRefundSpk = p2sh(hex(blake2b256(sRefundRedeem)));
  const sRefundAddr = spkToAddress(sRefundSpk, MAINNET.addressPrefix);
  const vault1Addr = spkToAddress(vault1.scriptPubKey, MAINNET.addressPrefix);

  liveByAddr.clear();
  liveByAddr.set(sRefundAddr, [utxoEntry(dispatchOp.txid, 1, 200_000_000n, sRefundSpk, 700006010n, openOp.shardCid)]);
  liveByAddr.set(vault1Addr, [utxoEntry(openOp.txid, 2, 200_000_000n, vault1.scriptPubKey, 700000020n, MAINNET_KUSDT_CID)]);
  liveByAddr.set(w1.address, [utxoEntry(keyHex('claim-kas'), 0, 500_000_000n, w1.spk, 700006010n, null)]);

  // KCI after DISPATCH_BATCH: omits manager (undefined), subPhase='s_refund'
  const postDispatchIndexer = {
    async roundDetail() {
      return {
        cid: MGR_CID,
        profileId: v2Profile.id,
        revision: '4',
        terminal: null,
        summary: {phase: 'REFUNDING', subPhase: 's_refund', ticketsSold: 1, ticketPrice: String(price)},
        protocolData: {openedCount: 1, cursor: 0, creatorPk: CREATOR_PK, winnerPk: null, closeDaa: '700005000', shards: [{shardCid: openOp.shardCid, terminal: false, tickets: 1, vaultAmount: String(price)}]},
      };
    },
    async covenant(cid) {
      if (cid === openOp.shardCid) {
        return {covenant: {outpoint: {transactionId: dispatchOp.txid, index: 1}, value: '200000000', spk: sRefundSpk, daaScore: '700006010', redeemHex: hex(sRefundRedeem)}};
      }
      throw new Error('NOT_FOUND');
    },
  };

  const preDispatchRound = {
    cid: MGR_CID,
    profileId: v2Profile.id,
    source: 'created',
    terminal: null,
    halted: null,
    step: 3,
    bought: 1,
    fees: 0n,
    frozen: [],
    pending: [],
    receipts: [{action: 'GENESIS', txid: genesisTxid, feeSompi: '10000', finalized: true}],
    manager: {outpoint: {transactionId: collectTxid, index: 0}, value: 400_000_000n, spk: mDispatchSpk, utxoDaa: 700006000n, daaScore: 700006000n, covenantId: MGR_CID, redeemScript: mDispatchRedeem},
    settings: {ticketPrice: price, ticketCap: 65536, minTickets: 3, closeEligibleDaa: 700005000n, closeDaa: 700005000n, creatorPk: CREATOR_PK},
    kusdt: {
      stage: STAGE.M_DISPATCH, price, closeDaa: 700005000n, openedCount: 1, cursor: 0, totalTickets: 1,
      decision: DECISION.REFUND, creatorPk: CREATOR_PK, winnerPk: '00'.repeat(32), nodeVerified: true,
      shards: [{shardCid: openOp.shardCid, stage: STAGE.S_FROZEN, terminal: false, firstBuyerPk: w1.key, tickets: 1, recordCount: 1, records: [{cumTickets: 1, buyerPk: w1.key}], outpoint: {transactionId: collectTxid, index: 1}, value: 200_000_000n, spk: sFrozenSpk, daaScore: 700006000n, redeem: sFrozenRedeem}],
    },
    intent: {
      status: 'SUBMITTED',
      action: 'DISPATCH_BATCH',
      txid: dispatchOp.txid,
      profileId: v2Profile.id,
      draft: dispatchOp.draft,
      nextManagerState: null,
      nextShardStates: dispatchOp.shardStates,
      shardCid: null,
    },
  };
  assert.equal(adapter.describeRound(preDispatchRound).winnerKey, null);

  const afterDispatch = await adapter.trackRoundIntent({rpc: makeRpc(), indexer: postDispatchIndexer, round: preDispatchRound, net: MAINNET});
  assert.equal(afterDispatch.accepted, true);
  assert.equal(afterDispatch.round.manager, null);
  assert.equal(afterDispatch.round.terminal, null);
  assert.equal(afterDispatch.round.kusdt.nodeVerified, true);
  assert.equal(afterDispatch.round.kusdt.winnerPk, null);
  assert.equal(afterDispatch.round.kusdt.shards[0].stage, STAGE.S_REFUND);
  assert.equal(afterDispatch.round.kusdt.shards[0].outpoint.transactionId, dispatchOp.txid);
  assert.equal(adapter.describeRound(afterDispatch.round).module, 'refund');
  assert.equal(adapter.describeRound(afterDispatch.round).winnerKey, null);

  // Syncing stale local preDispatchRound (no intent) against postDispatchIndexer must ALSO clear manager -> null & verify S_REFUND!
  const syncedPostDispatch = await adapter.syncRound({rpc: makeRpc(), indexer: postDispatchIndexer, round: {...preDispatchRound, intent: null}, cid: MGR_CID, net: MAINNET});
  assert.equal(syncedPostDispatch.round.manager, null);
  assert.equal(syncedPostDispatch.round.kusdt.nodeVerified, true);
  assert.equal(syncedPostDispatch.round.kusdt.winnerPk, null);
  assert.equal(syncedPostDispatch.round.kusdt.shards[0].stage, STAGE.S_REFUND);

  // Prepare CLAIM_REFUND via prepareForController -> verify +1 kUSDT delta and mine=true outputs
  const prepClaim = await adapter.prepareForController({
    rpc: makeRpc(),
    indexer: postDispatchIndexer,
    round: afterDispatch.round,
    choice: {action: 'CLAIM_REFUND', shardCid: openOp.shardCid, recIdx: 0},
    wallet: w1,
    feerate: '100',
    net: MAINNET,
  });
  const tokenDelta = prepClaim.review.assetDeltas.find(d => d.asset.kind === 'KCC20');
  assert.equal(tokenDelta?.amount, 1_000_000n);
  assert.equal(prepClaim.review.outputs[0].role, 'SHARD_DEPOSIT');
  assert.equal(prepClaim.review.outputs[0].mine, true);
  assert.equal(prepClaim.review.outputs[0].rollover, true);
  assert.equal(prepClaim.review.outputs[1].role, 'BUYER_REFUND');
  assert.equal(prepClaim.review.outputs[1].mine, true);
  assert.equal(prepClaim.review.outputs[1].rollover, false);
  assert.equal(prepClaim.review.outputs[1].tokenAmount, 1_000_000n);
  assert.match(prepClaim.review.outputs[1].note, /退回你的 1 kUSDT 票款/);
  await w1.sign(prepClaim.draft);

  // After CLAIM_REFUND confirms -> round transitions to terminal='REFUNDED'
  liveByAddr.delete(sRefundAddr);
  liveByAddr.set(w1.address, [utxoEntry(prepClaim.txid, 0, 400_000_000n, w1.spk, 700006020n, null)]);
  const afterClaim = await adapter.trackRoundIntent({
    rpc: makeRpc(),
    indexer: postDispatchIndexer,
    round: {
      ...afterDispatch.round,
      intent: {
        status: 'SUBMITTED',
        action: 'CLAIM_REFUND',
        txid: prepClaim.txid,
        profileId: v2Profile.id,
        draft: prepClaim.draft,
        nextShardState: prepClaim.shardState ?? null,
        shardCid: openOp.shardCid,
      },
    },
    net: MAINNET,
  });
  assert.equal(afterClaim.accepted, true);
  assert.equal(afterClaim.round.terminal, 'REFUNDED');
  assert.equal(afterClaim.round.kusdt.shards[0].terminal, true);
  const claimRc = afterClaim.round.receipts.find(r => r.txid === prepClaim.txid);
  assert.equal(claimRc?.action, 'CLAIM_REFUND');
  assert.equal(claimRc?.shardCid, openOp.shardCid);

  w1.close();
  w2.close();
});

test('kusdt-v2 syncRound hydrates receipts from KCI roundDetail, falls back to roundHistory, and decodes terminal det.shards redeemHex', async () => {
  const v2Profile = loadKusdtV2Profile(loadArtifacts());
  const adapter = createKusdtV2Adapter({profile: v2Profile, kcc20Suffix: KCC20_SUFFIX});
  const shardCid = keyHex('term-shard');
  const buyerPk = keyHex('term-buyer');
  const genTx = keyHex('term-gen');
  const openTx = keyHex('term-open');
  const colTx = keyHex('term-col');
  const dispTx = keyHex('term-disp');
  const claimTx = keyHex('term-claim');

  const sRefundState = {
    stage: STAGE.S_REFUND,
    version: KUSDT_V2_VERSION,
    firstBuyerPk: buyerPk,
    price: 1_000_000n,
    recordCount: 1,
    claimedMask: 0,
    records: [{cumTickets: 1, buyerPk}],
  };
  const sRefundRedeem = redeemForState(sRefundState, v2Profile);
  const sRefundSpk = p2sh(hex(blake2b256(sRefundRedeem)));

  // 1. Primary path: KCI roundDetail includes receipts + terminal det.shards[shardCid].redeemHex + state.claimedMask=1
  const detailWithReceipts = {
    schema: 1,
    cid: MGR_CID,
    profileId: v2Profile.id,
    revision: '5',
    terminal: 'REFUNDED',
    manager: null,
    origin: {transactionId: keyHex('term-origin'), index: 1},
    shards: {
      [shardCid]: {
        shardCid,
        stage: 'S_REFUND',
        outpoint: null,
        value: '200000000',
        spk: sRefundSpk,
        utxoDaa: '600272969',
        redeemHex: hex(sRefundRedeem),
        firstBuyerPk: buyerPk,
        tickets: 1,
        vaultAmount: '1000000',
        terminal: true,
        state: {stage: 'S_REFUND', stageCode: 20, recordCount: 1, claimedMask: 1, records: [{cumTickets: 1, buyerPk}]},
      },
    },
    receipts: [
      {action: 'GENESIS', txid: genTx, feeSompi: '1500000', finalized: true},
      {action: 'OPEN_SHARD', txid: openTx, feeSompi: '8951000', finalized: true, shardCid, recordIndex: 0},
      {action: 'COLLECT_BATCH', txid: colTx, feeSompi: '3100000', finalized: true},
      {action: 'DISPATCH_BATCH', txid: dispTx, feeSompi: '3200000', finalized: true},
      {action: 'CLAIM_REFUND', txid: claimTx, feeSompi: '4500000', finalized: true, shardCid, recIdx: 0},
    ],
    summary: {
      protocolId: 'kusdt-v2',
      profileId: v2Profile.id,
      phase: 'DONE',
      subPhase: 'REFUNDED',
      terminal: 'REFUNDED',
      ticketsSold: 1,
      ticketPrice: '1000000',
      protocolData: {
        openedCount: 1,
        cursor: 0,
        closeDaa: '600249661',
        creatorPk: buyerPk,
        winnerPk: null,
        shards: [{shardCid, terminal: true, firstBuyerPk: buyerPk, tickets: 1, vaultAmount: '1000000'}],
      },
    },
    head: {txid: claimTx, acceptingBlock: keyHex('term-blk'), acceptingDaa: '600309260'},
  };

  const synced = await adapter.syncRound({
    indexer: {
      async roundDetail() { return detailWithReceipts; },
      async covenant() { throw new Error('should not call covenant for det.shards terminal'); },
    },
    cid: MGR_CID,
    net: MAINNET,
  });
  assert.equal(synced.round.terminal, 'REFUNDED');
  assert.equal(synced.round.receipts.length, 5);
  assert.equal(synced.round.receipts[1].action, 'OPEN_SHARD');
  assert.equal(synced.round.receipts[1].txid, openTx);
  assert.equal(synced.round.receipts[1].shardCid, shardCid);
  assert.equal(synced.round.receipts[1].recordIndex, 0);
  assert.equal(synced.round.receipts[1].feeSompi, '8951000');
  assert.equal(synced.round.receipts[4].action, 'CLAIM_REFUND');
  assert.equal(synced.round.receipts[4].txid, claimTx);
  assert.equal(synced.round.receipts[4].shardCid, shardCid);
  assert.equal(synced.round.receipts[4].recIdx, 0);
  assert.equal(synced.round.fees, 1500000n + 8951000n + 3100000n + 3200000n + 4500000n);
  // Terminal shard decoded from det.shards[shardCid].redeemHex preserves records + claimedMask=1!
  assert.equal(synced.round.kusdt.shards.length, 1);
  assert.equal(synced.round.kusdt.shards[0].terminal, true);
  assert.equal(synced.round.kusdt.shards[0].recordCount, 1);
  assert.equal(synced.round.kusdt.shards[0].claimedMask, 1);
  assert.equal(synced.round.kusdt.shards[0].records?.[0]?.buyerPk, buyerPk);
  const catalog = adapter.shardCatalog(synced.round, buyerPk);
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].status, 'refunded');
  assert.equal(catalog[0].records?.[0]?.refunded, true);
  assert.equal(catalog[0].records?.[0]?.mine, true);

  // 2. Fallback path: older KCI without det.receipts falls back to indexer.roundHistory
  const detailNoReceipts = {...detailWithReceipts};
  delete detailNoReceipts.receipts;
  const syncedHist = await adapter.syncRound({
    indexer: {
      async roundDetail() { return detailNoReceipts; },
      async roundHistory() {
        return {
          cid: MGR_CID,
          events: [
            {type: 'ACCEPT', action: 'GENESIS', txid: genTx, status: 'FINAL', position: {acceptingBlockHash: keyHex('b0'), acceptingDaa: '1'}},
            {type: 'ACCEPT', action: 'OPEN_SHARD', txid: openTx, status: 'FINAL', position: {acceptingBlockHash: keyHex('b1'), acceptingDaa: '2'}},
            {type: 'ROLLBACK', action: 'BUY', txid: keyHex('rolled'), status: 'ROLLED_BACK', position: {acceptingBlockHash: keyHex('b2'), acceptingDaa: '3'}},
            {type: 'ACCEPT', action: 'CLAIM_REFUND', txid: claimTx, status: 'FINAL', position: {acceptingBlockHash: keyHex('b3'), acceptingDaa: '4'}},
          ],
          nextCursor: null,
        };
      },
    },
    cid: MGR_CID,
    net: MAINNET,
  });
  assert.deepEqual(syncedHist.round.receipts.map(r => r.txid), [genTx, openTx, claimTx]);
});

test('kusdt-v2 DRAW & REROLL: kusdtDrawSample, resolveKusdtDrawWinner, real VM execution with CSV sequence, and verifyKusdtDrawReceipt', async () => {
  const v2Profile = loadKusdtV2Profile(loadArtifacts());
  const adapter = createKusdtV2Adapter({profile: v2Profile, kcc20Suffix: KCC20_SUFFIX});
  const w1 = openMemoryWallet('31'.repeat(32), {prefix: MAINNET.addressPrefix});
  const w2 = openMemoryWallet('32'.repeat(32), {prefix: MAINNET.addressPrefix});
  const w3 = openMemoryWallet('33'.repeat(32), {prefix: MAINNET.addressPrefix});

  const scid0 = keyHex('draw-sh-0');
  const scid1 = keyHex('draw-sh-1');
  const sFrozen0 = {
    stage: STAGE.S_FROZEN, version: KUSDT_V2_VERSION, managerCid: MGR_CID,
    firstBuyerPk: w1.key, price: 1_000_000n,
    records: [{cumTickets: 1, buyerPk: w1.key}, {cumTickets: 2, buyerPk: w2.key}],
  };
  const sFrozen1 = {
    stage: STAGE.S_FROZEN, version: KUSDT_V2_VERSION, managerCid: MGR_CID,
    firstBuyerPk: w2.key, price: 1_000_000n,
    records: [{cumTickets: 1, buyerPk: w2.key}, {cumTickets: 3, buyerPk: w3.key}],
  };
  const redeem0 = redeemForState(sFrozen0, v2Profile);
  const redeem1 = redeemForState(sFrozen1, v2Profile);
  const hash0 = hex(blake2b256(encodeKusdtV2State(sFrozen0)));
  const hash1 = hex(blake2b256(encodeKusdtV2State(sFrozen1)));
  const sealedDaa = 700_000_000n;
  const sealedOutpoint = {transactionId: keyHex('draw-mgr-sealed'), index: 0};
  const mgrSealedState = {
    stage: STAGE.M_SEALED, version: KUSDT_V2_VERSION, creatorPk: w1.key,
    price: 1_000_000n, closeDaa: 699_999_000n, openedCount: 2, cursor: 0, totalTickets: 5,
    entries: [
      {shardCid: scid0, ledgerHash: hash0, cumTickets: 2},
      {shardCid: scid1, ledgerHash: hash1, cumTickets: 5},
    ],
  };
  const mgrSealedRedeem = redeemForState(mgrSealedState, v2Profile);
  const mgrSealedSpk = p2sh(hex(blake2b256(mgrSealedRedeem)));
  const shards = [
    {shardCid: scid0, stage: STAGE.S_FROZEN, redeem: redeem0, frozenRedeem: redeem0},
    {shardCid: scid1, stage: STAGE.S_FROZEN, redeem: redeem1, frozenRedeem: redeem1},
  ];

  // Find a deterministic synthetic Pass-A proof that lands in shard 1, record 1 (winner = w3)
  let chosen = null;
  for (let nonce = 0; nonce < 500; nonce++) {
    const syn = buildSyntheticDrawOp({manager: {utxoDaa: sealedDaa}}, nonce);
    const sample = kusdtDrawSample({
      cid: MGR_CID,
      outpoint: sealedOutpoint,
      utxoDaa: sealedDaa,
      currentDaa: sealedDaa + DRAW_DELAY_DAA + 20n,
      totalTickets: 5,
      proof: syn.proof,
      accessor: syn.accessor,
    });
    const win = resolveKusdtDrawWinner(mgrSealedState, shards, sample.ticket, v2Profile);
    if (win.shardIndex === 1 && win.recordIndex === 1) {
      chosen = {syn, sample, win};
      break;
    }
  }
  assert.ok(chosen, 'expected synthetic proof landing in shard 1 record 1');
  assert.equal(chosen.win.winnerPk, w3.key);

  const drawOp = adapter.prepareOperation({
    action: 'DRAW',
    managerUtxo: {outpoint: sealedOutpoint, value: 400_000_000n, spk: mgrSealedSpk, daa: sealedDaa, utxoDaa: sealedDaa, redeem: mgrSealedRedeem},
    managerCid: MGR_CID,
    passAProof: chosen.syn.proof,
    shardIndex: chosen.win.shardIndex,
    recordIndex: chosen.win.recordIndex,
    frozenShardState: chosen.win.frozenShardState,
    fundingUtxos: [{outpoint: {transactionId: keyHex('draw-fund'), index: 0}, value: 500_000_000n, spk: w1.spk, daa: sealedDaa, utxoDaa: sealedDaa, covenantId: null}],
    changeSpk: w1.spk,
    fee: 25_000n,
  });
  assert.equal(drawOp.transaction.inputs[0].sequence, DRAW_DELAY_DAA);
  assert.equal(drawOp.winnerPk, w3.key);

  const rerollOp = adapter.prepareOperation({
    action: 'REROLL',
    managerUtxo: {outpoint: sealedOutpoint, value: 400_000_000n, spk: mgrSealedSpk, daa: sealedDaa, utxoDaa: sealedDaa, redeem: mgrSealedRedeem},
    managerCid: MGR_CID,
    fundingUtxos: [{outpoint: {transactionId: keyHex('rr-fund'), index: 0}, value: 500_000_000n, spk: w1.spk, daa: sealedDaa, utxoDaa: sealedDaa, covenantId: null}],
    changeSpk: w1.spk,
    fee: 10_000n,
  });
  assert.equal(rerollOp.transaction.inputs[0].sequence, REROLL_TIMEOUT_DAA);

  // Real kaspa-txscript 2.1.0 VM execution of BOTH DRAW and REROLL (verifies CSV sequence & Pass-A proof & winner extraction!)
  if (process.env.KASWIN_VM_BIN) {
    const drawVm = runEngine(drawOp.draft, {execute: [0], accessor: chosen.syn.accessor});
    assert.equal(drawVm.inputs[0].ok, true);
    const rerollVm = runEngine(rerollOp.draft, {execute: [0]});
    assert.equal(rerollVm.inputs[0].ok, true);
  }

  // Node-authenticated verifyKusdtDrawReceipt recovers exact {txid, shard, record, ticket} from DRAW witness
  const drawAccBlock = keyHex('draw-acc-blk');
  const drawParentBlock = keyHex('draw-parent-blk');
  const drawTxid = drawOp.txid;
  const fakeRpc = {
    async call(method, params) {
      if (method === 'getSinkBlueScore') return {blueScore: '1200'};
      if (method === 'getBlock' && params.hash === drawAccBlock) {
        return {
          block: {
            header: {hash: drawAccBlock, daaScore: String(sealedDaa + DRAW_DELAY_DAA + 20n), blueScore: '1000', acceptedIdMerkleRoot: keyHex('amr')},
            verboseData: {isChainBlock: true, selectedParentHash: drawParentBlock, mergeSetBluesHashes: [drawParentBlock], mergeSetRedsHashes: []},
          },
        };
      }
      if (method === 'getVirtualChainFromBlockV2' && params.startHash === drawParentBlock) {
        return {
          removedChainBlockHashes: [],
          addedChainBlockHashes: [drawAccBlock],
          chainBlockAcceptedTransactions: [{
            chainBlockHeader: {hash: drawAccBlock, daaScore: String(sealedDaa + DRAW_DELAY_DAA + 20n), blueScore: '1000'},
            acceptedTransactions: [{
              version: drawOp.transaction.version,
              lockTime: String(drawOp.transaction.lockTime),
              subnetworkId: drawOp.transaction.subnetworkId,
              gas: String(drawOp.transaction.gas),
              payload: drawOp.transaction.payload,
              verboseData: {transactionId: drawTxid},
              inputs: drawOp.transaction.inputs.map((inp, idx) => {
                const u = drawOp.draft.inputUtxos[idx];
                return {
                  previousOutpoint: {transactionId: inp.previousOutpoint.transactionId, index: inp.previousOutpoint.index},
                  signatureScript: inp.signatureScript,
                  sequence: String(inp.sequence),
                  sigOpCount: 1,
                  verboseData: {
                    utxoEntry: {
                      amount: String(u.value),
                      scriptPublicKey: `0000${u.spk.script}`,
                      blockDaaScore: String(u.utxoDaa),
                      isCoinbase: false,
                      covenantId: u.covenantId ?? null,
                    },
                  },
                };
              }),
              outputs: drawOp.transaction.outputs.map(o => ({
                value: String(o.value),
                scriptPublicKey: `0000${o.scriptPublicKey.script}`,
                ...(o.covenant ? {covenant: {covenantId: o.covenant.covenantId, authorizingInput: o.covenant.authorizingInput}} : {}),
              })),
            }],
          }],
        };
      }
      if (method === 'getBlock' && params.hash === chosen.syn.accessor.blockHash) {
        return {
          block: {
            header: {hash: chosen.syn.accessor.blockHash, acceptedIdMerkleRoot: chosen.syn.accessor.sequenceCommitment},
            verboseData: {isChainBlock: true},
          },
        };
      }
      throw new Error(`unexpected rpc ${method} ${JSON.stringify(params)}`);
    },
  };
  const verified = await verifyKusdtDrawReceipt(
    {cid: MGR_CID, receipts: [{action: 'DRAW', txid: drawTxid, acceptingBlock: drawAccBlock, feeSompi: '25000', finalized: true}]},
    fakeRpc,
    v2Profile,
  );
  assert.deepEqual(verified, {txid: drawTxid, shard: 1, record: 1, ticket: chosen.sample.ticket});

  w1.close();
  w2.close();
  w3.close();
});

test('kusdt-v2 syncRound hydrates accepting block, PAID frozenRedeemHex records, det.draw, and controller.syncWalletActivity works without top-level profileId', async () => {
  const v2Profile = loadKusdtV2Profile(loadArtifacts());
  const adapter = createKusdtV2Adapter({profile: v2Profile, kcc20Suffix: KCC20_SUFFIX});
  const buyer1 = keyHex('paid-b1');
  const buyer2 = keyHex('paid-b2');
  const scid = keyHex('paid-sh0');
  const sFrozenState = {
    stage: STAGE.S_FROZEN, version: KUSDT_V2_VERSION, managerCid: MGR_CID,
    firstBuyerPk: buyer1, price: 1_000_000n,
    records: [{cumTickets: 1, buyerPk: buyer1}, {cumTickets: 3, buyerPk: buyer2}],
  };
  const sFrozenRedeem = redeemForState(sFrozenState, v2Profile);
  const sPayoutState = {
    stage: STAGE.S_PAYOUT, version: KUSDT_V2_VERSION, firstBuyerPk: buyer1,
    winnerPk: buyer2, vaultAmount: 3_000_000n, managerCid: MGR_CID, shardTickets: 3,
  };
  const sPayoutRedeem = redeemForState(sPayoutState, v2Profile);
  const sPayoutSpk = p2sh(hex(blake2b256(sPayoutRedeem)));
  const drawTx = keyHex('paid-draw-tx');
  const payTx = keyHex('paid-pay-tx');
  const headAcc = keyHex('paid-head-acc');

  const paidDetail = {
    schema: 1,
    network: MAINNET.networkId,
    genesisHash: MAINNET.genesis,
    cid: MGR_CID,
    profileId: v2Profile.id,
    revision: '6',
    terminal: 'PAID',
    manager: null,
    origin: {transactionId: keyHex('paid-origin'), index: 0},
    draw: {txid: drawTx, shard: 0, record: 1, ticket: 2, winnerPk: buyer2},
    shards: {
      [scid]: {
        shardCid: scid,
        stage: 'S_PAYOUT',
        outpoint: null,
        value: '200000000',
        spk: sPayoutSpk,
        utxoDaa: '700000500',
        redeemHex: hex(sPayoutRedeem),
        frozenRedeemHex: hex(sFrozenRedeem),
        firstBuyerPk: buyer1,
        tickets: 3,
        vaultAmount: '3000000',
        terminal: true,
      },
    },
    receipts: [
      {action: 'GENESIS', txid: keyHex('paid-gen'), feeSompi: '1000000', finalized: true},
      {action: 'OPEN_SHARD', txid: keyHex('paid-open'), feeSompi: '6000000', finalized: true, shardCid: scid, recordIndex: 0},
      {action: 'BUY', txid: keyHex('paid-buy'), feeSompi: '3000000', finalized: true, shardCid: scid, recordIndex: 1},
      {action: 'DRAW', txid: drawTx, feeSompi: '25000', finalized: true, acceptingBlock: keyHex('paid-draw-blk')},
      {action: 'PAYOUT_SELF', txid: payTx, feeSompi: '2000000', finalized: true, shardCid: scid},
    ],
    summary: {
      protocolId: 'kusdt-v2',
      profileId: v2Profile.id,
      phase: 'DONE',
      subPhase: 'PAID',
      terminal: 'PAID',
      ticketsSold: 3,
      ticketPrice: '1000000',
      protocolData: {
        openedCount: 1,
        cursor: 1,
        closeDaa: '700000000',
        creatorPk: buyer1,
        winnerPk: buyer2,
        shards: [{shardCid: scid, terminal: true, firstBuyerPk: buyer1, tickets: 3, vaultAmount: '3000000'}],
      },
    },
    head: {txid: payTx, acceptingBlock: headAcc, acceptingDaa: '700000600'},
  };

  // 1. syncRound hydrates draw, accepting, and frozenRedeemHex -> full buyer records on PAID shard!
  const synced = await adapter.syncRound({
    indexer: {async roundDetail() { return paidDetail; }},
    cid: MGR_CID,
    net: MAINNET,
  });
  assert.equal(synced.round.terminal, 'PAID');
  assert.equal(synced.round.accepting, headAcc);
  assert.equal(synced.round.draw, undefined, 'unverified KCI det.draw must not populate round.draw');
  assert.deepEqual(synced.round.drawHint, {txid: drawTx, shard: 0, record: 1, ticket: 2});
  assert.equal(synced.round.kusdt.shards[0].records?.length, 2);
  assert.equal(synced.round.kusdt.shards[0].records?.[1]?.buyerPk, buyer2);
  const catalog = adapter.shardCatalog(synced.round, buyer2);
  assert.equal(catalog[0].status, 'settled');
  assert.equal(catalog[0].records?.length, 2);
  assert.equal(catalog[0].mineCount, 2);

  // 2. createIndexerClient.walletActivity succeeds WITHOUT top-level profileId & controller.syncWalletActivity hydrates into store
  const fakeFetch = async url => {
    const u = String(url);
    if (u.endsWith('/info')) {
      return new Response(JSON.stringify({
        schema: 1, network: MAINNET.networkId, genesisHash: MAINNET.genesis,
        profileId: rollingProfile.id, readOnly: true, stale: false, roundsCount: 1,
      }), {status: 200});
    }
    if (u.includes('/rounds?')) {
      return new Response(JSON.stringify({
        schema: 1, network: MAINNET.networkId, genesisHash: MAINNET.genesis,
        profileId: rollingProfile.id, rounds: [], nextCursor: null,
      }), {status: 200});
    }
    if (u.includes(`/wallets/${buyer2}/activity`)) {
      // Matches real KCI api.rs:1422 — NO top-level profileId!
      return new Response(JSON.stringify({
        schema: 1, network: MAINNET.networkId, genesisHash: MAINNET.genesis,
        pk: buyer2,
        activities: [{
          cid: MGR_CID, profileId: v2Profile.id, roles: ['buyer'],
          phase: 'DONE', subPhase: 'PAID', terminal: 'PAID',
          asset: {kind: 'KCC20', symbol: 'kUSDT', decimals: 6, tokenCovenantId: MAINNET_KUSDT_CID},
          updatedAt: Date.now(),
        }],
        byProfile: {[v2Profile.id]: [{cid: MGR_CID}]},
      }), {status: 200});
    }
    if (u.endsWith(`/rounds/${MGR_CID}`)) {
      return new Response(JSON.stringify(paidDetail), {status: 200});
    }
    return new Response(JSON.stringify({detail: 'NOT_FOUND'}), {status: 404});
  };
  const client = createIndexerClient({
    baseUrl: 'https://indexer.test/mainnet',
    fetchImpl: fakeFetch,
    networkId: MAINNET.networkId,
    genesisHash: MAINNET.genesis,
    profileId: rollingProfile.id,
    profileIds: [rollingProfile.id, v2Profile.id],
  });
  const wa = await client.walletActivity(buyer2);
  assert.equal(wa.activities.length, 1);
  assert.equal(wa.activities[0].cid, MGR_CID);

  const backingMem = new MemoryStore();
  backingMem.persistent = true;
  const memStore = new RoundStore(backingMem, {genesis: MAINNET.genesis, profileId: rollingProfile.id});
  const registry = createProtocolRegistry([
    createRollingV1Adapter({profile: rollingProfile}),
    adapter,
  ], {defaultCreateProfileId: rollingProfile.id});
  const ctl = createController({
    profile: rollingProfile,
    registry,
    roundStore: memStore,
    net: MAINNET,
    fetcher: fakeFetch,
    connect: async () => ({
      url: 'ws://mainnet.test',
      async currentDaa() { return 700_000_700n; },
      async call() { return {entries: []}; },
      close() {},
    }),
  });
  await ctl.connectNode(['ws://mainnet.test']);
  await ctl.checkIndexer('https://indexer.test/mainnet');
  const res = await ctl.syncWalletActivity(buyer2);
  assert.deepEqual(res.synced, [MGR_CID]);
  const stored = await ctl.rounds();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].cid, MGR_CID);
  assert.equal(stored[0].draw, undefined);
  assert.deepEqual(stored[0].drawHint, {txid: drawTx, shard: 0, record: 1, ticket: 2});
  assert.equal(stored[0].kusdt.shards[0].records?.length, 2);
  ctl.close();
});

test('kusdt-v2 caps active buyable S_OPEN shards at MAX_ACTIVE_OPEN_SHARDS (8) and frees a slot once any shard hits 256 records', async () => {
  assert.equal(MAX_ACTIVE_OPEN_SHARDS, 8);
  const v2Profile = loadKusdtV2Profile(loadArtifacts());
  const adapter = createKusdtV2Adapter({profile: v2Profile, kcc20Suffix: KCC20_SUFFIX});
  const price = 1_000_000n;
  const wallet = openMemoryWallet('11'.repeat(32), {prefix: MAINNET.addressPrefix});

  const mkShardEntry = (idx, recordCount) => {
    const scid = keyHex(`cap-shard-${idx}`);
    const records = Array.from({length: recordCount}, (_, r) => ({cumTickets: r + 1, buyerPk: BUYER1_PK}));
    const redeem = redeemForState({
      stage: STAGE.S_OPEN,
      version: KUSDT_V2_VERSION,
      managerCid: MGR_CID,
      firstBuyerPk: BUYER1_PK,
      price,
      records,
    }, v2Profile);
    const spk = p2sh(hex(blake2b256(redeem)));
    return {
      shardCid: scid,
      stage: STAGE.S_OPEN,
      terminal: false,
      firstBuyerPk: BUYER1_PK,
      tickets: recordCount,
      recordCount,
      records,
      redeem,
      spk,
      outpoint: {transactionId: keyHex(`cap-sh-tx-${idx}`), index: 1},
      value: 200_000_000n,
      daaScore: 700_000_000n,
    };
  };

  const eightOpen = Array.from({length: 8}, (_, i) => mkShardEntry(i, 2));
  const mgrRedeem = redeemForState({
    stage: STAGE.M_OPEN,
    version: KUSDT_V2_VERSION,
    creatorPk: CREATOR_PK,
    price,
    closeDaa: 700_005_000n,
    openedCount: 8,
    cursor: 0,
    totalTickets: 0,
    entries: eightOpen.map(s => ({shardCid: s.shardCid, tickets: 0})),
  }, v2Profile);
  const mgrSpk = p2sh(hex(blake2b256(mgrRedeem)));
  const mgrOutpoint = {transactionId: keyHex('cap-mgr-tx'), index: 0};
  const capOrigin = {transactionId: keyHex('cap-origin'), index: 0};
  const capEmptyRedeem = redeemForState({
    stage: STAGE.M_OPEN, version: KUSDT_V2_VERSION, creatorPk: CREATOR_PK,
    price, closeDaa: 700_005_000n, openedCount: 0, cursor: 0, totalTickets: 0, entries: [],
  }, v2Profile);
  const capCid = covenantId(capOrigin, [{index: 0, value: 400_000_000n, spk: p2sh(hex(blake2b256(capEmptyRedeem)))}]);
  const baseRound = {
    cid: capCid,
    origin: capOrigin,
    profileId: v2Profile.id,
    terminal: null,
    halted: null,
    intent: null,
    manager: {outpoint: mgrOutpoint, value: 400_000_000n, spk: mgrSpk, utxoDaa: 700_000_000n, redeemScript: mgrRedeem},
    settings: {ticketPrice: price, closeEligibleDaa: 700_005_000n, closeDaa: 700_005_000n, creatorPk: CREATOR_PK},
    kusdt: {stage: STAGE.M_OPEN, price, closeDaa: 700_005_000n, openedCount: 8, cursor: 0, totalTickets: 16, decision: 0, creatorPk: CREATOR_PK, winnerPk: null, nodeVerified: true, shards: eightOpen},
  };

  let rpcCalls = 0;
  const spyRpc = {
    url: 'ws://mainnet.test',
    async currentDaa() { return 700_000_100n; },
    async call(method, params) {
      rpcCalls++;
      if (method === 'getUtxosByAddresses') {
        const entries = [];
        for (const a of params.addresses ?? []) {
          if (a === spkToAddress(mgrSpk, MAINNET.addressPrefix)) {
            entries.push({
              address: a,
              outpoint: mgrOutpoint,
              utxoEntry: {amount: '400000000', scriptPublicKey: `0000${mgrSpk.script}`, blockDaaScore: '700000000', isCoinbase: false, covenantId: capCid},
            });
          } else if (a === wallet.address) {
            entries.push({
              address: a,
              outpoint: {transactionId: keyHex('cap-kas'), index: 0},
              utxoEntry: {amount: '1000000000', scriptPublicKey: `0000${wallet.spk.script}`, blockDaaScore: '700000000', isCoinbase: false},
            });
          }
        }
        return {entries};
      }
      if (method === 'getMempoolEntriesByAddresses') return {entries: []};
      throw new Error(`unexpected rpc ${method}`);
    },
  };

  // 1. With 8 buyable open shards, OPEN_SHARD (no shardCid) MUST fail fast with USER / MAX_ACTIVE_SHARDS and 0 RPC calls!
  await assert.rejects(
    () => adapter.prepareForController({rpc: spyRpc, round: baseRound, choice: {action: 'BUY', quantity: 1}, wallet, feerate: 1, net: MAINNET}),
    e => e?.code === 'USER' && e?.safeCode === 'MAX_ACTIVE_SHARDS' && /上限 8 个/.test(e.message),
  );
  assert.equal(rpcCalls, 0);

  // 2. Once 1 of the 8 shards fills to 256 records, only 7 buyable open shards remain:
  //    - targeting the full 256-record shard directly rejects with USER / SHARD_FULL
  //    - opening a new shard (OPEN_SHARD) is allowed again!
  const sevenPlusOneFull = [mkShardEntry(0, MAX_RECORDS_PER_SHARD), ...eightOpen.slice(1)];
  assert.equal(sevenPlusOneFull.filter(isBuyableOpenShard).length, 7);
  assert.equal(isMutableStandaloneShard(sevenPlusOneFull[0]), false);
  assert.equal(isMutableStandaloneShard(sevenPlusOneFull[1]), true);
  const round7Active = {...baseRound, kusdt: {...baseRound.kusdt, shards: sevenPlusOneFull}};

  await assert.rejects(
    () => adapter.prepareForController({rpc: spyRpc, round: round7Active, choice: {action: 'BUY', quantity: 1, shardCid: sevenPlusOneFull[0].shardCid}, wallet, feerate: 1, net: MAINNET}),
    e => e?.code === 'USER' && e?.safeCode === 'SHARD_FULL',
  );
  assert.equal(rpcCalls, 0);

  const buyerKcc20 = kcc20RedeemAndSpk({
    amount: 5_000_000n,
    owner: wallet.key,
    ownerScheme: KCC20_OWNER_SCHEME.P2PK_SCHNORR,
    borrowScheme: 1,
  }, KCC20_SUFFIX);
  const buyerKcc20Addr = spkToAddress(buyerKcc20.scriptPubKey, MAINNET.addressPrefix);
  const fakeFetcher = async url => {
    if (String(url).includes('kascov.io')) {
      return new Response(JSON.stringify({
        network: 'mainnet',
        token_id: MAINNET_KUSDT_CID,
        owner: `00${wallet.key}`,
        cells: [{is_minter: false, outpoint: `${keyHex('cap-kcc20')}:0`, program_hex: hex(buyerKcc20.redeem)}],
      }), {status: 200});
    }
    return new Response(JSON.stringify({}), {status: 404});
  };
  const openRpc = {
    ...spyRpc,
    async call(method, params) {
      if (method === 'getUtxosByAddresses' && params.addresses?.includes(buyerKcc20Addr)) {
        return {
          entries: [{
            address: buyerKcc20Addr,
            outpoint: {transactionId: keyHex('cap-kcc20'), index: 0},
            utxoEntry: {amount: '200000000', scriptPublicKey: `0000${buyerKcc20.scriptPubKey.script}`, blockDaaScore: '700000000', isCoinbase: false, covenantId: MAINNET_KUSDT_CID},
          }],
        };
      }
      return spyRpc.call(method, params);
    },
  };
  const opened = await adapter.prepareForController({
    rpc: openRpc,
    round: round7Active,
    choice: {action: 'BUY', quantity: 1},
    wallet,
    feerate: 1,
    net: MAINNET,
    fetcher: fakeFetcher,
  });
  assert.equal(opened.kusdtAction, 'OPEN_SHARD');
  const openMgrOut = opened.review.outputs.find(o => o.role === 'MANAGER');
  const openShardOut = opened.review.outputs.find(o => o.role === 'SHARD_DEPOSIT');
  const openVaultOut = opened.review.outputs.find(o => o.role === 'VAULT_DEPOSIT');
  const openTokChg = opened.review.outputs.find(o => o.role === 'TOKEN_CHANGE');
  assert.equal(openMgrOut?.rollover, true);
  assert.match(openMgrOut?.note ?? '', /创建者押金，非你支出/);
  assert.equal(openShardOut?.rollover, false);
  assert.equal(openVaultOut?.rollover, false);
  assert.equal(openVaultOut?.tokenAmount, 1_000_000n);
  assert.equal(openTokChg?.mine, true);
  assert.equal(openTokChg?.tokenAmount, 4_000_000n);
});

test('kusdt-v2 syncRound & watchTargets skip full 256-record S_OPEN and S_FROZEN shards and batch mutable shard probes into 1 RPC', async () => {
  const v2Profile = loadKusdtV2Profile(loadArtifacts());
  const adapter = createKusdtV2Adapter({profile: v2Profile, kcc20Suffix: KCC20_SUFFIX});
  const price = 1_000_000n;
  const prefix = MAINNET.addressPrefix;

  const mkShard = (idx, stage, recordCount, terminal = false) => {
    const scid = keyHex(`batch-sh-${stage}-${idx}`);
    const firstBuyerPk = keyHex(`batch-buyer-${stage}-${idx}`);
    let redeem;
    let records = null;
    if (stage === STAGE.S_OPEN || stage === STAGE.S_FROZEN) {
      records = Array.from({length: recordCount}, (_, r) => ({cumTickets: r + 1, buyerPk: firstBuyerPk}));
      redeem = redeemForState({stage, version: KUSDT_V2_VERSION, managerCid: MGR_CID, firstBuyerPk, price, records}, v2Profile);
    } else if (stage === STAGE.S_PAYOUT) {
      redeem = redeemForState({stage, version: KUSDT_V2_VERSION, firstBuyerPk, winnerPk: BUYER2_PK, vaultAmount: BigInt(recordCount) * price, managerCid: MGR_CID, shardTickets: recordCount}, v2Profile);
    } else {
      records = Array.from({length: recordCount}, (_, r) => ({cumTickets: r + 1, buyerPk: firstBuyerPk}));
      redeem = redeemForState({stage: STAGE.S_REFUND, version: KUSDT_V2_VERSION, firstBuyerPk, price, claimedMask: 0, records}, v2Profile);
    }
    const spk = p2sh(hex(blake2b256(redeem)));
    const outpoint = {transactionId: keyHex(`batch-op-${stage}-${idx}`), index: 1};
    return {
      shardCid: scid, stage, terminal, firstBuyerPk,
      tickets: recordCount, recordCount, records, redeem, spk, outpoint,
      value: 200_000_000n, daaScore: 700_000_000n,
      ...(stage === STAGE.S_PAYOUT ? {winnerPk: BUYER2_PK, vaultAmount: BigInt(recordCount) * price} : {}),
    };
  };

  // Case 1: M_OPEN with 4 full (256-record) S_OPEN + 8 buyable (1-record) S_OPEN shards
  const fullShards = Array.from({length: 4}, (_, i) => mkShard(i, STAGE.S_OPEN, MAX_RECORDS_PER_SHARD));
  const openShards = Array.from({length: 8}, (_, i) => mkShard(i + 4, STAGE.S_OPEN, 1));
  const allOpen = [...fullShards, ...openShards];
  const mgrOpenRedeem = redeemForState({
    stage: STAGE.M_OPEN, version: KUSDT_V2_VERSION, creatorPk: CREATOR_PK, price,
    closeDaa: 700_005_000n, openedCount: 12, cursor: 0, totalTickets: 0,
    entries: allOpen.map(s => ({shardCid: s.shardCid, tickets: 0})),
  }, v2Profile);
  const mgrOpenSpk = p2sh(hex(blake2b256(mgrOpenRedeem)));
  const mgrOpenAddr = spkToAddress(mgrOpenSpk, prefix);
  const mgrOpenOut = {transactionId: keyHex('batch-mgr-open'), index: 0};

  const liveByAddr = new Map();
  const putLive = (spk, outpoint, cid, value = 200_000_000n) => {
    const addr = spkToAddress(spk, prefix);
    const arr = liveByAddr.get(addr) ?? [];
    arr.push({
      address: addr, outpoint,
      utxoEntry: {amount: value.toString(), scriptPublicKey: `0000${spk.script}`, blockDaaScore: '700000000', isCoinbase: false, covenantId: cid},
    });
    liveByAddr.set(addr, arr);
  };
  putLive(mgrOpenSpk, mgrOpenOut, MGR_CID, 400_000_000n);
  for (const s of allOpen) putLive(s.spk, s.outpoint, s.shardCid);

  const calls = [];
  const makeSpyRpc = () => ({
    url: 'ws://mainnet.test',
    async currentDaa() { return 700_000_100n; },
    async call(method, params) {
      if (method === 'getUtxosByAddresses') {
        calls.push([...(params.addresses ?? [])]);
        const entries = [];
        for (const a of params.addresses ?? []) entries.push(...(liveByAddr.get(a) ?? []));
        return {entries};
      }
      throw new Error(`unexpected rpc ${method}`);
    },
  });

  const roundOpen = {
    cid: MGR_CID, profileId: v2Profile.id, terminal: null, halted: null, intent: null, step: 12,
    manager: {outpoint: mgrOpenOut, value: 400_000_000n, spk: mgrOpenSpk, utxoDaa: 700_000_000n, redeemScript: mgrOpenRedeem},
    settings: {ticketPrice: price, closeEligibleDaa: 700_005_000n, closeDaa: 700_005_000n, creatorPk: CREATOR_PK},
    kusdt: {stage: STAGE.M_OPEN, price, closeDaa: 700_005_000n, openedCount: 12, cursor: 0, totalTickets: 0, decision: 0, creatorPk: CREATOR_PK, winnerPk: null, nodeVerified: false, shards: allOpen},
  };

  // Watch targets include Manager + 8 buyable shards, and EXCLUDE all 4 full 256-record shards!
  const wtOpen = kusdtV2WatchTargets(roundOpen, prefix);
  assert.equal(wtOpen.addresses.length, 9);
  assert.equal(wtOpen.addresses[0], mgrOpenAddr);
  for (const fs of fullShards) assert.ok(!wtOpen.addresses.includes(spkToAddress(fs.spk, prefix)));
  for (const os of openShards) assert.ok(wtOpen.addresses.includes(spkToAddress(os.spk, prefix)));

  const syncedOpen = await adapter.syncRound({rpc: makeSpyRpc(), round: roundOpen, net: MAINNET});
  assert.equal(syncedOpen.round.kusdt.nodeVerified, true);
  // 1 call for Manager + 1 single batched call for the 8 buyable shards (0 calls for the 4 full 256-record shards!)
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], [mgrOpenAddr]);
  assert.equal(calls[1].length, 8);
  for (const fs of fullShards) assert.ok(!calls[1].includes(spkToAddress(fs.spk, prefix)));

  // Case 2: M_SEALED with 12 S_FROZEN shards -> ONLY 1 RPC call (Manager only, 0 shard calls!)
  calls.length = 0;
  const frozenShards = Array.from({length: 12}, (_, i) => mkShard(i, STAGE.S_FROZEN, 5));
  const mgrSealedRedeem = redeemForState({
    stage: STAGE.M_SEALED, version: KUSDT_V2_VERSION, creatorPk: CREATOR_PK, price,
    closeDaa: 700_005_000n, openedCount: 12, cursor: 12, totalTickets: 60,
    entries: frozenShards.map((s, i) => ({shardCid: s.shardCid, tickets: (i + 1) * 5})),
  }, v2Profile);
  const mgrSealedSpk = p2sh(hex(blake2b256(mgrSealedRedeem)));
  const mgrSealedAddr = spkToAddress(mgrSealedSpk, prefix);
  const mgrSealedOut = {transactionId: keyHex('batch-mgr-sealed'), index: 0};
  putLive(mgrSealedSpk, mgrSealedOut, MGR_CID, 400_000_000n);
  const roundSealed = {
    ...roundOpen,
    manager: {outpoint: mgrSealedOut, value: 400_000_000n, spk: mgrSealedSpk, utxoDaa: 700_005_010n, redeemScript: mgrSealedRedeem},
    kusdt: {...roundOpen.kusdt, stage: STAGE.M_SEALED, cursor: 12, totalTickets: 60, shards: frozenShards},
  };
  const wtSealed = kusdtV2WatchTargets(roundSealed, prefix);
  assert.deepEqual(wtSealed.addresses, [mgrSealedAddr]);
  const syncedSealed = await adapter.syncRound({rpc: makeSpyRpc(), round: roundSealed, net: MAINNET});
  assert.equal(syncedSealed.round.kusdt.nodeVerified, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [mgrSealedAddr]);

  // Case 3: Post-DISPATCH_BATCH (!manager) with 2 terminal + 10 live S_PAYOUT shards -> 1 single batched RPC call!
  calls.length = 0;
  const payoutLive = Array.from({length: 10}, (_, i) => mkShard(i, STAGE.S_PAYOUT, 3, false));
  const payoutDone = Array.from({length: 2}, (_, i) => mkShard(i + 10, STAGE.S_PAYOUT, 3, true));
  for (const s of payoutLive) putLive(s.spk, s.outpoint, s.shardCid);
  const roundPostDispatch = {
    ...roundOpen,
    manager: null,
    kusdt: {...roundOpen.kusdt, stage: STAGE.M_DISPATCH, decision: DECISION.PAYOUT, winnerPk: BUYER2_PK, shards: [...payoutDone, ...payoutLive]},
  };
  const wtSettle = kusdtV2WatchTargets(roundPostDispatch, prefix);
  assert.equal(wtSettle.addresses.length, 10);
  const syncedSettle = await adapter.syncRound({rpc: makeSpyRpc(), round: roundPostDispatch, net: MAINNET});
  assert.equal(syncedSettle.round.kusdt.nodeVerified, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 10);
});

test('controller.watchRound subscribes kusdt-v2 Manager + mutable open shards, excludes full shards, and diffs subscriptions cleanly', async () => {
  const v2Profile = loadKusdtV2Profile(loadArtifacts());
  const adapter = createKusdtV2Adapter({profile: v2Profile, kcc20Suffix: KCC20_SUFFIX});
  const price = 1_000_000n;
  const prefix = MAINNET.addressPrefix;

  const mkOpen = (label, rc) => {
    const scid = keyHex(label);
    const records = Array.from({length: rc}, (_, r) => ({cumTickets: r + 1, buyerPk: BUYER1_PK}));
    const redeem = redeemForState({stage: STAGE.S_OPEN, version: KUSDT_V2_VERSION, managerCid: MGR_CID, firstBuyerPk: BUYER1_PK, price, records}, v2Profile);
    const spk = p2sh(hex(blake2b256(redeem)));
    return {shardCid: scid, stage: STAGE.S_OPEN, terminal: false, firstBuyerPk: BUYER1_PK, tickets: rc, recordCount: rc, records, redeem, spk, outpoint: {transactionId: keyHex(`tx-${label}`), index: 1}, value: 200_000_000n, daaScore: 700_000_000n};
  };
  const fullSh = mkOpen('watch-full', MAX_RECORDS_PER_SHARD);
  const activeSh = mkOpen('watch-active', 1);
  const mgrRedeem = redeemForState({
    stage: STAGE.M_OPEN, version: KUSDT_V2_VERSION, creatorPk: CREATOR_PK, price,
    closeDaa: 700_005_000n, openedCount: 2, cursor: 0, totalTickets: 0,
    entries: [{shardCid: fullSh.shardCid, tickets: 0}, {shardCid: activeSh.shardCid, tickets: 0}],
  }, v2Profile);
  const mgrSpk = p2sh(hex(blake2b256(mgrRedeem)));
  const mgrAddr = spkToAddress(mgrSpk, prefix);
  const activeAddr = spkToAddress(activeSh.spk, prefix);
  const fullAddr = spkToAddress(fullSh.spk, prefix);

  const subscribed = new Set();
  const listeners = new Map();
  const fakeRpc = {
    url: 'ws://mainnet.test',
    async currentDaa() { return 700_000_100n; },
    on(kind, fn) {
      if (!listeners.has(kind)) listeners.set(kind, new Set());
      listeners.get(kind).add(fn);
      return () => listeners.get(kind)?.delete(fn);
    },
    async subscribe(addrs, enabled = true) {
      for (const a of addrs) {
        if (enabled) subscribed.add(a);
        else subscribed.delete(a);
      }
    },
    async call() { return {entries: []}; },
    close() {},
  };

  const backing = new MemoryStore();
  backing.persistent = true;
  const store = new RoundStore(backing, {genesis: MAINNET.genesis, profileId: rollingProfile.id});
  const round = {
    cid: MGR_CID, profileId: v2Profile.id, source: 'indexed', terminal: null, halted: null, intent: null, step: 2,
    manager: {outpoint: {transactionId: keyHex('watch-mgr'), index: 0}, value: 400_000_000n, spk: mgrSpk, utxoDaa: 700_000_000n, redeemScript: mgrRedeem},
    frozen: [], receipts: [], pending: [], fees: 0n,
    settings: {ticketPrice: price, ticketCap: 65536, minTickets: 3, closeEligibleDaa: 700_005_000n, closeDaa: 700_005_000n, creatorPk: CREATOR_PK},
    bought: 257,
    kusdt: {stage: STAGE.M_OPEN, price, closeDaa: 700_005_000n, openedCount: 2, cursor: 0, totalTickets: 257, decision: 0, creatorPk: CREATOR_PK, winnerPk: null, nodeVerified: true, shards: [fullSh, activeSh]},
  };
  await store.create(round);

  const reg = createProtocolRegistry([createRollingV1Adapter({profile: rollingProfile}), adapter], {defaultCreateProfileId: rollingProfile.id});
  const ctl = createController({profile: rollingProfile, registry: reg, roundStore: store, net: MAINNET, connect: async () => fakeRpc});
  await ctl.connectNode(['ws://mainnet.test']);
  await ctl.watchRound(MGR_CID);

  assert.equal(ctl.state.watchedAddress, mgrAddr);
  assert.deepEqual([...subscribed].sort(), [mgrAddr, activeAddr].sort());
  assert.ok(!subscribed.has(fullAddr));

  // Once the active shard fills to 256 records, watchRound diff-unsubscribes activeAddr while keeping mgrAddr!
  const filledSh = {...activeSh, recordCount: MAX_RECORDS_PER_SHARD, tickets: MAX_RECORDS_PER_SHARD};
  await store.replace({...round, kusdt: {...round.kusdt, shards: [fullSh, filledSh]}}, 0);
  await ctl.watchRound(MGR_CID);
  assert.deepEqual([...subscribed], [mgrAddr]);
  assert.ok(!subscribed.has(activeAddr));

  await ctl.watchRound(null);
  assert.equal(subscribed.size, 0);
  ctl.close();
});

test('kusdt-v2 COLLECT_BATCH and DISPATCH_BATCH automatically step down k (8..1) on FEE_CAP under high feerate without masking non-resource errors', async () => {
  const v2Profile = loadKusdtV2Profile(loadArtifacts());
  const adapter = createKusdtV2Adapter({profile: v2Profile, kcc20Suffix: KCC20_SUFFIX});
  const price = 1_000_000n;
  const prefix = MAINNET.addressPrefix;
  const wallet = openMemoryWallet('11'.repeat(32), {prefix});

  const mkFullShard = (idx, stage) => {
    const scid = keyHex(`sd-sh-${stage}-${idx}`);
    const firstBuyerPk = keyHex(`sd-buyer-${stage}-${idx}`);
    const records = Array.from({length: MAX_RECORDS_PER_SHARD}, (_, r) => ({cumTickets: r + 1, buyerPk: firstBuyerPk}));
    const redeem = redeemForState({stage, version: KUSDT_V2_VERSION, managerCid: MGR_CID, firstBuyerPk, price, records}, v2Profile);
    const spk = p2sh(hex(blake2b256(redeem)));
    return {
      shardCid: scid, stage, terminal: false, firstBuyerPk,
      tickets: MAX_RECORDS_PER_SHARD, recordCount: MAX_RECORDS_PER_SHARD, records, redeem, spk,
      outpoint: {transactionId: keyHex(`sd-op-${stage}-${idx}`), index: 1},
      value: 200_000_000n, daaScore: 700_000_000n,
    };
  };

  const openShards = Array.from({length: 8}, (_, i) => mkFullShard(i, STAGE.S_OPEN));
  const mgrOpenRedeem = redeemForState({
    stage: STAGE.M_OPEN, version: KUSDT_V2_VERSION, creatorPk: CREATOR_PK, price,
    closeDaa: 700_005_000n, openedCount: 8, cursor: 0, totalTickets: 0,
    entries: openShards.map(s => ({shardCid: s.shardCid, ledgerHash: ZERO32, cumTickets: 0})),
  }, v2Profile);
  const mgrOpenSpk = p2sh(hex(blake2b256(mgrOpenRedeem)));
  const mgrOpenOut = {transactionId: keyHex('sd-mgr-open'), index: 0};

  const frozenShards = Array.from({length: 8}, (_, i) => mkFullShard(i, STAGE.S_FROZEN));
  const mgrDispRedeem = redeemForState({
    stage: STAGE.M_DISPATCH, version: KUSDT_V2_VERSION, creatorPk: CREATOR_PK, price,
    closeDaa: 700_005_000n, openedCount: 8, cursor: 0, totalTickets: 8 * MAX_RECORDS_PER_SHARD,
    decision: DECISION.PAYOUT, reserved: 0, winnerPk: BUYER2_PK,
    shardCids: frozenShards.map(s => s.shardCid),
  }, v2Profile);
  const mgrDispSpk = p2sh(hex(blake2b256(mgrDispRedeem)));
  const mgrDispOut = {transactionId: keyHex('sd-mgr-disp'), index: 0};

  const allMockShards = new Map([...openShards, ...frozenShards].map(s => [spkToAddress(s.spk, prefix), s]));
  const makeRpc = (mgrSpk, mgrOut) => ({
    url: 'ws://mainnet.test',
    async currentDaa() { return 700_006_000n; },
    async call(method, params) {
      if (method === 'getUtxosByAddresses') {
        const entries = [];
        for (const a of params.addresses ?? []) {
          if (a === spkToAddress(mgrSpk, prefix)) {
            entries.push({address: a, outpoint: mgrOut, utxoEntry: {amount: '400000000', scriptPublicKey: `0000${mgrSpk.script}`, blockDaaScore: '700000000', isCoinbase: false, covenantId: MGR_CID}});
          } else if (a === wallet.address) {
            entries.push({address: a, outpoint: {transactionId: keyHex('sd-kas'), index: 0}, utxoEntry: {amount: '5000000000', scriptPublicKey: `0000${wallet.spk.script}`, blockDaaScore: '700000000', isCoinbase: false}});
          } else if (allMockShards.has(a)) {
            const s = allMockShards.get(a);
            entries.push({address: a, outpoint: s.outpoint, utxoEntry: {amount: String(s.value), scriptPublicKey: `0000${s.spk.script}`, blockDaaScore: String(s.daaScore), isCoinbase: false, covenantId: s.shardCid}});
          }
        }
        return {entries};
      }
      if (method === 'getMempoolEntriesByAddresses') return {entries: []};
      throw new Error(`unexpected rpc ${method}`);
    },
  });

  const roundOpen = {
    cid: MGR_CID, origin: {transactionId: keyHex('sd-origin'), index: 0}, profileId: v2Profile.id, terminal: null, halted: null, intent: null,
    manager: {outpoint: mgrOpenOut, value: 400_000_000n, spk: mgrOpenSpk, utxoDaa: 700_000_000n, redeemScript: mgrOpenRedeem},
    settings: {ticketPrice: price, closeEligibleDaa: 700_005_000n, closeDaa: 700_005_000n, creatorPk: CREATOR_PK},
    kusdt: {stage: STAGE.M_OPEN, price, closeDaa: 700_005_000n, openedCount: 8, cursor: 0, totalTickets: 0, decision: 0, creatorPk: CREATOR_PK, winnerPk: null, nodeVerified: true, shards: openShards},
  };
  const roundDisp = {
    cid: MGR_CID, profileId: v2Profile.id, terminal: null, halted: null, intent: null,
    manager: {outpoint: mgrDispOut, value: 400_000_000n, spk: mgrDispSpk, utxoDaa: 700_006_000n, redeemScript: mgrDispRedeem},
    settings: {ticketPrice: price, closeEligibleDaa: 700_005_000n, closeDaa: 700_005_000n, creatorPk: CREATOR_PK},
    kusdt: {stage: STAGE.M_DISPATCH, price, closeDaa: 700_005_000n, openedCount: 8, cursor: 0, totalTickets: 8 * MAX_RECORDS_PER_SHARD, decision: DECISION.PAYOUT, creatorPk: CREATOR_PK, winnerPk: BUYER2_PK, nodeVerified: true, shards: frozenShards},
  };

  // 1) Normal mainnet feerate=100 -> full k=8 succeeds for BOTH COLLECT_BATCH & DISPATCH_BATCH
  const cNorm = await adapter.prepareForController({rpc: makeRpc(mgrOpenSpk, mgrOpenOut), round: roundOpen, choice: {action: 'CLOSE'}, wallet, feerate: '100', net: MAINNET});
  assert.equal(cNorm.targetCount, 8);
  assert.ok(cNorm.fee <= FEE_CAP);
  assert.equal(cNorm.review.outputs[0].role, 'MANAGER');
  assert.equal(cNorm.review.outputs[0].rollover, true);
  assert.equal(cNorm.review.outputs[1].role, 'FROZEN');
  assert.equal(cNorm.review.outputs[1].rollover, true);
  const dNorm = await adapter.prepareForController({rpc: makeRpc(mgrDispSpk, mgrDispOut), round: roundDisp, choice: {action: 'PAY_OLD'}, wallet, feerate: '100', net: MAINNET});
  assert.equal(dNorm.targetCount, 8);
  assert.ok(dNorm.fee <= FEE_CAP);

  // 2) Congested mainnet feerate=260 (where k=8 exceeds FEE_CAP=0.50 KAS!) -> steps down cleanly and fits under FEE_CAP!
  const cHigh = await adapter.prepareForController({rpc: makeRpc(mgrOpenSpk, mgrOpenOut), round: roundOpen, choice: {action: 'CLOSE'}, wallet, feerate: '260', net: MAINNET});
  assert.ok(cHigh.targetCount >= 1 && cHigh.targetCount < 8, `expected step-down k<8, got ${cHigh.targetCount}`);
  assert.equal(cHigh.shardStates.length, cHigh.targetCount);
  assert.ok(cHigh.fee <= FEE_CAP);

  const dHigh = await adapter.prepareForController({rpc: makeRpc(mgrDispSpk, mgrDispOut), round: roundDisp, choice: {action: 'PAY_OLD'}, wallet, feerate: '260', net: MAINNET});
  assert.ok(dHigh.targetCount >= 1 && dHigh.targetCount < 8, `expected step-down k<8, got ${dHigh.targetCount}`);
  assert.equal(dHigh.shardStates.length, dHigh.targetCount);
  assert.ok(dHigh.fee <= FEE_CAP);

  // 3) Extreme feerate where even k=1 exceeds FEE_CAP -> throws FEE_CAP
  await assert.rejects(
    () => adapter.prepareForController({rpc: makeRpc(mgrOpenSpk, mgrOpenOut), round: roundOpen, choice: {action: 'CLOSE'}, wallet, feerate: '10000', net: MAINNET}),
    e => e?.code === 'FEE_CAP' || e?.message === 'FEE_CAP',
  );

  // 4) Non-resource error (e.g. KUSDT_V2_INSUFFICIENT_KAS) rethrows immediately on first attempt without stepping down!
  let attempts = 0;
  assert.throws(
    () => prepareBatchWithStepDown([1, 2, 3], () => { attempts++; throw new Error('KUSDT_V2_INSUFFICIENT_KAS'); }),
    /KUSDT_V2_INSUFFICIENT_KAS/,
  );
  assert.equal(attempts, 1);

  wallet.close();
});

test('Batch-1 audit fixes: C-01 off-chain genesis root, C-02 submissionAttempted, H-01 bounds, H-02 recover order, H-03 KCI terminal guard, H-05 round schema, H-06 conflict & contiguous batch', async () => {
  const v2Profile = loadKusdtV2Profile(loadArtifacts());
  const adapter = createKusdtV2Adapter({profile: v2Profile, kcc20Suffix: KCC20_SUFFIX});
  const prefix = MAINNET.addressPrefix;
  const wallet = openMemoryWallet('22'.repeat(32), {prefix});
  const price = 1_000_000n;
  const closeDaa = 700_005_000n;

  // 1) H-01: price > PRICE_MAX and closeDaa >= CLOSE_DAA_MAX rejected in codec & builder
  assert.throws(() => encodeManagerOpenOrSealedState({
    stage: STAGE.M_OPEN, version: KUSDT_V2_VERSION, creatorPk: wallet.key,
    price: PRICE_MAX + 1n, closeDaa, openedCount: 0, cursor: 0, totalTickets: 0, decision: 0, reserved: 0, entries: [],
  }), /KUSDT_V2_PRICE_MAX/);
  assert.throws(() => encodeManagerOpenOrSealedState({
    stage: STAGE.M_OPEN, version: KUSDT_V2_VERSION, creatorPk: wallet.key,
    price, closeDaa: CLOSE_DAA_MAX, openedCount: 0, cursor: 0, totalTickets: 0, decision: 0, reserved: 0, entries: [],
  }), /KUSDT_V2_CLOSE_DAA/);

  // 2) C-01 off-chain: canonical empty M_OPEN genesis root passes, pre-seeded evil shard genesis M_OPEN fails & blocks BUY
  const origin = {transactionId: keyHex('audit-gen-in'), index: 0};
  const emptyRedeem = redeemForState({
    stage: STAGE.M_OPEN, version: KUSDT_V2_VERSION, creatorPk: wallet.key,
    price, closeDaa, openedCount: 0, cursor: 0, totalTickets: 0, decision: 0, reserved: 0, entries: [],
  }, v2Profile);
  const emptySpk = p2sh(hex(blake2b256(emptyRedeem)));
  const canonicalCid = covenantId(origin, [{index: 0, value: 400_000_000n, spk: emptySpk}]);
  assert.equal(verifyKusdtV2GenesisRoot({cid: canonicalCid, origin, price, closeDaa, creatorPk: wallet.key, profile: v2Profile}), true);

  const evilShardCid = keyHex('evil-shard');
  const evilRedeem = redeemForState({
    stage: STAGE.M_OPEN, version: KUSDT_V2_VERSION, creatorPk: wallet.key,
    price, closeDaa, openedCount: 1, cursor: 0, totalTickets: 0, decision: 0, reserved: 0,
    entries: [{shardCid: evilShardCid, hash: '00'.repeat(32), cumTickets: 0}],
  }, v2Profile);
  const evilSpk = p2sh(hex(blake2b256(evilRedeem)));
  const evilCid = covenantId(origin, [{index: 0, value: 400_000_000n, spk: evilSpk}]);
  assert.throws(
    () => verifyKusdtV2GenesisRoot({cid: evilCid, origin, price, closeDaa, creatorPk: wallet.key, profile: v2Profile}),
    /KUSDT_V2_GENESIS_ROOT_MISMATCH/,
  );

  const evilRound = {
    cid: evilCid, profileId: v2Profile.id, origin, terminal: null, halted: null, intent: null,
    manager: {outpoint: {transactionId: keyHex('evil-mgr-tx'), index: 0}, value: 400_000_000n, spk: evilSpk, utxoDaa: 700_000_000n, redeemScript: evilRedeem},
    settings: {ticketPrice: price, closeDaa, closeEligibleDaa: closeDaa, creatorPk: wallet.key},
    kusdt: {stage: STAGE.M_OPEN, price, closeDaa, openedCount: 1, cursor: 0, totalTickets: 0, decision: 0, creatorPk: wallet.key, winnerPk: null, nodeVerified: false, shards: []},
  };
  const evilRpc = {
    async currentDaa() { return 700_000_100n; },
    async call(method, params) {
      if (method === 'getUtxosByAddresses') {
        const entries = [];
        for (const a of params.addresses ?? []) {
          if (a === spkToAddress(evilSpk, prefix)) entries.push({address: a, outpoint: evilRound.manager.outpoint, utxoEntry: {amount: '400000000', scriptPublicKey: `0000${evilSpk.script}`, blockDaaScore: '700000000', isCoinbase: false, covenantId: evilCid}});
          else if (a === wallet.address) entries.push({address: a, outpoint: {transactionId: keyHex('audit-kas'), index: 0}, utxoEntry: {amount: '1000000000', scriptPublicKey: `0000${wallet.spk.script}`, blockDaaScore: '700000000', isCoinbase: false}});
        }
        return {entries};
      }
      if (method === 'getMempoolEntriesByAddresses') return {entries: []};
      throw new Error(`unexpected ${method}`);
    },
  };
  await assert.rejects(
    () => adapter.prepareForController({rpc: evilRpc, round: evilRound, choice: {action: 'BUY', quantity: 1}, wallet, feerate: 1, net: MAINNET}),
    e => e?.code === 'USER' && e?.safeCode === 'KUSDT_V2_GENESIS_ROOT_MISMATCH',
  );

  // 3) C-02: submitIntent sets submissionAttempted=true via beforeSend barrier (timeout -> UNKNOWN, RpcError -> REJECTED, pre-send -> UNSENT)
  const dummyIntent = {
    action: 'BUY',
    txid: keyHex('sub-tx'),
    draft: {transaction: {version: 1, inputs: [], outputs: [], lockTime: 0n, subnetworkId: '00'.repeat(20), gas: 0n, payload: new Uint8Array()}},
  };
  const rpcTimeout = {
    async currentDaa() { return 700_000_100n; },
    async call(_m, _p, _t, opts) {
      opts?.beforeSend?.();
      throw Object.assign(new Error('RPC_TIMEOUT'), {code: 'RPC_TIMEOUT'});
    },
  };
  await assert.rejects(() => adapter.submitIntent(rpcTimeout, dummyIntent), e => e?.submissionAttempted === true && statusAfterFailure(e) === 'UNKNOWN');

  const rpcReject = {
    async currentDaa() { return 700_000_100n; },
    async call(_m, _p, _t, opts) {
      opts?.beforeSend?.();
      throw new RpcError('submitTransaction', 'Rejected transaction: double spend');
    },
  };
  await assert.rejects(() => adapter.submitIntent(rpcReject, dummyIntent), e => e?.submissionAttempted === true && statusAfterFailure(e) === 'REJECTED');

  await assert.rejects(
    () => adapter.submitIntent(rpcTimeout, dummyIntent, {beforeSend: () => { throw new Error('WALLET_CHANGED'); }}),
    e => e?.submissionAttempted === false && statusAfterFailure(e) === 'UNSENT',
  );

  // 4) H-02: trackRoundIntent({recover: true}) checks output confirmation BEFORE probing inputs
  const confTxid = keyHex('conf-gen-tx');
  const confRound = {
    cid: canonicalCid, profileId: v2Profile.id, origin, terminal: null, halted: null,
    manager: {outpoint: {transactionId: confTxid, index: 0}, value: 400_000_000n, spk: emptySpk, utxoDaa: 0n, redeemScript: emptyRedeem},
    receipts: [{action: 'GENESIS', txid: confTxid, feeSompi: '10000', finalized: false}],
    settings: {ticketPrice: price, closeDaa, closeEligibleDaa: closeDaa, creatorPk: wallet.key},
    kusdt: {stage: STAGE.M_OPEN, price, closeDaa, openedCount: 0, cursor: 0, totalTickets: 0, decision: 0, creatorPk: wallet.key, winnerPk: null, nodeVerified: false, shards: []},
    intent: {
      status: 'UNKNOWN', action: 'GENESIS', txid: confTxid, profileId: v2Profile.id,
      draft: {
        fee: 10000n,
        inputUtxos: [{outpoint: origin, spk: wallet.spk, value: 500_000_000n}],
        transaction: {version: 1, inputs: [], outputs: [{value: 400_000_000n, scriptPublicKey: emptySpk}], lockTime: 0n, subnetworkId: '00'.repeat(20), gas: 0n, payload: new Uint8Array()},
      },
    },
  };
  const confRpc = {
    async call(method, params) {
      if (method === 'getUtxosByAddresses') {
        const entries = [];
        for (const a of params.addresses ?? []) {
          if (a === spkToAddress(emptySpk, prefix)) {
            entries.push({address: a, outpoint: {transactionId: confTxid, index: 0}, utxoEntry: {amount: '400000000', scriptPublicKey: `0000${emptySpk.script}`, blockDaaScore: '700000100', isCoinbase: false, covenantId: canonicalCid}});
          }
          // Notice wallet origin input is already SPENT (empty) — old recover code wrongly marked REJECTED!
        }
        return {entries};
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const recovRes = await adapter.trackRoundIntent({rpc: confRpc, round: confRound, recover: true, net: MAINNET});
  assert.equal(recovRes.accepted, true);
  assert.equal(recovRes.round.intent, null);
  assert.equal(recovRes.round.kusdt.nodeVerified, true);

  // 5) H-03: syncRound refuses lying KCI det.terminal='PAID' when shard UTXO is still live on node
  const liveShCid = keyHex('h03-shard');
  const liveShRedeem = redeemForState({
    stage: STAGE.S_PAYOUT, version: KUSDT_V2_VERSION, managerCid: canonicalCid,
    firstBuyerPk: wallet.key, winnerPk: wallet.key, shardTickets: 3, vaultAmount: 3_000_000n,
  }, v2Profile);
  const liveShSpk = p2sh(hex(blake2b256(liveShRedeem)));
  const liveShOut = {transactionId: keyHex('h03-sh-tx'), index: 0};
  const lyingIndexer = {
    async roundDetail() {
      return {
        cid: canonicalCid, terminal: 'PAID', origin,
        shards: {[liveShCid]: {shardCid: liveShCid, stage: 'S_PAYOUT', outpoint: liveShOut, value: '200000000', spk: liveShSpk, utxoDaa: '700000500', redeemHex: hex(liveShRedeem), terminal: true}},
        summary: {protocolId: 'kusdt-v2', profileId: v2Profile.id, phase: 'DONE', subPhase: 'PAID', terminal: 'PAID', ticketsSold: 3, ticketPrice: '1000000',
          protocolData: {openedCount: 1, cursor: 1, closeDaa: String(closeDaa), creatorPk: wallet.key, winnerPk: wallet.key, shards: [{shardCid: liveShCid, terminal: true, tickets: 3}]}},
      };
    },
  };
  const liveShardRpc = {
    async call(method, params) {
      if (method === 'getUtxosByAddresses') {
        const entries = [];
        for (const a of params.addresses ?? []) {
          if (a === spkToAddress(liveShSpk, prefix)) {
            entries.push({address: a, outpoint: liveShOut, utxoEntry: {amount: '200000000', scriptPublicKey: `0000${liveShSpk.script}`, blockDaaScore: '700000500', isCoinbase: false, covenantId: liveShCid}});
          }
        }
        return {entries};
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const syncedH03 = await adapter.syncRound({rpc: liveShardRpc, indexer: lyingIndexer, cid: canonicalCid, net: MAINNET});
  assert.equal(syncedH03.round.terminal, null, 'must reject KCI terminal when shard is still live on node');
  assert.equal(syncedH03.round.kusdt.shards[0].terminal, false);

  // 6) H-05: runtime kusdt-v2 round (manager.redeemScript + kusdt.shards) round-trips via roundToText/roundFromText (stripping intent/pending) & toRoundSummary/availableActions
  const rtRound = {
    cid: canonicalCid, profileId: v2Profile.id, origin, terminal: null, halted: null,
    intent: {status: 'SUBMITTED', action: 'BUY', txid: keyHex('fake-int')},
    pending: [{txid: keyHex('fake-pend')}],
    manager: {outpoint: {transactionId: confTxid, index: 0}, value: 400_000_000n, spk: emptySpk, utxoDaa: 700_000_000n, redeemScript: emptyRedeem},
    receipts: [], fees: 10_000n,
    settings: {ticketPrice: price, closeDaa, closeEligibleDaa: closeDaa, creatorPk: wallet.key},
    kusdt: {stage: STAGE.M_OPEN, price, closeDaa, openedCount: 0, cursor: 0, totalTickets: 0, decision: 0, creatorPk: wallet.key, winnerPk: null, nodeVerified: true, shards: []},
  };
  const parsedRt = adapter.roundFromText(adapter.roundToText(rtRound));
  assert.equal(parsedRt.cid, canonicalCid);
  assert.equal(parsedRt.intent, null, 'share/import must strip transient intent');
  assert.deepEqual(parsedRt.pending, []);
  assert.equal(parsedRt.settings.ticketPrice, price);
  assert.ok(parsedRt.manager.redeemScript instanceof Uint8Array);
  assert.ok(adapter.availableActions(parsedRt, 700_000_100n).includes('OPEN_SHARD'));
  assert.equal(adapter.toRoundSummary(parsedRt).phase, 'OPEN');

  // 6b) C-01 rogue shard injection: BUY targeting a shardCid NOT in live M_OPEN.entries MUST be rejected!
  const rogueShardCid = keyHex('rogue-shard');
  const rogueShRedeem = redeemForState({
    stage: STAGE.S_OPEN, version: KUSDT_V2_VERSION, managerCid: canonicalCid,
    firstBuyerPk: wallet.key, price, records: [{cumTickets: 1, buyerPk: wallet.key}],
  }, v2Profile);
  const rogueShSpk = p2sh(hex(blake2b256(rogueShRedeem)));
  const rogueRound = {
    ...rtRound,
    intent: null,
    pending: [],
    kusdt: {
      ...rtRound.kusdt,
      shards: [{shardCid: rogueShardCid, stage: STAGE.S_OPEN, terminal: false, outpoint: {transactionId: keyHex('rogue-tx'), index: 0}, value: 200_000_000n, spk: rogueShSpk, daaScore: 700_000_050n, redeem: rogueShRedeem, recordCount: 1, tickets: 1}],
    },
  };
  const rogueRpc = {
    async currentDaa() { return 700_000_100n; },
    async call(method, params) {
      if (method === 'getUtxosByAddresses') {
        const entries = [];
        for (const a of params.addresses ?? []) {
          if (a === spkToAddress(emptySpk, prefix)) entries.push({address: a, outpoint: rtRound.manager.outpoint, utxoEntry: {amount: '400000000', scriptPublicKey: `0000${emptySpk.script}`, blockDaaScore: '700000000', isCoinbase: false, covenantId: canonicalCid}});
          else if (a === wallet.address) entries.push({address: a, outpoint: {transactionId: keyHex('rogue-kas'), index: 0}, utxoEntry: {amount: '1000000000', scriptPublicKey: `0000${wallet.spk.script}`, blockDaaScore: '700000000', isCoinbase: false}});
        }
        return {entries};
      }
      if (method === 'getMempoolEntriesByAddresses') return {entries: []};
      throw new Error(`unexpected ${method}`);
    },
  };
  await assert.rejects(
    () => adapter.prepareForController({rpc: rogueRpc, round: rogueRound, choice: {action: 'BUY', quantity: 1, shardCid: rogueShardCid}, wallet, feerate: 1, net: MAINNET}),
    e => e?.code === 'USER' && e?.safeCode === 'KUSDT_V2_SHARD_NOT_IN_DIRECTORY',
  );

  // 7) H-06: real OPEN_SHARD/BUY draft puts KCC-20 wallet token input in scriptInputs (not authorizedInputIndices) -> MUST still classify as FUNDS_INPUT!
  const tokTx = keyHex('tok-in'), spTx = keyHex('tok-sp');
  const rej = classifyRejection({
    nodeError: `submitTransaction: Rejected transaction ${keyHex('tx')}: output (${tokTx}, 0) already spent by transaction ${spTx} in the mempool`,
    draft: {
      inputUtxos: [
        {outpoint: {transactionId: keyHex('mgr'), index: 0}, covenantId: canonicalCid},
        {outpoint: {transactionId: keyHex('kas'), index: 0}, covenantId: null},
        {outpoint: {transactionId: tokTx, index: 0}, covenantId: MAINNET_KUSDT_CID},
      ],
      authorizedInputIndices: [1],
      scriptInputs: [{inputIndex: 2, ownerKey: wallet.key}],
    },
  });
  assert.equal(rej.kind, 'FUNDS_INPUT');

  wallet.close();
});


