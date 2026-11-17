/** Wire format shared by the TN10 rolling page and the read-only budget/engine service.
 * Pure data code: no DOM, Node API, key material, network access or fixtures.
 * Every amount is a decimal string on the wire; bigint only inside the decoded draft.
 * The digest binds a response to ONE exact request (mode, network, Profile, transaction bytes incl. witnesses,
 * input contexts, signing indices and PASS-A accessor). A service answer is advice about an offline script run,
 * NOT proof of consensus validity; the page recomputes mass/fees and the node alone decides acceptance. */
import {sha256} from '../wallet/sha256.mjs';
import {stable} from '../core/lib/bytes.js';
import {referenceTxId} from '../core/lib/transaction.js';
import {check,hex,unhex,MAX_OUTPUTS,VALUE_LIMIT,ZERO} from '../core.mjs';

export const SCHEMA=1;
export const TN10_NETWORK_ID='testnet-10';
export const TN10_GENESIS='f896a3034873be1739fc4359236899fd3d65d2bc94f9780df0d0da3eb1cc4370';
export const TN10_PROFILE_ID='b56bcd9cb654610b238a32bae25c41128ebd2837cc7a91b3ea835f8a102fc4e5';
/** Default TN10 registry output (matching V2.0.2 TN10.registry) for KCI / REST round discovery. */
export const TN10_ROLLING_REGISTRY=Object.freeze({
  address:'kaspatest:qztrjpfpuf6g9jw76e6ay909z43hndpv5maqkker6ur4enz7llarsh82ezggl',
  spk:Object.freeze({version:0,script:'2096390521e27482c9ded675d215e5156379b42ca6fa0b5b23d7075ccc5efffa38ac'}),
  valueSompi:20_000_000n,
});
export const MODES=Object.freeze(['measure','verify']);
export const LIMITS=Object.freeze({
  bodyBytes:1_500_000,maxInputs:17,maxOutputs:MAX_OUTPUTS,sigScriptBytes:80_000,totalSigScriptBytes:400_000,
  payloadBytes:1024,spkBytes:100,maxBudget:65535});
const HEX32=/^[0-9a-f]{64}$/,AMOUNT=/^(0|[1-9][0-9]{0,18})$/,EVEN_HEX=/^(?:[0-9a-f]{2})*$/;
const utf8=s=>new TextEncoder().encode(s);
export const sha256Hex=data=>hex(sha256(typeof data==='string'?utf8(data):data));

function exact(o,keys,code) {
  check(o&&typeof o==='object'&&!Array.isArray(o)&&Object.getPrototypeOf(o)===Object.prototype,code);
  const own=Object.keys(o);check(own.length===keys.length&&keys.every(k=>Object.hasOwn(o,k)),code);return o;
}
const amount=(v,code,limit=VALUE_LIMIT)=>{check(typeof v==='string'&&AMOUNT.test(v)&&BigInt(v)<=limit,code);return BigInt(v);};
const u64=(v,code)=>{check(typeof v==='string'&&AMOUNT.test(v)&&BigInt(v)<(1n<<64n),code);return BigInt(v);};
const int=(v,min,max,code)=>{check(Number.isSafeInteger(v)&&v>=min&&v<=max,code);return v;};
const hexBytes=(v,max,code)=>{check(typeof v==='string'&&EVEN_HEX.test(v)&&v.length<=max*2,code);return v;};
const hash=(v,code)=>{check(typeof v==='string'&&HEX32.test(v),code);return v;};
function spkOf(o,code) {
  exact(o,['version','script'],code);int(o.version,0,65535,code);hexBytes(o.script,LIMITS.spkBytes,code);check(o.script.length>0,code);
  return {version:o.version,script:o.script};
}

/** Client side: draft -> canonical wire request. Only fields the engine needs; funds' ownership is NOT conveyed. */
export function toWire(mode,draft,{accessor=null}={}) {
  check(MODES.includes(mode),'WIRE_MODE');
  const t=draft.transaction,auth=[...draft.authorizedInputIndices].sort((a,b)=>a-b);
  return {schema:SCHEMA,mode,network:TN10_NETWORK_ID,profileId:TN10_PROFILE_ID,
    transaction:{version:t.version,lockTime:t.lockTime.toString(),subnetworkId:t.subnetworkId,gas:t.gas.toString(),payload:t.payload,
      storageMass:(t.storageMass??0n).toString(),
      inputs:t.inputs.map(i=>({txid:i.previousOutpoint.transactionId,index:i.previousOutpoint.index,signatureScript:i.signatureScript,
        sequence:i.sequence.toString(),computeBudget:i.computeBudget})),
      outputs:t.outputs.map(o=>({value:o.value.toString(),spk:{version:o.scriptPublicKey.version,script:o.scriptPublicKey.script},
        covenant:o.covenant?{covenantId:o.covenant.covenantId,authorizingInput:o.covenant.authorizingInput}:null}))},
    inputUtxos:draft.inputUtxos.map(u=>({value:u.value.toString(),spk:{version:u.spk.version,script:u.spk.script},
      daa:(u.utxoDaa??u.daa).toString(),covenantId:u.covenantId&&u.covenantId!==ZERO?u.covenantId:null})),
    authorizedInputIndices:auth,
    accessor:accessor?{blockHash:accessor.blockHash,sequenceCommitment:accessor.sequenceCommitment}:null};
}

