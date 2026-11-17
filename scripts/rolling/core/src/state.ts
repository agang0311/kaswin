/** Rolling v1 physical codec and invariants. TypeScript port of experiments/rolling/state.mjs; same bytes, same checks.
 * Source candidate; NOT_RUN (not compiled, not executed). Never interchangeable with the V2.0.2 KW21 codec: a Profile selects exactly one codec. */
import {cat,check,fromLe,hex,integer,le,unhex} from '../../../core/lib/bytes.js';
// Keep the legacy state module's byte helpers available through the public core entry point.
export {cat,check,fromLe,hex,integer,le,unhex};

export const MODULES=['sales','sealed','win','refund','frozen'] as const;
export type Module=typeof MODULES[number];
export type ManagerModule=Exclude<Module,'frozen'>;
export const HEADER:Readonly<Record<Module,number>>=Object.freeze({sales:59,sealed:59,win:93,refund:63,frozen:1});
export const MAX_LEDGER_BYTES=18453,MAX_OUTPUTS=36,TAIL_POOL_MIN=300000000n;
export const DEPOSIT=400000000n,PRICE_MIN=100000000n,REWARD=100000000n,REFUND_FEE=2000000n;
export const VALUE_LIMIT=9000000000000000n,PAY_FEE_CAP=100000000n,FEE_CAP=50000000n;
export const DAA_LIMIT=500000000000n,DRAW_DELAY=100n,TIMEOUT_DELAY=432000n,MAX_TICKETS=10000000;
export const ZERO='00'.repeat(32);

export interface Index {hash:string;end:number;}
export interface TicketRecord {end:number;key:string;}
export interface ManagerConfig {ticketPrice:bigint;ticketCap:number;minTickets:number;closeEligibleDaa:bigint;}
export interface RoundConfig extends ManagerConfig {ownerKey:string;}
interface ManagerBase extends RoundConfig {indices:Index[];records:TicketRecord[];}
export interface SalesState extends ManagerBase {module:'sales';}
export interface SealedState extends ManagerBase {module:'sealed';}
export interface WinState extends ManagerBase {module:'win';winnerKey:string;p:number;}
export interface RefundState extends ManagerBase {module:'refund';r:number;c:number;}
export interface FrozenState {module:'frozen';records:TicketRecord[];}
export type ManagerState=SalesState|SealedState|WinState|RefundState;
export type State=ManagerState|FrozenState;
/** Fields a phase change may set on top of the carried-over manager fields. */
export type PhaseExtra=Partial<{indices:Index[];records:TicketRecord[];winnerKey:string;p:number;r:number;c:number;}>;

