// REST supplies locations and display candidates, never reconstructed consensus transactions.
import {S, CONTRACT_TAG, REGISTRATION_SOMPI, ensure, hash32, unhex, hex, ascii, stable, p2sh, blake2b256} from '../core.mjs';
import {requireNet, linkNet} from '../chain/network-schema.mjs';
import {restAddressTransactions, restTransaction, restAcceptance} from '../chain/rest.mjs';
import {acceptedPair, commonUtxos, acceptanceFromPage, REORG_RECHECK_DAA} from '../chain/chain.mjs';
import {replayEvidence} from './replay.mjs';
import {viewFromLive, ledgerFromDetail, liveBelowPruningPoint, PRUNED_BASIS} from './rounds.mjs';
import {spkToAddress} from '../wallet/address.mjs';
import {uint} from '../chain/json.mjs';
import {terminalCheck, terminalSettled} from '../tracking/terminal-state.mjs';
import {queryContext, sameConnectionContext, failure} from '../chain/operation.mjs';

export function restGenesisCandidate(raw, profile, net) {
  requireNet(net);
  const tag = hex(ascii('KASWIN_GENESIS_V2'));
  ensure(typeof raw.payload === 'string' && raw.payload.startsWith(tag + profile.id), 'REST_NOT_GENESIS');
  const s = S.decodeLedger(unhex(raw.payload.slice(tag.length + 64)));
  S.validateLedger(s); ensure(stable(s) === stable(S.newOpen(s.ownerKey, s.config)), 'REST_GENESIS_STATE');
  const first = raw.inputs?.find(i => uint(i.index) === 0n), out = raw.outputs?.find(o => uint(o.index) === 0n);
  const origin = {transactionId: hash32(first?.previous_outpoint_hash), index: Number(uint(first.previous_outpoint_index))};
  const script = S.rootScript(s, profile), cid = S.rootId(origin, script), spk = p2sh(hex(blake2b256(script)));
  ensure(out?.covenant_id === cid && uint(out.covenant_authorizing_input) === 0n && uint(out.amount) === S.DEPOSIT && out.script_public_key === spk.script, 'REST_GENESIS_OUTPUT');
  ensure(raw.outputs.filter(o => o.covenant_id === cid).length === 1, 'REST_GENESIS_GROUP');
  ensure(raw.outputs.some(o => o.covenant_id === null && o.script_public_key === net.registry.spk.script && uint(o.amount) === REGISTRATION_SOMPI), 'REST_REGISTRATION');
  const txid = hash32(raw.transaction_id);
  const row = viewFromLive({ledger: s, snapshot: {tip: {transactionId: txid, index: 0}, value: S.DEPOSIT, utxoDaa: 0n, origin, scriptPublicKey: spk}, genesisTxid: txid}, cid);
  // REST lacks accepting DAA and complete transaction fields. Do not invent a usable live snapshot.
  delete row.utxoDaa; delete row.verifiedAt;
  return {...row, indexStatus: 'UNKNOWN', _src: 'rest', accepting: raw.accepting_block_hash ?? null, acceptance: 'UNKNOWN', coverage: 'genesis-only'};
}
export async function discoverRestRounds(profile, {net, cursor = 0, limit = 50, ...options} = {}) {
  requireNet(net);
  const page = await restAddressTransactions(net.registry.address, {offset: cursor, limit, ...options, net});
  const items = []; let rejected = 0;
  for (const raw of page.items) { try { items.push(restGenesisCandidate(raw, profile, net)); } catch { rejected++; } }
  return {items, nextCursor: page.nextOffset, source: 'rest', coverage: 'registry-window', rejected};
}
const spends = (raw, tip) => raw.inputs?.some(i => i.previous_outpoint_hash === tip.transactionId && uint(i.previous_outpoint_index) === BigInt(tip.index));
/** List fallback can locate a spender without pretending REST has a full state API. Details hydrate it on node. */
export async function refreshRestCandidate(row, options = {}) {
  const net = requireNet(options.net);
  if (!row.tip || !row.scriptPublicKey) return {...row, _src: 'rest'};
  const page = await restAddressTransactions(spkToAddress(row.scriptPublicKey, net.addressPrefix), options);
  const raw = page.items.find(t => spends(t, row.tip) && t.is_accepted === true && t.accepting_block_hash);
  if (!raw) return {...row, _src: 'rest', coverage: 'address-window', acceptance: 'UNKNOWN'};
  return {...row, _src: 'rest', indexStatus: 'STALE', acceptance: 'UNKNOWN',
    latestTxid: hash32(raw.transaction_id), accepting: hash32(raw.accepting_block_hash), updatedAt: Date.now(), coverage: 'spender-hint'};
}

