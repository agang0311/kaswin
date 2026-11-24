/** Classification of a node's rejection of a submitted transaction. Pure, no imports: shared by the controller (log line) and the views (help text).
 * Wording is fixed by rusty-kaspa v2.1.0 mining/errors/src/mempool.rs:
 *   "output {outpoint} already spent by transaction {txid} in the mempool"   (an outpoint prints as "(txid, index)")
 *   "transaction {txid} is an orphan where orphan is disallowed"              (a parent the node has never seen)
 * Anything else is OTHER: the caller shows the generic text and never guesses a cause. NOT_RUN (written 2026-11-15). */
const SPENT=/output \(([0-9a-f]{64}), ([0-9]{1,10})\) already spent by transaction ([0-9a-f]{64}) in the mempool/;
const ORPHAN=/transaction [0-9a-f]{64} is an orphan where orphan is disallowed/;

/** @param {{nodeError?:string|null,draft?:{inputUtxos?:{outpoint?:{transactionId:string,index:number|string},covenantId?:string|null}[],authorizedInputIndices?:number[]}}|null|undefined} intent
 * @returns {{kind:'FUNDS_INPUT'|'ROUND_INPUT'|'ORPHAN'|'OTHER',spender?:string,outpoint?:string}}
 * FUNDS_INPUT: the contested outpoint is one of this wallet's funding or token inputs (signed by the wallet, or no covenant) — another unconfirmed transaction
 *   of the same wallet holds it (typically a second page/tab or script using the same wallet).
 * ROUND_INPUT: the contested outpoint is the round's own covenant UTXO (not signed by the wallet) — someone else acted on the round first. */
export function classifyRejection(intent) {
  const text=typeof intent?.nodeError==='string'?intent.nodeError:'';
  const m=SPENT.exec(text);
  if(m) {
    const [,txid,index,spender]=m;
    const inputs=intent?.draft?.inputUtxos??[];
    const hitIdx=inputs.findIndex(u=>u?.outpoint?.transactionId===txid&&String(u.outpoint.index)===index);
    if(hitIdx<0)return {kind:'OTHER',spender,outpoint:`${txid}:${index}`}; // not one of the inputs we signed: do not guess
    const hit=inputs[hitIdx];
    const auth=Array.isArray(intent?.draft?.authorizedInputIndices)?intent.draft.authorizedInputIndices:null;
    const scriptIdxs=Array.isArray(intent?.draft?.scriptInputs)?intent.draft.scriptInputs.map(s=>s?.inputIndex):[];
    const isWalletInput=!hit.covenantId||(auth?auth.includes(hitIdx):false)||scriptIdxs.includes(hitIdx);
    return {kind:isWalletInput?'FUNDS_INPUT':'ROUND_INPUT',spender,outpoint:`${txid}:${index}`};
  }
  if(ORPHAN.test(text))return {kind:'ORPHAN'};
  return {kind:'OTHER'};
}
