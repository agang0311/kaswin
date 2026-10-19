/** Explain selected-chain ACCEPTED transactions using the fixed SIL semantics,
 * not our builder's stricter change layout or locktime choice. The new Profile
 * binds witness fee to actual amounts and binds the REFUND executor output.
 * Node acceptance is established first; the pure interpreter is not a VM. */
import {ensure, stable, REGISTRATION_SOMPI} from '../core.mjs';
import {linkNet} from '../chain/network-schema.mjs';
import {acceptedPair} from '../chain/chain.mjs';
import {parseSpk} from '../chain/nodes.mjs';
import {decodeSpend, interpretAccepted} from '../core/lib/accepted.js';
import {verifyGenesisAnnouncement} from '../core/lib/genesis-discovery.js';

import {requireRuntimeProfile} from '../contract/runtime.mjs';

function inputValues(ev) {
  ensure(Array.isArray(ev.inputs) && ev.inputs.length === ev.tx.inputs.length && ev.inputs.every(u => u && typeof u.value === 'bigint' && u.value > 0n), '接受交易缺少完整输入金额，无法核对真实费用');
  return ev.inputs.map(u => u.value);
}
export async function replayAccepted(pair, profile, txid, accepting, context = {}) {
  requireRuntimeProfile(profile);
  return replayEvidence(pair, profile, await acceptedPair(pair, txid, accepting), context);
}
/** Interpret already obtained node acceptance; never pass REST bodies or persisted receipts as fresh evidence. */
export async function replayEvidence(pair, profile, ev, context = {}) {
  requireRuntimeProfile(profile);
  const net = linkNet(pair);
  const {txid, accepting, tx} = ev, in0 = ev.inputs[0];
  const values = inputValues(ev);
  ensure(in0 && typeof in0.daa === 'bigint' && typeof in0.spk === 'string', '接受交易缺少 input0 上下文');
  if (!in0.covenantId) {
    const genesis = replayGenesis(profile, ev, values, net.registry.spk);
    ensure(context.cid === undefined || context.cid === genesis.cid, '接受交易不属于所选轮次');
    if (context.origin) ensure(stable(context.origin) === stable(tx.inputs[0].previousOutpoint), '见证 origin 与轮次资料不一致');
    return genesis;
  }
  ensure(ev.inputs.filter(u => u.covenantId === in0.covenantId).length === 1, '同一轮次有多个输入');
  const w = decodeSpend(tx.inputs[0].signatureScript, profile, context.origin);
  ensure(context.cid === undefined || context.cid === in0.covenantId, '接受交易不属于所选轮次');
  const snapshot = {ledger: w.ledger, tip: tx.inputs[0].previousOutpoint, origin: w.origin, scriptPublicKey: parseSpk(in0.spk),
    covenantId: in0.covenantId, value: in0.value, utxoDaa: in0.daa, currentDaa: ev.acceptingDaa};
  const result = interpretAccepted(snapshot, profile, tx, values);
  let draw = result.draw;
  if (draw) {
    let targetDaa = null, headerMatches = null;
    try {
      const h = (await pair.call('getBlock', {hash: draw.target, includeTransactions: false})).block.header;
      headerMatches = h.hash === draw.target && h.acceptedIdMerkleRoot === draw.seqCommit; targetDaa = String(h.daaScore);
    } catch {}
    ensure(headerMatches !== false, '开奖目标区块头的序列承诺与证明不一致');
    draw = {...draw, targetDaa, headerChecked: headerMatches === true};
  }
  return {...result, origin: w.origin, draw, txid, accepting, acceptingDaa: ev.acceptingDaa, confirmations: ev.confirmations,
    computeMass: ev.computeMass, storageMass: tx.storageMass, budget: tx.inputs[0].computeBudget};
}
function replayGenesis(profile, ev, values, registrySpk) {
  const tx = ev.tx, o0 = tx.outputs[0];
  ensure(o0?.covenant?.authorizingInput === 0, '这不是 Kaswin 创建交易（输出 0 没有 covenant 绑定）');
  const covOutputs = tx.outputs.flatMap((o, i) => o.covenant?.covenantId === o0.covenant.covenantId ? [i] : []);
  const ledger = verifyGenesisAnnouncement({accepted: true, payload: tx.payload, authorizingOutpoint: tx.inputs[0].previousOutpoint, outputIndex: 0,
    value: o0.value, spk: o0.scriptPublicKey, covenantId: o0.covenant.covenantId, authorizingInput: 0, covenantOutputIndices: covOutputs}, profile);
  const outputs = tx.outputs.map((o, i) => ({...o, constrained: i === 0,
    // Display role only. The registration address may be user-chosen, so recognize it by position/value like the builder.
    role: i === 0 ? 'STATE' : i === 1 && !o.covenant && o.value === REGISTRATION_SOMPI &&
      (stable(o.scriptPublicKey) === stable(registrySpk) || o.scriptPublicKey.script !== '20' + ledger.ownerKey + 'ac' || tx.outputs.length > 2) ? 'REGISTRY' : 'AUXILIARY'}));
  const fee = values.reduce((a, v) => a + v, 0n) - tx.outputs.reduce((a, o) => a + o.value, 0n);
  ensure(fee >= 0n, '接受交易费用为负');
  return {txid: ev.txid, origin: tx.inputs[0].previousOutpoint, accepting: ev.accepting, acceptingDaa: ev.acceptingDaa, confirmations: ev.confirmations, action: 'GENESIS', actorKey: ledger.ownerKey,
    fee, witnessFee: null, external: 0n, module: 'open', spent: null, next: ledger, terminal: null, outputs, constrainedOutputs: 1, draw: null, winner: null,
    computeMass: ev.computeMass, storageMass: tx.storageMass, budget: tx.inputs[0].computeBudget, cid: o0.covenant.covenantId};
}
