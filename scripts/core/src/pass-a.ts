/** Browser-safe TN10 PASS-A acquisition and verification (no local Rust/Node dependency).
 * Fixed consensus source: rusty-kaspa cfafeb4 (seq-commit hashing/verify,
 * crypto/smt proof, ghostdag consensus_ordered_mergeset). The node's independent
 * header commitment is the reference; self-consistency alone is NOT accepted.
 */
import {ascii,cat,check,hex,le,same,unhex} from './bytes.js';
import {domainHash} from './blake3.js';

const Z=new Uint8Array(32);
export const COINBASE_LANE_KEY='8aa78027db66a16cb69692ee0af5cb76738ef80ad14c9d13920d7fa3cc40b9e4';
const COINBASE_SUBNETWORK='0100000000000000000000000000000000000000';
const H=(tag:string,...parts:Uint8Array[]):Uint8Array=>domainHash(tag,cat(...parts));
const branch=(l:Uint8Array,r:Uint8Array)=>H('SeqCommitmentMerkleBranchHash',l,r);
const h32=(v:string)=>unhex(v,32);
const eq=(a:string,b:string,code:string)=>check(a===b,code);
function object(x:unknown,code:string):Record<string,unknown>{check(x!==null&&typeof x==='object'&&!Array.isArray(x),code);return x as Record<string,unknown>;}
function string(x:unknown,code:string):string{check(typeof x==='string',code);return x;}
function uint63(x:unknown,code:string):bigint {
 check(typeof x==='bigint'||typeof x==='string'||typeof x==='number'&&Number.isSafeInteger(x),code);
 check(typeof x!=='string'||/^(0|[1-9][0-9]*)$/.test(x),code);
 const n=BigInt(x);check(n>=0n&&n<1n<<63n,code);return n;
}
const u64=(x:unknown,code:string)=>le(uint63(x,code),8);
export interface BlockResponse {block:{header:Record<string,unknown>;verboseData?:Record<string,unknown>;transactions?:Array<Record<string,unknown>>};}
export interface SelectedChain {
 removedChainBlockHashes:string[];addedChainBlockHashes:string[];
 chainBlockAcceptedTransactions:Array<{chainBlockHeader:{hash?:string;daaScore?:bigint|string|number}}>;
}
export interface AcceptedClose {isAccepted:boolean;acceptingBlockHash:string;output0:{amount:bigint;scriptPublicKey:string;covenantId:string};}
export interface PassAProvider {
 getAcceptedClose(txid:string):Promise<AcceptedClose>;
 getSinkBlueScore():Promise<{blueScore:bigint|string|number}>;
 getVirtualChainFromBlockV2(arg:{startHash:string;minConfirmationCount:number}):Promise<SelectedChain>;
 /** Optional untrusted DAA index: returns the candidate FIRST chain block with DAA >= B.
  * Fixed TN10 RPC cannot resolve a selected-chain hash from a DAA score directly.
  * A wrong/stale candidate is rejected; an unavailable index returns null.
  * An index returning an arbitrary later block must NOT be described as first-crossing.
  */
 getSelectedChainCandidateAtOrAfterDaa?(boundaryDaa:bigint):Promise<string|null>;
 getBlock(arg:{hash:string;includeTransactions:boolean}):Promise<BlockResponse>;
 getSeqCommitLaneProof(hash:string,laneKey:string):Promise<unknown>;
}
export interface PassAResult {
 opening:Uint8Array;openingHex:string;boundaryDaa:string;
 parent:{hash:string;daa:string;seqCommit:string};target:{hash:string;daa:string;seqCommit:string};
 activityRoots:{parent:string;target:string};payloadRoots:{parent:string;target:string};
}
interface ParsedHeader {hash:string;daa:bigint;blue:bigint;timestamp:bigint;seqCommit:string;blueWork:string;}
interface SelectedHeader extends ParsedHeader {selectedParent:string;}
function parseHeader(raw:unknown):ParsedHeader {
 const h=object(raw,'BLOCK_HEADER');
 const hash=string(h.hash,'BLOCK_HASH'),seqCommit=string(h.acceptedIdMerkleRoot,'HEADER_SEQ_COMMIT');
 h32(hash);h32(seqCommit);
 const blueWork=string(h.blueWork,'BLUE_WORK');check(/^(?:[0-9a-f]{2}){1,24}$/.test(blueWork),'BLUE_WORK_ENCODING');
 return {hash,seqCommit,blueWork,daa:uint63(h.daaScore,'BLOCK_DAA'),blue:uint63(h.blueScore,'BLOCK_BLUE_SCORE'),timestamp:uint63(h.timestamp,'BLOCK_TIMESTAMP')};
}
/** cfafeb4 utxo_validation.rs: first-parent order is a chain-qualification rule,
 * NOT a header-validity rule for arbitrary mergeset members. */
