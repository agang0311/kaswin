/** Multi-covenant ProtocolAdapter (ProtocolPlugin) contract and registry (routed by profileId / protocolId).
 * Platform code (wallet, chain, store, intent, controller, UI shell & views) interacts with covenants solely
 * through this registry so adding a new round/pool/shard covenant requires zero changes in web/. */
import {check, MAX_TICKETS} from '../core.mjs';

const HASH64 = /^[0-9a-f]{64}$/;
export const UNIVERSAL_PHASES = Object.freeze(['OPEN', 'CLOSING', 'SEALED', 'SETTLING', 'DONE', 'REFUNDING']);
export const ASSET_KINDS = Object.freeze(['KAS', 'KCC20']);
export const ASSET_DELTA_ROLES = Object.freeze(['NET', 'REFUNDABLE_DEPOSIT', 'CARRIER', 'FEE']);

export function kasAsset(net = null) {
  return Object.freeze({kind: 'KAS', symbol: net?.unit ?? 'KAS', decimals: 8, tokenCovenantId: null});
}

export function validateAssetDescriptor(asset, code = 'PROTOCOL_ASSET') {
  check(asset && typeof asset === 'object', code);
  check(ASSET_KINDS.includes(asset.kind), code);
  check(typeof asset.symbol === 'string' && asset.symbol.length >= 1 && asset.symbol.length <= 16, code);
  check(Number.isInteger(asset.decimals) && asset.decimals >= 0 && asset.decimals <= 18, code);
  if (asset.kind === 'KAS') check(asset.tokenCovenantId == null, code);
  else check(typeof asset.tokenCovenantId === 'string' && HASH64.test(asset.tokenCovenantId), code);
  return asset;
}

