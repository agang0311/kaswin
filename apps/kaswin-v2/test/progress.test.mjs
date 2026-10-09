// Display ordering of round views (pure). Protects: a stale indexer view or a skewed clock must never put a round back
// to an earlier state the chain has already left (2026-10-09: a SEALED round kept showing as OPEN because the local
// view lost a cross-machine timestamp comparison). Lowest sufficient layer: pure function; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {compareProgress, chooseView} from '../scripts/shared/progress.mjs';
import {checkRow} from '../scripts/shared/rounds.mjs';
import {S, CONTRACT_TAG} from '../scripts/shared/core.mjs';

const view = (src, phase, {count = 1, cursor = 0, terminal = null, tx = 'aa', at = 0} = {}) => ({cid: 'c', _src: src, terminal, latestTxid: tx.repeat(32),
  updatedAt: at, verifiedAt: at, _fetchedAt: at, state: terminal ? undefined : {phase, purchaseCount: count, cursor}, phase: terminal ? null : phase});

test('progress follows the state machine, not timestamps', () => {
  assert.equal(compareProgress(view('l', 2), view('i', 1, {count: 1})), 1);           // CLOSE: OPEN -> SEALED
  assert.equal(compareProgress(view('l', 1, {count: 2}), view('i', 1, {count: 1})), 1); // BUY
  assert.equal(compareProgress(view('l', 5, {cursor: 32}), view('i', 5, {cursor: 0})), 1); // REFUND batch
  assert.equal(compareProgress(view('l', 0, {terminal: 'PAID'}), view('i', 2)), 1);
  assert.equal(compareProgress(view('l', 2), view('i', 2)), 0);
  assert.equal(compareProgress({phase: 1}, view('i', 1)), null); // summary row: undecidable, never guessed
});

test('the reported case: local SEALED beats a lagging indexer OPEN even when the indexer clock is ahead', () => {
  const index = view('live', 1, {count: 1, at: 2_000_000}), local = view('local', 2, {count: 1, tx: 'bb', at: 1_000_000});
  assert.equal(chooseView({index, local})._src, 'local');
  // ...and once the indexer catches up the indexer view is shown again (ties keep the indexer).
  assert.equal(chooseView({index: view('live', 2, {tx: 'bb'}), local})._src, 'live');
});

test('node-verified view: wins when further along or on a different tip at the same point; never goes backwards', () => {
  const index = view('live', 1, {at: 10});
  assert.equal(chooseView({index, node: view('node', 2, {tx: 'bb', at: 5})})._src, 'node');
  assert.equal(chooseView({index: view('live', 5, {at: 10}), node: view('node', 2, {at: 20})})._src, 'live');
  assert.equal(chooseView({index, node: view('node', 1, {tx: 'cc', at: 20})})._src, 'node');   // reorg replaced the tip
  assert.equal(chooseView({index, node: view('node', 1, {tx: 'cc', at: 5})})._src, 'live');    // older observation
  // A local successor already superseded by a later node verification (e.g. reorged out) is ignored.
  assert.equal(chooseView({index, node: view('node', 1, {at: 30}), local: view('local', 2, {tx: 'dd', at: 20})})._src, 'live'); // node agrees with index
  assert.equal(chooseView({index, node: view('node', 1, {at: 10}), local: view('local', 2, {tx: 'dd', at: 20})})._src, 'local');
  // Only a cache: shown as cache; any other source wins.
  assert.equal(chooseView({cache: view('cache', 5)})._src, 'cache');
  assert.equal(chooseView({index: {cid: 'c', phase: 1, terminal: null, latestTxid: 'ee'.repeat(32)}, local: view('local', 1, {tx: 'ee'})})._src, 'local');
});

test('NODE views read back from IndexedDB pass the same untrusted-row checks as indexer rows', () => {
  const s = S.newOpen('11'.repeat(32), {ticketPrice: 100_000_000n, ticketCap: 3, purchaseCap: 256, minTickets: 3, closeEligibleDaa: 1000n});
  const row = {cid: '22'.repeat(32), contract: CONTRACT_TAG, indexStatus: 'NODE', terminal: null, phase: 1, value: '20000000', latestTxid: '33'.repeat(32), updatedAt: 1,
    state: {...s, config: {...s.config, ticketPrice: '100000000', closeEligibleDaa: '1000'}, anchorDaa: '0', directory: undefined}, purchases: []};
  assert.equal(checkRow(row, {cached: true}).indexStatus, 'NODE');
  assert.throws(() => checkRow(row), /未知索引状态/); // an indexer may not claim node verification
});
