/** Rolling TN10 extension wallets. Provider APIs follow the pinned KasWare/Kastle adapters in scripts/wallet/.
 * The extension only signs the listed ordinary inputs. It never broadcasts; returned transactions are not submitted.
 * Only locally verified SIGHASH_ALL signature scripts are copied into the page's own approved transaction. */
import {check,hex,unhex,FEE_CAP} from '../core.mjs';
import {p2pk} from '../core/lib/covenant-id.js';
import {referenceTxId} from '../core/lib/transaction.js';
import {decodeAddress,pubkeyToAddress} from './address.mjs';
import {parseJson,jsonText} from '../chain/json.mjs';
import {isSignature,spliceScriptSignature,verifyOrdinarySignatures} from './wallet.mjs';
import {schnorrSighash} from './sighash.mjs';
import {TN10} from '../chain/tn10.mjs';
const NAMES={kasware:'KasWare',kastle:'Kastle'};
const SESSION_PROBE_MS=4000;
const KASWARE_QUICK_PROBE_MS=1500;
const DEFAULT_CONNECT_TIMEOUT_MS=30000;
export const availableExtensionWallets=(globals=globalThis)=>Object.keys(NAMES).filter(id=>!!globals[id]).map(id=>({id,name:NAMES[id]}));
const spkText=s=>Number(s.version).toString(16).padStart(4,'0')+s.script;
const sameSession=(a,b)=>a.address===b.address&&a.key===b.key&&a.network===b.network;

async function quickGetAccounts(provider,ms=KASWARE_QUICK_PROBE_MS) {
  let timer;
  try {
    const accounts=await Promise.race([
      Promise.resolve().then(()=>provider.getAccounts()),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('PROBE_TIMEOUT')),ms);}),
    ]);
    return Array.isArray(accounts)&&typeof accounts[0]==='string'&&accounts[0].length>0?accounts:null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function requestKaswareAccounts(provider,deadline,signal=null) {
  const quick=await quickGetAccounts(provider,Math.min(KASWARE_QUICK_PROBE_MS,Math.max(100,deadline-performance.now())));
  if(quick)return quick;
  if(signal?.aborted)throw new Error('WALLET_CONNECT_CANCELLED');
  return new Promise((resolve,reject)=>{
    const remaining=deadline-performance.now();
    if(remaining<=0){reject(new Error('WALLET_CONNECT_TIMEOUT'));return;}
    let done=false,timer=null,probing=false;
    const finish=(ok,val)=>{
      if(done)return;
      done=true;
      if(timer)clearTimeout(timer);
      if(signal)signal.removeEventListener('abort',onAbort);
      try{provider.removeListener?.('accountsChanged',onAccounts);}catch{}
      if(typeof document==='object')document.removeEventListener('visibilitychange',onWake);
      if(typeof window==='object')window.removeEventListener('focus',onWake);
      if(ok)resolve(val);else reject(val);
    };
    const onAbort=()=>finish(false,new Error('WALLET_CONNECT_CANCELLED'));
    const onAccounts=accts=>{
      if(Array.isArray(accts)&&typeof accts[0]==='string'&&accts[0].length>0)finish(true,accts);
    };
    const onWake=()=>{
      if(done||probing)return;
      if(typeof document==='object'&&document.visibilityState==='hidden')return;
      probing=true;
      void quickGetAccounts(provider).then(accts=>{
        probing=false;
        if(accts)finish(true,accts);
      },()=>{probing=false;});
    };
    timer=setTimeout(()=>finish(false,new Error('WALLET_CONNECT_TIMEOUT')),remaining);
    if(signal)signal.addEventListener('abort',onAbort,{once:true});
    try{provider.on?.('accountsChanged',onAccounts);}catch{}
    if(typeof document==='object')document.addEventListener('visibilitychange',onWake);
    if(typeof window==='object')window.addEventListener('focus',onWake);
    Promise.resolve().then(()=>provider.requestAccounts()).then(
      accts=>finish(true,accts),
      err=>finish(false,err),
    );
  });
}

