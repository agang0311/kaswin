/** Web reorg tracker, zero-depth policy (option B, 2026-10-13).
 * Web policy adapter over diagnosis.mjs, shared with the CLI ReorgGuard.
 * Scheduling/status-release/approval policies differ; the CLI synchronous journal is not imported here.
 * Query first. The ONLY send is the IDENTICAL signed bytes of this browser's own record: never rebuilt, never re-signed,
 * only while its inputs are all still live and it is absent from the mempool, inside the resend window (or on an
 * explicit user click), behind the submit lock, a durable CAS write and, for DRAW_AND_PAY, a fresh 100 blue-score
 * target check. Lost verdicts need two consecutive identical observations, each after a complete acceptance search.
 * Project policy, not consensus finality. */
import {errorText} from '../core.mjs';
import {mempoolEntry, inputsState} from '../chain/chain.mjs';
import {checkDraftDraw} from '../round/passa.mjs';
import {diagnoseRecord} from './diagnosis.mjs';

export const RESEND_WINDOW_MS = 30 * 60_000;   // automatic resend only this long after the user's submission
export const RESEND_LIMIT = 30;                 // same bound as the CLI rebroadcast limit
export const DIAG_GAP_MS = 8000;                // two observations of a verdict must be at least this far apart
export const PENDING_GRACE_MS = 15_000;         // a fresh submission propagates before absence is diagnosed
/** Own-record statuses the tracker follows. REPLACED (fee-bump family) is never resent: its replacement exists. */
export const TRACKED = new Set(['SUBMITTED', 'PENDING', 'UNKNOWN']);
/** Lost own records: inputs released, kept only for display and query-only reconciliation. */
export const LOST_STATUS = new Set(['CONFLICTED', 'DRIFTED']);
const PARENT_GONE = new Set(['CONFLICTED', 'DRIFTED', 'REJECTED', 'ARCHIVED', 'SUPERSEDED']);
const PARENT_ON_CHAIN = new Set(['ACCEPTED', 'CONFIRMING']);
const codeOf = e => e?.safeCode ?? e?.code ?? null;

export const VERDICT_TEXT = {
  MEMPOOL: '交易在节点内存池中，等待接受',
  DROPPED: '交易已从网络消失，所有输入仍未花费：可按原签名字节重发',
  DRAW_WAIT: '开奖目标块确认不足 100 次 blue score：等待，不重发',
  DRIFT: '封存状态在重组后以不同 DAA 重新接受，原开奖随机证明已失效：需要重新开奖',
  PROOF_INVALID: '开奖目标块已离开选中链或超出可用深度：不自动替换，可在核对后归档并重新开奖',
  PARENT_PENDING: '依赖的本机前一笔交易尚未被接受：等待',
  PARENT_LOST: '依赖的本机前一笔交易已失效：本笔不可能再生效',
  CONFLICT: '轮次状态输入已被其他交易花费：本轮已被他人推进（DIVERGED）',
  FUNDING_CONFLICT: '资金输入已被其他交易花费：本笔不可能再生效',
  UNREACHABLE: '节点暂时无法回答：保持占用，稍后再查',
};

/** Read-only diagnosis of an own record the complete acceptance search did NOT find. `own`: this browser's records. */
export async function diagnose(pair, r, own, profile) {
  const inputs = r.draft.inputUtxos;
  return diagnoseRecord({action: r.action, inputs,
    mempool: () => mempoolEntry(pair, r.txid), states: () => inputsState(pair, inputs),
    parentState: u => own.find(x => x.txid === u.outpoint.transactionId)?.status,
    onChain: PARENT_ON_CHAIN, gone: PARENT_GONE, describeError: errorText,
    proof: async st => {
      // The PASS-A witness commits to the sealed UTXO's DAA: a re-accepted seal at another DAA invalidates it for good.
      if (st[0].utxo.daa !== inputs[0].daa) return {verdict: 'DRIFT'};
      try { await checkDraftDraw(pair, {...r.draft, transaction: r.signed}, profile, r.origin); }
      catch (e) {
        const c = codeOf(e);
        if (c === 'DRAW_TARGET_UNCONFIRMED' || c === 'DRAW_CONFIRMATION_STALE') return {verdict: 'DRAW_WAIT'};
        if (c === 'PROOF_CONTEXT_INVALID') return {verdict: 'PROOF_INVALID'};
        return {verdict: 'UNREACHABLE', error: errorText(e)}; // unknown/unreadable is never permission to send or release
      }
      return null;
    },
  });
}

export const inResendWindow = (r, now = Date.now()) => now - (r.submittedAt ?? r.createdAt ?? 0) < RESEND_WINDOW_MS;
