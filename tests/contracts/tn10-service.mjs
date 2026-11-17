/** Read-only TN10 rolling budget / script-engine service. Explicitly started; importing has NO side effects.
 *   node tests/contracts/tn10-service.mjs [--port=8792] [--host=127.0.0.1] [--max-concurrent=2] [--timeout-ms=40000]
 * Needs KASWIN_VM_BIN (identity pinned by engine-pin.json, checked on every engine run by engine-gate).
 *   GET  /, /index.html         the standalone page built to dist/index.html (nothing else is served from disk)
 *   GET  /api/info              identity/limits (no secrets)
 *   POST /api/measure           real-engine budget measurement of UNSIGNED covenant inputs
 *   POST /api/verify            real-engine run of ALL inputs of the SIGNED transaction under its committed budgets (limited)
 * The service never holds keys, never signs, never broadcasts, never touches a node/wallet and offers no shell/file access.
 * Replies are bound to the request by an independently recomputable digest. They describe an OFFLINE script run over
 * the caller-supplied input contexts: they do not verify the UTXO set, do not claim consensus validity and are not a
 * safety proof. The page recomputes mass/fees, verifies inputs live and relies on the node for acceptance. */
import http from 'node:http';
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
import {parseWire,requestDigest,draftTxid,SCHEMA,TN10_NETWORK_ID,TN10_PROFILE_ID,LIMITS} from '../../scripts/contract/protocol.mjs';

const SELF=fileURLToPath(import.meta.url),here=dirname(SELF);
const PAGE=resolve(here,'../../dist/index.html');
const PIN=JSON.parse(readFileSync(new URL('./engine-pin.json',import.meta.url),'utf8'));
const LOOPBACK=new Set(['127.0.0.1','::1','localhost']);
const OUT_LIMIT=262144;
export const DEFAULTS=Object.freeze({port:8792,host:'127.0.0.1',maxConcurrent:2,timeoutMs:40000});
const NOTICE='Offline script-engine run over caller-supplied input contexts. Not a consensus verdict, not a UTXO check, not a safety proof.';

/** Codes that are about the engine/host rather than about the submitted transaction. engine-gate reports a runner exit
 * status != 0 (the usual way the pinned runner says "this transaction does not pass") as ENGINE_PROCESS_FAILED, so that
 * code is answered as 422 like ENGINE_REJECTED; a missing/unpinned binary is answered 503. */
const UNAVAILABLE=new Set(['ENGINE_BINARY_PIN','ENGINE_SOURCE_PIN','KASWIN_VM_BIN_REQUIRED','ENGINE_WORKER_FAILED']);

/** Project an engine result to the fields the page needs; never forward raw engine/error text. */
const project=rows=>rows.map(x=>({input:x.input,ok:x.ok===true,limitedOk:x.limitedOk===true,minBudget:x.minBudget,usedScriptUnits:x.usedScriptUnits}));

/** Worker body (runs in a child node process): parse the canonical wire again, run engine-gate, print one JSON line. */
async function engineWorker() {
  const chunks=[];let size=0;
  for await(const c of process.stdin){size+=c.length;if(size>LIMITS.bodyBytes*2)process.exit(2);chunks.push(c);}
  let out;
  try {
    const {runEngine}=await import('./engine-gate.mjs');
    const {mode,draft,accessor}=parseWire(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const auth=new Set(draft.authorizedInputIndices);
    const result=mode==='measure'
      ?runEngine(draft,{execute:draft.transaction.inputs.flatMap((_,i)=>auth.has(i)?[]:[i]),accessor})
      :runEngine(draft,{accessor,limited:true});
    out={ok:true,inputs:result.inputs.map(x=>({input:x.input,ok:x.ok,limitedOk:x.limitedOk,minBudget:x.minBudget,usedScriptUnits:x.usedScriptUnits}))};
  } catch(e) {out={ok:false,code:typeof e?.code==='string'&&/^[A-Z0-9_]{3,64}$/.test(e.code)?e.code:'ENGINE_WORKER_FAILED'};}
  process.stdout.write(JSON.stringify(out)+'\n');
}

/** Default engine: one short-lived child process per request, killed (whole process group) on timeout. */
export function processEngine({vmBin,timeoutMs=DEFAULTS.timeoutMs}={}) {
  return wire=>new Promise((resolveRun,reject)=>{
    if(!vmBin)return reject(Object.assign(new Error('x'),{code:'KASWIN_VM_BIN_REQUIRED'}));
    const child=spawn(process.execPath,[SELF,'--engine-worker'],{env:{PATH:process.env.PATH??'',KASWIN_VM_BIN:vmBin},stdio:['pipe','pipe','ignore'],detached:true});
    let out='',done=false;
    const finish=(fn,v)=>{if(done)return;done=true;clearTimeout(timer);fn(v);};
    const kill=()=>{try{process.kill(-child.pid,'SIGKILL');}catch{try{child.kill('SIGKILL');}catch{}}};
    const timer=setTimeout(()=>{kill();finish(reject,Object.assign(new Error('x'),{code:'ENGINE_TIMEOUT'}));},timeoutMs);
    child.stdout.on('data',d=>{out+=d;if(out.length>OUT_LIMIT){kill();finish(reject,Object.assign(new Error('x'),{code:'ENGINE_WORKER_FAILED'}));}});
    child.on('error',()=>finish(reject,Object.assign(new Error('x'),{code:'ENGINE_WORKER_FAILED'})));
    child.on('close',()=>{
      try {
        const r=JSON.parse(out.trim().split('\n').at(-1));
        if(r.ok===true&&Array.isArray(r.inputs))return finish(resolveRun,r.inputs);
        finish(reject,Object.assign(new Error('x'),{code:typeof r.code==='string'?r.code:'ENGINE_WORKER_FAILED'}));
      } catch {finish(reject,Object.assign(new Error('x'),{code:'ENGINE_WORKER_FAILED'}));}
    });
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(wire));
  });
}

