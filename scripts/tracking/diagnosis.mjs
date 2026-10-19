/** Shared read-only diagnosis. Hooks supply network/proof facts; policies decide what a verdict authorizes.
 * No persistence, signing, rebuilding, reservation release or transport is performed here. */
export async function diagnoseRecord({mempool, states, action, inputs, proof, parentState, pollAcceptance = async () => false,
  onChain, gone = new Set(), inspectDrawInMempool = false, check = () => {}, describeError = () => null}) {
  let m;
  try { m = await mempool(); check(); } catch (e) { check(); return {verdict: 'UNREACHABLE', error: describeError(e)}; }
  if (m && (action !== 'DRAW_AND_PAY' || !inspectDrawInMempool)) return {verdict: 'MEMPOOL'};
  let st;
  try { st = await states(); check(); } catch (e) { check(); return {verdict: 'UNREACHABLE', error: describeError(e)}; }
  if (!st || st.length !== inputs.length) return {verdict: 'UNREACHABLE'};
  if (st.every(x => x.live)) {
    if (action === 'DRAW_AND_PAY') {
      const result = await proof(st); check();
      if (result) return typeof result === 'string' ? {verdict: result} : result;
    }
    return {verdict: m ? 'MEMPOOL' : 'DROPPED'};
  }
  const missing = inputs.filter((_, i) => !st[i].live);
  if (missing.some(u => gone.has(parentState(u)))) return {verdict: 'PARENT_LOST'};
  if (missing.some(u => { const p = parentState(u); return p != null && !onChain.has(p); })) return {verdict: 'PARENT_PENDING'};
  if (await pollAcceptance()) { check(); return {verdict: 'ACCEPTED'}; }
  check();
  return {verdict: missing.some(u => !u.covenantId) ? 'FUNDING_CONFLICT' : 'CONFLICT'};
}

/** A response mismatch says nothing about whether the sent transaction entered the network. */
export function classifySubmitResponse(response, txid) {
  return response?.transactionId === txid ? {result: 'SENT'}
    : {result: 'NO_RESPONSE', message: 'SUBMIT_TXID_MISMATCH'};
}

/** First Web send only: a rejection names THIS exact transaction in an actual submission RpcError.
 * A resend rejection cannot prove that an earlier send was never accepted; keep its separate observation policy. */
export function classifyInitialWebSubmit(err, txid) {
  const message = String(err?.message ?? err).slice(0, 8000), brief = message.slice(0, 400);
  if (err?.name !== 'RpcError' || !['submitTransaction', 'submitTransactionReplacement'].includes(err.method)) return {result: 'NO_RESPONSE', message: brief};
  const payload = typeof err.rpc === 'string' ? err.rpc : err.rpc?.message;
  if (typeof payload !== 'string') return {result: 'NO_RESPONSE', message: brief};
  const match = /^Rejected transaction ([0-9a-f]{64}):\s*([\s\S]*)$/i.exec(payload.slice(0, 8000));
  if (!match || match[1].toLowerCase() !== txid) return {result: 'NO_RESPONSE', message: brief};
  const reason = match[2];
  if (/was already accepted|already (?:been )?accepted|already in the mempool|already in the orphan pool/i.test(reason)) return {result: 'KNOWN', message: brief};
  const kind = /already spent by transaction/i.test(reason) ? 'INPUT_CONFLICT'
    : /lacking a matching UTXO|impossible to have a matching UTXO|missing from current utxo|is an orphan where orphan is disallowed/i.test(reason) ? 'INPUT_MISSING' : 'RULE';
  return {result: 'REJECTED', kind, message: brief};
}

/** Explicit submission policy: CLI rejects other RpcErrors; Web requires a named txid rejection.
 * These are not interchangeable release permissions. Caller retains its own repeated-observation gate. */
export function classifySubmit(err, txid, {rpcOnly = false, rejectOtherRpcErrors = false, orphanKnown = true} = {}) {
  if (rpcOnly && err?.name !== 'RpcError') return {result: 'NO_RESPONSE'};
  const m = String(err?.message ?? err).slice(0, 400);
  if (/already (been )?accepted|was already accepted|already in the mempool/i.test(m) || (orphanKnown && /already in the orphan pool/i.test(m))) return {result: 'KNOWN', message: m};
  if (/orphan|lacking a matching UTXO|missing from current utxo|sequence lock|already spent by transaction/i.test(m)) return {result: 'WAIT', message: m};
  if (rejectOtherRpcErrors || (/Rejected transaction/i.test(m) && m.includes(txid))) return {result: 'REJECTED', message: m};
  return {result: 'NO_RESPONSE', message: m};
}
