// Endpoint defaults/migration (pure) + legacy cursor carry-over (engine, simulated node). No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_NODE, DEFAULT_NODES, DEFAULT_INDEXER, CONFIG_VERSION, migrateConfig, isRetired, connectionNotices} from '../scripts/endpoints.mjs';
import {EngineV2} from '../scripts/engine2.mjs';
import {SimChain, wsFactory, fakeKasware, simIndexer, loadProfile, MemoryStore, testLocks, TEST_ADDRESS} from './sim.mjs';
import {NodeLink, nodeUrl} from '../scripts/shared/nodes.mjs';
import {indexerBase} from '../scripts/shared/rounds.mjs';
import {readSession} from '../scripts/shared/wallet.mjs';
import {NETWORK_GENESIS, PROFILE_ID} from '../scripts/shared/core.mjs';

const OLD_NODE = 'wss://legacy.kaspa.test:18210/wrpc', OLD_IDX = 'https://legacy.kaspa.test:18210/indexer';
const PUBLIC = 'wss://muon-10.kaspa.blue/kaspa/testnet-10/wrpc/json';

test('explicit ws/http local, LAN, IPv6 and public endpoints remain plaintext and persist', () => {
  for (const host of ['127.0.0.1', 'localhost', '[::1]', '192.168.1.10', '10.0.0.2', 'node.example.org']) {
    const node = nodeUrl(`ws://${host}:18210`), indexer = indexerBase(`http://${host}:8788`);
    assert.equal(node, `ws://${host}:18210/`); assert.equal(indexer, `http://${host}:8788`);
    assert.deepEqual(migrateConfig({version: CONFIG_VERSION, nodes: [node], indexer}), {version: CONFIG_VERSION, nodes: [node], indexer});
  }
  assert.throws(() => nodeUrl('http://127.0.0.1:18210'), /wss:|ws:/);
  assert.throws(() => indexerBase('ws://127.0.0.1:8788'), /http:/);
  assert.throws(() => nodeUrl('ws://user:password@localhost:18210'), /凭据/);
  assert.throws(() => indexerBase('http://user:password@localhost:8788'), /凭据/);
});

