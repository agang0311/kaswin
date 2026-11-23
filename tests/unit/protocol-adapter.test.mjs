/** Unit tests for multi-covenant ProtocolRegistry, Rolling v1 adapter, asset-scoped UTXO filtering,
 * wallet capabilities, review assetDeltas, and KCI optional extension fields. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  ASSET_DELTA_ROLES,
  createProtocolRegistry,
  kasAsset,
  validateAssetDescriptor,
  formatAssetAmount,
} from '../../scripts/protocols/registry.mjs';
import {createRollingV1Adapter, rollingV1Summary} from '../../scripts/protocols/rolling-v1.mjs';
import {filterAssetUtxos, getAssetUtxos} from '../../scripts/chain/chain.mjs';
import {openMemoryWallet, publicRecipient} from '../../scripts/wallet/wallet.mjs';
import {reviewOf} from '../../scripts/round/prepare.mjs';
import {emptyRound} from '../../scripts/round/round.mjs';
import {sanitizeDiscoveredRound} from '../../scripts/store/round-store.mjs';
import {createIndexerClient} from '../../scripts/round/indexer-client.mjs';
import {TN10_GENESIS, TN10_NETWORK_ID, TN10_PROFILE_ID} from '../../scripts/contract/protocol.mjs';
import {fixture, fund, profile, PRICE, FEE} from '../contracts/fixtures.mjs';
import {buildAction} from '../contracts/transactions.mjs';

const SECRET_A = createHash('sha256').update('rolling-protocol-adapter-test-a').digest('hex');

function makeStubAdapter(overrides = {}) {
  const base = createRollingV1Adapter({profile});
  return Object.freeze({
    ...base,
    id: 'kcc20-v2',
    name: 'KCC20 v2',
    profileId: '22'.repeat(32),
    capabilities: Object.freeze({...base.capabilities, canCreate: false}),
    ...overrides,
  });
}

test('createProtocolRegistry registers multiple adapters, rejects duplicates/unknowns, and formats 8-dec KAS / 6-dec KCC20', () => {
  const v1 = createRollingV1Adapter({profile});
  const v2 = makeStubAdapter();
  const reg = createProtocolRegistry([v1, v2]);

  assert.equal(reg.list().length, 2);
  assert.deepEqual(reg.profileIds(), [profile.id, v2.profileId]);
  assert.equal(reg.has(profile.id), true);
  assert.equal(reg.has('ff'.repeat(32)), false);
  assert.equal(reg.get(v2.profileId), v2);
  assert.equal(reg.getById('kcc20-v2'), v2);
  assert.equal(reg.defaultForCreate(), v1);
  assert.throws(() => reg.require('ff'.repeat(32)), /UNSUPPORTED_PROFILE/);

  assert.throws(() => createProtocolRegistry([v1, makeStubAdapter({profileId: profile.id})]), /PROTOCOL_DUPLICATE_PROFILE/);
  assert.throws(() => createProtocolRegistry([v1, makeStubAdapter({id: 'rolling-v1'})]), /PROTOCOL_DUPLICATE_ID/);

  const kas = kasAsset();
  const kusdt = validateAssetDescriptor({
    kind: 'KCC20',
    symbol: 'kUSDT',
    decimals: 6,
    tokenCovenantId: 'aa'.repeat(32),
  });
  assert.equal(formatAssetAmount(123_456_789n, kas), '1.2345');
  assert.equal(formatAssetAmount(100_000_000n, kas), '1');
  assert.equal(formatAssetAmount(12_345_678n, kusdt), '12.3456');
  assert.equal(formatAssetAmount(-500_000n, kusdt), '-0.5');
});

test('createRollingV1Adapter and rollingV1Summary map OPEN / SEALED / SETTLING / REFUNDING / DONE phases', () => {
  const adapter = createRollingV1Adapter({profile});
  assert.equal(adapter.id, 'rolling-v1');
  assert.equal(adapter.profileId, profile.id);
  assert.equal(adapter.assetFor().kind, 'KAS');

  const mkRound = (mod, over = {}) => {
    const f = fixture({module: mod, ...(mod === 'sealed' ? {local: 3} : mod === 'win' ? {cnt: 1, local: 3, p: 0} : mod === 'refund' ? {cnt: 1, local: 2, r: 0, c: 0} : {})});
    const r = {
      ...emptyRound({
        cid: f.manager.cid,
        origin: f.manager.origin,
        settings: {
          ticketPrice: f.s.ticketPrice,
          ticketCap: f.s.ticketCap,
          minTickets: f.s.minTickets,
          closeEligibleDaa: f.s.closeEligibleDaa,
        },
        profileId: profile.id,
      }),
      manager: {...f.manager, daa: f.manager.utxoDaa, covenantId: f.manager.cid},
      frozen: f.targets.map(t => ({...t, covenantId: t.cid, daa: t.utxoDaa, origin: f.manager.origin})),
      bought: 5,
      ...over,
    };
    return r;
  };

  assert.equal(rollingV1Summary(mkRound('sales'), {profile}).phase, 'OPEN');
  assert.equal(rollingV1Summary(mkRound('sealed'), {profile}).phase, 'SEALED');

  const settling = adapter.toRoundSummary(mkRound('win', {
    receipts: [{action: 'PAY_OLD', txid: '11'.repeat(32), feeSompi: '1000', finalized: true}],
  }));
  assert.equal(settling.phase, 'SETTLING');
  assert.deepEqual(settling.settlementProgress, {done: 1, total: 3, labelKey: 'PAYOUT'});

  const refunding = rollingV1Summary(mkRound('refund'), {profile});
  assert.equal(refunding.phase, 'REFUNDING');
  assert.deepEqual(refunding.settlementProgress, {done: 0, total: 2, labelKey: 'REFUND'});

  const donePaid = rollingV1Summary({...mkRound('win'), terminal: 'PAID', manager: null, frozen: []}, {profile});
  assert.equal(donePaid.phase, 'DONE');
  assert.equal(donePaid.subPhase, 'PAID');
  assert.equal(donePaid.settlementProgress, null);
});

test('filterAssetUtxos and getAssetUtxos strictly isolate ordinary KAS from covenantId (KCC20) UTXOs', async () => {
  const tokenCidA = 'aa'.repeat(32);
  const tokenCidB = 'bb'.repeat(32);
  const spkA = {version: 0, script: '20' + '11'.repeat(32) + 'ac'};
  const spkB = {version: 0, script: '20' + '22'.repeat(32) + 'ac'};
  const mk = (txByte, idx, value, {covenantId = null, isCoinbase = false, spk = spkA} = {}) => ({
    outpoint: {transactionId: txByte.repeat(32), index: idx},
    value,
    spk,
    utxoDaa: 100n,
    isCoinbase,
    covenantId,
  });

  const utxos = [
    mk('01', 0, 500_000_000n),
    mk('02', 0, 999_000_000n, {covenantId: tokenCidA}),
    mk('03', 1, 200_000_000n, {covenantId: tokenCidB}),
    mk('04', 0, 300_000_000n, {isCoinbase: true}),
    mk('05', 0, 400_000_000n, {spk: spkB}),
  ];

  const kasOnly = filterAssetUtxos(utxos, {kind: 'KAS', tokenCovenantId: null}, {
    spkScript: spkA.script,
    excludeOutpoints: new Set(),
  });
  assert.deepEqual(kasOnly.map(u => u.outpoint.transactionId), ['01'.repeat(32)]);

  const kccA = filterAssetUtxos(utxos, {kind: 'KCC20', tokenCovenantId: tokenCidA});
  assert.deepEqual(kccA.map(u => u.outpoint.transactionId), ['02'.repeat(32)]);

  const mockRpc = {
    async call(method) {
      assert.equal(method, 'getUtxosByAddresses');
      return {
        entries: [
          {
            outpoint: {transactionId: '01'.repeat(32), index: 0},
            utxoEntry: {amount: '500000000', scriptPublicKey: '0000' + spkA.script, blockDaaScore: '100', isCoinbase: false},
          },
          {
            outpoint: {transactionId: '02'.repeat(32), index: 0},
            utxoEntry: {
              amount: '1000000',
              scriptPublicKey: '0000' + spkA.script,
              blockDaaScore: '100',
              isCoinbase: false,
              covenantId: tokenCidA,
            },
          },
        ],
      };
    },
  };

  const rpcKas = await getAssetUtxos(mockRpc, 'kaspatest:qq...', kasAsset());
  assert.equal(rpcKas.length, 1);
  assert.equal(rpcKas[0].outpoint.transactionId, '01'.repeat(32));

  const rpcToken = await getAssetUtxos(mockRpc, 'kaspatest:qq...', {kind: 'KCC20', symbol: 'kUSDT', decimals: 6, tokenCovenantId: tokenCidA});
  assert.equal(rpcToken.length, 1);
  assert.equal(rpcToken[0].covenantId, tokenCidA);
});

test('wallet capabilities distinguish key vs publicRecipient and reviewOf includes assetDeltas[]', () => {
  const mem = openMemoryWallet(SECRET_A);
  const pub = publicRecipient(mem.address);
  assert.deepEqual(mem.capabilities, {supportsCovenantTxV1: true, selectiveSigning: true});
  assert.deepEqual(pub.capabilities, {supportsCovenantTxV1: false, selectiveSigning: false});

  const f = fixture({module: 'sales'});
  const draft = buildAction(
    f.manager,
    profile,
    {action: 'BUY', quantity: 1, actorKey: mem.key},
    {funds: [fund(2, 10n * PRICE, mem.key)], fee: FEE, budgets: [10, 10]},
  );
  const rev = reviewOf(draft, mem);
  assert.deepEqual(ASSET_DELTA_ROLES, ['NET', 'REFUNDABLE_DEPOSIT', 'CARRIER', 'FEE']);
  assert.equal(Array.isArray(rev.assetDeltas), true);
  const netRow = rev.assetDeltas.find(d => d.role === 'NET');
  const feeRow = rev.assetDeltas.find(d => d.role === 'FEE');
  assert.ok(netRow);
  assert.equal(netRow.asset.kind, 'KAS');
  assert.equal(netRow.amount, -(PRICE + FEE));
  assert.ok(feeRow);
  assert.equal(feeRow.amount, -FEE);
  mem.close();
});

test('sanitizeDiscoveredRound and createIndexerClient accept valid optional extensions and reject malformed ones', async () => {
  const cid = '12'.repeat(32);
  const tokenCid = '34'.repeat(32);

  const clean = sanitizeDiscoveredRound({
    cid,
    terminal: null,
    module: 'paying',
    profileId: TN10_PROFILE_ID,
    subPhase: 'paying',
    asset: {kind: 'KCC20', symbol: 'kUSDT', decimals: 6, tokenCovenantId: tokenCid},
    settlementProgress: {done: 2, total: 5, labelKey: 'PAYOUT'},
  });
  assert.equal(clean.profileId, TN10_PROFILE_ID);
  assert.equal(clean.subPhase, 'paying');
  assert.deepEqual(clean.asset, {kind: 'KCC20', symbol: 'kUSDT', decimals: 6, tokenCovenantId: tokenCid});
  assert.deepEqual(clean.settlementProgress, {done: 2, total: 5, labelKey: 'PAYOUT'});

  const stripped = sanitizeDiscoveredRound({
    cid,
    profileId: 'bad-profile',
    asset: {kind: 'KCC20', symbol: 'kUSDT', decimals: 6, tokenCovenantId: 'bad'},
    settlementProgress: {done: 6, total: 5},
  });
  assert.equal(stripped.profileId, undefined);
  assert.equal(stripped.asset, undefined);
  assert.equal(stripped.settlementProgress, undefined);

  const scopeHeader = {schema: 1, network: TN10_NETWORK_ID, genesisHash: TN10_GENESIS, profileId: TN10_PROFILE_ID};
  const makeClient = handler => createIndexerClient({
    baseUrl: 'https://idx.test/tn10',
    fetchImpl: async url => {
      const body = handler(String(url));
      return new Response(JSON.stringify(body), {status: 200, headers: {'content-type': 'application/json'}});
    },
  });

  const okClient = makeClient(url => {
    if (url.includes('/rounds?')) {
      return {
        ...scopeHeader,
        rounds: [{
          cid,
          asset: {kind: 'KCC20', symbol: 'kUSDT', decimals: 6, tokenCovenantId: tokenCid},
          settlementProgress: {done: 1, total: 4},
          protocolData: {shardCount: 4},
        }],
        nextCursor: null,
      };
    }
    return {
      ...scopeHeader,
      cid,
      summary: {
        asset: {kind: 'KAS', symbol: 'TKAS', decimals: 8, tokenCovenantId: null},
        settlementProgress: {done: 4, total: 4},
      },
      protocolData: {note: 'ok'},
    };
  });

  const list = await okClient.rounds();
  assert.equal(list.rounds.length, 1);
  assert.deepEqual(list.rounds[0].protocolData, {shardCount: 4});
  const detail = await okClient.roundDetail(cid);
  assert.deepEqual(detail.protocolData, {note: 'ok'});

  const badAssetClient = makeClient(() => ({
    ...scopeHeader,
    rounds: [{cid, asset: {kind: 'KCC20', symbol: 'kUSDT', decimals: 6}}],
  }));
  await assert.rejects(() => badAssetClient.rounds(), /INDEXER_RESPONSE_INVALID/);

  const badProgressClient = makeClient(() => ({
    ...scopeHeader,
    rounds: [{cid, settlementProgress: {done: 5, total: 2}}],
  }));
  await assert.rejects(() => badProgressClient.rounds(), /INDEXER_RESPONSE_INVALID/);

  const badProtoDataClient = makeClient(() => ({
    ...scopeHeader,
    cid,
    summary: {},
    protocolData: ['not-an-object'],
  }));
  await assert.rejects(() => badProtoDataClient.roundDetail(cid), /INDEXER_RESPONSE_INVALID/);
});