async function session(provider,id,{request=false,net=TN10,deadline=null,signal=null}={}) {
  let address,pub,network;
  if(id==='kastle') {
    check(typeof provider.getAccount==='function'&&typeof provider.getNetwork==='function'&&typeof provider.signTx==='function','WALLET_UNSUPPORTED');
    if(request)check(typeof provider.connect==='function'&&await provider.connect()===true,'WALLET_NOT_AUTHORIZED');
    const account=await provider.getAccount();address=account?.address;pub=account?.publicKey;network=await provider.getNetwork();
    check(network===net.networkId,'WALLET_NETWORK_MISMATCH');
  } else {
    check(typeof provider.getPublicKey==='function'&&typeof provider.getNetwork==='function'&&typeof provider.signPskt==='function'&&typeof provider.getAccounts==='function','WALLET_UNSUPPORTED');
    check(!request||typeof provider.requestAccounts==='function','WALLET_UNSUPPORTED');
    const accounts=await (request?requestKaswareAccounts(provider,deadline??(performance.now()+DEFAULT_CONNECT_TIMEOUT_MS),signal):provider.getAccounts());
    address=Array.isArray(accounts)?accounts[0]:null;
    pub=await provider.getPublicKey();network=await provider.getNetwork();check(network===net.kaswareNetwork,'WALLET_NETWORK_MISMATCH');
  }
  check(typeof address==='string'&&address.length>0,'WALLET_NOT_AUTHORIZED');
  const decoded=decodeAddress(address,net.addressPrefix);check(decoded.version===0&&decoded.payload.length===32,'WALLET_SCHNORR_REQUIRED');
  const key=hex(decoded.payload),publicKey=String(pub??'').toLowerCase();
  check(publicKey===key||(/^0[23][0-9a-f]{64}$/.test(publicKey)&&publicKey.slice(2)===key),'WALLET_PUBLIC_KEY_MISMATCH');
  return {address:pubkeyToAddress(key,net.addressPrefix),key,network:net.networkId};
}

export function extensionSafeJson(draft,owner,{clearScriptIndices=null}={}) {
  const t=draft.transaction,auth=new Set(draft.authorizedInputIndices);
  return jsonText({id:referenceTxId(t),version:t.version,
    inputs:t.inputs.map((input,n)=>{
      const u=draft.inputUtxos[n];
      return {transactionId:input.previousOutpoint.transactionId,index:input.previousOutpoint.index,sequence:String(input.sequence),sigOpCount:0,
        computeBudget:input.computeBudget??0,signatureScript:clearScriptIndices?.has(n)?'':input.signatureScript,
        utxo:{address:auth.has(n)?owner.address:null,amount:String(u.value),scriptPublicKey:spkText(u.spk),blockDaaScore:String(u.utxoDaa??u.daa),isCoinbase:false,covenantId:u.covenantId??null}};
    }),
    outputs:t.outputs.map(o=>({value:String(o.value),scriptPublicKey:spkText(o.scriptPublicKey),covenant:o.covenant?{authorizingInput:o.covenant.authorizingInput,covenantId:o.covenant.covenantId}:null})),
    subnetworkId:t.subnetworkId,lockTime:String(t.lockTime),gas:String(t.gas),storageMass:String(t.storageMass),payload:t.payload});
}
export function committed(value,auth) {
  check(value&&Array.isArray(value.inputs)&&Array.isArray(value.outputs),'WALLET_RESPONSE_INVALID');
  return jsonText({version:String(value.version),lockTime:String(value.lockTime),gas:String(value.gas),subnetworkId:String(value.subnetworkId).toLowerCase(),payload:String(value.payload??'').toLowerCase(),
    inputs:value.inputs.map((i,n)=>({txid:String(i.transactionId).toLowerCase(),index:String(i.index),sequence:String(i.sequence),signature:auth.has(n)?'':String(i.signatureScript??'').toLowerCase()})),
    outputs:value.outputs.map(o=>({value:String(o.value),spk:String(o.scriptPublicKey).toLowerCase(),covenant:o.covenant?[String(o.covenant.authorizingInput),String(o.covenant.covenantId).toLowerCase()]:null}))});
}

