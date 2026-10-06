/** Kaswin physical ledger codec (V2, Chained Hash / No Routes / No NetworkGenesis). Fixed header (228B) + 36*N directory. */
import {check,integer,cat,ascii,le,fromLe,hex,unhex,same} from './bytes.js';
import {blake2b256} from './hashes.js';
import {blake3} from './blake3.js';
import {covenantId,p2sh,type Outpoint,type Spk} from './covenant-id.js';
export const HEADER=228, BUSINESS_HEADER=196, DEPOSIT=20_000_000n, MIN_PRICE=100_000_000n;
export const FINALIZER=100_000_000n, MAX_PAY_FEE=50_000_000n, REFUND_FEE=1_000_000n;
export const DRAW_DELAY=100n,TIMEOUT_DELAY=300n, DAA_LIMIT=500_000_000_000n;
export const MAX_PURCHASES=256,MAX_TICKETS=100_000,VALUE_LIMIT=9_000_000_000_000_000n;
export const ZERO='00'.repeat(32), MODULES=['open','sealed','refunding'] as const;
export type Module=typeof MODULES[number];
export enum Phase {OPEN=1,SEALED,DRAW_READY,WINNER_READY,REFUNDING}
export interface Config {ticketPrice:bigint;ticketCap:number;purchaseCap:number;minTickets:number;closeEligibleDaa:bigint;}
export interface Ledger {
 phase:Phase;ownerKey:string;config:Config;
 sold:number;purchaseCount:number;cursor:number;anchorDaa:bigint;anchorTxId:string;anchorIndex:number;
 seed:string;counter:number;winnerPlusOne:number;targetHash:string;targetSeq:string;
 directory:Uint8Array;
}
export interface Frame {tail:Uint8Array;templateHash:string;dispatchTag:string;sourceSha256:string;}
export interface Profile {id:string;frames:Record<Module,Frame>;compilerCommit:string;}
export interface Snapshot {ledger:Uint8Array;tip:Outpoint;scriptPublicKey:Spk;covenantId:string;value:bigint;utxoDaa:bigint;currentDaa:bigint;origin:Outpoint;}
export function phaseModule(phase:Phase):Module {integer(phase,1,5);return phase===1?'open':phase===5?'refunding':'sealed';}
export function templateHash(tail:Uint8Array):string {check(tail[0]===0x6c,'TEMPLATE_BOUNDARY');return hex(blake3(cat(le(1n,8),new Uint8Array([0x6b]),le(BigInt(tail.length),8),tail)));}
/** Data opcodes selected by payload length, matching the pinned compiler.
 * Empty OPEN ledger (228B): PUSHDATA1; nonempty ledger (264..9444B): PUSHDATA2.
 * Also used for arbitrary witness items, so keep the full general push encoding. */
