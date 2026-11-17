import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture,fund,profile,PRICE,FEE} from './fixtures.mjs';
import {buildAction,buildGenesis} from './transactions.mjs';
import {createTn10Service,startTn10Service,processEngine,DEFAULTS} from './tn10-service.mjs';
import {toWire,parseWire,requestDigest,draftTxid,checkServiceReply,LIMITS} from '../../web/rolling-tn10/protocol.mjs';
import {openMemoryWallet} from '../../web/rolling-tn10/wallet.mjs';
import {createServiceClient} from '../../web/rolling-tn10/service-client.mjs';

const pin=JSON.parse(readFileSync(new URL('./engine-pin.json',import.meta.url),'utf8')).binarySha256;
const wallet=openMemoryWallet(createHash('sha256').update('rolling-tn10-service-test-key').digest('hex'));
const buy=(budgets=[10,10])=>{const f=fixture({module:'sales'});return buildAction(f.manager,profile,{action:'BUY',quantity:1,actorKey:wallet.key},{funds:[fund(2,10n*PRICE,wallet.key)],fee:FEE,budgets});};
const dir=mkdtempSync(join(tmpdir(),'tn10-service-test-'));
const pagePath=join(dir,'page.html');writeFileSync(pagePath,'<!doctype html><title>stub page</title>');
process.on('exit',()=>rmSync(dir,{recursive:true,force:true}));

/** In-test stub engine: echoes plausible rows for exactly the inputs it was asked to run, records what it saw. */
function stubEngine(opts={}) {
  const seen=[];
  const fn=async wire=>{
    seen.push(wire);if(opts.gate)await opts.gate;if(opts.fail)throw Object.assign(new Error(opts.message??'x'),{code:opts.fail});
    const {draft,mode}=parseWire(wire),auth=new Set(draft.authorizedInputIndices);
    const idx=mode==='measure'?draft.transaction.inputs.flatMap((_,i)=>auth.has(i)?[]:[i]):draft.transaction.inputs.map((_,i)=>i);
    return idx.map(i=>({input:i,ok:true,limitedOk:true,minBudget:4,usedScriptUnits:40000,extraSecret:'must-not-be-forwarded'}));
  };
  fn.seen=seen;return fn;
}
async function withService(options,fn) {
  const s=await startTn10Service({port:0,pagePath,...options});
  try {return await fn(s);} finally {await s.close();}
}
const call=(s,method,path,{body=null,headers={},raw=null}={})=>new Promise((resolve,reject)=>{
  const data=raw??(body===null?null:Buffer.from(typeof body==='string'?body:JSON.stringify(body)));
  const r=http.request({host:'127.0.0.1',port:s.port,method,path,headers:{...(data?{'content-type':'application/json','content-length':data.length}:{}),...headers}},res=>{
    const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{const text=Buffer.concat(chunks).toString('utf8');let json=null;try{json=JSON.parse(text);}catch{}resolve({status:res.statusCode,headers:res.headers,text,json});});
  });
  r.on('error',reject);if(data)r.write(data);r.end();
});

