/** Rolling indexer wire constants and bounded configuration. Importing starts nothing. */
import {resolve} from 'node:path';
import {TN10} from '../chain/tn10.mjs';
import {TN10_PROFILE_ID} from '../contract/bundle.mjs';
export {TN10,TN10_PROFILE_ID};
export const SCHEMA=1;
export const DEFAULTS=Object.freeze({endpoint:'ws://127.0.0.1:18210',host:'127.0.0.1',port:18212,
  pollMs:2000,staleMs:60000,rpcMs:30000,pageLimit:25,maxPageLimit:100,maxUrlBytes:8192,
  maxResponseBytes:16_000_000,maxObjectBytes:32_000_000,maxChainBlocks:20000,maxTransactions:100000,
  maxRequestsPerMinute:240,maxConcurrentRequests:8,cursorTtlMs:900000});
export function fail(code,status=503) {return Object.assign(new Error(code),{code,status});}
export function need(value,code,status=503) {if(!value)throw fail(code,status);return value;}
export const hash=value=>need(typeof value==='string'&&/^[0-9a-f]{64}$/.test(value),'INVALID_HASH',400)&&value;
export const decimal=value=>need(typeof value==='string'&&/^(0|[1-9][0-9]{0,24})$/.test(value),'INVALID_INTEGER',400)&&value;
export const wire=value=>JSON.stringify(value,(_,v)=>{
  if(typeof v==='bigint')return v.toString();
  if(v instanceof Uint8Array)return Buffer.from(v).toString('hex');
  if(typeof v==='number')need(Number.isSafeInteger(v),'UNSAFE_JSON_NUMBER');
  return v;
});
export function safeCode(error) {
  const text=error?.code??error?.safeCode??error?.message;
  return typeof text==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(text)?text:'INDEXER_UNAVAILABLE';
}
const integer=(text,min,max,code)=>{
  need(typeof text==='string'&&/^[0-9]{1,9}$/.test(text),code,400);const n=Number(text);
  need(Number.isSafeInteger(n)&&n>=min&&n<=max,code,400);return n;
};
export function configFromArgs(args=[]) {
  const known=new Set(['data-dir','port','host','rpc','start-hash','cors-origin','poll-ms','stale-ms','profile','network']);
  const seen=new Set(),values={},origins=[];
  for(const arg of args) {
    const m=/^--([a-z-]+)=(.+)$/.exec(arg);need(m&&known.has(m[1]),'INVALID_ARGUMENT',400);
    need(m[1]==='cors-origin'||!seen.has(m[1]),'DUPLICATE_ARGUMENT',400);seen.add(m[1]);
    if(m[1]==='cors-origin')origins.push(m[2]);else values[m[1]]=m[2];
  }
  need(!values.network||values.network===TN10.networkId,'UNSUPPORTED_NETWORK',400);
  need(!values.profile||values.profile===TN10_PROFILE_ID,'UNSUPPORTED_PROFILE',400);
  const endpoint=values.rpc??DEFAULTS.endpoint,u=new URL(endpoint);
  need(u.protocol==='ws:'&&['127.0.0.1','[::1]','localhost'].includes(u.hostname)&&!u.username&&!u.password&&!u.search&&!u.hash,'LOOPBACK_RPC_REQUIRED',400);
  const host=values.host??DEFAULTS.host;need(['127.0.0.1','::1'].includes(host),'LOOPBACK_HTTP_REQUIRED',400);
  for(const origin of origins) {
    const o=new URL(origin);need(['http:','https:'].includes(o.protocol)&&o.origin===origin&&!o.username&&!o.password,'INVALID_CORS_ORIGIN',400);
  }
  const pollMs=values['poll-ms']?integer(values['poll-ms'],250,30000,'INVALID_POLL_MS'):DEFAULTS.pollMs;
  const staleMs=values['stale-ms']?integer(values['stale-ms'],10000,300000,'INVALID_STALE_MS'):DEFAULTS.staleMs;
  need(staleMs>=pollMs*3,'INVALID_STALE_MS',400);
  return {...DEFAULTS,endpoint,host,port:values.port?integer(values.port,1024,65535,'INVALID_PORT'):DEFAULTS.port,
    dataDir:resolve(values['data-dir']??'var/rolling-indexer'),startHash:values['start-hash']?hash(values['start-hash']):TN10.genesis,
    corsOrigins:[...new Set(origins)],pollMs,staleMs,network:TN10.networkId,genesisHash:TN10.genesis,profileId:TN10_PROFILE_ID};
}
