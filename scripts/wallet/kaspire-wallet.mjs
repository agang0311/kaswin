/** Kaspire mobile wallet adapter over WalletConnect v2 + Android Intent / App Link wake.
 * Like browser extension adapters, Kaspire only signs the listed ordinary P2PK inputs via kaspa_signPskt;
 * it never broadcasts, and returned signature scripts are locally verified before copying into the page's draft. */
import SignClient from '@walletconnect/sign-client';
import QRCode from 'qrcode';
import {check,hex,FEE_CAP} from '../core.mjs';
import {p2pk} from '../core/lib/covenant-id.js';
import {decodeAddress,pubkeyToAddress} from './address.mjs';
import {parseJson,jsonText} from '../chain/json.mjs';
import {verifyOrdinarySignatures} from './wallet.mjs';
import {extensionSafeJson,committed} from './extension-wallet.mjs';

const PREFIX='kaspatest';
export const KASPIRE_PROJECT_ID='2c8e6060f4267c5f64d6cdab9009d378';
export const KASPIRE_CHAIN='kaspa:testnet-10';
export const KASPIRE_APP_LINK='https://kaspire.kaslab.space/kaspire/wc';
export const KASPIRE_WAKE_LINK='kaspire://dapp';

export const kaspireSchemeLink=wcUri=>`kaspire://wc?uri=${encodeURIComponent(wcUri)}`;
export const kaspireAppLink=wcUri=>`${KASPIRE_APP_LINK}?uri=${encodeURIComponent(wcUri)}`;
export const kaspireAndroidIntent=wcUri=>`intent://wc?uri=${encodeURIComponent(wcUri)}#Intent;scheme=kaspire;package=space.kaspire.wallet;end`;
export const isAndroidBrowser=()=>typeof navigator==='object'&&/Android/i.test(navigator.userAgent??'');
export const isMobileBrowser=()=>typeof navigator==='object'&&/Android|iPhone|iPad|iPod/i.test(navigator.userAgent??'');

export function triggerAppLink(url) {
  if(typeof document!=='object'||!url)return;
  try {
    const a=document.createElement('a');
    a.href=url;a.rel='noopener noreferrer';a.style.display='none';
    document.body.appendChild(a);a.click();a.remove();
  } catch {}
}

export function wakeKaspire() {
  if(isMobileBrowser())triggerAppLink(KASPIRE_WAKE_LINK);
}

export function warmKaspireClient() {
  void getSignClient().catch(()=>{});
}

export async function renderPairingQrDataUrl(text) {
  return QRCode.toDataURL(text,{width:220,margin:2,errorCorrectionLevel:'M'});
}

let clientPromise=null;
async function getSignClient() {
  if(!clientPromise) {
    const origin=typeof location==='object'&&/^https?:/.test(location.origin)?location.origin:'https://cd311.cn:888';
    clientPromise=SignClient.init({
      projectId:KASPIRE_PROJECT_ID,
      metadata:{name:'Kaswin Rolling (Testnet 10)',description:'Kaswin Rolling Testnet 10 Experiment',url:origin,icons:[]},
    }).catch(e=>{clientPromise=null;throw e;});
  }
  return clientPromise;
}

const SAFE_CODES=new Set(['WALLET_UNSUPPORTED','WALLET_NOT_AUTHORIZED','WALLET_NETWORK_MISMATCH','WALLET_SCHNORR_REQUIRED','WALLET_PUBLIC_KEY_MISMATCH','WALLET_CONNECT_TIMEOUT','WALLET_SIGN_TIMEOUT','WALLET_CLOSED','WALLET_CHANGED','WALLET_REQUEST_REJECTED']);
function safeError(e,fallback='WALLET_REQUEST_REJECTED') {
  const code=e?.code??e?.message;
  if(SAFE_CODES.has(code))return new Error(code);
  const msg=String(e?.message??e??'');
  if(/rejected|denied|cancel/i.test(msg))return new Error('WALLET_REQUEST_REJECTED');
  return new Error(fallback);
}

function bounded(fn,timeoutCode,ms,signal=null) {
  let timer=null,onAbort=null;
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(new Error('WALLET_REQUEST_REJECTED'));return;}
    const cleanup=()=>{if(timer)clearTimeout(timer);if(onAbort&&signal)signal.removeEventListener('abort',onAbort);};
    timer=setTimeout(()=>{cleanup();reject(new Error(timeoutCode));},ms);
    if(signal){onAbort=()=>{cleanup();reject(new Error('WALLET_REQUEST_REJECTED'));};signal.addEventListener('abort',onAbort,{once:true});}
    Promise.resolve().then(fn).then(v=>{cleanup();resolve(v);},e=>{cleanup();reject(e);});
  });
}

