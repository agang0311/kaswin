/** Kaspire mobile wallet adapter over WalletConnect v2 + Android Intent / App Link wake.
 * Like browser extension adapters, Kaspire only signs the listed ordinary P2PK inputs via kaspa_signPskt;
 * it never broadcasts, and returned signature scripts are locally verified before copying into the page's draft. */
import {check,hex,FEE_CAP} from '../core.mjs';
import {p2pk} from '../core/lib/covenant-id.js';
import {decodeAddress,pubkeyToAddress} from './address.mjs';
import {parseJson,jsonText} from '../chain/json.mjs';
import {verifyOrdinarySignatures} from './wallet.mjs';
import {schnorrSighash} from './sighash.mjs';
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

let depsPromise=null;
async function loadKaspireDeps() {
  const cached=globalThis.__KASWIN_KASPIRE_WC__;
  if(cached?.SignClient&&cached?.QRCode)return cached;
  if(depsPromise)return depsPromise;
  depsPromise=(async()=>{
    if(typeof document==='object'&&document.head) {
      await new Promise((resolve,reject)=>{
        const script=document.createElement('script');
        const timer=setTimeout(()=>{script.remove();reject(new Error('KASPIRE_SDK_TIMEOUT'));},20000);
        script.src='./kaspire-wc.js';
        if(typeof __KASWIN_KASPIRE_WC_INTEGRITY__==='string'&&__KASWIN_KASPIRE_WC_INTEGRITY__){
          script.integrity=__KASWIN_KASPIRE_WC_INTEGRITY__;
          script.crossOrigin='anonymous';
        }
        script.async=true;
        script.onload=()=>{clearTimeout(timer);resolve();};
        script.onerror=()=>{clearTimeout(timer);script.remove();reject(new Error('KASPIRE_SDK_LOAD_FAILED'));};
        document.head.appendChild(script);
      });
      const loaded=globalThis.__KASWIN_KASPIRE_WC__;
      if(!loaded?.SignClient||!loaded?.QRCode)throw new Error('KASPIRE_SDK_INVALID');
      return loaded;
    }
    const wcPkg='@walletconnect/'+'sign-client',qrPkg='qr'+'code';
    const [{default:SignClient},{default:QRCode}]=await Promise.all([
      import(wcPkg),
      import(qrPkg),
    ]);
    return {SignClient,QRCode};
  })().catch(e=>{depsPromise=null;throw e;});
  return depsPromise;
}

export function warmKaspireClient() {
  void getSignClient().catch(()=>{});
}

export async function renderPairingQrDataUrl(text) {
  const {QRCode}=await loadKaspireDeps();
  return QRCode.toDataURL(text,{width:220,margin:2,errorCorrectionLevel:'M'});
}