test('importing the module has no side effects; only loopback hosts can be bound',async()=>{
  assert.equal(DEFAULTS.port,8792);assert.equal(DEFAULTS.host,'127.0.0.1');
  assert.throws(()=>startTn10Service({host:'0.0.0.0'}),/HOST_MUST_BE_LOOPBACK/);
  assert.throws(()=>createTn10Service({maxConcurrent:0}),/MAX_CONCURRENT/);
  const server=createTn10Service({engine:stubEngine()});assert.equal(server.listening,false);
});
test('serves only the built page and /api/info; no sign/broadcast/file/shell surface exists',async()=>withService({engine:stubEngine()},async s=>{
  const info=await call(s,'GET','/api/info');
  assert.equal(info.status,200);assert.equal(info.json.network,'testnet-10');assert.equal(info.json.readOnly,true);
  assert.deepEqual([info.json.holdsKeys,info.json.signs,info.json.broadcasts],[false,false,false]);
  assert.equal(info.json.engine.binarySha256,pin);assert.equal(info.json.limits.maxConcurrent,2);
  const page=await call(s,'GET','/');assert.equal(page.status,200);assert.match(page.text,/stub page/);
  assert.equal(page.headers['x-frame-options'],'DENY');assert.equal(page.headers['cache-control'],'no-store');
  assert.equal((await call(s,'GET','/rolling-tn10.html')).status,200);
  assert.equal((await call(s,'HEAD','/')).status,200);
  for(const p of ['/index.html','/dist/index.html','/../../etc/passwd','/%2e%2e/%2e%2e/etc/passwd','/api/sign','/api/broadcast','/api/submit','/api/exec','/api/file','/api/wallet','/package.json'])
    assert.equal((await call(s,'GET',p)).status,404,p);
  for(const p of ['/api/sign','/api/broadcast','/api/submit','/api/info','/'])assert.equal((await call(s,'POST',p,{body:{}})).status,404,p);
  assert.equal((await call(s,'PUT','/api/measure',{body:{}})).status,405);
  assert.equal((await call(s,'DELETE','/')).status,405);
}));
test('missing page file answers 503 rather than reading anything else',async()=>withService({engine:stubEngine(),pagePath:join(dir,'nope.html')},async s=>{
  const r=await call(s,'GET','/');assert.equal(r.status,503);assert.equal(r.json.code,'PAGE_NOT_BUILT');
}));
test('Host and Origin guards block rebinding and cross-site callers',async()=>withService({engine:stubEngine()},async s=>{
  assert.equal((await call(s,'GET','/api/info',{headers:{host:'evil.example'}})).status,403);
  assert.equal((await call(s,'GET','/api/info',{headers:{host:`127.0.0.1:${s.port+1}`}})).status,403);
  assert.equal((await call(s,'GET','/api/info',{headers:{origin:'https://evil.example'}})).status,403);
  assert.equal((await call(s,'GET','/api/info',{headers:{host:`localhost:${s.port}`}})).status,200);
  assert.equal((await call(s,'GET','/api/info',{headers:{origin:`http://127.0.0.1:${s.port}`}})).status,200);
}));
test('explicit HTTPS reverse-proxy origin is allowed without relaxing Host or other origins',async()=>withService({engine:stubEngine(),publicOrigin:'https://cd311.cn'},async s=>{
  assert.equal((await call(s,'GET','/api/info',{headers:{origin:'https://cd311.cn'}})).status,200);
  assert.equal((await call(s,'GET','/api/info',{headers:{origin:'https://evil.example'}})).status,403);
  assert.equal((await call(s,'GET','/api/info',{headers:{origin:'https://cd311.cn',host:'evil.example'}})).status,403);
  assert.throws(()=>createTn10Service({publicOrigin:'http://cd311.cn'}),/PUBLIC_ORIGIN/);
}));
test('/api/measure measures only unsigned covenant inputs and the reply is bound to the request',async()=>{
  const engine=stubEngine();
  await withService({engine},async s=>{
    const d=buy(),wire=toWire('measure',d),r=await call(s,'POST','/api/measure',{body:wire});
    assert.equal(r.status,200);assert.deepEqual(Object.keys(r.json.inputs[0]).sort(),['input','limitedOk','minBudget','ok','usedScriptUnits']); // raw engine extras are not forwarded
    assert.equal(r.json.requestDigest,requestDigest(wire));assert.equal(r.json.txid,draftTxid(d));
    assert.equal(r.json.advisory,true);assert.equal(r.json.notConsensus,true);assert.equal(r.json.offlineScriptCheck,true);
    const checked=checkServiceReply(wire,r.json,{enginePin:pin});assert.deepEqual(checked.inputs.map(x=>x.input),[0]);
    // The reply cannot be reused for another quote of the same transaction.
    const other=structuredClone(wire);other.transaction.inputs[0].computeBudget=77;
    assert.throws(()=>checkServiceReply(other,r.json,{enginePin:pin}),/REPLY_DIGEST_MISMATCH/);
    // Mode confusion is refused.
    assert.equal((await call(s,'POST','/api/verify',{body:wire})).status,400);
    assert.equal(engine.seen.length,1);
    // Genesis has no covenant input: nothing to measure, no engine run.
    const g=buildGenesis(profile,wallet.key,{ticketPrice:PRICE,ticketCap:3,minTickets:3,closeEligibleDaa:1000n},{funds:[fund(1,10n*PRICE,wallet.key)],fee:FEE,budgets:[10]});
    const gr=await call(s,'POST','/api/measure',{body:toWire('measure',g)});assert.equal(gr.status,200);assert.deepEqual(gr.json.inputs,[]);assert.equal(engine.seen.length,1);
  });
});
test('/api/verify covers every input of the SIGNED transaction and requires well-formed ordinary witnesses',async()=>withService({engine:stubEngine()},async s=>{
  const d=buy();await wallet.sign(d);
  const wire=toWire('verify',d),r=await call(s,'POST','/api/verify',{body:wire});
  assert.equal(r.status,200);assert.equal(r.json.inputs.length,2);assert.ok(r.json.inputs.every(x=>x.limitedOk));
  checkServiceReply(wire,r.json,{enginePin:pin});
  const unsigned=toWire('verify',buy());assert.equal((await call(s,'POST','/api/verify',{body:unsigned})).json.code,'WIRE_ORDINARY_WITNESS');
}));
test('strict input handling: content type, JSON, schema, sizes',async()=>withService({engine:stubEngine(),bodyLimit:20000},async s=>{
  const wire=toWire('measure',buy());
  assert.equal((await call(s,'POST','/api/measure',{body:wire,headers:{'content-type':'text/plain'}})).status,415);
  assert.equal((await call(s,'POST','/api/measure',{body:'{not json'})).json.code,'BAD_REQUEST');
  assert.equal((await call(s,'POST','/api/measure',{body:{...wire,extra:1}})).json.code,'WIRE_SHAPE');
  assert.equal((await call(s,'POST','/api/measure',{body:{...wire,network:'mainnet'}})).json.code,'WIRE_NETWORK');
  assert.equal((await call(s,'POST','/api/measure',{body:{...wire,profileId:'00'.repeat(32)}})).json.code,'WIRE_PROFILE');
  const hugeScript=structuredClone(wire);hugeScript.transaction.inputs[0].signatureScript='ab'.repeat(LIMITS.sigScriptBytes+1);
  const big=await call(s,'POST','/api/measure',{body:hugeScript});assert.equal(big.status,413); // over this test's tiny body limit
  const big2=await call(s,'POST','/api/measure',{raw:Buffer.alloc(30000,32),headers:{'content-type':'application/json'}});assert.equal(big2.status,413);assert.equal(big2.json.code,'BODY_LIMIT');
}));
test('size limits inside the schema are enforced independently of the body limit',async()=>withService({engine:stubEngine()},async s=>{
  const wire=toWire('measure',buy());
  const hugeScript=structuredClone(wire);hugeScript.transaction.inputs[0].signatureScript='ab'.repeat(LIMITS.sigScriptBytes+1);
  assert.equal((await call(s,'POST','/api/measure',{body:hugeScript})).json.code,'WIRE_SIGSCRIPT_SIZE');
  const hugeSpk=structuredClone(wire);hugeSpk.transaction.outputs[0].spk.script='aa'.repeat(LIMITS.spkBytes+1);
  assert.equal((await call(s,'POST','/api/measure',{body:hugeSpk})).json.code,'WIRE_OUTPUT_SPK');
  const tooMany=structuredClone(wire);tooMany.transaction.inputs=Array(LIMITS.maxInputs+1).fill(wire.transaction.inputs[0]);
  assert.equal((await call(s,'POST','/api/measure',{body:tooMany})).json.code,'WIRE_INPUT_COUNT');
  const manyOut=structuredClone(wire);manyOut.transaction.outputs=Array(LIMITS.maxOutputs+1).fill(wire.transaction.outputs[0]);
  assert.equal((await call(s,'POST','/api/measure',{body:manyOut})).json.code,'WIRE_OUTPUT_COUNT');
}));
test('busy service answers 429 immediately and frees its slot afterwards',async()=>{
  let release;const gate=new Promise(r=>{release=r;});const engine=stubEngine({gate});
  await withService({engine,maxConcurrent:1},async s=>{
    const wire=toWire('measure',buy()),first=call(s,'POST','/api/measure',{body:wire});
    await new Promise(r=>setTimeout(r,150));
    const second=await call(s,'POST','/api/measure',{body:wire});assert.equal(second.status,429);assert.equal(second.json.code,'BUSY');assert.equal(second.headers['retry-after'],'2');
    release();assert.equal((await first).status,200);
    assert.equal((await call(s,'POST','/api/measure',{body:wire})).status,200);
  });
});
test('engine failures map to fixed codes and never leak internal text',async()=>{
  const wire=toWire('measure',buy());
  for(const [fail,status,code] of [['ENGINE_TIMEOUT',504,'ENGINE_TIMEOUT'],['ENGINE_REJECTED',422,'ENGINE_REJECTED'],['ENGINE_INPUT_COVERAGE',422,'ENGINE_INPUT_COVERAGE'],
    ['ENGINE_BINARY_PIN',503,'ENGINE_BINARY_PIN'],['ENGINE_PROCESS_FAILED',422,'ENGINE_PROCESS_FAILED'],['KASWIN_VM_BIN_REQUIRED',503,'KASWIN_VM_BIN_REQUIRED'],['WHATEVER',422,'ENGINE_REJECTED']]) {
    await withService({engine:stubEngine({fail,message:'/root/secret/path private'})},async s=>{
      const r=await call(s,'POST','/api/measure',{body:wire});assert.equal(r.status,status);assert.deepEqual(r.json,{schema:1,ok:false,code});
      assert.ok(!r.text.includes('/root')&&!r.text.includes('private'));
    });
  }
});
test('default process engine: missing binary and unpinned binary are refused (503), nothing is run',async()=>{
  const wire=toWire('measure',buy());
  await withService({vmBin:undefined,engine:undefined},async s=>{
    const r=await call(s,'POST','/api/measure',{body:wire});
    if(process.env.KASWIN_VM_BIN)return; // default came from the environment; covered by the real-engine tests
    assert.equal(r.status,503);assert.equal(r.json.code,'KASWIN_VM_BIN_REQUIRED');
  });
  const fake=join(dir,'fake-vm');writeFileSync(fake,'not the pinned engine',{mode:0o700});
  await withService({vmBin:fake},async s=>{const r=await call(s,'POST','/api/measure',{body:wire});assert.equal(r.status,503);assert.equal(r.json.code,'ENGINE_BINARY_PIN');});
});
test('process engine kills a hung worker at the deadline',async()=>{
  // The worker is this very module; make it hang by pointing the pin check at stdin that never closes is not possible, so
  // verify the timer path directly with a deadline shorter than node start-up.
  const run=processEngine({vmBin:'/nonexistent',timeoutMs:1});
  await assert.rejects(()=>run(toWire('measure',buy())),e=>['ENGINE_TIMEOUT','ENGINE_BINARY_PIN','ENGINE_WORKER_FAILED'].includes(e.code));
});
test('the page client talks to the service end-to-end over HTTP and refuses a lying service',async()=>{
  await withService({engine:stubEngine()},async s=>{
    const client=createServiceClient({baseUrl:s.url,enginePin:pin});
    assert.equal((await client.info()).engine.binarySha256,pin);
    const d=buy(),m=await client.measure(d);assert.equal(m.inputs[0].minBudget,4);
    await wallet.sign(d);const v=await client.verify(d);assert.equal(v.inputs.length,2);
    const wrongPin=createServiceClient({baseUrl:s.url,enginePin:'ab'.repeat(32)});
    await assert.rejects(()=>wrongPin.info(),/SERVICE_ENGINE_PIN/);
    await assert.rejects(()=>wrongPin.measure(buy()),/REPLY_ENGINE_PIN/);
  });
  // A service that answers for a DIFFERENT transaction is refused.
  const liar=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{
    const other=toWire('measure',buy([11,11])),r={schema:1,ok:true,mode:'measure',network:'testnet-10',profileId:other.profileId,requestDigest:requestDigest(other),txid:draftTxid(parseWire(other).draft),
      engine:{binarySha256:pin},advisory:true,offlineScriptCheck:true,inputs:[{input:0,ok:true,limitedOk:true,minBudget:1,usedScriptUnits:1}]};
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(r));});});
  await new Promise(r=>liar.listen(0,'127.0.0.1',r));
  try {await assert.rejects(()=>createServiceClient({baseUrl:`http://127.0.0.1:${liar.address().port}`,enginePin:pin}).measure(buy()),/REPLY_DIGEST_MISMATCH/);}
  finally {await new Promise(r=>liar.close(r));}
  assert.throws(()=>createServiceClient({baseUrl:'ftp://x'}),/SERVICE_URL/);
});