export function pushBytes(b:Uint8Array):Uint8Array {
 const n=b.length;check(n<=0x7fffffff,'PUSH_LIMIT');
 return cat(n===0?new Uint8Array([0]):n<=75?new Uint8Array([n]):n<=255?new Uint8Array([0x4c,n]):n<=65535?cat(new Uint8Array([0x4d]),le(BigInt(n),2)):cat(new Uint8Array([0x4e]),le(BigInt(n),4)),b);
}
export function scriptFor(ledger:Uint8Array,tail:Uint8Array):Uint8Array {check(tail[0]===0x6c,'TEMPLATE_BOUNDARY');return cat(new Uint8Array([0x6b]),pushBytes(ledger),tail);}
export function newOpen(ownerKey:string,config:Config):Ledger {
 return {phase:Phase.OPEN,ownerKey,config:{...config},sold:0,purchaseCount:0,cursor:0,anchorDaa:0n,anchorTxId:ZERO,anchorIndex:0,seed:ZERO,counter:0,winnerPlusOne:0,targetHash:ZERO,targetSeq:ZERO,directory:new Uint8Array()};
}
export function encodeLedger(s:Ledger):Uint8Array {
 const p=cat(ascii('KW20'),le(BigInt(s.phase),4),le(s.config.ticketPrice,8),le(BigInt(s.config.ticketCap),4),le(BigInt(s.config.purchaseCap),4),le(BigInt(s.config.minTickets),4),le(s.config.closeEligibleDaa,8),le(BigInt(s.sold),4),le(BigInt(s.purchaseCount),4),le(BigInt(s.cursor),4),le(s.anchorDaa,8),unhex(s.anchorTxId,32),le(BigInt(s.anchorIndex),4),unhex(s.seed,32),le(BigInt(s.counter),4),le(BigInt(s.winnerPlusOne),4),unhex(s.targetHash,32),unhex(s.targetSeq,32),unhex(s.ownerKey,32),s.directory);
 check(p.length===HEADER+s.directory.length,'STATE_LAYOUT');return p;
}
export function decodeLedger(b:Uint8Array):Ledger {
 check(b.length>=HEADER&&b.length<=HEADER+MAX_PURCHASES*36,'LEDGER_LENGTH');check(same(b.slice(0,4),ascii('KW20')),'STATE_MAGIC');
 const u=(a:number,w:number)=>{const n=fromLe(b.slice(a,a+w));check(n<1n<<BigInt(w*8-1),'SIGNED_DOMAIN');return n;};
 const n=(a:number)=>Number(u(a,4)),h=(a:number)=>hex(b.slice(a,a+32));
 const pc=n(40);check(pc<=MAX_PURCHASES&&b.length===HEADER+36*pc,'DIRECTORY_LENGTH');
 return {phase:n(4),config:{ticketPrice:u(8,8),ticketCap:n(16),purchaseCap:n(20),minTickets:n(24),closeEligibleDaa:u(28,8)},sold:n(36),purchaseCount:pc,cursor:n(44),anchorDaa:u(48,8),anchorTxId:h(56),anchorIndex:n(88),seed:h(92),counter:n(124),winnerPlusOne:n(128),targetHash:h(132),targetSeq:h(164),ownerKey:h(196),directory:b.slice(HEADER)};
}
export function validateConfig(c:Config):void {
 integer(c.ticketCap,3,MAX_TICKETS);integer(c.purchaseCap,1,MAX_PURCHASES);integer(c.minTickets,3,c.ticketCap);
 check(c.ticketPrice>=MIN_PRICE&&c.ticketPrice<=(VALUE_LIMIT-DEPOSIT)/BigInt(c.ticketCap),'TICKET_PRICE');
 check(c.closeEligibleDaa>0n&&c.closeEligibleDaa<DAA_LIMIT-TIMEOUT_DELAY,'CLOSE_DAA');
}
export function records(s:Ledger):{end:number;key:string;count:number}[] {
 check(s.directory.length===s.purchaseCount*36,'DIRECTORY_LENGTH');let previous=0;
 return Array.from({length:s.purchaseCount},(_,i)=>{const at=i*36,end=Number(fromLe(s.directory.slice(at,at+4)));integer(end,previous+1,s.sold);const r={end,key:hex(s.directory.slice(at+4,at+36)),count:end-previous};previous=end;return r;});
}
export function validateLedger(s:Ledger):void {
 integer(s.phase,1,5);unhex(s.ownerKey,32);
 validateConfig(s.config);integer(s.sold,0,s.config.ticketCap);integer(s.purchaseCount,0,Math.min(s.config.purchaseCap,s.sold));
 check((s.sold===0)===(s.purchaseCount===0),'EMPTY_MISMATCH');
 const rs=records(s);check((rs.at(-1)?.end??0)===s.sold,'DIRECTORY_TOTAL');
 if(s.phase===Phase.REFUNDING){integer(s.cursor,0,s.purchaseCount-1);}else check(s.cursor===0,'CURSOR_NONREFUND');
 if(s.phase===Phase.OPEN||s.phase===Phase.SEALED)check(same(encodeLedger(s).slice(48,196),new Uint8Array(148)),'PREMATURE_RANDOM_STATE');
 if(s.phase>=Phase.SEALED&&s.phase<=Phase.WINNER_READY)check(s.sold>=s.config.minTickets,'DRAW_BELOW_MINIMUM');
 if(s.phase===Phase.DRAW_READY||s.phase===Phase.WINNER_READY){check(s.anchorDaa>=0n&&s.anchorDaa<DAA_LIMIT-TIMEOUT_DELAY,'ANCHOR_DAA');check(s.anchorTxId!==ZERO&&s.targetHash!==ZERO,'ANCHOR_MISSING');integer(s.counter,0,0x7fffffff);if(s.phase===Phase.DRAW_READY)check(s.winnerPlusOne===0,'WINNER_PREMATURE');else integer(s.winnerPlusOne,1,s.sold);}
}
export function valueOf(s:Ledger):bigint {const paid=s.cursor?records(s)[s.cursor-1]!.end:0;return DEPOSIT+BigInt(s.sold-paid)*s.config.ticketPrice;}
export function rootScript(s:Ledger,p:Profile):Uint8Array {return scriptFor(encodeLedger(newOpen(s.ownerKey,s.config)),p.frames.open.tail);}
export function rootId(origin:Outpoint,genesisScript:Uint8Array):string {return covenantId(origin,[{index:0,value:DEPOSIT,spk:p2sh(hex(blake2b256(genesisScript)))}]);}
/** Client bootstrap trust: ALL live phases must match the canonical OPEN Genesis CID.
 * Only the on-chain OPEN contract carries origin in its ABI; clients retain it as verified context. */
