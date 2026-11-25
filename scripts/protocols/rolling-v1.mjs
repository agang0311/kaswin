/** Rolling v1 ProtocolAdapter (ProtocolPlugin) implementation.
 * Wraps the existing Rolling v1 state machine, transaction builder, intent verifier, catch-up logic,
 * and UI view-model hooks behind the multi-covenant ProtocolAdapter interface without changing any wire/consensus semantics. */
import {check, identify, MAX_TICKETS, verifyManager} from '../core.mjs';
import {kasAsset} from './registry.mjs';
import {sequentialBuyReceipt, sequentialRefundReceipt, sequentialShardRefundReceipts} from './receipts.mjs';
import {emptyRound, validateRound, roundFromText, roundToText, availableActions, advanceRound, describeRound, shardCatalog} from '../round/round.mjs';
import {prepareOperation, signAndRecord, liveRound} from '../round/prepare.mjs';
import {authenticateIntent, submitIntent} from '../tracking/intent.mjs';
import {verifyIndexedSnapshot, materializeIndexedDocument, verifyDrawReceipt} from '../round/indexer-client.mjs';
import {syncRoundThreeTier, discoverRestRollingRounds} from '../round/catchup.mjs';

const FREE_ACTIONS = Object.freeze(['PAY_OLD', 'PAY_SELF', 'REFUND_OLD', 'REFUND_SELF']);

/** Map a Rolling v1 round into the protocol-agnostic summary used by shared list/detail/progress views. */
export function rollingV1Summary(round, {profile, net = null} = {}) {
  const asset = kasAsset(net);
  let phase = 'OPEN';
  let subPhase = 'sales';
  let settlementProgress = null;
  if (round.terminal === 'PAID' || round.terminal === 'EMPTY') {
    phase = 'DONE';
    subPhase = round.terminal;
  } else if (round.terminal === 'REFUNDED') {
    phase = 'DONE';
    subPhase = 'REFUNDED';
  } else if (round.manager) {
    let mod = null;
    try {
      const state = verifyManager({...round.manager, currentDaa: round.manager.utxoDaa}, profile);
      mod = state.module;
    } catch {}
    subPhase = mod ?? 'unknown';
    if (mod === 'sales') phase = 'OPEN';
    else if (mod === 'sealed') phase = 'SEALED';
    else if (mod === 'win') {
      phase = 'SETTLING';
      const remaining = (round.frozen?.length ?? 0) + 1;
      const paid = round.receipts?.filter(rc => rc.action === 'PAY_OLD' || rc.action === 'PAY_SELF').length ?? 0;
      settlementProgress = {done: paid, total: paid + remaining, labelKey: 'PAYOUT'};
    } else if (mod === 'refund') {
      phase = 'REFUNDING';
      const remaining = (round.frozen?.length ?? 0) + 1;
      const refunded = round.receipts?.filter(rc => rc.action === 'REFUND_OLD' || rc.action === 'REFUND_SELF').length ?? 0;
      settlementProgress = {done: refunded, total: refunded + remaining, labelKey: 'REFUND'};
    }
  }
  return {
    protocolId: 'rolling-v1',
    profileId: round.profileId ?? profile.id,
    roundId: round.cid,
    asset,
    phase,
    subPhase,
    terminal: round.terminal ?? null,
    ticketsSold: round.bought ?? 0,
    ticketCap: round.settings?.ticketCap ?? 0,
    ticketPrice: round.settings?.ticketPrice ?? 0n,
    settlementProgress,
  };
}