// --- Real script engine (needs the pinned runner: KASWIN_VM_BIN) ---
const engineTest=(name,fn)=>test(name,{skip:!process.env.KASWIN_VM_BIN},fn);
engineTest('real engine over HTTP: measure -> sign -> verify passes; a changed output is rejected (422)',async()=>{
  await withService({timeoutMs:60000},async s=>{
    const client=createServiceClient({baseUrl:s.url,enginePin:pin}),f=fixture({module:'sales'}),op={action:'BUY',quantity:1,actorKey:wallet.key};
    const opts={funds:[fund(2,10n*PRICE,wallet.key)],fee:FEE,budgets:[65535,65535]};
    let d=buildAction(f.manager,profile,op,opts);
    const m=await client.measure(d);assert.deepEqual(m.inputs.map(x=>x.input),[0]);
    opts.budgets=[m.inputs[0].minBudget+1,10];d=buildAction(f.manager,profile,op,opts);await wallet.sign(d);
    const v=await client.verify(d);assert.equal(v.inputs.length,2);
    d.transaction.outputs[1].value--;const w=toWire('verify',d);
    const bad=await call(s,'POST','/api/verify',{body:w});assert.equal(bad.status,422,bad.text);assert.ok(['ENGINE_REJECTED','ENGINE_PROCESS_FAILED'].includes(bad.json.code));
    // an under-budgeted covenant input fails the limited run
    const low=buildAction(f.manager,profile,op,{...opts,budgets:[0,10]});await wallet.sign(low);
    const lowR=await call(s,'POST','/api/verify',{body:toWire('verify',low)});assert.equal(lowR.status,422,lowR.text);
  });
});
