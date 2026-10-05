/** Independent replay of an ACCEPTED Kaswin F3.2 state transition.
 * From the accepted transaction (fetched from the configured node) we read the witness of input 0 (ABI order of builders.witness):
 *   action, originTxId, originIndex, tailBytes, genesisTail, nextTail, data, actorPk, fee, dispatchTag, redeemScript
 * The redeem script contains the spent ledger. We rebuild the spent snapshot, re-run the fixed core transition()
 * and require the actual outputs to equal the recomputed ones exactly. Acceptance already means the node executed
 * the covenant; the replay explains WHAT happened (winner, refunds, successor) without trusting the indexer.
 */
import {S, ensure, hex, unhex, transition, p2sh, blake2b256, ACTIONS, stable, cat, sample, authenticateDraw} from './core.mjs';
import {acceptedPair} from './chain.mjs';
import {parseSpk} from './nodes.mjs';
import {domainHash} from '../../../../packages/f3.2-core/lib/blake3.js';
import {verifyGenesisAnnouncement} from '../../../../packages/f3.2-core/lib/genesis-discovery.js';
import {DEFAULT_REGISTRY_SPK, REGISTRATION_SOMPI} from './core.mjs';

const ACTION_BY_ID = Object.fromEntries(Object.entries(ACTIONS).map(([k, v]) => [v, k]));

/** Data pushes of a script (only push opcodes are expected in a Kaswin witness). */
export function scriptPushes(bytes) {
  const out = []; let i = 0;
  while (i < bytes.length) {
    const op = bytes[i++]; let n;
    if (op === 0x00) { out.push(new Uint8Array()); continue; }
    if (op >= 0x51 && op <= 0x60) { out.push(new Uint8Array([op - 0x50])); continue; }
    if (op <= 75) n = op;
    else if (op === 0x4c) { n = bytes[i]; i += 1; }
    else if (op === 0x4d) { n = bytes[i] | bytes[i + 1] << 8; i += 2; }
    else if (op === 0x4e) { n = (bytes[i] | bytes[i + 1] << 8 | bytes[i + 2] << 16) + bytes[i + 3] * 16777216; i += 4; }
    else throw new Error(`见证脚本含非 push 操作码 0x${op.toString(16)}`);
    ensure(i + n <= bytes.length, '见证脚本截断');
    out.push(bytes.slice(i, i + n)); i += n;
  }
  return out;
}
/** Minimal non-negative ScriptNum (as produced by builders.pushInt). */
export function scriptNum(b) {
  if (b.length === 0) return 0n;
  ensure((b[b.length - 1] & 0x80) === 0, '见证整数为负');
  let n = 0n; for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]); return n;
}
const openSeq = (opening, base, parent) => {
  const ctx = domainHash('SeqCommitMergesetContext', opening.slice(base + 64, base + 88));
  return domainHash('SeqCommitmentMerkleBranchHash', cat(parent, domainHash('SeqCommitmentMerkleBranchHash', cat(opening.slice(base, base + 32), domainHash('SeqCommitmentMerkleBranchHash', cat(ctx, opening.slice(base + 32, base + 64)))))));
};
export const targetSeqOf = opening => hex(openSeq(opening, 32, openSeq(opening, 152, opening.slice(120, 152))));