export function createRollingV1Adapter({profile, canCreate = true} = {}) {
  check(profile && typeof profile.id === 'string', 'ROLLING_V1_PROFILE');
  const profileId = profile.id;
  return Object.freeze({
    id: 'rolling-v1',
    name: 'Rolling v1',
    profileId,
    profile,
    supportedNetworks: Object.freeze(['mainnet', 'tn10']),
    supportsNetwork() { return true; },
    displayName(net = null) {
      return `${net?.unit ?? 'KAS'} (Rolling v1)`;
    },
    capabilities: Object.freeze({
      canCreate: !!canCreate,
      multiShardSelect: false,
      pullRefund: false,
      supportsExecIncentive: false,
      supportsBudgetCalculator: true,
      supportsBatchSettlement: true,
      supportsIntentResend: true,
      freeActions: FREE_ACTIONS,
      customRoundSync: false,
      customLifecycle: false,
    }),
    assetFor(net = null) { return kasAsset(net); },
    matchesRound(r) {
      if (!r || typeof r !== 'object') return false;
      if (r.kusdt) return false;
      if (r.protocol && r.protocol !== 'rolling-v1') return false;
      if (r.protocolId && r.protocolId !== 'rolling-v1') return false;
      return !r.profileId || r.profileId === profileId;
    },
    viewMeta(net = null) {
      return Object.freeze({
        protocolId: 'rolling-v1',
        profileId,
        displayName: `${net?.unit ?? 'KAS'} (Rolling v1)`,
        shardModel: 'sequential',
        maxShards: 256,
        supportsBatchSettlement: true,
        supportsIntentResend: true,
        freeActions: FREE_ACTIONS,
        actionStyle: 'sequential',
      });
    },
    createSpec(net = null) {
      const asset = kasAsset(net);
      return Object.freeze({
        protocolId: 'rolling-v1',
        profileId,
        name: 'Rolling v1',
        displayName: `${asset.symbol} (Rolling v1)`,
        layout: 'sequential_cap',
        supportedOnNet: true,
        asset,
        priceMin: 100_000_000n,
        priceMax: null,
        fixedTicketCap: null,
        minTicketCap: 3,
        maxTicketCap: MAX_TICKETS,
        fixedMinTickets: null,
        minTicketsFloor: 3,
        shardSize: 256,
        maxShards: 256,
        creatorDepositSompi: 400_000_000n,
        minCloseMinutes: 1,
        maxCloseMinutes: 10080,
      });
    },
    roundFingerprint(r) {
      if (!r) return '';
      return `${r.step ?? 0}:${r.terminal ?? ''}:${r.manager ? `${r.manager.outpoint.transactionId}:${r.manager.outpoint.index}` : '-'}:${r.frozen?.length ?? 0}:${r.history ? 'h' : ''}`;
    },
    isNodeVerified(r) {
      return !!r?.terminal || !!r?.manager;
    },
    isTerminalImmutable(r) {
      return !!r?.terminal && (r.terminal === 'EMPTY' || !!r.history);
    },
    lockedSompi(r) {
      return r?.manager ? r.manager.value + (r.frozen ?? []).reduce((n, x) => n + x.value, 0n) : 0n;
    },
    emptyRound(args) { return emptyRound({...args, profileId}); },
    validateRound(r, opts = {}) { return validateRound(r, profile, {...opts, profileId}); },
    roundFromText(text, opts = {}) { return roundFromText(text, profile, {...opts, profileId}); },
    roundToText(r, opts = {}) { return roundToText(r, profile, {...opts, profileId}); },
    availableActions(r, currentDaa) { return availableActions(r, profile, currentDaa); },
    uiActions(r, currentDaa = null) { return availableActions(r, profile, currentDaa ?? 0n); },
    advanceRound(r, accepted, tx, accessor) { return advanceRound(r, accepted, tx, profile, accessor); },
    describeRound(r, currentDaa) { return describeRound(r, profile, currentDaa); },
    shardCatalog(r, walletKey = null) { return shardCatalog(r, profile, walletKey); },
    holdingsOf(r, facts, shards, walletKey) {
      if (!walletKey || !r?.manager || !['sales', 'sealed'].includes(facts?.module ?? '')) return null;
      if (shards) {
        let mine = 0;
        let total = 0;
        for (const s of shards) { mine += s.mineCount; total += s.tickets; }
        return {tickets: mine, total};
      }
      try {
        let mine = 0;
        let total = 0;
        const add = recs => {
          let prev = 0;
          for (const x of recs) {
            const c = x.end - prev;
            prev = x.end;
            total += c;
            if (x.key === walletKey) mine += c;
          }
        };
        const m = identify(r.manager.redeemScript, profile);
        if (m.module === 'frozen') return null;
        add(m.records);
        for (const z of r.frozen ?? []) {
          const s = identify(z.redeemScript, profile);
          add(s.records);
        }
        return {tickets: mine, total};
      } catch {
        return null;
      }
    },
    interactiveModel() { return null; },
    matchBuyReceipt(sh, rec, r, shards) { return sequentialBuyReceipt(sh, rec, r, shards); },
    matchRefundReceipt(sh, rec, r, shards) { return sequentialRefundReceipt(sh, rec, r, shards); },
    shardRefundReceipts(sh, r, shards) { return sequentialShardRefundReceipts(sh, r, shards); },
    isPurchaseReceipt(t) { return t?.action === 'BUY'; },
    isRefundReceipt(t) { return t?.action === 'REFUND_OLD' || t?.action === 'REFUND_SELF'; },
    verifyDrawReceipt(r, rpc, opts) { return verifyDrawReceipt(r, rpc, profile, opts); },
    checkManagerLive(rpc, r) { return liveRound(rpc, r, profile, {targets: []}); },
    liveRound(rpc, r, opts = {}) { return liveRound(rpc, r, profile, opts); },
    prepareOperation(args) { return prepareOperation({...args, profile}); },
    signAndRecord(args) { return signAndRecord({...args, profile}); },
    authenticateIntent(intent, opts = {}) { return authenticateIntent(intent, profile, {...opts, profileId}); },
    submitIntent(rpc, intent, opts = {}) { return submitIntent(rpc, intent, profile, opts); },
    verifyIndexedSnapshot(doc, rpc, opts = {}) { return verifyIndexedSnapshot(doc, rpc, profile, {...opts, profileId}); },
    materializeIndexedDocument(doc, opts = {}) { return materializeIndexedDocument(doc, profile, opts); },
    syncRound(args) { return syncRoundThreeTier({...args, profile}); },
    discoverRestRounds(args) { return discoverRestRollingRounds({...args, profile}); },
    toRoundSummary(r, opts = {}) { return rollingV1Summary(r, {...opts, profile}); },
  });
}