export async function openExtensionWallet(id,{globals=globalThis,onInvalidate=()=>{},timeoutMs=90000,connectTimeoutMs=DEFAULT_CONNECT_TIMEOUT_MS,signal=null,net=TN10}={}) {
  check(Object.hasOwn(NAMES,id),'WALLET_UNSUPPORTED');const provider=globals[id];check(provider&&typeof provider==='object','WALLET_NOT_INSTALLED');
  check(Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=300000,'WALLET_TIMEOUT_CONFIG');
  const safeCodes=new Set(['WALLET_UNSUPPORTED','WALLET_NOT_AUTHORIZED','WALLET_NETWORK_MISMATCH','WALLET_SCHNORR_REQUIRED','WALLET_PUBLIC_KEY_MISMATCH','WALLET_CONNECT_TIMEOUT','WALLET_CONNECT_CANCELLED','WALLET_SIGN_TIMEOUT','WALLET_SIGN_CANCELLED','WALLET_CLOSED','WALLET_CHANGED']);
  const safeError=e=>{const code=e?.code??e?.message;return new Error(safeCodes.has(code)?code:'WALLET_REQUEST_REJECTED');};
  const bounded=async(fn,code,deadline=performance.now()+timeoutMs,sig=null,cancelCode='WALLET_SIGN_CANCELLED')=>{
    if(sig?.aborted)throw new Error(cancelCode);
    const remaining=deadline-performance.now();if(remaining<=0)throw new Error(code);let timer;
    let onAbort=null;
    try{
      const race=[Promise.resolve().then(fn),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(code)),remaining);})];
      if(sig)race.push(new Promise((_,reject)=>{onAbort=()=>reject(new Error(cancelCode));sig.addEventListener('abort',onAbort,{once:true});}));
      return await Promise.race(race);
    }
    finally{clearTimeout(timer);if(sig&&onAbort)sig.removeEventListener('abort',onAbort);}
  };
  let owner;
  const connectDeadline=performance.now()+Math.min(timeoutMs,Math.max(100,Number(connectTimeoutMs)||DEFAULT_CONNECT_TIMEOUT_MS));
  try{owner=await bounded(()=>session(provider,id,{request:true,net,deadline:connectDeadline,signal}),'WALLET_CONNECT_TIMEOUT',connectDeadline,signal,'WALLET_CONNECT_CANCELLED');}catch(e){throw safeError(e);}
  let closed=false;const listeners=[];
  const close=()=>{if(closed)return;closed=true;for(const [name,fn]of listeners)try{provider.removeListener?.(name,fn);}catch{}};
  const invalidate=()=>{if(closed)return;close();onInvalidate();};
  const onAccountsChanged=payload=>{
    if(Array.isArray(payload)&&payload.length>0&&String(payload[0]??'').trim().toLowerCase()===owner.address)return;
    invalidate();
  };
  const onNetworkChanged=payload=>{
    const raw=String(payload??'').trim().toLowerCase();
    if(raw&&(raw===owner.network||raw===String(net.kaswareNetwork??'').toLowerCase()))return;
    invalidate();
  };
  if(typeof provider.on==='function')for(const [name,fn]of [['accountsChanged',onAccountsChanged],['networkChanged',onNetworkChanged]]){
    try{provider.on(name,fn);listeners.push([name,fn]);}catch{close();throw new Error('WALLET_EVENTS_UNAVAILABLE');}
  }
  const assertSession=async(deadline,{probe=false,signal=null}={})=>{
    check(!closed,'WALLET_CLOSED');
    if(globals[id]!==provider){invalidate();throw new Error('WALLET_CHANGED');}
    const probeDeadline=probe?Math.min(deadline,performance.now()+Math.min(timeoutMs,SESSION_PROBE_MS)):deadline;
    let current;
    try{current=await bounded(()=>session(provider,id,{net}),'WALLET_SIGN_TIMEOUT',probeDeadline,signal);}
    catch(e){const err=safeError(e);if(err.message!=='WALLET_SIGN_CANCELLED')invalidate();throw err;}
    if(closed||!sameSession(current,owner)){invalidate();throw new Error('WALLET_CHANGED');}
  };
  return Object.freeze({kind:'extension',id,name:NAMES[id],canSign:true,...owner,spk:p2pk(owner.key),
    capabilities:Object.freeze({supportsCovenantTxV1:true,selectiveSigning:true}),get closed(){return closed;},close,
    async ping() {
      if(closed)return false;
      try{await assertSession(performance.now()+Math.min(timeoutMs,SESSION_PROBE_MS),{probe:true});return true;}
      catch{return false;}
    },
    async sign(draft,{signal=null}={}) {
      const deadline=performance.now()+timeoutMs;await assertSession(deadline,{probe:true,signal});
      const auth=new Set(draft.authorizedInputIndices);
      const scriptInputs=Array.isArray(draft.scriptInputs)?draft.scriptInputs:[];
      if(!auth.size&&!scriptInputs.length)return;
      check(typeof draft.fee==='bigint'&&draft.fee>0n&&draft.fee<=FEE_CAP,'SIGNER_FEE_SCOPE');
      check(draft.inputUtxos.reduce((n,u)=>n+u.value,0n)-draft.transaction.outputs.reduce((n,o)=>n+o.value,0n)===draft.fee,'SIGNER_CONSERVATION');
      const utxos=draft.inputUtxos.map(u=>({value:u.value,spk:u.spk}));
      for(const i of auth){
        check(Number.isInteger(i)&&i>=0&&i<draft.transaction.inputs.length,'SIGNER_INPUT_SCOPE');
        const u=draft.inputUtxos[i];check(u.spk.version===0&&u.spk.script===p2pk(owner.key).script&&!u.covenantId,'SIGNER_INPUT_SCOPE');
        check(draft.transaction.inputs[i].signatureScript==='','SIGNER_ALREADY_SIGNED');
      }
      const scriptIdxSet=new Set();
      for(const si of scriptInputs){
        const i=si.inputIndex;
        check(Number.isInteger(i)&&i>=0&&i<draft.transaction.inputs.length&&!auth.has(i)&&!scriptIdxSet.has(i),'SIGNER_INPUT_SCOPE');
        check(!!draft.inputUtxos[i]?.covenantId&&si.ownerKey===owner.key,'SIGNER_INPUT_SCOPE');
        check(draft.transaction.inputs[i].signatureScript===si.prebuiltSignatureScript,'SIGNER_ALREADY_SIGNED');
        if(si.expectedSighash)check(hex(schnorrSighash(draft.transaction,utxos,i))===si.expectedSighash,'SCRIPT_SIGHASH_MISMATCH');
        scriptIdxSet.add(i);
      }
      const allSigned=new Set([...auth,...scriptIdxSet]);
      const request=extensionSafeJson(draft,owner,{clearScriptIndices:scriptIdxSet.size?scriptIdxSet:null}),approved=jsonText(draft.transaction),contexts=jsonText(draft.inputUtxos);let response;
      try {
        response=await bounded(()=>id==='kastle'
          ?provider.signTx(net.networkId,request,[...allSigned].map(inputIndex=>({inputIndex,signType:'All'})))
          :provider.signPskt({txJsonString:request,options:{signInputs:[...allSigned].map(index=>({index,sighashType:1}))}}),'WALLET_SIGN_TIMEOUT',deadline,signal);
      }catch(e){throw safeError(e);}
      await assertSession(deadline,{probe:true,signal});check(jsonText(draft.transaction)===approved&&jsonText(draft.inputUtxos)===contexts,'WALLET_DRAFT_CHANGED');
      check(typeof response==='string'&&response.length<=8*1024*1024,'WALLET_RESPONSE_INVALID');
      let back;try{back=parseJson(response);}catch{throw new Error('WALLET_RESPONSE_INVALID');}
      check(committed(back,allSigned)===committed(parseJson(request),allSigned),'WALLET_TRANSACTION_CHANGED');
      const candidate=structuredClone(draft);
      for(const index of auth)candidate.transaction.inputs[index].signatureScript=String(back.inputs[index].signatureScript??'').toLowerCase();
      for(const si of scriptInputs){
        const rawSig=String(back.inputs[si.inputIndex].signatureScript??'').toLowerCase();
        if(isSignature(rawSig)){
          candidate.transaction.inputs[si.inputIndex].signatureScript=spliceScriptSignature(si.prebuiltSignatureScript,si.signatureOffsets,rawSig.slice(2,132));
        }else if(rawSig.length===si.prebuiltSignatureScript.length){
          candidate.transaction.inputs[si.inputIndex].signatureScript=rawSig;
        }else{
          throw Object.assign(new Error('当前扩展钱包不支持对 KCC-20 合约输入签名，请改用 Kaspire 钱包购买 kUSDT 票。'),{code:'USER'});
        }
      }
      await verifyOrdinarySignatures(candidate);await assertSession(deadline);
      for(const index of allSigned)draft.transaction.inputs[index].signatureScript=candidate.transaction.inputs[index].signatureScript;
    },
  });
}
