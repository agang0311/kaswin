/** Client of the read-only budget/engine service. The service holds no key and never broadcasts; its answers are
 * advisory (an offline script-engine run) and are accepted only when bound to THIS request's digest, txid and mode.
 * Budgets/fees/mass are always recomputed by the page. */
import {toWire,checkServiceReply,TN10_NETWORK_ID,TN10_PROFILE_ID,SCHEMA,LIMITS} from './protocol.mjs';
import {check} from '../../scripts/rolling/core.mjs';
const REPLY_LIMIT=1_000_000;
const err=(code,extra={})=>Object.assign(new Error(code),{code,safeCode:code,...extra});
export function serviceBase(text) {
  const u=new URL(String(text).trim());
  check(u.protocol==='http:'||u.protocol==='https:','SERVICE_URL');
  check(!u.username&&!u.password&&!u.search&&!u.hash,'SERVICE_URL');
  return u.origin+u.pathname.replace(/\/+$/,'');
}
export function createServiceClient({baseUrl,fetchImpl=globalThis.fetch,enginePin=null,timeoutMs=60000}={}) {
  const base=serviceBase(baseUrl);
  async function call(path,init) {
    const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),timeoutMs);
    let res,text;
    try {
      res=await fetchImpl(base+path,{...init,signal:ctl.signal,redirect:'error',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'});
      text=await res.text();
    } catch(e) {throw err(ctl.signal.aborted?'SERVICE_TIMEOUT':'SERVICE_UNREACHABLE');}
    finally {clearTimeout(timer);}
    if(text.length>REPLY_LIMIT)throw err('SERVICE_REPLY_SIZE');
    let body;try{body=JSON.parse(text);}catch{throw err('SERVICE_REPLY_FORMAT',{status:res.status});}
    if(res.status===429)throw err('SERVICE_BUSY');
    if(!res.ok||body?.ok===false)throw err(typeof body?.code==='string'&&/^[A-Z0-9_]{3,64}$/.test(body.code)?body.code:'SERVICE_ERROR',{status:res.status});
    return body;
  }
  async function run(mode,draft,accessor) {
    const wire=toWire(mode,draft,{accessor}),body=JSON.stringify(wire);
    check(body.length<=LIMITS.bodyBytes,'SERVICE_REQUEST_SIZE');
    const reply=await call('/api/'+mode,{method:'POST',headers:{'content-type':'application/json'},body});
    return checkServiceReply(wire,reply,{enginePin});
  }
  return Object.freeze({
    base,
    async info() {
      const i=await call('/api/info',{method:'GET'});
      check(i.schema===SCHEMA&&i.network===TN10_NETWORK_ID&&i.profileId===TN10_PROFILE_ID&&i.readOnly===true&&i.holdsKeys===false&&i.broadcasts===false,'SERVICE_IDENTITY');
      if(enginePin)check(i.engine?.binarySha256===enginePin,'SERVICE_ENGINE_PIN');
      return {engine:i.engine,limits:i.limits,configured:i.engine?.configured===true};
    },
    /** Unsigned draft: real-engine measurement of the covenant (non-signing) inputs. */
    measure:(draft,{accessor=null}={})=>run('measure',draft,accessor),
    /** Signed draft: every input executed under the transaction's committed budgets. */
    verify:(draft,{accessor=null}={})=>run('verify',draft,accessor),
  });
}