export function verifySnapshot(x:Snapshot,p:Profile):Ledger {
 unhex(x.tip.transactionId,32);integer(x.tip.index,0,0x7fffffff);check(x.origin,'ORIGIN_REQUIRED');unhex(x.origin.transactionId,32);check(x.origin.transactionId!==ZERO,'ORIGIN_ZERO');integer(x.origin.index,0,0x7fffffff);unhex(x.covenantId,32);
 check(typeof x.utxoDaa==='bigint'&&x.utxoDaa>=0n&&x.utxoDaa<DAA_LIMIT,'UTXO_DAA');
 check(typeof x.currentDaa==='bigint'&&x.currentDaa>=0n&&x.currentDaa<DAA_LIMIT,'CURRENT_DAA');
 const s=decodeLedger(x.ledger);validateLedger(s);
 check(s.phase===Phase.OPEN||s.phase===Phase.SEALED||s.phase===Phase.REFUNDING,'NON_LIVE_PHASE');
 const root=rootScript(s,p);
 check(rootId(x.origin,root)===x.covenantId,'OPEN_GENESIS_CID_MISMATCH');check(x.value===valueOf(s),'STATE_INPUT_AMOUNT');
 const expected=p2sh(hex(blake2b256(scriptOf(s,p))));
 check(x.scriptPublicKey?.version===expected.version&&x.scriptPublicKey?.script===expected.script,'STATE_INPUT_SPK');
 return s;
}
export function scriptOf(s:Ledger,p:Profile):Uint8Array{return scriptFor(encodeLedger(s),p.frames[phaseModule(s.phase)].tail);}
export function appendPurchase(s:Ledger,quantity:number,buyer:string):Ledger {validateLedger(s);check(s.phase===1,'NOT_OPEN');integer(quantity,1,s.config.ticketCap-s.sold);check(s.purchaseCount<s.config.purchaseCap,'DIRECTORY_FULL');unhex(buyer,32);const sold=s.sold+quantity;return {...s,sold,purchaseCount:s.purchaseCount+1,directory:cat(s.directory,le(BigInt(sold),4),unhex(buyer,32))};}
export function cloneLedger(s:Ledger):Ledger{return decodeLedger(encodeLedger(s));}