export async function replayAccepted(pair, profile, txid, accepting) {
  const ev = await acceptedPair(pair, txid, accepting);
  const tx = ev.tx, in0 = ev.inputs[0];
  if (!in0?.covenantId) return replayGenesis(profile, ev);
  const pushes = scriptPushes(unhex(tx.inputs[0].signatureScript));
  ensure(pushes.length === 11, `见证字段数量不是 11（${pushes.length}）`);
  const action = ACTION_BY_ID[Number(scriptNum(pushes[0]))];
  ensure(action, '未知动作编号');
  const redeem = pushes[10];
  // Redeem script = 0x6b || push(ledger) || tail; the tail is one of the three pinned frames.
  const module = S.MODULES.find(m => { const t = profile.frames[m].tail; return redeem.length > t.length && hex(redeem.slice(redeem.length - t.length)) === hex(t); });
  ensure(module, '赎回脚本尾部不是固定 Profile 的任何模板');
  ensure(redeem[0] === 0x6b, '赎回脚本格式');
  const ledger = scriptPushes(redeem.slice(1, redeem.length - profile.frames[module].tail.length))[0];
  const spent = S.decodeLedger(ledger);
  const origin = {transactionId: hex(pushes[1]), index: Number(scriptNum(pushes[2]))};
  const snapshot = {ledger, tip: tx.inputs[0].previousOutpoint, origin, scriptPublicKey: parseSpk(in0.spk), covenantId: in0.covenantId, value: in0.value, utxoDaa: in0.daa, currentDaa: ev.acceptingDaa};
  S.verifySnapshot(snapshot, profile); // same template routes, same genesis CID, same P2SH, exact locked value
  const actorKey = hex(pushes[7]), fee = scriptNum(pushes[8]), data = pushes[6];
  const op = {action, actorKey};
  let draw = null;
  if (action === 'BUY') op.quantity = Number(data[0] | data[1] << 8 | data[2] << 16) + data[3] * 16777216;
  if (action === 'DRAW_AND_PAY' || action === 'DRAW') {
    const opening = data.slice(0, 240), seq = targetSeqOf(opening), target = hex(opening.slice(0, 32));
    op.opening = opening; op.accessor = {blockHash: target, sequenceCommitment: seq};
    // Display-only cross-check: the node's header of T carries the same sequencing commitment as the opening.
    // (Consensus already enforced this at spend via OpChainblockSeqCommit; old blocks may be pruned -> shown as unavailable.)
    let targetDaa = null, headerMatches = null;
    try { const h = (await pair.call('getBlock', {hash: target, includeTransactions: false})).block.header; headerMatches = h.acceptedIdMerkleRoot === seq; targetDaa = String(h.daaScore); }
    catch {}
    ensure(headerMatches !== false, '开奖目标区块头的序列承诺与证明不一致');
    draw = {opening: hex(opening), target, seqCommit: seq, boundaryDaa: (in0.daa + S.DRAW_DELAY).toString(), targetDaa, headerChecked: headerMatches === true};
  }
  const external = ev.inputs.slice(1).reduce((a, u) => a + (u?.value ?? 0n), 0n);
  const t = transition(snapshot, profile, op, fee, external);
  // Expected outputs exactly as builders.buildAction would produce them.
  const expected = [];
  if (t.next) expected.push({value: S.valueOf(t.next), scriptPublicKey: p2sh(hex(blake2b256(S.scriptOf(t.next, profile)))), covenant: {covenantId: snapshot.covenantId, authorizingInput: 0}, role: 'STATE'});
  for (const p of t.payments) expected.push({value: p.value, scriptPublicKey: p.spk, covenant: null, role: p.role});
  ensure(expected.length === tx.outputs.length, `输出数量与规则重算不一致（链上 ${tx.outputs.length}，重算 ${expected.length}）`);
  expected.forEach((e, i) => {
    const o = tx.outputs[i];
    ensure(o.value === e.value && stable(o.scriptPublicKey) === stable(e.scriptPublicKey) && stable(o.covenant) === stable(e.covenant), `输出 ${i}（${e.role}）与规则重算不一致`);
  });
  ensure(tx.lockTime === t.lockTime && tx.inputs[0].sequence === t.sequence, 'lockTime / sequence 与规则不一致');
  const actualFee = ev.inputs.reduce((a, u) => a + (u?.value ?? 0n), 0n) - tx.outputs.reduce((a, o) => a + o.value, 0n);
  ensure(actualFee === fee, '见证中的费用与实际费用不一致');
  let winner = null;
  if (action === 'DRAW_AND_PAY') {
    const winnerPay = t.payments.find(p => p.role === 'WINNER');
    const recIndex = Number(data[240] | data[241] << 8 | data[242] << 16) + data[243] * 16777216;
    const rec = S.records(spent)[recIndex];
    // Same steps the contract executed: seed from the PASS-A opening, then the 56-bit sample at counter 0 (1-based ticket).
    const smp = sample(authenticateDraw(snapshot, spent, op.opening, op.accessor));
    ensure(smp.ticket !== null, '链上派奖对应的样本被拒绝（不应出现）');
    const ticket = smp.ticket + 1;
    ensure(ticket > rec.end - rec.count && ticket <= rec.end, '重算的中奖票号不在链上派奖所指的购买记录内');
    winner = {record: recIndex, ticket, key: rec.key, ticketsInRecord: rec.count, firstTicket: rec.end - rec.count + 1, lastTicket: rec.end, prize: winnerPay.value};
  }
  return {txid, accepting, acceptingDaa: ev.acceptingDaa, confirmations: ev.confirmations, action, actorKey, fee, external, module, spent, next: t.next, terminal: t.terminal,
    outputs: expected.map((e, i) => ({...e, value: tx.outputs[i].value})), draw, winner, computeMass: ev.computeMass, storageMass: tx.storageMass, budget: tx.inputs[0].computeBudget};
}

/** GENESIS: no covenant input. Verify the KASWIN_F3_GENESIS payload, canonical initial ledger, template routes,
 * output 0 (0.2 TKAS, P2SH of the OPEN script, CID derived from input 0's outpoint) and the optional Registry output. */
function replayGenesis(profile, ev) {
  const tx = ev.tx, o0 = tx.outputs[0];
  ensure(o0?.covenant && o0.covenant.authorizingInput === 0, '这不是 Kaswin 创建交易（输出 0 没有 covenant 绑定）');
  const covOutputs = tx.outputs.map((o, i) => o.covenant?.covenantId === o0.covenant.covenantId ? i : -1).filter(i => i >= 0);
  const ledger = verifyGenesisAnnouncement({accepted: true, payload: tx.payload, authorizingOutpoint: tx.inputs[0].previousOutpoint, outputIndex: 0,
    value: o0.value, spk: o0.scriptPublicKey, covenantId: o0.covenant.covenantId, authorizingInput: 0, covenantOutputIndices: covOutputs}, profile);
  const outputs = tx.outputs.map((o, i) => ({value: o.value, scriptPublicKey: o.scriptPublicKey, covenant: o.covenant,
    role: i === 0 ? 'STATE' : (o.scriptPublicKey.script === DEFAULT_REGISTRY_SPK.script && o.value === REGISTRATION_SOMPI ? 'REGISTRY' : 'CHANGE')}));
  const fee = ev.inputs.reduce((a, u) => a + (u?.value ?? 0n), 0n) - tx.outputs.reduce((a, o) => a + o.value, 0n);
  return {txid: ev.txid, accepting: ev.accepting, acceptingDaa: ev.acceptingDaa, confirmations: ev.confirmations, action: 'GENESIS', actorKey: ledger.ownerKey, fee,
    external: 0n, module: 'open', spent: null, next: ledger, terminal: null, outputs, draw: null, winner: null, computeMass: ev.computeMass, storageMass: tx.storageMass, budget: tx.inputs[0].computeBudget, cid: o0.covenant.covenantId};
}