let clientPromise=null;
async function getSignClient() {
  if(!clientPromise) {
    const origin=typeof location==='object'&&/^https?:/.test(location.origin)?location.origin:'https://cd311.cn:888';
    clientPromise=(async()=>{
      const {SignClient}=await loadKaspireDeps();
      return SignClient.init({
        projectId:KASPIRE_PROJECT_ID,
        metadata:{name:'Kaswin Rolling',description:'Kaswin Rolling Lottery',url:origin,icons:[]},
      });
    })().catch(e=>{clientPromise=null;throw e;});
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

function ownerFromSession(session,net) {
  const accts=session?.namespaces?.kaspa?.accounts??[];
  for(const raw of accts) {
    const parts=String(raw).split(':');
    if(parts.length===3&&parts[0]==='kaspa'&&parts[1]===net.networkId) {
      const payload=parts[2];
      const address=payload.startsWith(`${net.addressPrefix}:`)?payload:`${net.addressPrefix}:${payload}`;
      const decoded=decodeAddress(address,net.addressPrefix);
      check(decoded.version===0&&decoded.payload.length===32,'WALLET_SCHNORR_REQUIRED');
      const key=hex(decoded.payload);
      return {address:pubkeyToAddress(key,net.addressPrefix),key,network:net.networkId};
    }
  }
  throw new Error('WALLET_NETWORK_MISMATCH');
}

function sessionActive(s,chain=KASPIRE_CHAIN) {
  if(!s||typeof s!=='object')return false;
  if(typeof s.expiry==='number'&&s.expiry*1000<=Date.now())return false;
  return !!s?.namespaces?.kaspa?.chains?.includes(chain);
}

function extractSignedJson(res) {
  if(typeof res==='string')return res;
  if(res&&typeof res==='object') {
    if(typeof res.psktTransactionJson==='string')return res.psktTransactionJson;
    if(typeof res.txJsonString==='string')return res.txJsonString;
  }
  throw new Error('WALLET_RESPONSE_INVALID');
}

function normalizeKaspaNetwork(raw) {
  const s=String(raw??'').trim().toLowerCase();
  if(s==='mainnet'||s==='kaspa:mainnet'||s==='kaspa_mainnet')return 'mainnet';
  if(s==='testnet-10'||s==='kaspa:testnet-10'||s==='kaspa_testnet_10'||s==='tn10')return 'testnet-10';
  return s;
}

function normalizeEventAddress(raw,prefix) {
  const s=String(raw??'').trim().toLowerCase();
  if(!s)return '';
  return s.includes(':')?s:`${prefix}:${s}`;
}

export async function openKaspireWallet({client=null,onPairingUri=null,onInvalidate=()=>{},onLog=()=>{},signal=null,timeoutMs=120000,reuseExisting=true,net={networkId:'testnet-10',addressPrefix:PREFIX}}={}) {
  check(Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=300000,'WALLET_TIMEOUT_CONFIG');
  const chain=`kaspa:${net.networkId}`;
  const sc=client??await getSignClient();
  let session=null,owner=null;

  if(reuseExisting) {
    const existing=sc.session.getAll().filter(s=>sessionActive(s,chain));
    for(const cand of existing) {
      try {owner=ownerFromSession(cand,net);session=cand;onLog(`Kaspire：复用已有会话 (${cand.topic.slice(0,8)}…)`);break;}
      catch {try{await sc.disconnect({topic:cand.topic,reason:{code:6000,message:'stale'}});}catch{}}
    }
  }

  if(!session) {
    let pair;
    onLog('Kaspire：正在连接 WalletConnect 中继…');
    try {
      pair=await bounded(()=>sc.connect({
        requiredNamespaces:{kaspa:{chains:[chain],methods:['kaspa_getAccounts','kaspa_getNetwork','kaspa_getPublicKey','kaspa_signPskt'],events:['accountsChanged','networkChanged']}},
      }),'WALLET_CONNECT_TIMEOUT',15000,signal);
    } catch(e){throw safeError(e,'WALLET_CONNECT_TIMEOUT');}
    onLog(`Kaspire：配对请求已生成（中继${sc.core?.relayer?.connected?'已连接':'未连接'}），等待 Kaspire 确认…`);
    const wcUri=pair?.uri;
    check(typeof wcUri==='string'&&/^wc:[0-9a-f]{64}@2\?/i.test(wcUri),'WALLET_REQUEST_REJECTED');
    const schemeUri=kaspireSchemeLink(wcUri),appLink=kaspireAppLink(wcUri),intentUri=kaspireAndroidIntent(wcUri);
    onPairingUri?.({wcUri,schemeUri,appLink,intentUri});
    const onVisible=()=>{
      if(typeof document==='object'&&document.visibilityState==='visible') {
        try{void (sc.core?.relayer?.restartTransport?.()??sc.core?.relayer?.transportOpen?.());}catch{}
      }
    };
    if(typeof document==='object')document.addEventListener('visibilitychange',onVisible);
    try {
      session=await bounded(()=>pair.approval(),'WALLET_CONNECT_TIMEOUT',timeoutMs,signal);
      owner=ownerFromSession(session,net);
    } catch(e){
      onLog(`Kaspire：连接未完成 (${String(e?.code??e?.message??e).slice(0,160)})`);
      throw safeError(e,'WALLET_CONNECT_TIMEOUT');
    }
    finally{if(typeof document==='object')document.removeEventListener('visibilitychange',onVisible);}
  }

  let closed=false;
  const onDelete=ev=>{
    if(ev?.topic!==session.topic)return;
    onLog(`Kaspire：会话已断开 (session_delete, ${session.topic.slice(0,8)}…)`);
    invalidate();
  };
  const onEvent=ev=>{
    if(ev?.topic!==session.topic)return;
    const name=ev?.params?.event?.name;
    const data=ev?.params?.event?.data;
    const evChain=ev?.params?.chainId;
    if(name==='networkChanged'){
      const nextNet=normalizeKaspaNetwork(data);
      if(nextNet&&nextNet===owner.network){
        onLog(`Kaspire：钱包已确认当前网络 (${nextNet})，保持会话`);
        return;
      }
      onLog(`Kaspire：钱包切换网络 (${String(data??'').slice(0,32)} ≠ ${owner.network})，断开当前会话`);
      invalidate();
      return;
    }
    if(name==='accountsChanged'){
      if(evChain&&evChain!==chain)return;
      const list=Array.isArray(data)?data:(typeof data==='string'&&data?[data]:[]);
      const nextAddr=list.length?normalizeEventAddress(list[0],net.addressPrefix):'';
      if(nextAddr&&nextAddr===owner.address){
        onLog('Kaspire：钱包账户未变化，保持会话');
        return;
      }
      onLog(`Kaspire：钱包账户已变化 (${nextAddr?'已切换其他地址':'空账户'})，断开当前会话`);
      invalidate();
    }
  };
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
    capabilities:Object.freeze({supportsCovenantTxV1:true,selectiveSigning:true}),
    get closed(){return closed;},
    close,
    async disconnectSession(){close();try{await sc.disconnect({topic:session.topic,reason:{code:6000,message:'user_disconnected'}});}catch{}},
    async sign(draft,{signal=null}={}) {
      check(!closed,'WALLET_CLOSED');
      if(signal?.aborted)throw Object.assign(new Error('WALLET_SIGN_CANCELLED'),{code:'WALLET_SIGN_CANCELLED'});
      const auth=new Set(draft.authorizedInputIndices);
      const scriptInputs=Array.isArray(draft.scriptInputs)?draft.scriptInputs:[];
      if(!auth.size&&!scriptInputs.length)return;
      check(typeof draft.fee==='bigint'&&draft.fee>0n&&draft.fee<=FEE_CAP,'SIGNER_FEE_SCOPE');
      check(draft.inputUtxos.reduce((n,u)=>n+u.value,0n)-draft.transaction.outputs.reduce((n,o)=>n+o.value,0n)===draft.fee,'SIGNER_CONSERVATION');
      const utxos=draft.inputUtxos.map(u=>({value:u.value,spk:u.spk}));
      for(const i of auth) {
        check(Number.isInteger(i)&&i>=0&&i<draft.transaction.inputs.length,'SIGNER_INPUT_SCOPE');
        const u=draft.inputUtxos[i];check(u.spk.version===0&&u.spk.script===p2pk(owner.key).script&&!u.covenantId,'SIGNER_INPUT_SCOPE');
        check(draft.transaction.inputs[i].signatureScript==='','SIGNER_ALREADY_SIGNED');
      }
      const scriptIdxSet=new Set();
      for(const si of scriptInputs) {
        const i=si.inputIndex;
        check(Number.isInteger(i)&&i>=0&&i<draft.transaction.inputs.length&&!auth.has(i)&&!scriptIdxSet.has(i),'SIGNER_INPUT_SCOPE');
        check(!!draft.inputUtxos[i]?.covenantId&&si.ownerKey===owner.key,'SIGNER_INPUT_SCOPE');
        check(draft.transaction.inputs[i].signatureScript===si.prebuiltSignatureScript,'SIGNER_ALREADY_SIGNED');
        if(si.expectedSighash)check(hex(schnorrSighash(draft.transaction,utxos,i))===si.expectedSighash,'SCRIPT_SIGHASH_MISMATCH');
        scriptIdxSet.add(i);
      }
      const allSigned=new Set([...auth,...scriptIdxSet]);
      const request=extensionSafeJson(draft,owner),approved=jsonText(draft.transaction),contexts=jsonText(draft.inputUtxos);
      const params=scriptInputs.length
        ?{
            psktTransactionJson:request,
            submitTransaction:false,
            signInputs:[...auth].map(index=>({index,sighashType:1})),
            scripts:scriptInputs.map(si=>({
              inputIndex:si.inputIndex,
              scriptHex:'',
              signType:si.signType??1,
              prebuiltSignatureScript:si.prebuiltSignatureScript,
              signatureOffsets:si.signatureOffsets,
              expectedSighash:si.expectedSighash,
            })),
          }
        :{txJsonString:request,options:{signInputs:[...auth].map(index=>({index,sighashType:1}))}};
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
        onLog('Kaspire：签名请求已送达中继');
      };
      const onVisible=()=>{
        if(typeof document==='object'&&document.visibilityState==='visible'){onLog('Kaspire：页面回到前台，刷新中继连接…');void reopenRelay();}
      };
      sc.on?.('session_request_sent',onSent);
      if(typeof document==='object')document.addEventListener('visibilitychange',onVisible);
      onLog(`Kaspire：正在发送签名请求 (${session.topic.slice(0,8)}…)`);
      // Trigger mobile wake within the user-activation window rather than waiting for relay publish + 700ms.
      scheduleWake(150);
      let onAbort=null;
      try {
        const reqP=bounded(()=>sc.request({
          topic:session.topic,chainId:chain,
          request:{method:'kaspa_signPskt',params},
        }),'WALLET_SIGN_TIMEOUT',timeoutMs);
        rawRes=signal?await new Promise((resolve,reject)=>{
          if(signal.aborted){reject(Object.assign(new Error('WALLET_SIGN_CANCELLED'),{code:'WALLET_SIGN_CANCELLED'}));return;}
          onAbort=()=>reject(Object.assign(new Error('WALLET_SIGN_CANCELLED'),{code:'WALLET_SIGN_CANCELLED'}));
          signal.addEventListener('abort',onAbort,{once:true});
          reqP.then(resolve,reject);
        }):await reqP;
        if(signal?.aborted)throw Object.assign(new Error('WALLET_SIGN_CANCELLED'),{code:'WALLET_SIGN_CANCELLED'});
        onLog('Kaspire：已收到签名响应，正在本地验签…');
      } catch(e){
        if(signal?.aborted||e?.code==='WALLET_SIGN_CANCELLED'){
          onLog('Kaspire：已取消等待签名');
          throw Object.assign(new Error('WALLET_SIGN_CANCELLED'),{code:'WALLET_SIGN_CANCELLED'});
        }
        onLog(`Kaspire：签名异常 (${String(e?.code??e?.message??e).slice(0,120)})`);
        throw safeError(e,'WALLET_SIGN_TIMEOUT');
      }
      finally {
        settled=true;
        if(onAbort&&signal)signal.removeEventListener('abort',onAbort);
        if(wakeTimer)clearTimeout(wakeTimer);
        sc.off?.('session_request_sent',onSent);
        if(typeof document==='object')document.removeEventListener('visibilitychange',onVisible);
      }
      check(!closed,'WALLET_CLOSED');
      check(jsonText(draft.transaction)===approved&&jsonText(draft.inputUtxos)===contexts,'WALLET_DRAFT_CHANGED');
      const response=extractSignedJson(rawRes);
      check(response.length<=8*1024*1024,'WALLET_RESPONSE_INVALID');
      let back;try{back=parseJson(response);}catch{throw new Error('WALLET_RESPONSE_INVALID');}
      check(committed(back,allSigned)===committed(parseJson(request),allSigned),'WALLET_TRANSACTION_CHANGED');
      const candidate=structuredClone(draft);
      for(const index of allSigned)candidate.transaction.inputs[index].signatureScript=String(back.inputs[index].signatureScript??'').toLowerCase();
      await verifyOrdinarySignatures(candidate);
      check(!closed,'WALLET_CLOSED');
      for(const index of allSigned)draft.transaction.inputs[index].signatureScript=candidate.transaction.inputs[index].signatureScript;
    },
  });
}
