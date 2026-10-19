// Shared cancellable operation budgets. Transport adapters select their own bounded timeout policy.
// Cancellation fences every RPC result: timed-out async tails cannot write evidence or send later.
// Policy (2026-10-17): a single step must never exceed 30s. Longer waits are built by repeating a
// bounded step and accumulating progress across iterations, not by widening one step's deadline.
export const LIMITS = Object.freeze({rpcMs: 15_000, connectMs: 30_000, stepMs: 30_000, tickMs: 30_000,
  acceptanceMs: 30_000, settleMs: 30_000, completionMs: 30_000, stopMs: 1000, runMs: 2 * 60 * 60_000});
export function failure(code) { return Object.assign(new Error(code), {safeCode: code}); }
/** Authority callbacks must complete synchronously; async success is not permission either. */
export function requireSyncPermission(result) {
  if (result?.then) {
    Promise.resolve(result).catch(() => {});
    throw failure('SYNC_SEND_GATE_REQUIRED');
  }
  return result;
}
export function withDeadline(task, {timeoutMs = LIMITS.stepMs, signal = null, code = 'OPERATION_TIMEOUT', onCancel = () => {}} = {}) {
  const ctl = new AbortController(), end = Date.now() + timeoutMs;
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const cancel = reason => {
    if (ctl.signal.aborted) return;
    ctl.abort(reason); rejectAbort(reason);
    try { onCancel(reason); } catch {} // cleanup must not replace the original failure
  };
  const relay = () => cancel(signal.reason ?? failure('OPERATION_CANCELLED'));
  const timer = setTimeout(() => cancel(failure(code)), Math.max(0, timeoutMs));
  const scope = {signal: ctl.signal, remaining: () => Math.max(0, end - Date.now()),
    check() { if (ctl.signal.aborted) throw ctl.signal.reason; if (Date.now() >= end) { cancel(failure(code)); throw ctl.signal.reason; } }};
  signal?.addEventListener('abort', relay, {once: true});
  if (signal?.aborted) relay();
  const work = Promise.resolve().then(() => { scope.check(); return task(scope); });
  return Promise.race([work, aborted]).then(value => { scope.check(); return value; }).finally(() => {
    clearTimeout(timer); signal?.removeEventListener('abort', relay);
  });
}
export function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(); };
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', abort, {once: true}); if (signal?.aborted) abort();
  });
}
/** Identity of an actual RPC connection and its observed selected-chain revision. Not an acceptance proof. */
export function queryContext(target) {
  if (typeof target.readContext === 'function') return target.readContext();
  const node = target.nodes?.[0] ?? target;
  return {node, socket: node.ws ?? null, epoch: node.epoch ?? 0, revision: node.chainRevision ?? 0};
}
/** Same physical RPC session. Callers that use this must separately fence the specific facts their read depends on. */
export function sameConnectionContext(a, b) {
  return !!a && !!b && a.node === b.node && a.socket === b.socket && a.epoch === b.epoch && a.socket?.readyState === 1;
}
export function sameQueryContext(a, b) {
  return !!a && !!b && a.node === b.node && a.socket === b.socket && a.epoch === b.epoch && a.revision === b.revision &&
    a.socket?.readyState === 1;
}
/** Scoped link / raw-RPC view. Fourth call arg carries cancellation and the synchronous transport gate. */
export function scopedLink(target, scope) {
  const checked = async task => { scope.check(); const value = await task(); scope.check(); return value; };
  return {
    net: target.net,
    call: (m, a, ms = LIMITS.rpcMs, options = {}) => checked(() => target.call(m, a, Math.min(ms, LIMITS.rpcMs, scope.remaining()),
      {...options, signal: scope.signal, beforeSend: () => { scope.check(); return options.beforeSend?.(); }})),
    connect: typeof target.connect === 'function'
      ? () => checked(async () => {
          const res = await target.connect();
          return Array.isArray(res) ? res.map(rpc => scopedLink(rpc, scope)) : res;
        }) : undefined,
    currentDaa: (options = {}) => checked(() => target.currentDaa({...options, signal: scope.signal})),
    feerate: (options = {}) => checked(() => target.feerate({...options, signal: scope.signal})),
    readContext: () => queryContext(target),
    get knownAnchor() { return target.knownAnchor; },
    rememberChainAnchor: hash => { scope.check(); target.rememberChainAnchor?.(hash); },
    close: () => target.close?.(false),
  };
}
