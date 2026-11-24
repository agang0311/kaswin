/** Profile loader and script-frame helpers for Kaswin kUSDT v2 (7-template DAG). */
import {blake2b256, check, hex, p2sh, same, scriptFor, scriptPushes, templateHash, unhex} from '../../core.mjs';
import {
  decodeManagerState,
  decodeShardState,
  encodeManagerDispatchState,
  encodeManagerOpenOrSealedState,
  encodeShardOpenOrFrozenState,
  encodeShardPayoutState,
  encodeShardRefundState,
} from './codec.mjs';
import {
  FROZEN_MAINNET_TEMPLATE_HASHES,
  KUSDT_V2_TEMPLATE_ORDER,
  MAINNET_KUSDT_CID,
  STAGE,
} from './constants.mjs';

export const TEMPLATE_CONTRACT_NAMES = Object.freeze({
  s_payout: 'KusdtShardPayout',
  s_refund: 'KusdtShardRefund',
  s_frozen: 'KusdtShardFrozen',
  s_open: 'KusdtShardOpen',
  m_dispatch: 'KusdtManagerDispatch',
  m_sealed: 'KusdtManagerSealed',
  m_open: 'KusdtManagerOpen',
});

export function parseKusdtV2Frame(name, artifactJson, expectedHash = null) {
  const doc = typeof artifactJson === 'string' ? JSON.parse(artifactJson) : artifactJson;
  const contractName = TEMPLATE_CONTRACT_NAMES[name];
  check(contractName, `KUSDT_V2_UNKNOWN_TEMPLATE:${name}`);
  const c = doc?.contracts?.[contractName];
  check(c && c.compiled && Array.isArray(c.compiled.bytecode), `KUSDT_V2_ARTIFACT:${name}`);
  const span = c.compiled.state_span;
  check(span && Number.isInteger(span.offset) && Number.isInteger(span.len), `KUSDT_V2_SPAN:${name}`);
  const tailStart = span.offset + span.len;
  const bytecode = Uint8Array.from(c.compiled.bytecode);
  const tail = bytecode.slice(tailStart);
  check(tail.length > 0 && tail[0] === 0x6c, `KUSDT_V2_TAIL_BOUNDARY:${name}`);
  const hash = templateHash(tail);
  if (expectedHash) check(hash === expectedHash, `KUSDT_V2_HASH_MISMATCH:${name}`);
  const spend = c.entries?.spend;
  check(spend && typeof spend.dispatch_tag === 'string', `KUSDT_V2_DISPATCH_TAG:${name}`);
  unhex(spend.dispatch_tag, 4);
  return Object.freeze({
    name,
    contractName,
    tail,
    templateHash: hash,
    dispatchTag: spend.dispatch_tag,
  });
}

export function loadKusdtV2Profile(artifacts, {kusdtCid = MAINNET_KUSDT_CID, expectedHashes = FROZEN_MAINNET_TEMPLATE_HASHES, status = 'UNVALIDATED'} = {}) {
  check(typeof kusdtCid === 'string' && /^[0-9a-f]{64}$/.test(kusdtCid), 'KUSDT_V2_CID');
  const frames = {};
  for (const name of KUSDT_V2_TEMPLATE_ORDER) {
    check(artifacts && artifacts[name] != null, `KUSDT_V2_MISSING_ARTIFACT:${name}`);
    frames[name] = parseKusdtV2Frame(name, artifacts[name], expectedHashes?.[name] ?? null);
  }
  return Object.freeze({
    id: frames.m_open.templateHash,
    protocol: 'kaswin-kusdt-v2',
    kusdtCid,
    status,
    frames: Object.freeze(frames),
  });
}

export function templateNameForStage(stage) {
  switch (stage) {
    case STAGE.M_OPEN: return 'm_open';
    case STAGE.M_SEALED: return 'm_sealed';
    case STAGE.M_DISPATCH: return 'm_dispatch';
    case STAGE.S_OPEN: return 's_open';
    case STAGE.S_FROZEN: return 's_frozen';
    case STAGE.S_PAYOUT: return 's_payout';
    case STAGE.S_REFUND: return 's_refund';
    default: throw new Error(`KUSDT_V2_UNKNOWN_STAGE:${stage}`);
  }
}

export function encodeKusdtV2State(state) {
  switch (state.stage) {
    case STAGE.M_OPEN:
    case STAGE.M_SEALED:
      return encodeManagerOpenOrSealedState(state);
    case STAGE.M_DISPATCH:
      return encodeManagerDispatchState(state);
    case STAGE.S_OPEN:
    case STAGE.S_FROZEN:
      return encodeShardOpenOrFrozenState(state);
    case STAGE.S_PAYOUT:
      return encodeShardPayoutState(state);
    case STAGE.S_REFUND:
      return encodeShardRefundState(state);
    default:
      throw new Error(`KUSDT_V2_UNKNOWN_STAGE:${state.stage}`);
  }
}

export function redeemForState(state, profile) {
  const name = templateNameForStage(state.stage);
  const frame = profile.frames[name];
  check(frame, `KUSDT_V2_FRAME:${name}`);
  return scriptFor(encodeKusdtV2State(state), frame.tail);
}

export function scriptPubKeyForState(state, profile) {
  return p2sh(hex(blake2b256(redeemForState(state, profile))));
}

export function verifyKusdtV2Redeem(raw, profile, expectedKind = null) {
  check(raw instanceof Uint8Array && raw.length >= 2 && raw[0] === 0x6b, 'KUSDT_V2_REDEEM_PREFIX');
  for (const name of KUSDT_V2_TEMPLATE_ORDER) {
    const frame = profile.frames[name];
    if (raw.length <= frame.tail.length + 1) continue;
    const tailOffset = raw.length - frame.tail.length;
    if (!same(raw.slice(tailOffset), frame.tail)) continue;
    const statePushes = scriptPushes(raw.slice(1, tailOffset));
    if (statePushes.length !== 1) continue;
    const stateBytes = statePushes[0];
    const isManager = name.startsWith('m_');
    if (expectedKind === 'manager' && !isManager) throw new Error('KUSDT_V2_EXPECTED_MANAGER');
    if (expectedKind === 'shard' && isManager) throw new Error('KUSDT_V2_EXPECTED_SHARD');
    const state = isManager ? decodeManagerState(stateBytes) : decodeShardState(stateBytes);
    check(templateNameForStage(state.stage) === name, 'KUSDT_V2_STAGE_TEMPLATE_MISMATCH');
    check(same(redeemForState(state, profile), raw), 'KUSDT_V2_NONCANONICAL_REDEEM');
    return {name, state, redeem: raw, scriptPubKey: p2sh(hex(blake2b256(raw)))};
  }
  throw new Error('KUSDT_V2_UNRECOGNIZED_REDEEM');
}
