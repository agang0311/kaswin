/** Local calibrated compute-budget estimator for Kaswin Rolling TN10 (single-page SPA; zero backend engine calls).
 * Coefficients & empirical safety offsets come from experiments/rolling/artifacts/vm/budget-model.json
 * (fitted across 2,073 grid shapes + 684 random holdout shapes with 0 violations, plus +1 unit covenant margin).
 * Like V2.0.2 actionBudget(), this is an empirical client-side sizing bound; consensus acceptance belongs to the node. */
import {check,totalTickets} from '../core.mjs';

const FREE_UNITS=9999;
const UNITS_PER_BUDGET=10000;
export const FUNDING_INPUT_BUDGET=10;
export const COVENANT_BUDGET_MARGIN=1;

const MODELS=Object.freeze({
  'BUY plain':{beta:[110405.331,1547.604,1542.967,-508.551],offset:15425},
  'BUY freeze':{beta:[660777.768,1788.148,-369.302],offset:16292},
  'CLOSE sealed':{beta:[134879.332,1513.588,1507.674,-586.502],offset:15263},
  'CLOSE refund':{beta:[254868.003,1696,1685.292,-168.661],offset:14372},
  'TIMEOUT':{beta:[214758.328,1624.019,1613.348,-167.432],offset:13586},
  'DRAW old':{beta:[506228.267,1798.238,1826.094,490.078],offset:17743},
  'DRAW local':{beta:[220148.247,1739.677,1890.492,-509.586],offset:18031},
  'PAY_OLD':{beta:[236301.486,1712.111,1717.722,191185.029,107.67,108.159],offset:59286},
  'PAY_OLD merge-final':{beta:[138164.91,1070.241,3340.62,191315.762,107.37],offset:44567},
  'PAY_SELF':{beta:[140237.459,1089.316,1065.351],offset:11034},
  'REFUND_OLD':{beta:[1037079.734,1827.243,1859.78,87.079,52.871],offset:32087},
  'REFUND_OLD last-batch':{beta:[1044936.567,2371.813,2399.92,53.783],offset:29616},
  'REFUND_OLD final':{beta:[936839.951,1218.417,10124.758],offset:33132},
  'REFUND_SELF':{beta:[248.042,3.808,4073.957,7937.163,127.759,7497.841,144.66],offset:30399},
  'REFUND_SELF final':{beta:[103600.653,1134.897,1718.673,15331.029,72.931,279.723],offset:44405},
});

const FROZEN_MODELS=Object.freeze({
  PAY_OLD:{a:111729.84,b:12,offset:4588},
  REFUND_OLD:{a:114614.5,b:12.0001,offset:4664},
});

const dot=(f,beta)=>f.reduce((s,v,i)=>s+v*beta[i],0);
const evalClass=(name,features)=>{
  const m=MODELS[name];
  check(m,'BUDGET_CLASS_UNKNOWN');
  return Math.ceil(dot(features,m.beta))+m.offset;
};

export const unitsToBudget=units=>Math.max(0,Math.ceil((Math.ceil(units)-FREE_UNITS)/UNITS_PER_BUDGET))+COVENANT_BUDGET_MARGIN;

export function managerBoundUnits(action,{state:s,targets=[],funds=[],op={}}={}) {
  check(s,'BUDGET_STATE_REQUIRED');
  const cnt=s.indices.length,local=s.records.length,nF=funds.length,k=targets.length;
  switch(action) {
    case 'BUY':
      return local===255
        ?evalClass('BUY freeze',[1,cnt,nF])
        :evalClass('BUY plain',[1,cnt,local,nF]);
    case 'CLOSE': {
      const total=totalTickets(s);
      return total>0&&total>=s.minTickets
        ?evalClass('CLOSE sealed',[1,cnt,local,nF])
        :evalClass('CLOSE refund',[1,cnt,local,nF]);
    }
    case 'TIMEOUT':
      return evalClass('TIMEOUT',[1,cnt,local,nF]);
    case 'DRAW': {
      if(op.j!=null&&op.j<cnt)return evalClass('DRAW old',[1,cnt,local,nF]);
      if(op.j===cnt)return evalClass('DRAW local',[1,cnt,local,nF]);
      return Math.max(evalClass('DRAW old',[1,cnt,local,nF]),evalClass('DRAW local',[1,cnt,local,nF]));
    }
    case 'PAY_OLD': {
      const terminal=s.p+k===cnt&&local===0;
      return terminal
        ?evalClass('PAY_OLD merge-final',[1,cnt,local,k,k*cnt])
        :evalClass('PAY_OLD',[1,cnt,local,k,k*cnt,k*local]);
    }
    case 'PAY_SELF':
      return evalClass('PAY_SELF',[1,cnt,local]);
    case 'REFUND_OLD': {
      const c=s.c,r=s.r,terminal=r+1===cnt&&c+32>=256&&local===0;
      if(terminal)return evalClass('REFUND_OLD final',[1,cnt,local]);
      if(c>=224)return evalClass('REFUND_OLD last-batch',[1,cnt,local,r]);
      return evalClass('REFUND_OLD',[1,cnt,local,c,r]);
    }
    case 'REFUND_SELF': {
      const c=s.c,batch=Math.min(32,local-c),terminal=c+batch>=local;
      return terminal
        ?evalClass('REFUND_SELF final',[1,cnt,local,batch,batch*cnt,nF])
        :evalClass('REFUND_SELF',[1,cnt,local,batch,batch*cnt,c>0?1:0,nF]);
    }
    default:
      check(false,'BUDGET_ACTION_UNKNOWN');
  }
}

export function frozenBoundUnits(action,managerLedgerBytes) {
  const m=FROZEN_MODELS[action];
  check(m,'BUDGET_FROZEN_UNSUPPORTED');
  check(Number.isSafeInteger(managerLedgerBytes)&&managerLedgerBytes>0,'BUDGET_LEDGER_BYTES');
  return Math.ceil(m.a+m.b*managerLedgerBytes)+m.offset;
}

/** Deterministic per-input computeBudget array matching transaction input order:
 * GENESIS -> [funding...]; other actions -> [manager, ...targets, ...funds]. */
export function actionBudgets(action,{manager=null,state=null,targets=[],funds=[],op={}}={}) {
  if(action==='GENESIS')return funds.map(()=>FUNDING_INPUT_BUDGET);
  check(manager?.redeemScript,'BUDGET_MANAGER_REQUIRED');
  const managerBudget=unitsToBudget(managerBoundUnits(action,{state,targets,funds,op}));
  const targetBudget=targets.length?unitsToBudget(frozenBoundUnits(action,manager.redeemScript.length)):0;
  return [managerBudget,...targets.map(()=>targetBudget),...funds.map(()=>FUNDING_INPUT_BUDGET)];
}