/** Stateful, bounded resolver. Cursors are hints scoped to this detail session; every result is rechecked on node. */
export class RestRoundResolver {
  constructor(profile, options = {}) {
    const {evidence = null, ...rest} = options;
    this.net = requireNet(rest.net); this.profile = profile; this.options = {...rest, net: this.net}; this.sharedEvidence = evidence;
    ensure(!evidence || (evidence.net.genesis === this.net.genesis && evidence.profileId === profile.id), 'RESOLVER_EVIDENCE_CONTEXT');
    this.offsets = new Map(); this.discoveryOffsets = new Map(); this.nodeCursors = new Map(); this.searchVersion = 0;
  }
  pageEvidence(link, page, txid, accepting, sink = null) {
    return this.sharedEvidence ? this.sharedEvidence.fromPage(link, page, txid, accepting, sink) : acceptanceFromPage(page, txid, accepting, sink);
  }
  resetSearch(cid) { this.searchVersion++; this.nodeCursors.delete(cid); this.offsets.delete(cid); }
  searchProgress(cid) {
    const c = this.nodeCursors.get(cid);
    return c ? {pages: c.pages, blueScore: String(c.blue), source: 'node'} : null;
  }
  /** A resumable location search, never live authority. Full pages are bounded by a blue-score target and the node's
   * own batch limit. Re-read the cursor header on every call; a removed cursor restarts from the verified predecessor. */
  async nodeSpender(link, cid, ev, {signal, maxPages = 3} = {}) {
    ensure(Number.isSafeInteger(maxPages) && maxPages > 0 && maxPages <= 3, 'NODE_SEARCH_PAGE_BUDGET');
    const context = queryContext(link), version = this.searchVersion;
    const check = () => {
      signal?.throwIfAborted();
      if (version !== this.searchVersion || !sameConnectionContext(context, queryContext(link))) throw failure('READ_VIEW_CHANGED');
    };
    const header = async hash => {
      const b = (await link.call('getBlock', {hash, includeTransactions: false})).block; check();
      ensure(b?.header?.hash === hash, 'NODE_SEARCH_HEADER'); return b;
    };
    let cursor = this.nodeCursors.get(cid);
    if (cursor && (cursor.tip !== ev.txid || !sameConnectionContext(cursor.context, context))) { this.nodeCursors.delete(cid); cursor = null; }
    if (cursor) {
      const b = await header(cursor.from);
      if (b.verboseData?.isChainBlock !== true || uint(b.header.blueScore) !== cursor.blue) { this.nodeCursors.delete(cid); cursor = null; }
    }
    if (!cursor) {
      const accepting = await header(ev.accepting);
      ensure(accepting.verboseData?.isChainBlock === true, '接受块当前不在选中链上', 'NOT_CHAIN');
      const from = hash32(accepting.verboseData.selectedParentHash), parent = await header(from);
      ensure(parent.verboseData?.isChainBlock === true, '节点搜索起点已离开选中链', 'REORG');
      cursor = {tip: ev.txid, from, blue: uint(parent.header.blueScore), window: 100n, pages: 0, context};
    }
    for (let page = 0; page < maxPages; page++) {
      check();
      const sink = uint((await link.call('getSinkBlueScore')).blueScore); check();
      ensure(sink >= cursor.blue, 'SINK_BEHIND');
      const target = cursor.blue + cursor.window, min = sink > target ? sink - target : 0n;
      ensure(min <= BigInt(Number.MAX_SAFE_INTEGER), 'NODE_SEARCH_RANGE');
      const full = await link.call('getVirtualChainFromBlockV2', {startHash: cursor.from, dataVerbosityLevel: 'Full', minConfirmationCount: Number(min)}); check();
      if (!Array.isArray(full?.removedChainBlockHashes) || full.removedChainBlockHashes.length) {
        this.nodeCursors.delete(cid); ensure(false, '节点搜索期间选中链发生变化', 'REORG');
      }
      const added = full.addedChainBlockHashes, rows = full.chainBlockAcceptedTransactions;
      ensure(Array.isArray(added) && added.length <= 20000 && Array.isArray(rows) && rows.length === added.length, 'NODE_SEARCH_ROWS');
      let blue = cursor.blue, found = null;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]; hash32(added[i]);
        ensure(row?.chainBlockHeader?.hash === added[i] && Array.isArray(row.acceptedTransactions), 'NODE_SEARCH_ROW');
        const nextBlue = uint(row.chainBlockHeader.blueScore); ensure(nextBlue > blue, 'NODE_SEARCH_ORDER'); blue = nextBlue;
        if (!found) {
          const raw = row.acceptedTransactions.find(t => t.inputs?.some(input => input.previousOutpoint?.transactionId === ev.txid && input.previousOutpoint.index === 0));
          if (raw) found = this.pageEvidence(link, full, raw.verboseData?.transactionId, added[i]);
        }
      }
      check();
      if (found) { this.nodeCursors.delete(cid); return {ev: found, page: full}; }
      cursor = {...cursor, pages: cursor.pages + 1, ...(added.length ? {from: added.at(-1), blue, window: 100n} : {window: cursor.window * 2n})};
      this.nodeCursors.set(cid, cursor); // only a query position, including when this bounded read later times out
      if (!added.length && min === 0n) return null; // no forward segment yet; not proof that the round is terminal
    }
    return null;
  }
  async evidence(link, txid, accepting, signal) {
    if (!accepting) {
      const raw = await restTransaction(txid, {...this.options, signal}), claim = restAcceptance(raw, txid);
      ensure(claim.outcome === 'ACCEPTED', 'REST_ACCEPTANCE_UNKNOWN'); accepting = claim.acceptingBlockHash;
    }
    return this.sharedEvidence ? (await this.sharedEvidence.read(txid, accepting, {link, signal, origin: this.readOrigin(link)})).ev : acceptedPair(link, txid, accepting);
  }
  async locate(cid, {signal, maxPages = 4, cursor = 0} = {}) {
    let at = this.discoveryOffsets.get(cid) ?? cursor;
    for (let p = 0; p < maxPages; p++) {
      const page = await discoverRestRounds(this.profile, {...this.options, signal, cursor: at});
      const hit = page.items.find(x => x.cid === cid); if (hit) { this.discoveryOffsets.delete(cid); return hit; }
      if (page.nextCursor === null) { this.discoveryOffsets.delete(cid); throw new Error('ROUND_NOT_FOUND_IN_REST_WINDOW'); }
      at = page.nextCursor; this.discoveryOffsets.set(cid, at);
    }
    throw new Error('REST_DISCOVERY_CONTINUES');
  }
  readOrigin(link) { return this.origins?.get(link) ?? null; }
  /** History pruned by the node: an untrusted candidate ledger (indexer detail or cached view) is verified against the
   * live UTXO below the pruning point (liveBelowPruningPoint). If that state was spent meanwhile, its spender is recent:
   * the newest REST page of the ledger-derived state address locates it, and replay verifies its body as usual.
   * Returns {result} (a resolve() result), {ev} (the spender's accepted evidence) or null. */
  async prunedFallback(link, cid, row, signal) {
    if (!row?.state || !row.purchases || !row.origin) return null;
    let ledger;
    try { ledger = ledgerFromDetail(row, this.profile); } catch { return null; }
    try {
      const live = await liveBelowPruningPoint(link, this.profile, cid, {ledger, origin: row.origin, genesisTxid: row.genesisTxid ?? null});
      signal?.throwIfAborted();
      this.offsets.delete(cid); this.nodeCursors.delete(cid);
      return {result: {view: {...viewFromLive(live, cid), basis: PRUNED_BASIS}, live, replay: null, terminal: false}};
    } catch (e) {
      signal?.throwIfAborted();
      if (e?.code !== 'STALE_TIP' || !row.tip) return null;
    }
    let page;
    try { page = await restAddressTransactions(spkToAddress(p2sh(hex(blake2b256(S.scriptOf(ledger, this.profile)))), this.net.addressPrefix), {...this.options, signal}); }
    catch { signal?.throwIfAborted(); return null; }
    for (const raw of page.items.filter(raw => spends(raw, row.tip))) {
      try {
        const ev = await this.evidence(link, hash32(raw.transaction_id), raw.accepting_block_hash, signal);
        ensure(ev.tx.inputs.some(i => i.previousOutpoint.transactionId === row.tip.transactionId && i.previousOutpoint.index === row.tip.index), 'SPENDER_MISMATCH');
        return {ev};
      } catch { signal?.throwIfAborted(); }
    }
    return null;
  }
  async resolve(link, cid, candidate, {signal, maxSteps = 12, nodePages = 3, anchor = null, initialEvidence = null, origin: readerOrigin = null, captured = false} = {}) {
    if (this.sharedEvidence && !captured) return this.sharedEvidence.capture(link, shared => {
      this.origins ??= new WeakMap(); this.origins.set(shared, readerOrigin);
      return this.resolve(shared, cid, candidate, {signal, maxSteps, nodePages, anchor, initialEvidence, origin: readerOrigin, captured: true});
    }, {origin: readerOrigin, signal});
    ensure(linkNet(link).genesis === this.net.genesis, 'RESOLVER_NETWORK_MISMATCH');
    signal?.throwIfAborted();
    // Read depth BEFORE obtaining the Full body: a settled terminal always has a new post-threshold verification.
    const virtualDaa = await link.currentDaa();
    let row = candidate?.latestTxid ? candidate : initialEvidence
      ? {latestTxid: initialEvidence.txid, accepting: initialEvidence.accepting}
      : await this.locate(cid, {signal});
    // initialEvidence is a current-runtime node Full handoff; it never substitutes for replay or live checks.
    // Replay, CID/origin authentication and the actual successor UTXO check below are still mandatory.
    let ev = initialEvidence, fast = null, refreshedFull = false;
    // A recent node Full page may already contain the known transaction or its spender.
    // This avoids locating an accepting block and fetching the same body again on the hot path.
    if (anchor && !ev) {
      try {
        fast = await link.call('getVirtualChainFromBlockV2', {startHash: anchor, dataVerbosityLevel: 'Full', minConfirmationCount: 0});
        if (fast.removedChainBlockHashes?.length === 0) {
          for (const block of fast.chainBlockAcceptedTransactions ?? []) {
            const raw = block.acceptedTransactions?.find(t => t.verboseData?.transactionId === row.latestTxid ||
              (row.tip && t.inputs?.some(i => i.previousOutpoint.transactionId === row.tip.transactionId && i.previousOutpoint.index === row.tip.index)));
            if (raw) { ev = this.pageEvidence(link, fast, raw.verboseData.transactionId, block.chainBlockHeader.hash); break; }
          }
        }
      } catch { signal?.throwIfAborted(); fast = false; }
    }
    // A state already verified below the pruning point has no body to read: recheck it (or find its spender) first.
    let prunedTried = false;
    if (!ev && row.basis === PRUNED_BASIS) {
      prunedTried = true;
      const p = await this.prunedFallback(link, cid, row, signal);
      if (p?.result) return p.result;
      if (p?.ev) ev = p.ev;
    }
    if (!ev) try { ev = await this.evidence(link, row.latestTxid, row.accepting, signal); }
    catch (e) {
      // An old accepting location may have been displaced. REST only supplies a new location; still verify it.
      signal?.throwIfAborted();
      try { ev = await this.evidence(link, row.latestTxid, null, signal); }
      catch (moved) {
        signal?.throwIfAborted();
        try {
          if (!row.genesisTxid || row.genesisTxid === row.latestTxid) throw moved;
          // A cached successor/terminal can disappear entirely. Restart at authenticated genesis, not at the stale tip.
          ev = await this.evidence(link, row.genesisTxid, null, signal); this.offsets.delete(cid);
        } catch (lost) {
          signal?.throwIfAborted();
          // Every body is unreadable, e.g. pruned by the node. A candidate ledger may still match the live UTXO.
          const p = prunedTried ? null : await this.prunedFallback(link, cid, row, signal);
          if (p?.result) return p.result;
          if (!p?.ev) throw lost;
          ev = p.ev;
        }
      }
    }
    for (let step = 0; step < maxSteps; step++) {
      signal?.throwIfAborted();
      const r = await replayEvidence(link, this.profile, ev, {cid, origin: row.origin});
      const origin = row.origin ?? r.origin;
      const genesisTxid = row.genesisTxid ?? (r.action === 'GENESIS' ? ev.txid : null);
      const ledger = r.next ?? r.spent;
      const snapshot = {ledger: S.encodeLedger(ledger), tip: {transactionId: ev.txid, index: 0}, origin,
        value: ev.tx.outputs[0].value, scriptPublicKey: ev.tx.outputs[0].scriptPublicKey,
        covenantId: cid, utxoDaa: ev.acceptingDaa, currentDaa: ev.acceptingDaa};
      const live = {ledger, snapshot, accepting: ev.accepting, acceptedTx: ev, genesisTxid};
      if (r.terminal) {
        this.nodeCursors.delete(cid);
        // Output 0 of a terminal spend is an ordinary payment, not a state script: never expose it as the round SPK.
        const view = {...viewFromLive(live, cid), status: 'close', tip: null, value: '0', scriptPublicKey: null, terminal: r.terminal, indexStatus: 'TERMINAL'};
        const check = terminalCheck(view, virtualDaa, ev.acceptingDaa), settled = terminalSettled(view, check);
        // Cached/handed-off bodies may prove first acceptance, never settlement using a later DAA.
        const threshold = ev.acceptingDaa + REORG_RECHECK_DAA;
        if (settled && this.sharedEvidence && (this.sharedEvidence.readDaa(ev) ?? -1n) < threshold) {
          ev = (await this.sharedEvidence.read(ev.txid, ev.accepting, {link, fresh: true, minDaa: threshold, origin: readerOrigin, signal})).ev;
          step--; continue;
        }
        if (settled && !this.sharedEvidence && initialEvidence === ev) return this.resolve(link, cid, view, {signal, maxSteps, anchor: null});
        return {view: {...view, terminalSettled: settled, acceptance: settled ? 'ACCEPTED' : 'CONFIRMING'}, live: null, replay: r,
          terminal: true, terminalSettled: settled, terminalCheck: check};
      }
      S.verifySnapshot(snapshot, this.profile);
      row = viewFromLive(live, cid);
      const address = spkToAddress(snapshot.scriptPublicKey, this.net.addressPrefix), utxos = await commonUtxos(link, address);
      const u = utxos.find(u => u.outpoint.transactionId === ev.txid && u.outpoint.index === 0);
      if (u) {
        ensure(!u.isCoinbase && u.value === snapshot.value && u.covenantId === cid && u.daa === ev.acceptingDaa && stable(u.spk) === stable(snapshot.scriptPublicKey), 'LIVE_STATE_MISMATCH');
        snapshot.currentDaa = await link.currentDaa();
        this.offsets.delete(cid); this.nodeCursors.delete(cid); return {view: row, live, replay: r, terminal: false};
      }
      // One bounded recent Full page can resolve several successive transitions without re-fetching each body.
      if (anchor && fast === null) {
        try { fast = await link.call('getVirtualChainFromBlockV2', {startHash: anchor, dataVerbosityLevel: 'Full', minConfirmationCount: 0}); }
        catch { fast = false; }
      }
      let next = null;
      if (fast && fast.removedChainBlockHashes?.length === 0) {
        for (const block of fast.chainBlockAcceptedTransactions ?? []) {
          const raw = block.acceptedTransactions?.find(t => t.inputs?.some(i => i.previousOutpoint.transactionId === ev.txid && i.previousOutpoint.index === 0));
          if (raw) { next = this.pageEvidence(link, fast, raw.verboseData.transactionId, block.chainBlockHeader.hash); break; }
        }
      }
      if (!next && !refreshedFull) {
        // Continue the bounded node walk across refreshes. A STALE indexer can be hours behind: rereading just its
        // accepting parent's first page forever cannot find a later spender. REST remains an independent accelerator.
        refreshedFull = true;
        try {
          const found = await this.nodeSpender(link, cid, ev, {signal, maxPages: nodePages});
          if (found) { next = found.ev; fast = found.page; }
        } catch { signal?.throwIfAborted(); }
      }
      if (!next) {
        const previous = this.offsets.get(cid), offset = previous?.txid === ev.txid ? previous.offset : 0;
        // Revisit the newest page while resuming history: REST may publish the spender after our earlier scan.
        let tail = null;
        const seen = new Set();
        for (const at of offset ? [0, offset] : [0]) {
          let page;
          try { page = await restAddressTransactions(address, {...this.options, signal, offset: at}); }
          catch { signal?.throwIfAborted(); continue; }
          if (at === offset) tail = page;
          for (const raw of page.items.filter(raw => spends(raw, snapshot.tip))) {
            try {
              const txid = hash32(raw.transaction_id); if (seen.has(txid)) continue; seen.add(txid);
              const hit = await this.evidence(link, txid, raw.accepting_block_hash, signal);
              ensure(hit.tx.inputs.some(i => i.previousOutpoint.transactionId === ev.txid && i.previousOutpoint.index === 0), 'SPENDER_MISMATCH');
              next = hit; break;
            } catch { signal?.throwIfAborted(); }
          }
          if (next) break;
        }
        if (!next) {
          if (tail?.nextOffset != null) this.offsets.set(cid, {txid: ev.txid, offset: tail.nextOffset});
          else if (tail) this.offsets.delete(cid); // A successful tail ends this scan; errors never imply end-of-history.
          return {view: {...row, _src: 'cache', indexStatus: 'STALE'}, live: null, incomplete: true, candidate: row, progress: this.searchProgress(cid)};
        }
      }
      ev = next;
    }
    return {view: {...row, _src: 'cache', indexStatus: 'STALE'}, live: null, incomplete: true, candidate: row, progress: this.searchProgress(cid)};
  }
}