/** Strict decoder used by the service (and by tests). Unknown/missing fields, oversized or non-canonical values are rejected.
 * Returns the canonical wire object (re-serialised from the decoded values) and an engine-ready draft. */
export function parseWire(raw) {
  exact(raw,['schema','mode','network','profileId','transaction','inputUtxos','authorizedInputIndices','accessor'],'WIRE_SHAPE');
  check(raw.schema===SCHEMA,'WIRE_SCHEMA');check(MODES.includes(raw.mode),'WIRE_MODE');
  check(raw.network===TN10_NETWORK_ID,'WIRE_NETWORK');check(raw.profileId===TN10_PROFILE_ID,'WIRE_PROFILE');
  const t=exact(raw.transaction,['version','lockTime','subnetworkId','gas','payload','storageMass','inputs','outputs'],'WIRE_TX');
  check(t.version===1,'WIRE_TX_VERSION');
  check(t.subnetworkId==='00'.repeat(20)&&t.gas==='0','WIRE_NATIVE_ONLY');
  const lockTime=u64(t.lockTime,'WIRE_LOCKTIME'),storageMass=u64(t.storageMass,'WIRE_STORAGE_MASS');
  hexBytes(t.payload,LIMITS.payloadBytes,'WIRE_PAYLOAD');
  check(Array.isArray(t.inputs)&&t.inputs.length>=1&&t.inputs.length<=LIMITS.maxInputs,'WIRE_INPUT_COUNT');
  check(Array.isArray(t.outputs)&&t.outputs.length>=1&&t.outputs.length<=LIMITS.maxOutputs,'WIRE_OUTPUT_COUNT');
  check(Array.isArray(raw.inputUtxos)&&raw.inputUtxos.length===t.inputs.length,'WIRE_UTXO_COUNT');
  check(Array.isArray(raw.authorizedInputIndices)&&raw.authorizedInputIndices.length<=t.inputs.length,'WIRE_AUTH_COUNT');
  const auth=raw.authorizedInputIndices.map(i=>int(i,0,t.inputs.length-1,'WIRE_AUTH_INDEX'));
  check(new Set(auth).size===auth.length&&auth.every((v,i)=>!i||v>auth[i-1]),'WIRE_AUTH_ORDER'); // strictly ascending = canonical
  let sigTotal=0;const seen=new Set();
  const inputs=t.inputs.map((i,n)=>{
    exact(i,['txid','index','signatureScript','sequence','computeBudget'],'WIRE_INPUT');
    hash(i.txid,'WIRE_OUTPOINT');int(i.index,0,0xffffffff,'WIRE_OUTPOINT_INDEX');
    check(!seen.has(i.txid+':'+i.index),'WIRE_DUPLICATE_INPUT');seen.add(i.txid+':'+i.index);
    hexBytes(i.signatureScript,LIMITS.sigScriptBytes,'WIRE_SIGSCRIPT_SIZE');sigTotal+=i.signatureScript.length/2;
    check(sigTotal<=LIMITS.totalSigScriptBytes,'WIRE_SIGSCRIPT_TOTAL');
    if(auth.includes(n)) check(raw.mode==='measure'?i.signatureScript==='':/^41[0-9a-f]{128}01$/.test(i.signatureScript),'WIRE_ORDINARY_WITNESS');
    else check(i.signatureScript.length>0,'WIRE_COVENANT_WITNESS');
    return {previousOutpoint:{transactionId:i.txid,index:i.index},signatureScript:i.signatureScript,sequence:u64(i.sequence,'WIRE_SEQUENCE'),
      computeBudget:int(i.computeBudget,0,LIMITS.maxBudget,'WIRE_BUDGET')};
  });
  const outputs=t.outputs.map(o=>{
    exact(o,['value','spk','covenant'],'WIRE_OUTPUT');
    const value=amount(o.value,'WIRE_OUTPUT_VALUE');check(value>0n,'WIRE_OUTPUT_VALUE');
    let covenant=null;
    if(o.covenant!==null){exact(o.covenant,['covenantId','authorizingInput'],'WIRE_COVENANT');
      covenant={covenantId:hash(o.covenant.covenantId,'WIRE_COVENANT_ID'),authorizingInput:int(o.covenant.authorizingInput,0,t.inputs.length-1,'WIRE_COVENANT_INPUT')};}
    return {value,scriptPublicKey:spkOf(o.spk,'WIRE_OUTPUT_SPK'),covenant};
  });
  const inputUtxos=raw.inputUtxos.map((u,n)=>{
    exact(u,['value','spk','daa','covenantId'],'WIRE_UTXO');
    const value=amount(u.value,'WIRE_UTXO_VALUE');check(value>0n,'WIRE_UTXO_VALUE');
    check(u.covenantId===null||(hash(u.covenantId,'WIRE_UTXO_COVENANT')&&u.covenantId!==ZERO),'WIRE_UTXO_COVENANT');
    return {outpoint:inputs[n].previousOutpoint,value,spk:spkOf(u.spk,'WIRE_UTXO_SPK'),daa:u64(u.daa,'WIRE_UTXO_DAA'),covenantId:u.covenantId};
  });
  let accessor=null;
  if(raw.accessor!==null){exact(raw.accessor,['blockHash','sequenceCommitment'],'WIRE_ACCESSOR');
    accessor={blockHash:hash(raw.accessor.blockHash,'WIRE_ACCESSOR'),sequenceCommitment:hash(raw.accessor.sequenceCommitment,'WIRE_ACCESSOR')};}
  const transaction={version:1,lockTime,subnetworkId:t.subnetworkId,gas:0n,payload:t.payload,storageMass,inputs,outputs};
  const draft={transaction,inputUtxos,authorizedInputIndices:auth};
  const wire=toWire(raw.mode,draft,{accessor});
  check(stable(wire)===stable(raw),'WIRE_NOT_CANONICAL');
  return {mode:raw.mode,wire,draft,accessor};
}

