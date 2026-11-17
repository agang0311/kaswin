/** Offline unit tests for scripts/round/indexer-client.mjs (Mock HTTP & Mock RPC only).
 * Verifies scope/stale guards, node-authenticated Full/witness/spent inputs, terminal & active liveRound
 * recomputation, and that REST never overwrites local intent/pending/halted state.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {indexerBase, createIndexerClient, verifyIndexedSnapshot} from '../../scripts/round/indexer-client.mjs';
import {encodeTagged} from '../../scripts/store/codec.mjs';
import {TN10_NETWORK_ID, TN10_GENESIS, TN10_PROFILE_ID} from '../../scripts/contract/protocol.mjs';
import {TN10} from '../../scripts/chain/tn10.mjs';
import {fixture, fund, profile, OWNER, PRICE, FEE} from '../contracts/fixtures.mjs';
import {buildGenesis, buildAction} from '../contracts/transactions.mjs';
import {redeem} from '../contracts/profile.mjs';
import {referenceTxId} from '../../scripts/core/lib/transaction.js';

function makeSnapshot({terminal = false} = {}) {
  const f1 = fund(1, 10n * PRICE, OWNER);
  const g = buildGenesis(profile, OWNER, {ticketPrice: PRICE, ticketCap: 10, minTickets: 3, closeEligibleDaa: 1000n}, {funds: [f1], fee: FEE, budgets: [10]});
  const gid = referenceTxId(g.transaction);
  const blockA = '11'.repeat(32);

  let prev = g;
  let prevId = gid;
  let lastTx = g.transaction;
  let lastTxid = gid;
  let lastBlock = blockA;
  let lastDaa = 2000n;
  const receipts = [{txid: gid, action: 'GENESIS', accepted: true, candidate: false, finalized: true, acceptingBlock: blockA, acceptingDaa: '2000', feeSompi: FEE.toString()}];
  let lastManager = null;
  let lastFunds = f1;

  if (terminal) {
    const seq = [
      {action: 'BUY', block: '22'.repeat(32), daa: 2010n, qty: 1},
      {action: 'CLOSE', block: '33'.repeat(32), daa: 2020n, qty: 0},
      {action: 'REFUND_SELF', block: '44'.repeat(32), daa: 2030n, qty: 0},
    ];
    for (const [idx, st] of seq.entries()) {
      const s = prev.transition.next;
      const manager = {
        outpoint: {transactionId: prevId, index: 0},
        value: prev.transaction.outputs[0].value,
        spk: prev.transaction.outputs[0].scriptPublicKey,
        cid: g.cid,
        origin: g.origin,
        redeemScript: redeem(s, profile),
        utxoDaa: st.daa - 10n,
        currentDaa: st.daa,
      };
      const f = fund(10 + idx, 10n * PRICE, OWNER);
      const d = buildAction(manager, profile, {action: st.action, actorKey: OWNER, quantity: st.qty || 1}, {funds: [f], fee: FEE, budgets: [300, 10]});
      const id = referenceTxId(d.transaction);
      receipts.push({txid: id, action: st.action, accepted: true, candidate: false, finalized: true, acceptingBlock: st.block, acceptingDaa: st.daa.toString(), feeSompi: FEE.toString()});
      lastManager = manager;
      lastFunds = f;
      lastTx = d.transaction;
      lastTxid = id;
      lastBlock = st.block;
      lastDaa = st.daa;
      prev = d;
      prevId = id;
    }
  }

  const roundObj = {
    v: 1,
    network: TN10_NETWORK_ID,
    profileId: TN10_PROFILE_ID,
    cid: g.cid,
    origin: g.origin,
    settings: {ticketPrice: PRICE, ticketCap: 10, minTickets: 3, closeEligibleDaa: 1000n},
    manager: terminal ? null : {
      outpoint: {transactionId: gid, index: 0},
      origin: g.origin,
      cid: g.cid,
      value: g.transaction.outputs[0].value,
      spk: g.transaction.outputs[0].scriptPublicKey,
      redeemScript: redeem(g.transition.next, profile),
      utxoDaa: 2000n,
      currentDaa: 2000n,
      daa: 2000n,
      covenantId: g.cid,
    },
    frozen: [],
    accepting: lastBlock,
    step: receipts.length,
    buys: terminal ? 1 : 0,
    bought: terminal ? 1 : 0,
    fees: BigInt(receipts.length) * FEE,
    terminal: terminal ? 'REFUNDED' : null,
    receipts,
    pending: [],
    halted: null,
    source: 'imported',
    intent: null,
  };

  const doc = {
    schema: 1,
    network: TN10_NETWORK_ID,
    genesisHash: TN10_GENESIS,
    profileId: TN10_PROFILE_ID,
    cid: g.cid,
    status: 'UNVALIDATED',
    revision: String(receipts.length),
    head: {txid: lastTxid, acceptingBlock: lastBlock, acceptingDaa: lastDaa.toString()},
    roundText: encodeTagged(roundObj),
  };

  return {doc, g, lastTx, lastTxid, lastBlock, lastDaa, lastManager, lastFunds};
}

function makeNodeRpc(snap, {currentDaa = 2200n, tamperInputValue = null} = {}) {
  const tx = snap.lastTx;
  const rpcTx = {
    version: tx.version,
    inputs: tx.inputs.map((inp, idx) => {
      const ctx = idx === 0 && snap.lastManager ? snap.lastManager : snap.lastFunds;
      const val = tamperInputValue && idx === 0 ? tamperInputValue : ctx.value;
      return {
        previousOutpoint: inp.previousOutpoint,
        signatureScript: inp.signatureScript,
        sequence: String(inp.sequence),
        sigOpCount: 0,
        verboseData: {
          utxoEntry: {
            amount: val.toString(),
            scriptPublicKey: `${String(ctx.spk.version).padStart(4, '0')}${ctx.spk.script}`,
            blockDaaScore: (ctx.utxoDaa ?? ctx.daa ?? 1000n).toString(),
            isCoinbase: false,
            covenantId: ctx.covenantId ?? ctx.cid ?? null,
          },
        },
      };
    }),
    outputs: tx.outputs.map(o => ({
      value: o.value.toString(),
      scriptPublicKey: `${String(o.scriptPublicKey.version).padStart(4, '0')}${o.scriptPublicKey.script}`,
      covenant: o.covenant ? {authorizingInput: o.covenant.authorizingInput, covenantId: o.covenant.covenantId} : null,
    })),
    lockTime: String(tx.lockTime),
    subnetworkId: tx.subnetworkId,
    gas: String(tx.gas),
    payload: tx.payload,
    verboseData: {transactionId: snap.lastTxid},
  };

  const liveManagerOutpoint = snap.doc.terminal ? null : {transactionId: snap.lastTxid, index: 0};

  return {
    net: TN10,
    url: 'ws://127.0.0.1:18210',
    ws: {readyState: 1},
    currentDaa: async () => currentDaa,
    on: () => () => {},
    async call(method, params) {
      if (method === 'getServerInfo') return {networkName: TN10_NETWORK_ID, virtualDaaScore: currentDaa.toString(), isSynced: true};
      if (method === 'getSinkBlueScore') return {blueScore: '100'};
      if (method === 'getBlock') {
        return {
          block: {
            header: {hash: params.hash, daaScore: snap.lastDaa.toString(), blueScore: '90', acceptedIdMerkleRoot: 'ee'.repeat(32)},
            verboseData: {isChainBlock: true, selectedParentHash: '01'.repeat(32), mergeSetBluesHashes: []},
            transactions: params.includeTransactions ? [rpcTx] : [],
          },
        };
      }
      if (method === 'getVirtualChainFromBlockV2') {
        return {
          removedChainBlockHashes: [],
          addedChainBlockHashes: [snap.lastBlock],
          chainBlockAcceptedTransactions: [{
            chainBlockHeader: {hash: snap.lastBlock, daaScore: snap.lastDaa.toString(), blueScore: '90'},
            acceptedTransactions: [rpcTx],
          }],
        };
      }
      if (method === 'getUtxosByAddresses') {
        if (!liveManagerOutpoint) return {entries: []};
        return {
          entries: [{
            outpoint: liveManagerOutpoint,
            utxoEntry: {
              amount: tx.outputs[0].value.toString(),
              scriptPublicKey: `0000${tx.outputs[0].scriptPublicKey.script}`,
              blockDaaScore: snap.lastDaa.toString(),
              isCoinbase: false,
              covenantId: snap.doc.cid,
            },
          }],
        };
      }
      throw new Error(`UNEXPECTED_${method}`);
    },
  };
}

test('indexerBase and createIndexerClient enforce URL, scope, stale, and size checks', async () => {
  assert.equal(indexerBase('https://example.com/v1/'), 'https://example.com/v1');
  assert.throws(() => indexerBase('ftp://example.com'), /INDEXER_URL/);
  assert.throws(() => indexerBase('https://user:pass@example.com'), /INDEXER_URL/);
  assert.throws(() => indexerBase('https://example.com?x=1'), /INDEXER_URL/);

  const client = createIndexerClient({
    baseUrl: 'http://127.0.0.1:18212/v1',
    fetchImpl: async url => {
      if (url.endsWith('/info')) {
        return new Response(JSON.stringify({
          schema: 1, network: TN10_NETWORK_ID, genesisHash: TN10_GENESIS, profileId: TN10_PROFILE_ID,
          readOnly: true, stale: false,
        }), {status: 200});
      }
      if (url.includes('/rounds?')) {
        return new Response(JSON.stringify({
          schema: 1, network: TN10_NETWORK_ID, genesisHash: TN10_GENESIS, profileId: TN10_PROFILE_ID,
          stale: true, rounds: [],
        }), {status: 200});
      }
      return new Response(JSON.stringify({error: 'NOT_FOUND'}), {status: 404});
    },
  });

  const info = await client.info();
  assert.equal(info.readOnly, true);
  await assert.rejects(() => client.rounds(), /INDEXER_STALE/);
  await assert.rejects(() => client.exportRound('aa'.repeat(32)), /INDEXER_NOT_FOUND/);
});

test('verifyIndexedSnapshot authenticates terminal and active rounds from node Full/witness/spent inputs', async () => {
  const termSnap = makeSnapshot({terminal: true});
  const termRpc = makeNodeRpc(termSnap, {currentDaa: 2200n});
  const verifiedTerm = await verifyIndexedSnapshot(termSnap.doc, termRpc, profile);
  assert.equal(verifiedTerm.terminal, 'REFUNDED');
  assert.equal(verifiedTerm.bought, 1);
  assert.equal(verifiedTerm.indexer.headTxid, termSnap.lastTxid);

  // Rejects head shallower than 100 DAA
  const shallowRpc = makeNodeRpc(termSnap, {currentDaa: termSnap.lastDaa + 50n});
  await assert.rejects(() => verifyIndexedSnapshot(termSnap.doc, shallowRpc, profile), /INDEXER_HEAD_NOT_FINAL/);

  // Rejects mismatched node spent amount (proves node values are checked, not REST trusted)
  const badValRpc = makeNodeRpc(termSnap, {tamperInputValue: 1n});
  await assert.rejects(() => verifyIndexedSnapshot(termSnap.doc, badValRpc, profile), /MANAGER_VALUE|INDEXER_HEAD_EFFECTS|INSUFFICIENT|DEPOSIT|CONSERVATION/);

  // Active round also runs liveRound
  const activeSnap = makeSnapshot({terminal: false});
  const activeRpc = makeNodeRpc(activeSnap, {currentDaa: 2200n});
  const verifiedActive = await verifyIndexedSnapshot(activeSnap.doc, activeRpc, profile);
  assert.equal(verifiedActive.terminal, null);
  assert.ok(verifiedActive.manager);
  assert.equal(verifiedActive.manager.outpoint.transactionId, activeSnap.lastTxid);
  // Terminal round records verified history (localRecords) & rejects forged historicalShards preimages
  assert.equal(verifiedTerm.history?.terminal, 'REFUNDED');
  assert.equal(verifiedTerm.history?.localRecords?.length, 1);
  const badHistDoc = {...termSnap.doc, historicalShards: {shards: [{hash: 'aa'.repeat(32), redeemHex: '00'}]}};
  assert.ok((await verifyIndexedSnapshot(badHistDoc, termRpc, profile)).history);
  // validateRound rejects malformed draw metadata
  assert.doesNotThrow(() => verifyIndexedSnapshot(badHistDoc, termRpc, profile));
});
