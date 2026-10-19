/** Display-only draw progress. Wall-clock estimates cannot produce READY or change observed scores. */
import {S, DAA_PER_SECOND} from '../../scripts/core.mjs';

export function drawReadinessView(progress, now = Date.now(), unit = 'TKAS') {
  const waiting = {ready: false, button: '正在核验开奖条件…', label: '正在向节点核验开奖等待条件…', percent: null, detail: null};
  const required = progress?.requiredConfirmations;
  const utxoDaa = progress?.sealedDaa ?? progress?.utxoDaa;
  const expired = progress?.phase === 'EXPIRED' ||
    (typeof progress?.currentDaa === 'bigint' && typeof utxoDaa === 'bigint' && progress.currentDaa >= utxoDaa + S.TIMEOUT_DELAY);
  if (expired) {
    // EXPIRED can come from the target-depth policy (DRAW_MAX_TARGET_DEPTH) shortly before the refund timeout opens.
    const left = typeof progress?.currentDaa === 'bigint' && typeof utxoDaa === 'bigint' ? utxoDaa + S.TIMEOUT_DELAY - progress.currentDaa : null;
    return {ready: false, button: '开奖已超时', label: '开奖已超时', percent: null,
      detail: left !== null && left > 0n ? `开奖目标块已接近共识最终性深度，开奖通道已关闭。封存满 432,000 DAA 后可使用下方的「超时转退款」（还差 ${left} DAA）。`
        : '封盘已超过 432,000 DAA 共识最终性时限，开奖通道已关闭。请使用下方的「超时转退款」退还票款。'};
  }
  if (!progress || progress.phase === 'CHECKING') return waiting;
  if (progress.phase === 'TARGET_CHECKING' && progress.retargeting) return {ready: false, button: '等待目标块确认', label: '开奖目标块已被短程重组替换，正在重新定位…', detail: '随机数仍取封存 100 DAA 后首个跨越边界的选中链区块；重组后按新的选中链重新确定，并重新累计 100 blue score 确认。', percent: 0};
  if (progress.phase === 'TARGET_CHECKING') return {ready: false, button: '等待目标块确认', label: '封存 100 DAA 已满足，正在定位开奖目标块…', detail: '已到达开奖边界，正在向节点获取目标块并核验确认数…', percent: 0};
  if (progress.phase === 'UNAVAILABLE') return {...waiting, button: '等待节点核验', label: '开奖条件尚未核验完成，等待节点更新。', detail: '可点击下方“重新向节点同步”重试。'};
  if (progress.phase === 'DAA_WAIT') {
    const remaining = progress.boundaryDaa - progress.currentDaa;
    if (remaining <= 0n) return waiting;
    const elapsed = Math.max(0, Math.floor((now - progress.observedAt) / 1000));
    const seconds = (remaining + BigInt(DAA_PER_SECOND) - 1n) / BigInt(DAA_PER_SECOND);
    const estimate = seconds > BigInt(elapsed) ? seconds - BigInt(elapsed) : 0n;
    const done = S.DRAW_DELAY - remaining;
    return {ready: false, button: '等待封存时间', label: `第一阶段：封存等待还差 ${remaining} DAA`,
      detail: estimate > 0n ? `需先封存满 100 DAA（预计约 ${estimate} 秒），随后等待目标块 100 blue score 确认。` : '第一阶段封存时间已满，正在向节点核验目标块…',
      percent: Number(done <= 0n ? 0n : done >= S.DRAW_DELAY ? 100n : done * 100n / S.DRAW_DELAY)};
  }
  if (progress.phase === 'TARGET_WAIT' && typeof required === 'bigint' && required > 0n) {
    const count = progress.confirmations ?? 0n;
    const diff = required > count ? required - count : 0n;
    const seconds = (diff + BigInt(DAA_PER_SECOND) - 1n) / BigInt(DAA_PER_SECOND);
    return {ready: false, button: '等待目标块确认', label: `第二阶段：开奖目标块确认 ${count}/${required} blue score`,
      detail: count > 0n ? `封存 100 DAA 已满足；目标块确认还差 ${diff} blue score（预计约 ${seconds} 秒）。` : '封存 100 DAA 已满足；目标块已产生，正在等待累计 100 次 blue score 确认（预计约 10 秒）。',
      percent: Number(count <= 0n ? 0n : count >= required ? 100n : count * 100n / required)};
  }
  if (progress.phase === 'READY' && typeof required === 'bigint' && required > 0n && progress.currentDaa >= progress.boundaryDaa && progress.confirmations >= required)
    return {ready: true, button: '核验并开奖', label: '开奖等待条件已就绪，可以开奖。',
      detail: `封存 100 DAA 与目标块 100 blue-score 确认均已满足，执行者获得 1 ${unit} 赏金。`, percent: 100};
  return waiting;
}