/** Standard fallback sequential creation spec (used when views/tests run without an explicit registry). */
export function defaultSequentialCreateSpec(net = null, {
  protocolId = 'default',
  profileId = '00'.repeat(32),
  name = 'Classic Round',
  displayName = null,
} = {}) {
  const asset = kasAsset(net);
  return Object.freeze({
    protocolId,
    profileId,
    name,
    displayName: displayName ?? `${asset.symbol} (${name})`,
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
}

export function validateProtocolAdapter(adapter) {
  check(adapter && typeof adapter === 'object', 'PROTOCOL_ADAPTER_INVALID');
  check(typeof adapter.id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(adapter.id), 'PROTOCOL_ADAPTER_ID');
  check(typeof adapter.name === 'string' && adapter.name.length >= 1 && adapter.name.length <= 64, 'PROTOCOL_ADAPTER_NAME');
  check(typeof adapter.profileId === 'string' && HASH64.test(adapter.profileId), 'PROTOCOL_ADAPTER_PROFILE_ID');
  check(typeof adapter.assetFor === 'function', 'PROTOCOL_ADAPTER_ASSET');
  check(adapter.capabilities && typeof adapter.capabilities === 'object', 'PROTOCOL_ADAPTER_CAPABILITIES');
  for (const fn of [
    'emptyRound', 'validateRound', 'roundFromText', 'roundToText', 'availableActions',
    'prepareOperation', 'signAndRecord', 'authenticateIntent', 'submitIntent',
    'verifyIndexedSnapshot', 'materializeIndexedDocument', 'syncRound', 'toRoundSummary',
  ]) {
    check(typeof adapter[fn] === 'function', `PROTOCOL_ADAPTER_METHOD:${fn}`);
  }
  return adapter;
}

/** Format a minimal-unit bigint amount with an asset descriptor (e.g. KAS=8, kUSDT=6). */
export function formatAssetAmount(amount, asset, {maxFrac = 4} = {}) {
  const n = typeof amount === 'bigint' ? amount : BigInt(amount);
  const decimals = asset?.decimals ?? 8;
  const neg = n < 0n;
  const abs = neg ? -n : n;
  if (decimals === 0) return (neg ? '-' : '') + abs.toString();
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fracRaw = (abs % base).toString().padStart(decimals, '0');
  const trimmed = fracRaw.slice(0, Math.min(decimals, maxFrac)).replace(/0+$/, '');
  return (neg ? '-' : '') + whole.toString() + (trimmed ? '.' + trimmed : '');
}

export function createProtocolRegistry(adapters, {defaultCreateProfileId = null, defaultUiCreateId = null} = {}) {
  check(Array.isArray(adapters) && adapters.length >= 1, 'PROTOCOL_REGISTRY_EMPTY');
  const byProfile = new Map();
  const byId = new Map();
  for (const raw of adapters) {
    const adapter = validateProtocolAdapter(raw);
    check(!byProfile.has(adapter.profileId), 'PROTOCOL_DUPLICATE_PROFILE');
    check(!byId.has(adapter.id), 'PROTOCOL_DUPLICATE_ID');
    byProfile.set(adapter.profileId, adapter);
    byId.set(adapter.id, adapter);
  }
  const all = [...byProfile.values()];
  const createDefault = defaultCreateProfileId
    ? byProfile.get(defaultCreateProfileId)
    : all.find(a => a.capabilities.canCreate === true) ?? null;
  check(createDefault && createDefault.capabilities.canCreate === true, 'PROTOCOL_DEFAULT_CREATE');
  const uiDefault = (defaultUiCreateId && byId.get(defaultUiCreateId)?.capabilities.canCreate)
    ? byId.get(defaultUiCreateId)
    : createDefault;

  return Object.freeze({
    list() { return [...all]; },
    profileIds() { return [...byProfile.keys()]; },
    has(profileId) { return typeof profileId === 'string' && byProfile.has(profileId); },
    get(profileId) { return typeof profileId === 'string' ? byProfile.get(profileId) ?? null : null; },
    getById(id) { return typeof id === 'string' ? byId.get(id) ?? null : null; },
    require(profileId) {
      const hit = typeof profileId === 'string' ? byProfile.get(profileId) : null;
      check(hit, 'UNSUPPORTED_PROFILE');
      return hit;
    },
    defaultForCreate() { return createDefault; },
    defaultUiCreateId() { return uiDefault.id; },
    /** Resolve the owning adapter for a round, preview, or discovered entry without hardcoding protocol IDs in callers. */
    resolveForRound(roundOrDoc) {
      if (!roundOrDoc || typeof roundOrDoc !== 'object') return createDefault;
      if (typeof roundOrDoc.profileId === 'string' && byProfile.has(roundOrDoc.profileId)) {
        return byProfile.get(roundOrDoc.profileId);
      }
      const pid = roundOrDoc.protocolId ?? roundOrDoc.protocol;
      if (typeof pid === 'string' && byId.has(pid)) return byId.get(pid);
      for (const a of all) {
        if (a !== createDefault && typeof a.matchesRound === 'function' && a.matchesRound(roundOrDoc)) return a;
      }
      for (const a of all) {
        if (typeof a.matchesRound === 'function' && a.matchesRound(roundOrDoc)) return a;
      }
      return null;
    },
    /** Build UI-consumable compatible profile entries for rules/settings/explore views on `net`. */
    compatibleProfiles(net = null) {
      return all.map(p => {
        const a = p.assetFor(net);
        const supportsNet = typeof p.supportsNetwork === 'function' ? !!p.supportsNetwork(net) : true;
        const displayName = typeof p.displayName === 'function' ? p.displayName(net) : `${a.symbol} (${p.name})`;
        return {
          protocolId: p.id,
          name: p.name,
          displayName,
          asset: a.symbol,
          assetDescriptor: a,
          profileId: p.profileId,
          tokenCovenantId: a.tokenCovenantId ?? null,
          supportsNet,
        };
      });
    },
    /** Build declarative creation form specs for all create-capable protocols (ordered with UI default first if specified). */
    createSpecs(net = null) {
      const creatable = all.filter(p => p.capabilities.canCreate === true);
      const ordered = uiDefault
        ? [uiDefault, ...creatable.filter(p => p.id !== uiDefault.id)]
        : creatable;
      return ordered.map(p => (typeof p.createSpec === 'function'
        ? p.createSpec(net)
        : defaultSequentialCreateSpec(net, {protocolId: p.id, profileId: p.profileId, name: p.name})));
    },
  });
}
