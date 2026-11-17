/** Classification of a node's rejection of a submitted transaction. Pure, no imports: shared by the controller (log line) and the views (help text).
 * Wording is fixed by rusty-kaspa v2.1.0 mining/errors/src/mempool.rs:
 *   "output {outpoint} already spent by transaction {txid} in the mempool"   (an outpoint prints as "(txid, index)")
 *   "transaction {txid} is an orphan where orphan is disallowed"              (a parent the node has never seen)
 * Anything else is OTHER: the caller shows the generic text and never guesses a cause. NOT_RUN (written 2026-11-15). */
const SPENT=/output \(([0-9a-f]{64}), ([0-9]{1,10})\) already spent by transaction ([0-9a-f]{64}) in the mempool/;
const ORPHAN=/transaction [0-9a-f]{64} is an orphan where orphan is disallowed/;

/** @param {{nodeError?:string|null,draft?:{inputUtxos?:{outpoint?:{transactionId:string,index:number|string},covenantId?:string|null}[]}}|null|undefined} intent
 * @returns {{kind:'FUNDS_INPUT'|'ROUND_INPUT'|'ORPHAN'|'OTHER',spender?:string,outpoint?:string}}
 * FUNDS_INPUT: the contested outpoint is one of this wallet's funding inputs (no covenant) — another unconfirmed transaction of the same wallet
 *   holds it (typically a second page/tab or script using the same wallet).
 * ROUND_INPUT: the contested outpoint is the round's own covenant UTXO — someone else acted on the round first. */
export function classifyRejection(intent) {
  const text=typeof intent?.nodeError==='string'?intent.nodeError:'';
  const m=SPENT.exec(text);
  if(m) {
    const [,txid,index,spender]=m;
    const hit=(intent?.draft?.inputUtxos??[]).find(u=>u?.outpoint?.transactionId===txid&&String(u.outpoint.index)===index);
    if(!hit)return {kind:'OTHER',spender,outpoint:`${txid}:${index}`}; // not one of the inputs we signed: do not guess
    return {kind:hit.covenantId?'ROUND_INPUT':'FUNDS_INPUT',spender,outpoint:`${txid}:${index}`};
  }
  if(ORPHAN.test(text))return {kind:'ORPHAN'};
  return {kind:'OTHER'};
}