const key=(value:string):string=>{unhex(value,32);return value;};
export function recordTotal(records:readonly TicketRecord[]):number {return records.at(-1)?.end??0;}
export function baseTickets(s:ManagerState):number {return s.indices.at(-1)?.end??0;}
export function totalTickets(s:ManagerState):number {return baseTickets(s)+recordTotal(s.records);}
export function paidTickets(records:readonly TicketRecord[],c:number):number {integer(c,0,records.length);return c===0?0:records[c-1]!.end;}
/** Use the original local ledger, never the balance remaining after refunds. */
export function mergeTail(s:ManagerState):boolean {return s.indices.length>0&&BigInt(recordTotal(s.records))*s.ticketPrice<TAIL_POOL_MIN;}
export function validateRecords(records:readonly TicketRecord[],maxCount:number):void {
  check(Array.isArray(records),'RECORDS');integer(records.length,0,maxCount);let end=0;
  for(const r of records){integer(r.end,end+1,MAX_TICKETS);key(r.key);end=r.end;}
}
export function validate<T extends State>(state:T):T {
  const s=state as State; // not `const s:State=state`: assignment narrowing would keep the generic T and break the module discrimination below
  check(s&&(MODULES as readonly string[]).includes(s.module),'MODULE');validateRecords(s.records,s.module==='frozen'?256:255);
  if(s.module==='frozen'){check(s.records.length===256,'FROZEN_RECORDS');return state;}
  key(s.ownerKey);integer(s.ticketCap,3,MAX_TICKETS);integer(s.minTickets,3,s.ticketCap);
  check(typeof s.ticketPrice==='bigint'&&s.ticketPrice>=PRICE_MIN&&s.ticketPrice<=(VALUE_LIMIT-DEPOSIT)/BigInt(s.ticketCap),'PRICE');
  check(typeof s.closeEligibleDaa==='bigint'&&s.closeEligibleDaa>0n&&s.closeEligibleDaa<DAA_LIMIT-TIMEOUT_DELAY,'CLOSE_DAA');
  check(Array.isArray(s.indices),'INDICES');integer(s.indices.length,0,256);let end=0;
  for(const item of s.indices){key(item.hash);integer(item.end,end+256,s.ticketCap);end=item.end;}
  check(s.indices.length<256||s.records.length===0,'CAPACITY_MANAGER');
  check(totalTickets(s)<=s.ticketCap,'TICKET_CAP');
  if(s.module==='sealed'||s.module==='win')check(totalTickets(s)>=s.minTickets,'BELOW_MINIMUM');
  if(s.module==='win'){
    key(s.winnerKey);check(!Object.hasOwn(s,'ticket'),'WIN_TICKET_FIELD');
    integer(s.p,0,s.indices.length-(mergeTail(s)?1:0));
  }
  if(s.module==='refund'){
    check(totalTickets(s)>0,'EMPTY_REFUND_STATE');
    integer(s.r,0,s.indices.length-(mergeTail(s)?1:0));integer(s.c,0,255);check(s.c%32===0,'REFUND_CURSOR');
    if(s.r<s.indices.length)check(s.c<=224,'OLD_CURSOR');
    else check(s.records.length>0&&s.c<s.records.length,'LOCAL_CURSOR');
  }
  return state;
}
export function initial(ownerKey:string,config:ManagerConfig):SalesState {
  return validate<SalesState>({module:'sales',ownerKey,ticketPrice:config.ticketPrice,ticketCap:config.ticketCap,
    minTickets:config.minTickets,closeEligibleDaa:config.closeEligibleDaa,indices:[],records:[]});
}
export function phase<M extends ManagerModule>(s:ManagerState,module:M,extra?:PhaseExtra):Extract<ManagerState,{module:M}>;
export function phase(s:ManagerState,module:ManagerModule,extra:PhaseExtra={}):ManagerState {
  return validate({module,ownerKey:s.ownerKey,ticketPrice:s.ticketPrice,ticketCap:s.ticketCap,
    minTickets:s.minTickets,closeEligibleDaa:s.closeEligibleDaa,
    indices:s.indices.map(v=>({...v})),records:s.records.map(v=>({...v})),...extra} as ManagerState);
}
export function encode(s:State):Uint8Array {
  validate(s);const rs=cat(...s.records.map(r=>cat(le(BigInt(r.end),4),unhex(r.key,32))));
  if(s.module==='frozen')return cat(Uint8Array.of(0),rs);
  const common=cat(Uint8Array.of(1),unhex(s.ownerKey,32),le(s.ticketPrice,8),le(BigInt(s.ticketCap),4),
    le(BigInt(s.minTickets),4),le(s.closeEligibleDaa,8),le(BigInt(s.indices.length),2));
  const suffix=s.module==='win'?cat(unhex(s.winnerKey,32),le(BigInt(s.p),2)):
    s.module==='refund'?cat(le(BigInt(s.r),2),le(BigInt(s.c),2)):new Uint8Array();
  return cat(common,suffix,...s.indices.map(i=>cat(unhex(i.hash,32),le(BigInt(i.end),4))),rs);
}
export function decode<M extends Module>(module:M,raw:Uint8Array):Extract<State,{module:M}>;
export function decode(module:Module,raw:Uint8Array):State {
  check((MODULES as readonly string[]).includes(module)&&raw instanceof Uint8Array,'LEDGER');
  const h=HEADER[module];check(raw.length>=h&&raw.length<=MAX_LEDGER_BYTES,'LEDGER_LENGTH');
  const num=(at:number,width:number):bigint=>{check(at+width<=raw.length,'TRUNCATED');return fromLe(raw.slice(at,at+width));};
  const n=module==='frozen'?0:Number(num(57,2));integer(n,0,256);
  check(raw[0]===(module==='frozen'?0:1),'ROLE');
  check(raw.length>=h+36*n&&(raw.length-h-36*n)%36===0,'LEDGER_PARTITION');
  const records:TicketRecord[]=[];for(let at=h+36*n;at<raw.length;at+=36)records.push({end:Number(num(at,4)),key:hex(raw.slice(at+4,at+36))});
  if(module==='frozen')return validate<FrozenState>({module:'frozen',records});
  const indices:Index[]=[];for(let at=h;at<h+36*n;at+=36)indices.push({hash:hex(raw.slice(at,at+32)),end:Number(num(at+32,4))});
  const base={ownerKey:hex(raw.slice(1,33)),ticketPrice:num(33,8),ticketCap:Number(num(41,4)),
    minTickets:Number(num(45,4)),closeEligibleDaa:num(49,8),indices,records};
  if(module==='win')return validate<WinState>({module:'win',...base,winnerKey:hex(raw.slice(59,91)),p:Number(num(91,2))});
  if(module==='refund')return validate<RefundState>({module:'refund',...base,r:Number(num(59,2)),c:Number(num(61,2))});
  return validate<ManagerState>({module,...base});
}
export function managerValue(s:State):bigint {
  validate(s);check(s.module!=='frozen','MANAGER_REQUIRED');
  const paid=s.module==='refund'&&s.r===s.indices.length?paidTickets(s.records,s.c):0;
  return DEPOSIT+BigInt(recordTotal(s.records)-paid)*s.ticketPrice;
}
export function shardTickets(s:ManagerState,j:number):number {integer(j,0,s.indices.length-1);return s.indices[j]!.end-(j?s.indices[j-1]!.end:0);}
export function frozenValue(s:ManagerState,j:number,records:readonly TicketRecord[]):bigint {
  check(recordTotal(records)===shardTickets(s,j),'SHARD_TICKETS');
  const paid=s.module==='refund'&&s.r===j?paidTickets(records,s.c):0;
  return BigInt(recordTotal(records)-paid)*s.ticketPrice;
}
