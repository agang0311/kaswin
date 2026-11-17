/** Parametric ledger/transaction shapes for the budget sweep (vm-sweep.mjs), the model fit (vm-model.mjs) and the hold-out check.
 * shapeCase(p) -> {name, mk} where mk() builds [fixture, op, options] for makeBase. All shapes are valid transactions built by the real
 * JS builder; invalid parameter combinations throw (counted as skipped by callers).
 * p = {action, cnt, local, regime, ...action fields}:
 *   BUY {q, nf} · CLOSE {variant: sealed|refund|empty, nf} · DRAW {winner: 'old'|'local'|{j,i}, nf} · TIMEOUT {nf}
 *   PAY_OLD {k, p} · PAY_SELF {} · REFUND_OLD {r, c} · REFUND_SELF {c, nf}
 * regime: narrow (1 KAS price, 1 ticket per record) | wide (cumulative ends up to ~9.9 M) | maxprice (ticketCap just above the round's
 * tickets, largest price the contract allows for that cap) | wide+maxprice. */
import {S,fixture,fund,findDrawWhere,PRICE,KAS} from './fixtures.mjs';
import {FUNDER_KEY} from './vm-cases.mjs';
const KAS10=10n*KAS,FEE_PAY=50000000n;
const F=(n,v)=>fund(n,v,FUNDER_KEY);
/** `nf` funding inputs that together hold `total` (the last one takes the remainder). */
const funds=(start,nf,total)=>Array.from({length:nf},(_,i)=>F(start+i,i<nf-1?total/BigInt(nf):total-total/BigInt(nf)*BigInt(nf-1)));
export function regimeOptions(cnt,local,regime,extraTickets=1) {
  const o={},wide=regime.includes('wide');let per=1;
  if(wide) {per=Math.max(1,Math.floor(9900000/Math.max(256*cnt+local,1)));o.per=per;}
  if(regime.includes('maxprice')) {const cap=Math.max(3,(256*cnt+local)*per+extraTickets);o.ticketCap=cap;o.price=(S.VALUE_LIMIT-S.DEPOSIT)/BigInt(cap);}
  return o;
}
const keyOf=p=>Object.entries(p).filter(([k])=>k!=='action').map(([k,v])=>`${k}=${typeof v==='object'?`${v.j}.${v.i}`:v}`).join(' ');
export function shapeCase(p) {
  const {action,cnt,local,regime='narrow'}=p,nf=p.nf??1,name=`${action} ${keyOf({regime,...p})}`;
  const T=cnt*256+local,per0=regimeOptions(cnt,local,regime,1);
  const mk=()=>{
    switch(action) {
      case 'BUY': {
        const q=p.q??1,o=regimeOptions(cnt,local,regime,q+1),price=o.price??PRICE;
        return [fixture({module:'sales',cnt,local,...o}),{action:'BUY',quantity:q},{funds:funds(1,nf,BigInt(q)*price+KAS10),extra:{params:p}}];
      }
      case 'CLOSE': {
        const o=regimeOptions(cnt,local,regime,1),minTickets=p.variant==='refund'?Math.min(T*(o.per??1)+1,o.ticketCap??10000000):3;
        return [fixture({module:'sales',cnt,local,...o,...(p.variant==='empty'?{}:{minTickets})}),{action:'CLOSE'},{funds:funds(2,nf,KAS10),extra:{params:p}}];
      }
      case 'TIMEOUT':
        return [fixture({module:'sealed',cnt,local,currentDaa:2000n+S.TIMEOUT_DELAY,...per0}),{action:'TIMEOUT'},{funds:funds(4,nf,KAS10),extra:{params:p}}];
      case 'DRAW': {
        const f=fixture({module:'sealed',cnt,local,currentDaa:2000n+S.DRAW_DELAY+10n,...per0}),w=p.winner;
        const pred=w==='old'?d=>d.j<cnt:w==='local'?d=>d.j===cnt:d=>d.j===w.j&&d.i===w.i;
        return [f,findDrawWhere(f,pred,{max:900000,per:per0.per??1}),{funds:funds(3,nf,KAS10),extra:{params:p}}];
      }
      case 'PAY_OLD': {
        const f=fixture({module:'win',cnt,local,p:p.p,...per0});
        return [f,{action:'PAY_OLD'},{targets:f.targets.slice(p.p,p.p+p.k),fee:FEE_PAY,extra:{params:p}}];
      }
      case 'PAY_SELF':
        return [fixture({module:'win',cnt,local,p:cnt,...per0}),{action:'PAY_SELF'},{fee:FEE_PAY,extra:{params:p}}];
      case 'REFUND_OLD': {
        const f=fixture({module:'refund',cnt,local,r:p.r,c:p.c,...per0});
        return [f,{action:'REFUND_OLD'},{targets:f.targets.slice(p.r,p.r+1),fee:FEE_PAY,extra:{params:p}}];
      }
      case 'REFUND_SELF':
        return [fixture({module:'refund',cnt,local,r:cnt,c:p.c,...per0}),{action:'REFUND_SELF'},{funds:funds(20,nf,nf===0?1n:125000000n*BigInt(nf)),fee:5000000n,extra:{params:p}}];
      default: throw new Error('unknown action '+action);
    }
  };
  return {name,mk};
}