function ownerFromSession(session) {
  const accts=session?.namespaces?.kaspa?.accounts??[];
  for(const raw of accts) {
    const parts=String(raw).split(':');
    if(parts.length===3&&parts[0]==='kaspa'&&parts[1]==='testnet-10') {
      const payload=parts[2];
      const address=payload.startsWith(`${PREFIX}:`)?payload:`${PREFIX}:${payload}`;
      const decoded=decodeAddress(address,PREFIX);
      check(decoded.version===0&&decoded.payload.length===32,'WALLET_SCHNORR_REQUIRED');
      const key=hex(decoded.payload);
      return {address:pubkeyToAddress(key,PREFIX),key,network:'testnet-10'};
    }
  }
  throw new Error('WALLET_NETWORK_MISMATCH');
}

function sessionActive(s) {
  if(!s||typeof s!=='object')return false;
  if(typeof s.expiry==='number'&&s.expiry*1000<=Date.now())return false;
  return !!s?.namespaces?.kaspa?.chains?.includes(KASPIRE_CHAIN);
}

function extractSignedJson(res) {
  if(typeof res==='string')return res;
  if(res&&typeof res==='object') {
    if(typeof res.psktTransactionJson==='string')return res.psktTransactionJson;
    if(typeof res.txJsonString==='string')return res.txJsonString;
  }
  throw new Error('WALLET_RESPONSE_INVALID');
}