function reply(res,status,body,extra={}) {
  const bytes=Buffer.from(JSON.stringify(body));
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',
    'content-length':bytes.length,...extra});res.end(bytes);
}
const fail=(res,status,code,extra)=>reply(res,status,{schema:SCHEMA,ok:false,code},extra);

/** Build (but do not start) the HTTP server. `engine(wire) -> Promise<inputs[]>` is injectable for tests. */
export function createTn10Service({vmBin=process.env.KASWIN_VM_BIN,engine=null,pagePath=PAGE,maxConcurrent=DEFAULTS.maxConcurrent,
  timeoutMs=DEFAULTS.timeoutMs,bodyLimit=LIMITS.bodyBytes,publicOrigin=null}={}) {
  if(publicOrigin!==null) {const u=new URL(publicOrigin);if(u.protocol!=='https:'||u.origin!==publicOrigin)throw new Error('PUBLIC_ORIGIN');}
  if(!Number.isSafeInteger(maxConcurrent)||maxConcurrent<1||maxConcurrent>16)throw new Error('MAX_CONCURRENT');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>120000)throw new Error('TIMEOUT_MS');
  const run=engine??processEngine({vmBin,timeoutMs});
  let active=0;
  const info=()=>({schema:SCHEMA,network:TN10_NETWORK_ID,profileId:TN10_PROFILE_ID,readOnly:true,holdsKeys:false,signs:false,broadcasts:false,
    engine:{configured:Boolean(vmBin||engine),binarySha256:PIN.binarySha256,scope:PIN.scope},
    limits:{...LIMITS,bodyBytes:bodyLimit,maxConcurrent,timeoutMs},notice:NOTICE});

  async function readBody(req) {
    const length=req.headers['content-length'];
    if(length!==undefined&&(!/^[0-9]+$/.test(length)||Number(length)>bodyLimit))throw Object.assign(new Error('x'),{status:413,code:'BODY_LIMIT'});
    const chunks=[];let size=0;
    for await(const c of req){size+=c.length;if(size>bodyLimit)throw Object.assign(new Error('x'),{status:413,code:'BODY_LIMIT'});chunks.push(c);}
    return Buffer.concat(chunks).toString('utf8');
  }
  async function api(req,res,mode) {
    if(!String(req.headers['content-type']??'').toLowerCase().startsWith('application/json'))return fail(res,415,'JSON_REQUIRED');
    // The slot is taken before the body is read, so a busy service never buffers more requests.
    if(active>=maxConcurrent)return fail(res,429,'BUSY',{'retry-after':'2'});
    active++;
    try {
      let parsed;
      try {parsed=parseWire(JSON.parse(await readBody(req)));}
      catch(e) {
        if(e.status)return fail(res,e.status,e.code);
        return fail(res,400,typeof e?.code==='string'&&e.code.startsWith('WIRE_')?e.code:'BAD_REQUEST');
      }
      if(parsed.mode!==mode)return fail(res,400,'WIRE_MODE');
      const digest=requestDigest(parsed.wire),txid=draftTxid(parsed.draft);
      const auth=new Set(parsed.draft.authorizedInputIndices);
      let inputs=[];
      try {
        const nothing=mode==='measure'&&parsed.draft.transaction.inputs.every((_,i)=>auth.has(i));
        if(!nothing)inputs=project(await run(parsed.wire));
      } catch(e) {
        const code=typeof e?.code==='string'?e.code:'ENGINE_WORKER_FAILED';
        if(code==='ENGINE_TIMEOUT')return fail(res,504,code);
        return fail(res,UNAVAILABLE.has(code)?503:422,/^ENGINE_|^KASWIN_VM_BIN_REQUIRED$/.test(code)?code:'ENGINE_REJECTED');
      }
      reply(res,200,{schema:SCHEMA,ok:true,mode,network:TN10_NETWORK_ID,profileId:TN10_PROFILE_ID,requestDigest:digest,txid,
        engine:{binarySha256:PIN.binarySha256,scope:PIN.scope},advisory:true,offlineScriptCheck:true,notConsensus:true,inputs,notice:NOTICE});
    } finally {active--;}
  }
  const server=http.createServer(async(req,res)=>{
    try {
      const port=server.address()?.port,host=req.headers.host;
      // DNS-rebinding / cross-site guard: only our own loopback origin may talk to the service.
      if(typeof host!=='string'||![`127.0.0.1:${port}`,`localhost:${port}`,`[::1]:${port}`].includes(host.toLowerCase()))return fail(res,403,'HOST_NOT_ALLOWED');
      if(req.headers.origin!==undefined&&req.headers.origin!=='http://'+host&&req.headers.origin!==publicOrigin)return fail(res,403,'ORIGIN_NOT_ALLOWED');
      if(typeof req.url!=='string'||req.url.length>256)return fail(res,414,'URL_TOO_LONG');
      const path=req.url.split('?')[0];
      if(req.method==='GET'||req.method==='HEAD') {
        if(path==='/api/info')return reply(res,200,info());
        if(path==='/'||path==='/index.html') {
          let page;try{page=await readFile(pagePath);}catch{return fail(res,503,'PAGE_NOT_BUILT');}
          res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',
            'x-frame-options':'DENY','referrer-policy':'no-referrer','content-length':page.length});
          return res.end(req.method==='HEAD'?undefined:page);
        }
        return fail(res,404,'NOT_FOUND');
      }
      if(req.method==='POST') {
        if(path==='/api/measure')return await api(req,res,'measure');
        if(path==='/api/verify')return await api(req,res,'verify');
        return fail(res,404,'NOT_FOUND');
      }
      return fail(res,405,'METHOD_NOT_ALLOWED',{allow:'GET, HEAD, POST'});
    } catch {if(!res.headersSent)fail(res,500,'REQUEST_FAILED');else res.destroy();}
  });
  server.requestTimeout=20000;server.headersTimeout=10000;server.keepAliveTimeout=5000;server.maxRequestsPerSocket=100;
  server.on('clientError',(_,socket)=>{if(socket.writable)socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');});
  return server;
}

/** Listen on a loopback address only. port 0 picks a free port (tests). */
export function startTn10Service({port=DEFAULTS.port,host=DEFAULTS.host,...options}={}) {
  if(!LOOPBACK.has(host))throw new Error('HOST_MUST_BE_LOOPBACK');
  if(!Number.isSafeInteger(port)||port<0||port>65535)throw new Error('PORT');
  const server=createTn10Service(options);
  return new Promise((res,rej)=>{
    server.once('error',rej);
    server.listen(port,host,()=>{
      server.off('error',rej);const a=server.address();
      res({server,host,port:a.port,url:`http://${host.includes(':')?`[${host}]`:host}:${a.port}/`,
        close:()=>new Promise(done=>{server.close(()=>done());server.closeAllConnections?.();})});
    });
  });
}

if(process.argv[1]&&resolve(process.argv[1])===SELF) {
  if(process.argv.includes('--engine-worker'))await engineWorker();
  else {
    const arg=n=>process.argv.find(x=>x.startsWith(`--${n}=`))?.slice(n.length+3);
    try {
      const options={};
      if(arg('port')!==undefined)options.port=Number(arg('port'));
      if(arg('host')!==undefined)options.host=arg('host');
      if(arg('max-concurrent')!==undefined)options.maxConcurrent=Number(arg('max-concurrent'));
      if(arg('timeout-ms')!==undefined)options.timeoutMs=Number(arg('timeout-ms'));
      if(arg('public-origin')!==undefined)options.publicOrigin=arg('public-origin');
      const s=await startTn10Service(options);
      console.log(`kaswin rolling TN10 service (read-only: no keys, no signing, no broadcast) listening on ${s.url}`);
      if(!process.env.KASWIN_VM_BIN)console.log('KASWIN_VM_BIN is not set: /api/measure and /api/verify will answer 503 KASWIN_VM_BIN_REQUIRED');
      for(const sig of ['SIGINT','SIGTERM'])process.once(sig,()=>{s.close().then(()=>process.exit(0));});
    } catch(e) {console.error(e.code??e.message);process.exitCode=1;}
  }
}
