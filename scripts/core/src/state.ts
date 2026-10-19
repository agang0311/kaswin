/** Kaswin physical ledger codec, contract V2.0.2 source candidate (magic KW21). Fixed header (80B) + 36*N directory.
 * [0,4) magic | [4,8) phase | [8,16) ticketPrice | [16,20) ticketCap | [20,24) purchaseCap | [24,28) minTickets
 * [28,36) closeEligibleDaa | [36,40) sold | [40,44) purchaseCount | [44,48) refund cursor | [48,80) ownerKey | [80,..) directory
 * No draw/anchor field is persisted: the draw is computed inside DRAW_AND_PAY and TIMEOUT_REFUND only changes phase.
 * Not interchangeable with the archived V2 (228B, KW20) codec; a Profile selects exactly one codec. */
import {check,integer,cat,ascii,le,fromLe,hex,unhex,same} from './bytes.js';
import {blake2b256} from './hashes.js';
import {blake3} from './blake3.js';
import {covenantId,p2sh,type Outpoint,type Spk} from './covenant-id.js';
import * as Layout from './ledger-layout.js';
export * from './ledger-layout.js';
export const CONTRACT_VERSION='V2.0.2';
/** New source hashes imply a new Profile even if tails are byte-identical.
 * Empty until the V2.0.2 candidate is compiled and explicitly reviewed; never reuse the V2.0.1 pin. */
export const APPROVED_PROFILE_ID:string='ed0387c9e77bb4e0a8f1f4654a326c316d83663f455283ec6a046a095c94856d';
export const COMPILER_COMMIT='3ed973335b59269293564805cc2c58a14595ec03';
export const DEPOSIT=400_000_000n, MIN_PRICE=100_000_000n;
/** Protocol batch limit; distinct from the coincidentally equal key width. */
export const MAX_REFUND_RECORDS=32;
export const FINALIZER=100_000_000n, MAX_PAY_FEE=50_000_000n, REFUND_FEE=2_000_000n;
export const DRAW_DELAY=100n,TIMEOUT_DELAY=432000n, DAA_LIMIT=500_000_000_000n;
export const MAX_PURCHASES=256,MAX_TICKETS=100_000,VALUE_LIMIT=9_000_000_000_000_000n;
/** Per-template output caps retained in V2.0.2 (inputs remain <= 9). */
export const OUTPUT_LIMIT={open:2,sealed:3,refunding:34} as const, INPUT_LIMIT=9;
export const ZERO='00'.repeat(32), MODULES=['open','sealed','refunding'] as const;
export type Module=typeof MODULES[number];
/** Live phases only; KW21 has no DRAW_READY/WINNER_READY ledgers (values 3/4 are invalid here). */
export enum Phase {OPEN=1,SEALED=2,REFUNDING=5}
export interface Config {ticketPrice:bigint;ticketCap:number;purchaseCap:number;minTickets:number;closeEligibleDaa:bigint;}
export interface Ledger {phase:Phase;ownerKey:string;config:Config;sold:number;purchaseCount:number;cursor:number;directory:Uint8Array;}
export interface Frame {tail:Uint8Array;templateHash:string;dispatchTag:string;sourceSha256:string;}
export interface Profile {id:string;frames:Record<Module,Frame>;compilerCommit:string;}
export interface Snapshot {ledger:Uint8Array;tip:Outpoint;scriptPublicKey:Spk;covenantId:string;value:bigint;utxoDaa:bigint;currentDaa:bigint;origin:Outpoint;}
const PHASES:readonly number[]=[Phase.OPEN,Phase.SEALED,Phase.REFUNDING];
export function checkPhase(phase:number):Phase {check(PHASES.includes(phase),'PHASE');return phase as Phase;}
export function phaseModule(phase:Phase):Module {checkPhase(phase);return phase===Phase.OPEN?'open':phase===Phase.REFUNDING?'refunding':'sealed';}
export function templateHash(tail:Uint8Array):string {check(tail[0]===0x6c,'TEMPLATE_BOUNDARY');return hex(blake3(cat(le(1n,8),new Uint8Array([0x6b]),le(BigInt(tail.length),8),tail)));}
/** Recompute identity from actual bytecode, not caller-provided template hashes. */
export function profileId(frames:Record<Module,Frame>):string {
 for(const m of MODULES){const f=frames?.[m];check(f&&f.tail instanceof Uint8Array,'PROFILE_FRAME');check(templateHash(f.tail)===f.templateHash,'ARTIFACT_HASH');}
 check(new Set(MODULES.map(m=>frames[m].templateHash)).size===3,'FRAME_COLLISION');
 return hex(blake2b256(cat(ascii('KASWIN_PROFILE_V2'),...MODULES.flatMap(m=>[unhex(frames[m].sourceSha256,32),unhex(frames[m].templateHash,32),unhex(frames[m].dispatchTag,4)]))));
}
/** Fail closed before producing/consuming version-specific scripts. No object-identity
 * cache: Profile fields and Uint8Array tails can be mutated after a successful check. */