export async function openKaspireWallet({client=null,onPairingUri=null,onInvalidate=()=>{},onLog=()=>{},signal=null,timeoutMs=120000,reuseExisting=true}={}) {
  check(Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=300000,'WALLET_TIMEOUT_CONFIG');
  const sc=client??await getSignClient();
  let session=null,owner=null;

  if(reuseExisting) {
    const existing=sc.session.getAll().filter(sessionActive);
    for(const cand of existing) {
      try {owner=ownerFromSession(cand);session=cand;onLog(`Kaspire：复用已有会话 (${cand.topic.slice(0,8)}…)`);break;}
      catch {try{await sc.disconnect({topic:cand.topic,reason:{code:6000,message:'stale'}});}catch{}}
    }
  }

  if(!session) {
    let pair;
    try {
      pair=await bounded(()=>sc.connect({
        requiredNamespaces:{kaspa:{chains:[KASPIRE_CHAIN],methods:['kaspa_getAccounts','kaspa_getNetwork','kaspa_getPublicKey','kaspa_signPskt'],events:['accountsChanged','networkChanged']}},
      }),'WALLET_CONNECT_TIMEOUT',15000,signal);
    } catch(e){throw safeError(e,'WALLET_CONNECT_TIMEOUT');}
    const wcUri=pair?.uri;
    check(typeof wcUri==='string'&&/^wc:[0-9a-f]{64}@2\?/i.test(wcUri),'WALLET_REQUEST_REJECTED');
    const schemeUri=kaspireSchemeLink(wcUri),appLink=kaspireAppLink(wcUri),intentUri=kaspireAndroidIntent(wcUri);
    onPairingUri?.({wcUri,schemeUri,appLink,intentUri});
    const onVisible=()=>{
      if(typeof document==='object'&&document.visibilityState==='visible') {
        try{void sc.core?.relayer?.transportOpen?.();}catch{}
      }
    };
    if(typeof document==='object')document.addEventListener('visibilitychange',onVisible);
    try {
      session=await bounded(()=>pair.approval(),'WALLET_CONNECT_TIMEOUT',timeoutMs,signal);
      owner=ownerFromSession(session);
    } catch(e){throw safeError(e,'WALLET_CONNECT_TIMEOUT');}
    finally{if(typeof document==='object')document.removeEventListener('visibilitychange',onVisible);}
  }

  let closed=false;
  const onDelete=ev=>{if(ev?.topic===session.topic)invalidate();};
  const onEvent=ev=>{if(ev?.topic===session.topic&&['accountsChanged','networkChanged'].includes(ev?.params?.event?.name))invalidate();};
  const close=()=>{
    if(closed)return;
    closed=true;
    sc.off?.('session_delete',onDelete);sc.off?.('session_event',onEvent);
  };
  const invalidate=()=>{if(closed)return;close();onInvalidate();};
  sc.on?.('session_delete',onDelete);
  sc.on?.('session_event',onEvent);

  return Object.freeze({
    kind:'extension',id:'kaspire',name:'Kaspire',canSign:true,...owner,spk:p2pk(owner.key),
    get closed(){return closed;},
    close,
    async disconnectSession(){close();try{await sc.disconnect({topic:session.topic,reason:{code:6000,message:'user_disconnected'}});}catch{}},
    async sign(draft) {
      check(!closed,'WALLET_CLOSED');
      const auth=new Set(draft.authorizedInputIndices);
      if(!auth.size)return;
      check(typeof draft.fee==='bigint'&&draft.fee>0n&&draft.fee<=FEE_CAP,'SIGNER_FEE_SCOPE');
      check(draft.inputUtxos.reduce((n,u)=>n+u.value,0n)-draft.transaction.outputs.reduce((n,o)=>n+o.value,0n)===draft.fee,'SIGNER_CONSERVATION');
      for(const i of auth) {
        check(Number.isInteger(i)&&i>=0&&i<draft.transaction.inputs.length,'SIGNER_INPUT_SCOPE');
        const u=draft.inputUtxos[i];check(u.spk.version===0&&u.spk.script===p2pk(owner.key).script&&!u.covenantId,'SIGNER_INPUT_SCOPE');
        check(draft.transaction.inputs[i].signatureScript==='','SIGNER_ALREADY_SIGNED');
      }
      const request=extensionSafeJson(draft,owner),approved=jsonText(draft.transaction),contexts=jsonText(draft.inputUtxos);
      const params={txJsonString:request,options:{signInputs:[...auth].map(index=>({index,sighashType:1}))}};
      const serializedParams=JSON.stringify(params);
      const reopenRelay=()=>Promise.resolve(sc.core?.relayer?.restartTransport?.()??sc.core?.relayer?.transportOpen?.()).catch(()=>{});
      let rawRes,wakeTimer=null,woken=false,settled=false;
      const scheduleWake=(delayMs)=>{
        if(woken||settled)return;
        woken=true;
        wakeTimer=setTimeout(()=>{if(!settled)wakeKaspire();},delayMs);
      };
      const onSent=ev=>{
        if(ev?.topic!==session.topic||ev?.request?.method!=='kaspa_signPskt')return;
        try{if(JSON.stringify(ev.request?.params)!==serializedParams)return;}catch{return;}
        onLog('Kaspire：签名请求已送达中继，正在拉起 Kaspire…');
        scheduleWake(700);
      };
      const onVisible=()=>{
        if(typeof document==='object'&&document.visibilityState==='visible'){onLog('Kaspire：页面回到前台，刷新中继连接…');void reopenRelay();}
      };
      sc.on?.('session_request_sent',onSent);
      if(typeof document==='object')document.addEventListener('visibilitychange',onVisible);
      onLog(`Kaspire：正在发送签名请求 (${session.topic.slice(0,8)}…)`);
      try {
        rawRes=await bounded(()=>sc.request({
          topic:session.topic,chainId:KASPIRE_CHAIN,
          request:{method:'kaspa_signPskt',params},
        }),'WALLET_SIGN_TIMEOUT',timeoutMs);
        onLog('Kaspire：已收到签名响应，正在本地验签…');
      } catch(e){
        onLog(`Kaspire：签名异常 (${String(e?.code??e?.message??e).slice(0,120)})`);
        throw safeError(e,'WALLET_SIGN_TIMEOUT');
      }
      finally {
        settled=true;
        if(wakeTimer)clearTimeout(wakeTimer);
        sc.off?.('session_request_sent',onSent);
        if(typeof document==='object')document.removeEventListener('visibilitychange',onVisible);
      }
      check(!closed,'WALLET_CLOSED');
      check(jsonText(draft.transaction)===approved&&jsonText(draft.inputUtxos)===contexts,'WALLET_DRAFT_CHANGED');
      const response=extractSignedJson(rawRes);
      check(response.length<=8*1024*1024,'WALLET_RESPONSE_INVALID');
      let back;try{back=parseJson(response);}catch{throw new Error('WALLET_RESPONSE_INVALID');}
      check(committed(back,auth)===committed(parseJson(request),auth),'WALLET_TRANSACTION_CHANGED');
      const candidate=structuredClone(draft);
      for(const index of auth)candidate.transaction.inputs[index].signatureScript=String(back.inputs[index].signatureScript??'').toLowerCase();
      await verifyOrdinarySignatures(candidate);
      check(!closed,'WALLET_CLOSED');
      for(const index of auth)draft.transaction.inputs[index].signatureScript=candidate.transaction.inputs[index].signatureScript;
    },
  });
}