function parseSelectedHeader(raw:unknown):SelectedHeader {
 const h=parseHeader(raw),parents=object(raw,'BLOCK_HEADER').parentsByLevel;
 check(Array.isArray(parents)&&Array.isArray(parents[0])&&typeof parents[0][0]==='string','SELECTED_PARENT_MISSING');
 const selectedParent=parents[0][0];h32(selectedParent);return {...h,selectedParent};
}
function sameHeader(actual:SelectedHeader,expected:SelectedHeader,code:string):void {
 for(const key of ['hash','daa','blue','timestamp','seqCommit','blueWork','selectedParent'] as const)check(actual[key]===expected[key],code);
}
function merkle(leaves:Uint8Array[]):Uint8Array {
 if(!leaves.length)return Z;if(leaves.length===1)return leaves[0]!;
 let size=1;while(size<leaves.length)size*=2;
 // kaspa-merkle::calc_merkle_root_with_hasher: an absent LEFT subtree stays
 // absent. Only an existing left child with a missing right child hashes ZERO.
 // Hashing padded ZERO subtrees would give the wrong root for 5, 9, ... leaves.
 let level:Array<Uint8Array|undefined>=Array.from({length:size},(_,i)=>leaves[i]);
 while(level.length>1){const next:Array<Uint8Array|undefined>=[];
  for(let i=0;i<level.length;i+=2)next.push(level[i]===undefined?undefined:branch(level[i]!,level[i+1]??Z));
  level=next;
 }
 check(level[0]!==undefined,'MERKLE_ROOT_MISSING');return level[0];
}
/** OwnedSmtProof::from_bytes + compute_root<SeqCommitActiveNode>. */
export function laneRoot(proofBytes:readonly number[],laneKey:string,lane:unknown):Uint8Array {
 check(Array.isArray(proofBytes)&&proofBytes.length>=33&&proofBytes.length<=16384&&proofBytes.every(x=>Number.isInteger(x)&&x>=0&&x<=255),'SMT_PROOF_BYTES');
 const raw=Uint8Array.from(proofBytes),bitmap=raw.slice(0,32),tag=raw[32];let at=33,depth=256;
 if(tag===1||tag===2){check(raw.length>at,'SMT_TERMINAL');depth=raw[at++]!;}
 else check(tag===0,'SMT_TERMINAL_TAG');
 check((lane===null?tag!==1:tag!==2),'SMT_TERMINAL_LANE_MISMATCH');
 let foreignKey:Uint8Array|undefined,foreignLeaf:Uint8Array|undefined;
 if(tag===2){check(raw.length>=at+64,'SMT_FOREIGN_LEAF');foreignKey=raw.slice(at,at+32);foreignLeaf=raw.slice(at+32,at+64);at+=64;}
 const expected=Array.from({length:depth},(_,d)=>d).filter(d=>(bitmap[d>>>3]!&(1<<(d&7)))===0).length;
 check(raw.length-at===expected*32,'SMT_SIBLING_COUNT');
 const key=h32(laneKey),siblings=Array.from({length:expected},(_,i)=>raw.slice(at+i*32,at+i*32+32));
 let seed:Uint8Array;
 if(lane!==null){const v=object(lane,'SMT_LANE');seed=H('SeqCommitActiveCollapsedNode',key,H('SeqCommitActiveLeaf',h32(string(v.tip,'SMT_LANE_TIP')),u64(v.blueScore,'SMT_LANE_SCORE')));}
 else seed=tag===2&&foreignKey&&!same(foreignKey,key)?H('SeqCommitActiveCollapsedNode',foreignKey,foreignLeaf!):Z;
 let cursor=expected;const empty:Uint8Array[]=[Z];for(let i=1;i<=256;i++)empty.push(H('SeqCommitActiveNode',empty[i-1]!,empty[i-1]!));
 for(let d=depth-1;d>=0;d--){const missing=(bitmap[d>>>3]!&(1<<(d&7)))!==0;
  const sibling=missing?empty[255-d]!:siblings[--cursor]!;
  const right=(key[d>>>3]!&(0x80>>(d&7)))!==0;
  seed=H('SeqCommitActiveNode',...(right?[sibling,seed]:[seed,sibling]));
 }
 check(cursor===0,'SMT_SIBLING_CURSOR');return seed;
}
export function verifyLaneProof(headerSeq:string,proof:unknown,expectedParentSeq?:string){
 const p=object(proof,'LANE_PROOF'),laneKey=string(p.laneKey,'LANE_KEY');eq(laneKey,COINBASE_LANE_KEY,'WRONG_LANE');
 const siblings=p.smtProof;check(Array.isArray(siblings),'SMT_PROOF_REQUIRED');
 const lr=laneRoot(siblings as number[],laneKey,p.lane);
 const activity=H('SeqCommitActivityRoot',h32(string(p.inactivityShortcut,'SHORTCUT')),lr);
 const digest=string(p.payloadAndCtxDigest,'PAYLOAD_CONTEXT_DIGEST'),parentSeq=string(p.parentSeqCommit,'PARENT_SEQ');h32(digest);h32(parentSeq);
 if(expectedParentSeq!==undefined)eq(parentSeq,expectedParentSeq,'PARENT_SEQ_MISMATCH');
 const seq=branch(h32(parentSeq),branch(activity,h32(digest)));
 eq(hex(seq),headerSeq,'LANE_HEADER_COMMITMENT_MISMATCH');
 return {activityRoot:activity,lanesRoot:lr,parentSeq,payloadAndCtxDigest:digest};
}
function minerPayloadLeaf(hash:string,blueWork:string,payload:string):Uint8Array {
 const work=unhex(blueWork),bytes=unhex(payload);check(work.length<=24&&bytes.length<=1_000_000,'PAYLOAD_INPUT_LIMIT');
 let first=0;while(first<work.length&&work[first]===0)first++;
 return H('SeqCommitMinerPayloadLeaf',h32(hash),le(BigInt(work.length-first),8),work.slice(first),H('PayloadDigest',bytes));
}
/** A payload member need not be chain-qualified. Its own parents/mergeset are irrelevant
 * to its miner-payload leaf and must not be interpreted as selected-chain context. */