export function assertCompatibleProfile(p:Profile):void {
 check(APPROVED_PROFILE_ID.length===64,'PROFILE_NOT_APPROVED');
 check(p?.id===APPROVED_PROFILE_ID,'INCOMPATIBLE_PROFILE');
 check(p.compilerCommit===COMPILER_COMMIT,'PROFILE_COMPILER');
 check(profileId(p.frames)===APPROVED_PROFILE_ID,'PROFILE_CONTENT_MISMATCH');
}
/** Data opcodes selected by payload length, matching the pinned compiler.
 * Ledger 80..224B (0..4 records): PUSHDATA1; 260..9296B (5..256 records): PUSHDATA2.
 * Also used for arbitrary witness items, so keep the full general push encoding. */
export function pushBytes(b:Uint8Array):Uint8Array {
 const n=b.length;check(n<=0x7fffffff,'PUSH_LIMIT');
 return cat(n===0?new Uint8Array([0]):n<=75?new Uint8Array([n]):n<=255?new Uint8Array([0x4c,n]):n<=65535?cat(new Uint8Array([0x4d]),le(BigInt(n),2)):cat(new Uint8Array([0x4e]),le(BigInt(n),4)),b);
}
export function scriptFor(ledger:Uint8Array,tail:Uint8Array):Uint8Array {check(tail[0]===0x6c,'TEMPLATE_BOUNDARY');return cat(new Uint8Array([0x6b]),pushBytes(ledger),tail);}
export function newOpen(ownerKey:string,config:Config):Ledger {
 return {phase:Phase.OPEN,ownerKey,config:{...config},sold:0,purchaseCount:0,cursor:0,directory:new Uint8Array()};
}
export function encodeLedger(s:Ledger):Uint8Array {
 const p=cat(ascii(Layout.MAGIC),le(BigInt(s.phase),Layout.U32_BYTES),le(s.config.ticketPrice,Layout.U63_BYTES),le(BigInt(s.config.ticketCap),Layout.U32_BYTES),le(BigInt(s.config.purchaseCap),Layout.U32_BYTES),le(BigInt(s.config.minTickets),Layout.U32_BYTES),le(s.config.closeEligibleDaa,Layout.U63_BYTES),le(BigInt(s.sold),Layout.U32_BYTES),le(BigInt(s.purchaseCount),Layout.U32_BYTES),le(BigInt(s.cursor),Layout.U32_BYTES),unhex(s.ownerKey,Layout.KEY_BYTES),s.directory);
 check(p.length===Layout.HEADER_BYTES+s.directory.length,'STATE_LAYOUT');return p;
}
export function decodeLedger(b:Uint8Array):Ledger {
 check(b.length>=Layout.HEADER_BYTES&&b.length<=Layout.HEADER_BYTES+MAX_PURCHASES*Layout.RECORD_BYTES,'LEDGER_LENGTH');check(same(b.slice(Layout.OFFSET_MAGIC,Layout.OFFSET_PHASE),ascii(Layout.MAGIC)),'STATE_MAGIC');
 const u=(a:number,w:number)=>{const n=fromLe(b.slice(a,a+w));check(n<1n<<BigInt(w*8-1),'SIGNED_DOMAIN');return n;};
 const n=(a:number)=>Number(u(a,Layout.U32_BYTES));
 const pc=n(Layout.OFFSET_PURCHASE_COUNT);check(pc<=MAX_PURCHASES&&b.length===Layout.HEADER_BYTES+Layout.RECORD_BYTES*pc,'DIRECTORY_LENGTH');
 return {phase:n(Layout.OFFSET_PHASE),config:{ticketPrice:u(Layout.OFFSET_TICKET_PRICE,Layout.U63_BYTES),ticketCap:n(Layout.OFFSET_TICKET_CAP),purchaseCap:n(Layout.OFFSET_PURCHASE_CAP),minTickets:n(Layout.OFFSET_MIN_TICKETS),closeEligibleDaa:u(Layout.OFFSET_CLOSE_ELIGIBLE_DAA,Layout.U63_BYTES)},sold:n(Layout.OFFSET_SOLD),purchaseCount:pc,cursor:n(Layout.OFFSET_REFUND_CURSOR),ownerKey:hex(b.slice(Layout.OFFSET_OWNER_KEY,Layout.HEADER_BYTES)),directory:b.slice(Layout.HEADER_BYTES)};
}
export function validateConfig(c:Config):void {
 integer(c.ticketCap,3,MAX_TICKETS);integer(c.purchaseCap,1,MAX_PURCHASES);integer(c.minTickets,3,c.ticketCap);
 check(c.ticketPrice>=MIN_PRICE&&c.ticketPrice<=(VALUE_LIMIT-DEPOSIT)/BigInt(c.ticketCap),'TICKET_PRICE');
 check(c.closeEligibleDaa>0n&&c.closeEligibleDaa<DAA_LIMIT-TIMEOUT_DELAY,'CLOSE_DAA');
}
export function records(s:Ledger):{end:number;key:string;count:number}[] {
 check(s.directory.length===s.purchaseCount*Layout.RECORD_BYTES,'DIRECTORY_LENGTH');let previous=0;
 return Array.from({length:s.purchaseCount},(_,i)=>{const at=i*Layout.RECORD_BYTES,end=Number(fromLe(s.directory.slice(at+Layout.RECORD_OFFSET_END,at+Layout.RECORD_OFFSET_BUYER_KEY)));integer(end,previous+1,s.sold);const r={end,key:hex(s.directory.slice(at+Layout.RECORD_OFFSET_BUYER_KEY,at+Layout.RECORD_BYTES)),count:end-previous};previous=end;return r;});
}
export function validateLedger(s:Ledger):void {
 checkPhase(s.phase);unhex(s.ownerKey,Layout.KEY_BYTES);
 validateConfig(s.config);integer(s.sold,0,s.config.ticketCap);integer(s.purchaseCount,0,Math.min(s.config.purchaseCap,s.sold));
 check((s.sold===0)===(s.purchaseCount===0),'EMPTY_MISMATCH');
 const rs=records(s);check((rs.at(-1)?.end??0)===s.sold,'DIRECTORY_TOTAL');
 if(s.phase===Phase.REFUNDING){integer(s.cursor,0,s.purchaseCount-1);}else check(s.cursor===0,'CURSOR_NONREFUND');
 if(s.phase===Phase.SEALED)check(s.sold>=s.config.minTickets,'DRAW_BELOW_MINIMUM');
}
/** Tickets already refunded (records before the cursor). */
export function paidTickets(s:Ledger):number {return s.cursor?records(s)[s.cursor-1]!.end:0;}
export function valueOf(s:Ledger):bigint {return DEPOSIT+BigInt(s.sold-paidTickets(s))*s.config.ticketPrice;}
/** Canonical zero-ticket OPEN script the OPEN contract rebuilds (genesisLedger()) to authenticate the round CID. */
export function rootScript(s:Ledger,p:Profile):Uint8Array {assertCompatibleProfile(p);return scriptFor(encodeLedger(newOpen(s.ownerKey,s.config)),p.frames.open.tail);}
export function rootId(origin:Outpoint,genesisScript:Uint8Array):string {return covenantId(origin,[{index:0,value:DEPOSIT,spk:p2sh(hex(blake2b256(genesisScript)))}]);}
/** Client bootstrap trust: ALL live phases must match the canonical OPEN Genesis CID.
 * Only the on-chain OPEN contract carries origin in its ABI; clients retain it as verified context. */