/** Digest over the exact canonical request, domain-separated. Client and service compute it independently. */
export const requestDigest=wire=>sha256Hex('KASWIN_ROLLING_TN10_SERVICE_V1\n'+stable(wire));
/** Consensus txid (witnesses excluded) of the transaction in a decoded draft. */
export const draftTxid=draft=>referenceTxId(draft.transaction);

/** Client-side acceptance of a service reply. Throws unless the reply is for EXACTLY this request.
 * Returns per-input measurements. Nothing here makes the reply a safety proof. */
export function checkServiceReply(wire,reply,{enginePin=null}={}) {
  check(reply&&typeof reply==='object'&&reply.schema===SCHEMA&&reply.ok===true,'REPLY_NOT_OK');
  check(reply.mode===wire.mode&&reply.network===TN10_NETWORK_ID&&reply.profileId===TN10_PROFILE_ID,'REPLY_SCOPE');
  check(reply.requestDigest===requestDigest(wire),'REPLY_DIGEST_MISMATCH');
  const parsed=parseWire(wire);
  check(reply.txid===draftTxid(parsed.draft),'REPLY_TXID_MISMATCH');
  check(reply.advisory===true&&reply.offlineScriptCheck===true,'REPLY_NOT_ADVISORY');
  const auth=new Set(parsed.draft.authorizedInputIndices),expected=wire.mode==='measure'
    ?parsed.draft.transaction.inputs.flatMap((_,i)=>auth.has(i)?[]:[i]):parsed.draft.transaction.inputs.map((_,i)=>i);
  check(Array.isArray(reply.inputs)&&reply.inputs.length===expected.length,'REPLY_INPUT_COVERAGE');
  const out=reply.inputs.map((x,n)=>{
    check(x&&x.input===expected[n]&&x.ok===true&&Number.isSafeInteger(x.minBudget)&&x.minBudget>=0&&x.minBudget<LIMITS.maxBudget
      &&Number.isSafeInteger(x.usedScriptUnits)&&x.usedScriptUnits>=0,'REPLY_INPUT');
    if(wire.mode==='verify')check(x.limitedOk===true&&parsed.draft.transaction.inputs[x.input].computeBudget>=x.minBudget,'REPLY_LIMITED');
    return {input:x.input,minBudget:x.minBudget,usedScriptUnits:x.usedScriptUnits};
  });
  check(reply.engine&&typeof reply.engine.binarySha256==='string'&&HEX32.test(reply.engine.binarySha256),'REPLY_ENGINE');
  if(enginePin)check(reply.engine.binarySha256===enginePin,'REPLY_ENGINE_PIN');
  return {inputs:out,engine:{binarySha256:reply.engine.binarySha256},requestDigest:reply.requestDigest,txid:reply.txid};
}