export interface PayloadBlock {header:ParsedHeader;coinbasePayload:string;}
export interface BlockData extends PayloadBlock {header:SelectedHeader;blues:string[];reds:string[];chainBlock:boolean;}
function readPayloadBlock(response:BlockResponse):PayloadBlock {
 const b=object(response.block,'BLOCK_RESPONSE'),header=parseHeader(b.header);
 const txs=b.transactions;check(Array.isArray(txs)&&txs.length>0,'COINBASE_MISSING');
 const coinbase=object(txs[0],'COINBASE_TX');eq(string(coinbase.subnetworkId,'COINBASE_SUBNETWORK'),COINBASE_SUBNETWORK,'COINBASE_SUBNETWORK');
 const coinbasePayload=string(coinbase.payload,'COINBASE_PAYLOAD');unhex(coinbasePayload);
 return {header,coinbasePayload};
}
/** Only for the anchor, P/T and their chain-membership rechecks. */
function readBlock(response:BlockResponse,withBody:boolean):BlockData {
 const b=object(response.block,'BLOCK_RESPONSE'),h=parseSelectedHeader(b.header),verbose=object(b.verboseData,'BLOCK_VERBOSE');
 check(verbose.isChainBlock===true,'NOT_SELECTED_CHAIN_BLOCK');
 if(!withBody)return {header:h,coinbasePayload:'',blues:[],reds:[],chainBlock:true};
 const {coinbasePayload}=readPayloadBlock(response);
 const blues=verbose.mergeSetBluesHashes,reds=verbose.mergeSetRedsHashes;
 check(Array.isArray(blues)&&blues.length>0&&blues.every(v=>typeof v==='string')&&Array.isArray(reds)&&reds.every(v=>typeof v==='string'),'MERGESET_MISSING');
 eq(blues[0] as string,h.selectedParent,'MERGESET_SELECTED_PARENT');
 const hashes=[...blues,...reds] as string[];check(hashes.length<=1024&&new Set(hashes).size===hashes.length,'MERGESET_SIZE_OR_DUPLICATE');hashes.forEach(h32);
 return {header:h,coinbasePayload,blues:blues as string[],reds:reds as string[],chainBlock:true};
}
function payloadRoot(current:BlockData,mergeset:Map<string,PayloadBlock>):Uint8Array {
 const {blues,reds,header}=current,all=[...blues,...reds];eq(all[0]!,header.selectedParent,'MERGESET_PARENT');
 const ordered=all.slice(1).sort((a,b)=>{const x=BigInt('0x'+mergeset.get(a)!.header.blueWork),y=BigInt('0x'+mergeset.get(b)!.header.blueWork);return x<y?-1:x>y?1:a<b?-1:a>b?1:0;});
 return merkle([all[0]!,...ordered].map(hash=>{const data=mergeset.get(hash);check(data,'MERGESET_BLOCK_MISSING');return minerPayloadLeaf(hash,data.header.blueWork,data.coinbasePayload);}));
}
function verifyPayload(current:BlockData,proofDigest:string,root:Uint8Array,parent:PayloadBlock):void {
 eq(current.header.selectedParent,parent.header.hash,'CONTEXT_SELECTED_PARENT');
 const ctx=H('SeqCommitMergesetContext',u64(parent.header.timestamp,'CONTEXT_TIMESTAMP'),u64(current.header.daa,'CONTEXT_DAA'),u64(current.header.blue,'CONTEXT_BLUE'));
 eq(hex(branch(ctx,root)),proofDigest,'PAYLOAD_CONTEXT_HEADER_MISMATCH');
}
function openSeq(opening:Uint8Array,base:number,parent:Uint8Array):Uint8Array {
 const ctx=H('SeqCommitMergesetContext',opening.slice(base+64,base+88));
 return branch(parent,branch(opening.slice(base,base+32),branch(ctx,opening.slice(base+32,base+64))));
}
/** Assemble from already-captured node data, verifying both independent header SeqCommits. */
export function assemblePassA(input:{boundaryDaa:bigint;parent:BlockData;target:BlockData;parentLane:unknown;targetLane:unknown;blocks:Map<string,PayloadBlock>}):PassAResult {
 const {boundaryDaa,parent,target,blocks}=input;
 check(parent.header.daa<boundaryDaa&&target.header.daa>=boundaryDaa&&target.header.blue>parent.header.blue,'FIRST_CROSSING');
 eq(target.header.selectedParent,parent.header.hash,'NOT_DIRECT_SELECTED_PARENT');
 const pProof=verifyLaneProof(parent.header.seqCommit,input.parentLane);
 const tProof=verifyLaneProof(target.header.seqCommit,input.targetLane,parent.header.seqCommit);
 const pParent=blocks.get(parent.header.selectedParent),tParent=blocks.get(target.header.selectedParent);
 check(pParent&&tParent,'CONTEXT_PARENT_MISSING');
 eq(pProof.parentSeq,pParent.header.seqCommit,'P_PARENT_HEADER_COMMITMENT');
 const pRoot=payloadRoot(parent,blocks),tRoot=payloadRoot(target,blocks);
 verifyPayload(parent,pProof.payloadAndCtxDigest,pRoot,pParent);verifyPayload(target,tProof.payloadAndCtxDigest,tRoot,tParent);
 const opening=cat(h32(target.header.hash),tProof.activityRoot,tRoot,u64(tParent.header.timestamp,'T_PARENT_TIME'),u64(target.header.daa,'T_DAA'),u64(target.header.blue,'T_BLUE'),h32(pProof.parentSeq),pProof.activityRoot,pRoot,u64(pParent.header.timestamp,'P_PARENT_TIME'),u64(parent.header.daa,'P_DAA'),u64(parent.header.blue,'P_BLUE'));
 check(opening.length===240,'PASS_A_LENGTH');
 eq(hex(openSeq(opening,152,opening.slice(120,152))),parent.header.seqCommit,'P_OPENING_COMMITMENT');
 eq(hex(openSeq(opening,32,openSeq(opening,152,opening.slice(120,152)))),target.header.seqCommit,'T_OPENING_COMMITMENT');
 return {opening,openingHex:hex(opening),boundaryDaa:boundaryDaa.toString(),parent:{hash:parent.header.hash,daa:parent.header.daa.toString(),seqCommit:parent.header.seqCommit},target:{hash:target.header.hash,daa:target.header.daa.toString(),seqCommit:target.header.seqCommit},activityRoots:{parent:hex(pProof.activityRoot),target:hex(tProof.activityRoot)},payloadRoots:{parent:hex(pRoot),target:hex(tRoot)}};
}