export function verifySnapshot(x:Snapshot,p:Profile):Ledger {
 assertCompatibleProfile(p);
 unhex(x.tip.transactionId,32);integer(x.tip.index,0,0x7fffffff);check(x.origin,'ORIGIN_REQUIRED');unhex(x.origin.transactionId,32);check(x.origin.transactionId!==ZERO,'ORIGIN_ZERO');integer(x.origin.index,0,0x7fffffff);unhex(x.covenantId,32);
 check(typeof x.utxoDaa==='bigint'&&x.utxoDaa>=0n&&x.utxoDaa<DAA_LIMIT,'UTXO_DAA');
 check(typeof x.currentDaa==='bigint'&&x.currentDaa>=0n&&x.currentDaa<DAA_LIMIT,'CURRENT_DAA');
 const s=decodeLedger(x.ledger);validateLedger(s);
 const root=rootScript(s,p);
 check(rootId(x.origin,root)===x.covenantId,'OPEN_GENESIS_CID_MISMATCH');check(x.value===valueOf(s),'STATE_INPUT_AMOUNT');
 const expected=p2sh(hex(blake2b256(scriptOf(s,p))));
 check(x.scriptPublicKey?.version===expected.version&&x.scriptPublicKey?.script===expected.script,'STATE_INPUT_SPK');
 return s;
}
export function scriptOf(s:Ledger,p:Profile):Uint8Array{assertCompatibleProfile(p);return scriptFor(encodeLedger(s),p.frames[phaseModule(s.phase)].tail);}
export function appendPurchase(s:Ledger,quantity:number,buyer:string):Ledger {validateLedger(s);check(s.phase===Phase.OPEN,'NOT_OPEN');integer(quantity,1,s.config.ticketCap-s.sold);check(s.purchaseCount<s.config.purchaseCap,'DIRECTORY_FULL');unhex(buyer,Layout.KEY_BYTES);const sold=s.sold+quantity;return {...s,sold,purchaseCount:s.purchaseCount+1,directory:cat(s.directory,le(BigInt(sold),Layout.U32_BYTES),unhex(buyer,Layout.KEY_BYTES))};}
export function cloneLedger(s:Ledger):Ledger{return decodeLedger(encodeLedger(s));}