test('connection notices cover both transports, distinguish loopback, never change URLs', () => {
  const values = {nodes: ['ws://192.168.1.10:18210'], indexer: 'http://192.168.1.10:8788', pageUrl: 'https://page.example.org/'};
  const before = structuredClone(values), text = connectionNotices(values).join(' ');
  assert.match(text, /混合内容/); assert.match(text, /ws:\/\//); assert.match(text, /http:\/\//); assert.match(text, /可以保存/);
  assert.deepEqual(values, before);
  assert.doesNotMatch(connectionNotices({...values, pageUrl: 'http://192.168.1.10:8000/'}).join(' '), /混合内容/);
  assert.match(connectionNotices({nodes: ['ws://localhost:18210'], indexer: 'http://[::1]:8788', pageUrl: values.pageUrl}).join(' '), /回环地址的例外/);
  assert.deepEqual(connectionNotices({nodes: [DEFAULT_NODE], indexer: DEFAULT_INDEXER, pageUrl: values.pageUrl}), []);
});

test('defaults: kaspay node first, kaspay indexer, no retired endpoint anywhere', () => {
  assert.equal(DEFAULT_NODE, 'wss://tn10.kaspay.top/wrpc'); assert.equal(DEFAULT_INDEXER, 'https://tn10.kaspay.top/indexer');
  assert.equal(DEFAULT_NODES[0], DEFAULT_NODE); assert.equal(DEFAULT_NODES.some(isRetired), false);
  assert.equal(new Set(DEFAULT_NODES).size, DEFAULT_NODES.length);
  for (const u of DEFAULT_NODES) assert.match(u, /^wss:\/\//);
});

test('migration: retired endpoint removed from saved settings; custom entries kept; idempotent', () => {
  // The previous default list (old node + public fallbacks) becomes "use defaults".
  const oldDefault = [OLD_NODE, ...DEFAULT_NODES.slice(1)];
  assert.deepEqual(migrateConfig({version: 2, nodes: oldDefault, indexer: OLD_IDX}), {version: CONFIG_VERSION, nodes: null, indexer: null});
  // Old node only -> becomes exactly the new default node (kept as a custom single-node list).
  assert.deepEqual(migrateConfig({version: 2, nodes: [OLD_NODE], indexer: null}).nodes, [DEFAULT_NODE]);
  // Custom list: old entry replaced in place, other entries and order preserved, duplicates collapsed.
  assert.deepEqual(migrateConfig({version: 2, nodes: ['ws://192.168.1.50:18210/', OLD_NODE, DEFAULT_NODE, PUBLIC]}).nodes, ['ws://192.168.1.50:18210/', DEFAULT_NODE, PUBLIC]);
  // Non-retired external paths are preserved.
  assert.deepEqual(migrateConfig({version: 2, nodes: ['wss://example.org:890/wrpc'], indexer: 'http://example.org:890/indexer'}), {version: CONFIG_VERSION, nodes: ['wss://example.org:890/wrpc'], indexer: 'http://example.org:890/indexer'});
  assert.equal(isRetired('wss://tn10.kaspay.top/wrpc'), false); assert.equal(isRetired('not a url'), false);
  // Custom indexer kept; v1 local lists still dropped.
  assert.equal(migrateConfig({version: 2, indexer: 'https://example.org/indexer'}).indexer, 'https://example.org/indexer');
  assert.deepEqual(migrateConfig({version: 1, nodes: ['ws://127.0.0.1:18210', OLD_NODE], indexer: 'http://192.168.1.201:8788'}), {version: CONFIG_VERSION, nodes: null, indexer: null});
  // Nothing saved / garbage -> defaults.
  assert.deepEqual(migrateConfig({}), {version: CONFIG_VERSION, nodes: null, indexer: null});
  assert.deepEqual(migrateConfig({version: 2, nodes: 'x', indexer: 5}), {version: CONFIG_VERSION, nodes: null, indexer: null});
  // Already migrated: untouched (a user may deliberately re-add any endpoint later).
  assert.deepEqual(migrateConfig({version: CONFIG_VERSION, nodes: [OLD_NODE], indexer: OLD_IDX}), {version: CONFIG_VERSION, nodes: [OLD_NODE], indexer: OLD_IDX});
});

test('engine: search cursor saved under the retired URL is resumed on the new node, still verified; no extra submit', async t => {
  const chain = new SimChain(), url = 'wss://alpha.sim/kaspa/testnet-10/wrpc/json';
  const pair = new NodeLink([url], {WebSocketImpl: wsFactory(chain)});
  globalThis.fetch = simIndexer(chain, loadProfile()).fetch; globalThis.kasware = fakeKasware();
  const store = new MemoryStore(), engine = new EngineV2({pair, profile: loadProfile(), indexer: 'http://localhost/indexer', openStore: async () => store, locks: testLocks, reorgRecheckDaa: 0n, restQuery: null, legacyUrls: [OLD_NODE]});
  t.after(() => pair.close());
  chain.fund(TEST_ADDRESS, 50_000_000_000n);
  chain.advance(2); // make the newer search cursor distinct from the original anchor below
  const session = await readSession(globalThis.kasware, {request: true});
  const plan = await engine.plan({action: 'GENESIS', config: {ticketPrice: 100_000_000n, ticketCap: 3, purchaseCap: 256, minTickets: 3, closeEligibleDaa: chain.daa + 1000n}, registry: false}, session);
  chain.dropResponse = true; const rec = await engine.execute(plan, {approved: true}); assert.equal(rec.status, 'UNKNOWN');
  // Simulate a record created while the page used the retired URL: anchors/cursors keyed by the old URL only.
  const k = `${NETWORK_GENESIS}/${PROFILE_ID}/tx/${rec.txid}`, cur = await store.get(k), [n] = await pair.connect();
  const legacyCursor = cur.value.cursors[n.url];
  await store.compareAndSet(k, cur.revision, {...cur.value, anchors: [{url: OLD_NODE, sink: chain.chain[0]}], cursors: {[OLD_NODE]: legacyCursor}});
  const starts = []; const orig = n.call.bind(n);
  n.call = (m, p, t) => { if (m === 'getVirtualChainFromBlock') starts.push(p.startHash); return orig(m, p, t); };
  const r = await engine.reconcile(rec.txid);
  assert.equal(r.status, 'ACCEPTED'); assert.equal(starts[0], legacyCursor); assert.equal(r.cursors[OLD_NODE], legacyCursor);
  assert.equal(r.cursors[n.url], legacyCursor);
  assert.equal(chain.submits, 1);
});

for (const mode of ['pruned', 'reorg', 'tampered fields', 'CAS conflict']) {
  test(`engine: migrated cursor does not bypass ${mode}; no resubmit or release`, async t => {
    const chain = new SimChain(), pair = new NodeLink([DEFAULT_NODE], {WebSocketImpl: wsFactory(chain)});
    t.after(() => pair.close());
    globalThis.fetch = simIndexer(chain, loadProfile()).fetch; globalThis.kasware = fakeKasware();
    const store = new MemoryStore(), engine = new EngineV2({pair, profile: loadProfile(), indexer: 'http://localhost/indexer', openStore: async () => store, locks: testLocks, reorgRecheckDaa: 0n, restQuery: null});
    chain.fund(TEST_ADDRESS, 50_000_000_000n);
    const session = await readSession(globalThis.kasware, {request: true});
    const plan = await engine.plan({action: 'GENESIS', config: {ticketPrice: 100_000_000n, ticketCap: 3, purchaseCap: 256, minTickets: 3, closeEligibleDaa: chain.daa + 1000n}, registry: false}, session);
    chain.dropResponse = true;
    const rec = await engine.execute(plan, {approved: true}), k = `${NETWORK_GENESIS}/${PROFILE_ID}/tx/${rec.txid}`;
    const cur = await store.get(k), [n] = await pair.connect(), legacy = cur.value.cursors[n.url];
    await store.compareAndSet(k, cur.revision, {...cur.value, anchors: [{url: OLD_NODE, sink: legacy}], cursors: {[OLD_NODE]: legacy}});
    const original = n.call.bind(n);
    n.call = async (method, params, timeout) => {
      if (mode === 'pruned' && method === 'getBlock') throw Error('cannot find header');
      const out = await original(method, params, timeout);
      if (mode === 'reorg' && method === 'getVirtualChainFromBlock') out.removedChainBlockHashes = ['ab'.repeat(32)];
      if (mode === 'tampered fields' && method === 'getVirtualChainFromBlockV2') out.chainBlockAcceptedTransactions[0].acceptedTransactions[0].outputs[0].value = '1';
      return out;
    };
    if (mode === 'CAS conflict') {
      const cas = store.compareAndSet.bind(store);
      store.compareAndSet = async (key, rev, value) => {
        const latest = await store.get(key);
        await cas(key, latest.revision, {...latest.value, concurrentMarker: 'newer write'});
        return cas(key, rev, value); // must reject the now-stale revision
      };
      await assert.rejects(engine.reconcile(rec.txid), /STALE_CACHE_REVISION/);
      assert.equal((await store.get(k)).value.concurrentMarker, 'newer write');
    } else {
      const result = await engine.reconcile(rec.txid);
      assert.equal(result.status, 'UNKNOWN'); assert.equal(result.accepted, false);
    }
    const after = (await store.get(k)).value;
    assert.deepEqual(after.inputs, rec.inputs); assert.equal(after.status, 'UNKNOWN');
    assert.equal(after.archivedAt, undefined); assert.equal(after.cursors[OLD_NODE], legacy); assert.equal(chain.submits, 1);
  });
}
