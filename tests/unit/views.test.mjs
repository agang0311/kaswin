import test from 'node:test';
import assert from 'node:assert/strict';
import {html} from '../../web/ui/ui.ts';
import {errText,errCode,phaseOf,ACTION_INFO} from '../../web/ui/messages.ts';
import {makeShare,parseShare,MAX_SHARE_TEXT} from '../../web/app/share.ts';
import {ACTIONS} from '../../scripts/round/round.mjs';
import {drawReadiness} from '../../web/ui/draw-readiness.ts';
import {exploreView,createView,roundView,mineView,rulesView,walletBody,settingsBody,confirmBody,parseCreate,qtyCost,MAX_TICKET_CAP,VERIFIED_TICKET_CAP} from '../../web/ui/views.ts';
import {TN10_ROLLING_REGISTRY} from '../../scripts/contract/protocol.mjs';
import {MAINNET} from '../../scripts/chain/mainnet.mjs';
import {TN10} from '../../scripts/chain/tn10.mjs';
import {parseNodeList} from '../../web/app/settings.ts';

/* The views are pure (data in, HTML string out): no DOM, controller, node or wallet is needed. */
const hex=c=>c.repeat(64),price=100000000n;
const EX={tx:id=>`https://explorer.test/transactions/${id}`,addr:a=>`https://explorer.test/addresses/${a}`,addrOfKey:k=>k?`kaspatest:q${k.slice(0,8)}`:null,addrOfScript:s=>s};
const NO=reason=>({ok:false,reason});
const actions=(over={})=>({BUY:NO('x'),CLOSE:NO('x'),DRAW:NO('x'),TIMEOUT:NO('x'),PAY_OLD:NO('x'),PAY_SELF:NO('x'),REFUND_OLD:NO('x'),REFUND_SELF:NO('x'),...over});
const roundFixture=(over={})=>({cid:hex('a'),source:'local',terminal:null,halted:null,intent:null,
  manager:{value:400000000n,outpoint:{transactionId:hex('b'),index:0},utxoDaa:100n},frozen:[],receipts:[],pending:[],fees:0n,origin:{transactionId:hex('c'),index:0},settings:{},bought:0,...over});
const facts=(over={})=>({module:'sales',ticketPrice:price,ticketCap:100,minTickets:3,closeEligibleDaa:1000n,tickets:5,shards:0,localRecords:5,owner:hex('d'),winnerKey:null,payCursor:null,refundShard:null,...over});
const item=(r,f,a)=>({r,f,a,ph:phaseOf(r,f),value:r.manager?.value??0n,at:1});
const BASE_S={view:'explore',cid:null,filter:'all',sort:'new',query:'',qty:'1',join:'',wtab:'key',form:{price:'1',cap:'100',min:'3',dur:'60',custom:''},nodes:'wss://n.test',svc:'https://s.test'};
const ctx=(over={})=>({net:TN10,items:[],S:BASE_S,wallet:null,balance:null,daa:0n,conn:{},busy:false,ex:EX,logs:[],gate:()=>({ok:true}),detail:null,verify:null,...over});

test('html`` escapes values; fragments and arrays of fragments are inserted as-is',()=>{
  const evil='<img src=x onerror=alert(1)>"\'&';
  const out=html`<p title="${evil}">${evil}</p>${[html`<b>${evil}</b>`,html`<i>1</i>`]}`.s;
  assert.ok(!out.includes('<img'));assert.ok(out.includes('&lt;img'));assert.ok(out.includes('<i>1</i>'));
  assert.equal(html`${null}${false}${undefined}${0}`.s,'0');
});

test('explore: empty state, unified V2.0.2 plaza cards (local + indexed), filters, and escaped user text',()=>{
  const evil='"><script>alert(1)</script>';
  let out=exploreView(ctx({S:{...BASE_S,query:evil,join:evil}})).s;
  assert.ok(!out.includes('<script>'));assert.ok(out.includes('&lt;script&gt;'));assert.match(out,/没有轮次/);
  const r=roundFixture();
  out=exploreView(ctx({items:[item(r,facts(),actions())]})).s;
  assert.ok(out.includes(`data-open="${r.cid}"`));assert.match(out,/售票中/);assert.match(out,/5 \/ 100/);
  assert.match(out,/轮次广场/);assert.doesNotMatch(out,/我的轮次|索引发现（链上共/);
  // Unified plaza merges local rounds (data-open, deduplicated) and unjoined indexed rounds (data-indexed) as cards
  const dOut=exploreView(ctx({conn:{indexer:true},indexerMore:true,items:[item(r,facts(),actions())],discovered:[
    {cid:r.cid,terminal:'PAID',bought:4355,buys:4353,updatedAt:500},
    {cid:hex('b'),terminal:'PAID',bought:4355,buys:4353,shards:17,updatedAt:900},
    {cid:hex('c'),terminal:'EMPTY',bought:0,buys:0,updatedAt:200},
    {cid:hex('f'),module:'sales',tickets:12,managerValue:'1600000000',updatedAt:1000},
  ]})).s;
  assert.match(dOut,/索引 4 · 本机 1/);
  assert.match(dOut,/data-act="refreshIndex"/);
  assert.match(dOut,/data-act="moreIndex"/);
  assert.equal((dOut.match(new RegExp(`data-(?:open|indexed)="${r.cid}"`,'g'))??[]).length,1);
  assert.ok(dOut.includes(`data-indexed="${hex('b')}"`));
  assert.match(dOut,/17 个封存分片/);
  assert.ok(dOut.includes(`data-indexed="${hex('c')}"`));
  assert.ok(dOut.includes(`data-indexed="${hex('f')}"`));
  assert.match(dOut,/状态锁定 16 TKAS/);
  // Done filter keeps finished local and indexed cards only
  const doneOut=exploreView(ctx({conn:{indexer:true},S:{...BASE_S,filter:'done'},items:[item(r,facts(),actions())],discovered:[
    {cid:hex('b'),terminal:'PAID',bought:4355,buys:4353},
    {cid:hex('c'),terminal:'EMPTY',bought:0,buys:0},
  ]})).s;
  assert.ok(!doneOut.includes(`data-open="${r.cid}"`));
  assert.ok(doneOut.includes(`data-indexed="${hex('b')}"`));
  assert.ok(doneOut.includes(`data-indexed="${hex('c')}"`));
  // REST fallback discovery strip + REST badge on cards
  const restOut=exploreView(ctx({conn:{node:true,discoveredSource:'rest'},discovered:[
    {cid:hex('e'),module:'sales',tickets:0,managerValue:'400000000',source:'rest',updatedAt:1200},
  ]})).s;
  assert.match(restOut,/REST API 备用查询/);
  assert.match(restOut,/REST 发现/);
  assert.match(restOut,/REST 备用 1 · 本机 0/);
  // Local storage cached Plaza renders immediately on reload before live indexer responds, and when indexer is offline
  const cacheOut=exploreView(ctx({conn:{discoveredSource:'cache'},discovered:[
    {cid:hex('d'),terminal:'PAID',module:'win',bought:10,buys:1,updatedAt:1500},
  ]})).s;
  assert.ok(!cacheOut.includes('已从本地存储恢复广场列表'));
  assert.match(cacheOut,/本地缓存 1 · 本机 0/);
  assert.match(cacheOut,/本地缓存/);
  assert.match(cacheOut,/data-act="refreshIndex"/);
  assert.ok(cacheOut.includes(`data-indexed="${hex('d')}"`));
  const offlineCacheOut=exploreView(ctx({conn:{discoveredSource:'cache',indexerStale:true},discovered:[
    {cid:hex('d'),terminal:'PAID',module:'win',bought:10,buys:1,updatedAt:1500},
  ]})).s;
  assert.match(offlineCacheOut,/索引暂不可用，当前显示本地缓存列表/);
  // Starred filter & collapsed incompatible rounds
  const savedOut=exploreView(ctx({S:{...BASE_S,filter:'saved'},saved:new Set([r.cid]),items:[item(r,facts(),actions()),item({...r,cid:hex('9')},{module:null},actions())]})).s;
  assert.match(savedOut,/★ 关注/);
  assert.ok(savedOut.includes(`data-open="${r.cid}"`));
  assert.match(savedOut,/不适用轮次 \(1\)/);
});

test('create form: bounds are enforced, bad input never throws, and values are escaped in the page',()=>{
  const base={price:'1',cap:'100',min:'3',dur:'60',custom:''};
  assert.equal(parseCreate(base).ok,true);assert.equal(parseCreate({...base,price:'2'}).ok,true);assert.equal(MAX_TICKET_CAP,10000000);assert.equal(parseCreate({...base,cap:'10000000'}).ok,true);assert.equal(parseCreate({...base,cap:String(VERIFIED_TICKET_CAP)}).ok,true);
  for(const bad of [{cap:String(MAX_TICKET_CAP+1)},{cap:'2'},{min:'2'},{min:'101'},{price:'0'},{price:'1.5'},{price:'1.'},{price:'0.99999999'},{price:'abc'},{price:'1.123456789'},{price:''},
    {dur:'custom',custom:'0'},{dur:'custom',custom:'99999'},{dur:'custom',custom:'-1'},{dur:'custom',custom:''}])
    assert.equal(parseCreate({...base,...bad}).ok,false,JSON.stringify(bad));
  const KEYED={kind:'key',address:'kaspatest:qabc',key:hex('1'),spk:{script:'x'}};
  const out=createView(ctx({wallet:KEYED,S:{...BASE_S,form:{...base,price:'<x>'}}})).s;
  assert.ok(!out.includes('<x>'));assert.match(out,/data-act="create"/);assert.match(out,/disabled/);   // invalid form: the send button is disabled
  // large ticket caps are allowed without a scary ticket-count warning (shards depend on purchase count, capped at 256)
  assert.doesNotMatch(createView(ctx({wallet:KEYED})).s,/超出已验证范围/);
  const big=createView(ctx({wallet:KEYED,S:{...BASE_S,form:{...base,cap:'10000000',min:'3'}}})).s;
  assert.doesNotMatch(big,/超出已验证范围|notice warn/);assert.match(big,/封存分片<\/dt><dd>最多约 256 个/);assert.match(big,/购买笔数/);assert.doesNotMatch(big,/39063|39,063/);assert.doesNotMatch(big,/disabled/);
  // an illegal cap (10000001) shows the error only: no preview that pretends 256 shards / 39063 shards exist
  const over=createView(ctx({wallet:KEYED,S:{...BASE_S,form:{...base,cap:'10000001'}}})).s;
  assert.match(over,/票数上限需在 3 – 10,000,000 之间/);assert.doesNotMatch(over,/最多约/);
  // the button says what will really happen for each wallet type
  assert.match(createView(ctx()).s,/连接钱包后创建/);assert.ok(!createView(ctx()).s.includes('data-act="create"'));
  const ro=createView(ctx({wallet:{...KEYED,kind:'public'}})).s;
  assert.match(ro,/仅收款地址/);assert.match(ro,/连接签名钱包/);assert.ok(!ro.includes('data-act="create"'));
  // registry options: default V2.0.2 address, custom address warning, invalid address rejection, and opt-out
  assert.equal(TN10_ROLLING_REGISTRY.address,'kaspatest:qztrjpfpuf6g9jw76e6ay909z43hndpv5maqkker6ur4enz7llarsh82ezggl');
  const defCreate=createView(ctx({wallet:KEYED,S:{...BASE_S,form:base}})).s;
  assert.ok(defCreate.includes(TN10_ROLLING_REGISTRY.address));
  assert.doesNotMatch(defCreate,/已改为非默认地址/);
  const customAddr='kaspatest:qz5ksvzrlr5qjkltejvadpvc2u36d5u7ul2krjqfh9jpzm5jk5f2cpctvz792';
  const customParsed=parseCreate({...base,registry:true,registryAddr:customAddr});
  assert.equal(customParsed.ok,true);assert.equal(customParsed.registry,customAddr);assert.equal(customParsed.isCustomRegistry,true);
  assert.match(createView(ctx({wallet:KEYED,S:{...BASE_S,form:{...base,registry:true,registryAddr:customAddr}}})).s,/已改为非默认地址/);
  const noRegParsed=parseCreate({...base,registry:false,registryAddr:'invalid-addr'});
  assert.equal(noRegParsed.ok,true);assert.equal(noRegParsed.registry,false);
  assert.match(createView(ctx({wallet:KEYED,S:{...BASE_S,form:{...base,registry:false}}})).s,/不附加（不进入公共索引/);
  assert.equal(parseCreate({...base,registry:true,registryAddr:'kaspa:qztrjpfpuf6g9jw76e6ay909z43hndpv5maqkker6ur4enz7llarsh82ezggl'}).ok,false);
});

test('buy quantity text',()=>{
  const f=facts();
  assert.match(qtyCost('3',f,{maxQuantity:95}),/3 张 ×/);assert.match(qtyCost('0',f,{maxQuantity:95}),/请输入/);
  assert.match(qtyCost('96',f,{maxQuantity:95}),/最多还能买 95/);assert.match(qtyCost('1e3',f,{maxQuantity:95}),/请输入/);
  assert.match(qtyCost('10000000',facts({ticketCap:10000000,tickets:0}),{maxQuantity:10000000}),/10000000 张 ×/);
});

test('round view: offered actions follow the phase; blocked ones carry their (escaped) reason; finished rounds offer nothing',()=>{
  const r=roundFixture(),a=actions({BUY:{ok:true,maxQuantity:95},CLOSE:NO('<b>尚未到可关闭 DAA</b>')});
  let out=roundView(ctx({S:{...BASE_S,view:'round',cid:r.cid,qty:'2'},detail:{...item(r,facts(),a),mine:null,isWinner:false}})).s;
  assert.match(out,/购买票/);assert.match(out,/data-act="BUY"/);assert.match(out,/&lt;b&gt;尚未到可关闭/);assert.ok(!out.includes('<b>尚未到可关闭'));
  assert.ok(!out.includes('data-act="DRAW"'));assert.ok(!out.includes('data-act="CLOSE"'));   // CLOSE is blocked -> disabled button, no hook
  assert.match(out,/data-act="verify"/);assert.match(out,/role="switch"/);assert.match(out,/实时同步/);assert.ok(!out.includes('data-act="syncIndex"'));
  assert.match(out,/<button[^>]*data-act="moreRound"[^>]*aria-haspopup="dialog"/);
  // unmet wallet: the same action turns into a "connect wallet" hook instead of a send hook
  out=roundView(ctx({gate:()=>({ok:false,reason:'需要先连接钱包。',fix:'wallet'}),detail:{...item(r,facts(),a),mine:null,isWinner:false}})).s;
  assert.match(out,/data-fix="wallet"/);assert.ok(!out.includes('data-act="BUY"'));
  // finished round
  const done=roundFixture({manager:null,terminal:'PAID'});
  out=roundView(ctx({detail:{...item(done,facts({module:null,tickets:7}),actions()),mine:null,isWinner:false}})).s;
  assert.match(out,/已派奖/);assert.ok(!out.includes('data-act="BUY"'));assert.ok(!out.includes('data-act="verify"'));
  assert.match(roundView(ctx({detail:null})).s,/没有找到这一轮/);
});

test('round view: verification and pending-intent notices',()=>{
  const r=roundFixture({source:'imported',intent:{status:'REJECTED',action:'BUY'}}),D={...item(r,facts(),actions()),mine:null,isWinner:false};
  let out=roundView(ctx({detail:D,verify:{state:'bad',code:'STALE_INPUT'}})).s;
  assert.match(out,/与链上状态不一致/);assert.match(out,/被节点拒绝/);assert.match(out,/data-act="discard"/);assert.ok(!out.includes('data-act="recover"'));
  out=roundView(ctx({detail:{...D,r:{...r,intent:{status:'UNKNOWN',action:'BUY'}}},verify:{state:'ok',at:Date.now()}})).s;
  assert.match(out,/已向节点核对/);assert.match(out,/data-act="recover"/);assert.match(out,/data-act="discard"/);
  assert.match(roundView(ctx({detail:null,verify:{state:'checking'}})).s,/同步轮次最新状态/);
  // Local-first detail rendering: cached Plaza summary renders immediately without blanking, and preview mode disables share/export until verified
  const discSummary=roundView(ctx({
    S:{...BASE_S,view:'round',cid:hex('7')},
    detail:null,
    discovered:[{cid:hex('7'),module:'win',tickets:10,buys:1,managerValue:'1400000000'}],
  })).s;
  assert.match(discSummary,/本地缓存摘要/);
  assert.match(discSummary,/派奖中/);
  assert.match(discSummary,/10 张/);
  assert.match(discSummary,/14 TKAS/);
  assert.doesNotMatch(discSummary,/没有找到这一轮/);
  const previewOut=roundView(ctx({
    S:{...BASE_S,view:'round',cid:r.cid},
    detail:{...item({...r,intent:null},facts(),actions({BUY:{ok:true,maxQuantity:95}})),mine:null,isWinner:false,preview:true},
    gate:()=>({ok:false,reason:'正在向节点核对链上状态，核对完成后即可操作。'}),
  })).s;
  assert.match(previewOut,/本地预览 · 后台核对中/);
  assert.match(previewOut,/已加载本地\/索引明细快照/);
  assert.match(previewOut,/正在向节点核对链上状态，核对完成后即可操作/);
  assert.match(previewOut,/data-act="moreRound"[^>]*disabled/);
});

test('mine / rules / dialogs render, never claim full validation, and show no key input once a wallet is connected',()=>{
  const rc={action:'BUY',txid:hex('e'),feeSompi:'1000',finalized:false};
  const r=roundFixture({source:'imported',receipts:[rc]});
  const unconn=mineView(ctx({items:[item(r,facts(),actions())]})).s;
  assert.doesNotMatch(unconn,/确认中/);
  assert.doesNotMatch(unconn,/data-open="/);
  assert.match(unconn,/连接钱包后显示你创建、买票、中奖或在本机操作过的轮次/);
  assert.match(unconn,/连接钱包后显示你的交易记录/);
  const w={kind:'key',address:'kaspatest:qabc',key:hex('1')};
  const connMine=mineView(ctx({wallet:w,balance:5n,items:[item(r,facts(),actions())],mine:{rounds:[{item:item(r,facts(),actions()),tickets:2,created:false,won:false}],txs:[{cid:r.cid,t:rc}]}})).s;
  assert.match(connMine,/我 2 张/);
  assert.match(connMine,/确认中/);
  assert.match(connMine,/data-act="checkPending"/);
  const rules=rulesView(ctx({S:{...BASE_S,budgetPc:64}})).s;assert.match(rules,/UNVALIDATED/);assert.match(rules,/4,355 张票、17 个封存分片/);assert.match(rules,/TIMEOUT → REFUND_SELF/);assert.match(rules,/KasWare 已在实链完成 TIMEOUT 与 REFUND_SELF/);assert.doesNotMatch(rules,/515 张票|超过 2 个封存分片/);assert.doesNotMatch(rules,/已全部验证|已通过全部验证|fully validated/i);
  assert.match(rules,/id="budgetPc"/);assert.match(rules,/value="64"/);assert.match(rules,/<svg class="chart"/);
  assert.match(walletBody(ctx()).s,/type="password"/);
  assert.match(walletBody(ctx({S:{...BASE_S,wtab:'extension'}})).s,/value="kaspire"/);
  const connected=walletBody(ctx({wallet:{kind:'key',address:'kaspatest:qabc',key:hex('1')},balance:5n})).s;
  assert.ok(!connected.includes('<input'));
  const settingsHtml=settingsBody(ctx({conn:{node:true,indexer:true}})).s;
  assert.match(settingsHtml,/id="sProbe"/);
  assert.match(settingsHtml,/id="sNodes"/);
  assert.ok(!settingsBody(ctx()).s.includes('sSvc'));
});

test('foreground work visibly disables transaction buttons; background verification only marks its own button as checking',()=>{
  const r=roundFixture(),D={...item(r,facts(),actions({BUY:{ok:true},CLOSE:{ok:true}})),mine:null,isWinner:false};
  let out=roundView(ctx({detail:D,busy:true,gate:()=>({ok:false,reason:'正在准备交易，请稍候。'})})).s;
  assert.match(out,/正在准备交易，请稍候/);assert.match(out,/<button[^>]*disabled aria-busy="true"[^>]*>处理中…<\/button>/);
  assert.ok(!out.includes('data-act="BUY"'));assert.ok(!out.includes('data-act="CLOSE"'));
  out=roundView(ctx({detail:D,verify:{state:'checking'}})).s;
  assert.match(out,/<button[^>]*data-act="verify"[^>]*aria-busy="true"[^>]*>[\s\S]*?实时同步中…<\/button>/);
  assert.match(out,/data-act="BUY"/);assert.match(out,/data-act="CLOSE"/);
  const key={kind:'key',address:'kaspatest:qabc',key:hex('1'),spk:{script:'x'}};
  out=createView(ctx({wallet:key,busy:true})).s;
  assert.match(out,/disabled aria-busy="true">处理中…/);assert.ok(!out.includes('data-act="create"'));
});

test('error wording: known codes are explained in Chinese; unknown text is never echoed back',()=>{
  assert.match(errText({code:'STALE_INPUT'}),/状态已被别人推进/);assert.match(errText('NODE_REQUIRED'),/节点/);
  const u=errText(new Error('secret <b> text'));assert.ok(!u.includes('secret'));assert.match(u,/UNKNOWN/);assert.equal(errCode(new Error('x y')),'UNKNOWN');
  assert.deepEqual(Object.keys(ACTION_INFO).sort(),[...ACTIONS].sort());
  for(const a of ACTIONS)assert.ok(ACTION_INFO[a].title&&ACTION_INFO[a].desc&&typeof ACTION_INFO[a].free==='boolean',a);
});

test('share links round-trip, accept bare codes and raw JSON, and refuse decompression bombs',async()=>{
  const text=JSON.stringify({k:'v',n:'中文'.repeat(100)}),code=await makeShare(text);
  assert.match(code,/^kwr1\./);
  assert.equal(await parseShare(`https://x.test/p#join=${code}`),text);assert.equal(await parseShare(code),text);assert.equal(await parseShare(text),text);
  await assert.rejects(parseShare(''),{code:'SHARE_EMPTY'});await assert.rejects(parseShare('kwr1.***'),{code:'SHARE_FORMAT'});await assert.rejects(parseShare('nonsense'),{code:'SHARE_FORMAT'});
  const bomb=await makeShare('\0'.repeat(MAX_SHARE_TEXT*2));   // a few KB on the wire, 4 MB inflated: must be cut off while reading
  assert.ok(bomb.length<20000);await assert.rejects(parseShare(bomb),{code:'SHARE_FORMAT'});
});

test('settings: node list validation rejects wrong schemes, credentials and junk; empty means the default',()=>{
  const DEF='wss://node.test/node';
  assert.deepEqual(parseNodeList('',DEF),[DEF]);assert.deepEqual(parseNodeList(' wss://a.test/x \n\n ws://127.0.0.1:18210 ',DEF),['wss://a.test/x','ws://127.0.0.1:18210']);
  for(const bad of ['wss://','http://evil.example','https://a.test','ftp://a.test','a.test','wss://a.test/#frag','not a url'])
    assert.throws(()=>parseNodeList(bad,DEF),{code:'NODE_URL_INVALID'},bad);
  assert.throws(()=>parseNodeList('wss://user:pw@a.test',DEF),{code:'NODE_URL_CREDENTIALS'});
  assert.throws(()=>parseNodeList(Array.from({length:9},(_,i)=>`wss://n${i}.test`).join('\n'),DEF),{code:'NODE_URL_COUNT'});
});

test('confirmation rows carry the unit; designed user errors are shown, unknown ones are not echoed',()=>{
  const mine='20'+'ab'.repeat(32)+'ac',other='20'+'cd'.repeat(32)+'ac';
  const p={op:{action:'BUY',quantity:1},fee:1000n,feerate:'100',mass:{computeMass:1,transientMass:2,storageMass:3},targetCount:0,cid:hex('a'),
    review:{txid:hex('e'),fee:1000n,inputs:[{index:0,value:500000000n,kind:'普通输入（需签名）'}],
      outputs:[{role:'MANAGER',value:400000000n,script:'x',covenant:true},{role:'CHANGE',value:99999000n,script:mine,covenant:false},{role:'EXECUTOR',value:1n,script:other,covenant:false}]}};
  const out=confirmBody({...ctx({wallet:{kind:'key',address:'kaspatest:qa',key:hex('1'),spk:{script:mine}}}),prepared:p,planText:'x'}).s;
  const values=[...out.matchAll(/<span class="v">([^<]*)<\/span>/g)].map(m=>m[1]);
  assert.equal(values.length,3);assert.ok(values.every(v=>/ TKAS$/.test(v)),values.join('|'));
  const user=Object.assign(new Error('地址校验和错误'),{code:'USER'});
  assert.equal(errText(user),'地址校验和错误');assert.match(errText(Object.assign(new Error('x'),{code:'USER'})),/USER/);
  assert.match(errText({code:'SEARCH_RANGE'}),/回溯/);assert.match(errText({code:'INTENT_TXID'}),/没有通过校验/);
});

test('a malformed receipt fee can neither be imported nor abort a render',()=>{
  const r=roundFixture({receipts:[{action:'BUY',txid:hex('e'),feeSompi:'x',finalized:true}]});
  const w={kind:'key',address:'kaspatest:qabc',key:hex('1')};
  const out=mineView(ctx({wallet:w,items:[item(r,facts(),actions())],mine:{rounds:[],txs:[{cid:r.cid,t:r.receipts[0]}]}})).s;assert.match(out,/>—</);
  const D={...item(r,facts(),actions()),mine:null,isWinner:false};
  assert.doesNotThrow(()=>roundView(ctx({detail:D})));
});

test('rejected notice names the cause from the node message: wallet funds held by another pending transaction vs the round taken by someone else (NOT_RUN)',()=>{
  const T='a'.repeat(64),S='b'.repeat(64),F='c'.repeat(64),C='d'.repeat(64);
  const draft={inputUtxos:[{outpoint:{transactionId:T,index:0},covenantId:C},{outpoint:{transactionId:F,index:1},covenantId:null}]};
  const msg=o=>`submitTransaction: Rejected transaction ${F}: output (${o}) already spent by transaction ${S} in the mempool`;
  const page=nodeError=>{const r=roundFixture({intent:{status:'REJECTED',action:'BUY',nodeError,draft}});return roundView(ctx({detail:{...item(r,facts(),actions()),mine:null,isWinner:false}})).s;};
  let s=page(msg(`${F}, 1`));assert.match(s,/资金已被另一笔还没确认的交易/);assert.match(s,/不会扣款/);assert.ok(s.includes(S.slice(0,8)));assert.match(s,/data-act="discard"/);
  s=page(msg(`${T}, 0`));assert.match(s,/别人抢先操作了同一轮/);assert.ok(!s.includes('资金已被另一笔'));
  s=page(`submitTransaction: Rejected transaction ${F}: transaction ${F} is an orphan where orphan is disallowed`);assert.match(s,/找不到这笔交易所依赖的上一笔交易/);
  s=page('submitTransaction: rejected by the fake node');assert.match(s,/常见原因是别人抢先操作了同一轮/);
  assert.match(errText('WALLET_FUNDS_PENDING'),/占用/);
});

test('round view: "创建交易" is the GENESIS receipt, not the output GENESIS spent (that one is the 创世输出 in the technical details)',()=>{
  const G=hex('e'),O=hex('c'),mk=receipts=>{const r=roundFixture({receipts,origin:{transactionId:O,index:3}});return roundView(ctx({detail:{...item(r,facts(),actions()),mine:null,isWinner:false}})).s;};
  const row=s=>(/<dt>创建交易<\/dt><dd>([\s\S]*?)<\/dd>/.exec(s)??[])[1]??'';
  let s=mk([{action:'GENESIS',txid:G,feeSompi:'1000000',finalized:true},{action:'BUY',txid:hex('d'),feeSompi:'1000000',finalized:true}]);
  assert.ok(row(s).includes(`data-copy="${G}"`));assert.ok(!row(s).includes(O)); // the row points at the GENESIS transaction
  assert.match(s,/创世输出/);assert.ok(s.includes(`${O.slice(0,10)}`)&&/:3</.test(s)); // the origin outpoint is still shown, labelled as what it is
  s=mk([]);assert.ok(!row(s).includes(O));assert.match(row(s),/—/); // no GENESIS receipt: nothing is claimed
});

test('round view: renders shard dot-map first without listing 65536 records, then renders selected shard purchases on click',()=>{
  const mkShard=(index,count=256)=>{
    const startTicket=index*count+1,endTicket=(index+1)*count;
    return {index,kind:'frozen',status:'frozen',startTicket,endTicket,tickets:count,recordCount:count,hash:hex('f'),refundedRecords:0,mineCount:index===1?3:0,
      records:index===1?Array.from({length:count},(_,i)=>({index:i,startTicket:startTicket+i,endTicket:startTicket+i,count:1,key:hex(i===0?'1':'2'),mine:i===0,refunded:false})):[]};
  };
  const allShards=Array.from({length:256},(_,j)=>mkShard(j));
  const r=roundFixture();
  const fBig=facts({ticketCap:65536,tickets:65536,shards:256,localRecords:0});
  const baseD={...item(r,fBig,actions()),mine:null,isWinner:false,shards:allShards};
  // Initial view: 256 shard dots only; zero individual purchase dots/rows in DOM.
  let out=roundView(ctx({S:{...BASE_S,view:'round',cid:r.cid,shard:null,purchase:null},detail:baseD})).s;
  assert.equal((out.match(/data-shard="/g)??[]).length,256);
  assert.ok(!out.includes('data-purchase="'));
  assert.match(out,/点击任意分片点图/);
  // Selecting shard #1 (index=1): displays that shard's 256 purchases dot-map and details without rendering 65536 rows or address ticket-count stats.
  out=roundView(ctx({S:{...BASE_S,view:'round',cid:r.cid,shard:1,purchase:0},detail:baseD})).s;
  assert.match(out,/封存分片 #2/);
  assert.match(out,/data-shard="close"/);
  assert.equal((out.match(/data-purchase="/g)??[]).length,256);
  assert.match(out,/票号 #257/);
  assert.match(out,/第 1 笔购买/);
  const shardDetail=out.slice(out.indexOf('<div class="shard-detail">'));
  assert.doesNotMatch(shardDetail,/位买家|<div class="legend">/);
  // Untrusted key / HTML inside key must be escaped.
  const evilShards=[{index:0,kind:'active',status:'active',startTicket:1,endTicket:1,tickets:1,recordCount:1,hash:null,refundedRecords:0,mineCount:0,
    records:[{index:0,startTicket:1,endTicket:1,count:1,key:'<script>x</script>',mine:false,refunded:false}]}];
  out=roundView(ctx({S:{...BASE_S,view:'round',cid:r.cid,shard:0,purchase:0},detail:{...baseD,shards:evilShards}})).s;
  assert.ok(!out.includes('<script>'));
  assert.ok(out.includes('&lt;script&gt;'));
  // Terminal PAID round with historical shards shows clickable 17-shard dot-map
  const paid17=Array.from({length:17},(_,j)=>({...mkShard(j),status:'settled'}));
  const manyReceipts=[
    {action:'GENESIS',txid:hex('a'),feeSompi:'1000000',finalized:true},
    ...Array.from({length:300},(_,i)=>({action:'BUY',txid:hex(i%2?'a':'b'),feeSompi:'1000000',finalized:true})),
    {action:'CLOSE',txid:hex('c'),feeSompi:'1000000',finalized:true},
    {action:'DRAW',txid:hex('d'),feeSompi:'1000000',finalized:true},
    {action:'PAY_SELF',txid:hex('e'),feeSompi:'1000000',finalized:true},
  ];
  const doneR=roundFixture({manager:null,terminal:'PAID',bought:4355,receipts:manyReceipts});
  const doneD={...item(doneR,facts({module:null,tickets:4355,shards:17,localRecords:1}),actions()),mine:null,isWinner:false,shards:paid17};
  out=roundView(ctx({S:{...BASE_S,view:'round',cid:doneR.cid,shard:1,purchase:null},detail:doneD})).s;
  assert.equal((out.match(/data-shard="/g)??[]).length,18); // 17 shard dots + 1 close button
  assert.match(out,/本轮已结束（已派奖）/);
  assert.match(out,/封存分片 #2/);
  // Confirmed BUY receipts are omitted from txTable (only GENESIS/CLOSE/DRAW/PAY_SELF = 4 rows + 1 header = 5 rows), and no shard text table
  assert.ok(!out.includes('<th>票号</th>'));
  assert.ok(!out.includes('data-shardtable='));
  assert.equal((out.match(/<tr>/g)??[]).length,5);
  assert.match(out,/已省略 300 笔已确认购买交易/);
  assert.doesNotMatch(out,/<td>购买票<\/td>/);
  // Winning mark targets ONLY the specific winning purchase record (not all purchases by winnerKey), and purchaseTip shows the exact BUY txid
  const buyTx0=hex('1'),buyTx1=hex('2'),winBuyer=hex('9');
  const twoShards=[{index:0,kind:'frozen',status:'settled',startTicket:1,endTicket:2,tickets:2,recordCount:2,hash:hex('f'),refundedRecords:0,mineCount:0,
    records:[{index:0,startTicket:1,endTicket:1,count:1,key:winBuyer,mine:false,refunded:false},{index:1,startTicket:2,endTicket:2,count:1,key:winBuyer,mine:false,refunded:false}]}];
  const winR=roundFixture({manager:null,terminal:'PAID',bought:2,draw:{txid:hex('d'),shard:0,record:1,ticket:1},
    receipts:[{action:'BUY',txid:buyTx0,feeSompi:'1000000',finalized:true},{action:'BUY',txid:buyTx1,feeSompi:'1000000',finalized:true}]});
  const winD={...item(winR,facts({module:null,tickets:2,shards:1,localRecords:0,winnerKey:winBuyer}),actions()),mine:null,isWinner:false,shards:twoShards};
  // Purchase 0 by the same winnerKey is NOT marked as winning, and its tip shows buyTx0
  out=roundView(ctx({S:{...BASE_S,view:'round',cid:winR.cid,shard:0,purchase:0},detail:winD})).s;
  assert.match(out,/第 1 笔购买/);
  assert.doesNotMatch(out,/中奖记录/);
  assert.ok(out.includes(`data-copy="${buyTx0}"`)&&!out.includes(`data-copy="${buyTx1}"`));
  assert.equal((out.match(/data-purchase="\d+"[^>]*>🏆/g)??[]).length,1); // only purchase 1 cell has the trophy, not purchase 0
  // Purchase 1 is the exact winner; shard detail keeps winning-ticket legend without per-address ticket counts
  out=roundView(ctx({S:{...BASE_S,view:'round',cid:winR.cid,shard:0,purchase:1},detail:winD})).s;
  assert.match(out,/🏆 中奖记录（中奖票 #2）/);
  assert.ok(out.includes(`data-copy="${buyTx1}"`));
  const winDetail=out.slice(out.indexOf('<div class="shard-detail">'));
  assert.match(winDetail,/<div class="legend"><span><i style="--c:var\(--gold\)"><\/i>中奖票 #2（第 2 笔）<\/span><\/div>/);
});

test('round view: folds confirmed refund receipts into purchaseTip / shard panel and omits them from txTable',()=>{
  const mkTx=n=>n.toString(16).padStart(64,'0');
  const buyer=hex('7');
  const frozenRecs=Array.from({length:256},(_,i)=>({index:i,startTicket:i+1,endTicket:i+1,count:1,key:buyer,mine:false,refunded:true}));
  const tailRecs=Array.from({length:3},(_,i)=>({index:i,startTicket:257+i,endTicket:257+i,count:1,key:buyer,mine:false,refunded:true}));
  const refShards=[
    {index:0,kind:'frozen',status:'refunded',startTicket:1,endTicket:256,tickets:256,recordCount:256,hash:hex('f'),refundedRecords:256,mineCount:0,records:frozenRecs},
    {index:1,kind:'active',status:'refunded',startTicket:257,endTicket:259,tickets:3,recordCount:3,hash:null,refundedRecords:3,mineCount:0,records:tailRecs},
  ];
  const buyTxs=Array.from({length:259},(_,i)=>({action:'BUY',txid:mkTx(1000+i),feeSompi:'1000000',finalized:true}));
  const refOldTxs=Array.from({length:8},(_,i)=>({action:'REFUND_OLD',txid:mkTx(2000+i),feeSompi:'2000000',finalized:true}));
  const refSelfTx={action:'REFUND_SELF',txid:mkTx(3000),feeSompi:'2500000',finalized:true};
  const refR=roundFixture({manager:null,terminal:'REFUNDED',bought:259,receipts:[
    {action:'GENESIS',txid:mkTx(1),feeSompi:'1000000',finalized:true},
    ...buyTxs,
    {action:'CLOSE',txid:mkTx(2),feeSompi:'1000000',finalized:true},
    {action:'TIMEOUT',txid:mkTx(3),feeSompi:'1500000',finalized:true},
    ...refOldTxs,
    refSelfTx,
  ]});
  const refD={...item(refR,facts({module:null,tickets:259,shards:1,localRecords:3}),actions()),mine:null,isWinner:false,shards:refShards};

  // txTable omits 259 confirmed BUYs + 9 confirmed REFUNDs -> shows only header + GENESIS/CLOSE/TIMEOUT (4 <tr>)
  let out=roundView(ctx({S:{...BASE_S,view:'round',cid:refR.cid,shard:0,purchase:35},detail:refD})).s;
  assert.equal((out.match(/<tr>/g)??[]).length,4);
  assert.doesNotMatch(out,/<td>退款：/);
  assert.match(out,/已省略 259 笔已确认购买交易、9 笔已确认退款交易/);
  // Purchase index 35 (ticket #36) maps to batch 1 (refOldTxs[1]) alongside buyTxs[35]
  assert.match(out,/退款交易：/);
  assert.ok(out.includes(`data-copy="${buyTxs[35].txid}"`));
  assert.ok(out.includes(`data-copy="${refOldTxs[1].txid}"`));
  assert.ok(!out.includes(`data-copy="${refOldTxs[0].txid}"`));

  // Tail purchase index 1 maps to refSelfTx
  out=roundView(ctx({S:{...BASE_S,view:'round',cid:refR.cid,shard:1,purchase:1},detail:refD})).s;
  assert.ok(out.includes(`data-copy="${buyTxs[257].txid}"`));
  assert.ok(out.includes(`data-copy="${refSelfTx.txid}"`));

  // Tail-merged refund (activeCount <= 2 -> last REFUND_OLD handles tail with 0 REFUND_SELF)
  const mergedShards=[refShards[0],{...refShards[1],endTicket:258,tickets:2,recordCount:2,refundedRecords:2,records:tailRecs.slice(0,2)}];
  const mergedR={...refR,bought:258,receipts:[{action:'GENESIS',txid:mkTx(1),feeSompi:'1000000',finalized:true},...buyTxs.slice(0,258),{action:'CLOSE',txid:mkTx(2),feeSompi:'1000000',finalized:true},...refOldTxs]};
  const mergedD={...item(mergedR,facts({module:null,tickets:258,shards:1,localRecords:2}),actions()),mine:null,isWinner:false,shards:mergedShards};
  out=roundView(ctx({S:{...BASE_S,view:'round',cid:mergedR.cid,shard:1,purchase:0},detail:mergedD})).s;
  assert.ok(out.includes(`data-copy="${refOldTxs[7].txid}"`));

  // Active refund round with records:null on already-refunded frozen shard shows shard-level refund txs, and unfinalized REFUND_OLD remains in txTable
  const activeShards=[{...refShards[0],records:null},{...refShards[1],status:'refunding',refundedRecords:0,records:tailRecs.map(x=>({...x,refunded:false}))}];
  const pendingRef={...refOldTxs[7],finalized:false};
  const activeR=roundFixture({terminal:null,bought:259,receipts:[{action:'GENESIS',txid:mkTx(1),feeSompi:'1000000',finalized:true},...refOldTxs.slice(0,7),pendingRef]});
  const activeD={...item(activeR,facts({module:'refund',tickets:259,shards:1,localRecords:3,refundShard:1}),actions()),mine:null,isWinner:false,shards:activeShards};
  out=roundView(ctx({S:{...BASE_S,view:'round',cid:activeR.cid,shard:0,purchase:null},detail:activeD})).s;
  assert.match(out,/退款交易（8 批）/);
  assert.ok(out.includes(`data-copy="${refOldTxs[0].txid}"`));
  assert.match(out,/<td>退款：已封存的分片<\/td>/);
});

test('mainnet views: disable memory private key tab, use KAS unit and mainnet registry/prefix',()=>{
  const w=walletBody(ctx({net:MAINNET,S:{...BASE_S,wtab:'key'}})).s;
  assert.doesNotMatch(w,/data-wtab="key"|测试私钥/);
  assert.match(w,/Kaspa mainnet/);
  const wAddr=walletBody(ctx({net:MAINNET,S:{...BASE_S,wtab:'addr'}})).s;
  assert.match(wAddr,/kaspa:q/);
  const c=createView(ctx({net:MAINNET})).s;
  assert.match(c,/每张票价格（KAS）/);
  assert.ok(c.includes(MAINNET.registry.address));
  const s=settingsBody(ctx({net:MAINNET})).s;
  assert.match(s,/切换到 Testnet 10/);
  assert.match(s,/data-act="switchNet"/);
});

test('round countdown: sales close countdown and two-stage sealed draw readiness never unlock DRAW from wall-clock elapsed time alone',()=>{
  const r=roundFixture({manager:{value:400000000n,outpoint:{transactionId:hex('b'),index:0},utxoDaa:1000n}});
  // Sales countdown
  const salesD={...item(r,facts({module:'sales',closeEligibleDaa:1600n}),actions({BUY:{ok:true,maxQuantity:95},CLOSE:NO('尚未到可关闭 DAA')})),mine:null,isWinner:false};
  const salesHtml=roundView(ctx({daa:1000n,detail:salesD})).s;
  assert.match(salesHtml,/最早封盘倒计时/);
  assert.match(salesHtml,/距最早封盘还有约 1 分 0 秒/);

  // Sealed Stage 1: DAA wait (even after wall-clock elapsed > 20s, never becomes ready without node DAA >= 1100n)
  const sealedD={...item(r,facts({module:'sealed'}),actions({DRAW:{ok:true},TIMEOUT:NO('wait')})),mine:null,isWinner:false};
  const stage1=drawReadiness(sealedD,ctx({daa:1040n,daaObservedAt:1000}),30000);
  assert.equal(stage1.ready,false);
  assert.equal(stage1.percent,40);
  assert.match(stage1.detail,/正在等待节点确认封存满 100 DAA/);
  const stage1Html=roundView(ctx({daa:1040n,daaObservedAt:1000,detail:sealedD})).s;
  assert.match(stage1Html,/开奖倒计时 · 封存等待/);
  assert.match(stage1Html,/<progress max="100" value="40"/);
  assert.ok(!stage1Html.includes('data-act="DRAW"'));

  // Sealed Stage 2: Target block confirmations wait (daa >= 1100n, confirmations 35/100)
  const now=Date.now();
  const stage2Ctx=ctx({daa:1120n,daaObservedAt:now,drawProgress:{phase:'TARGET_WAIT',confirmations:35n,requiredConfirmations:100n,observedAt:now},detail:sealedD});
  const stage2=drawReadiness(sealedD,stage2Ctx,now+2000);
  assert.equal(stage2.ready,false);
  assert.equal(stage2.percent,35);
  assert.match(stage2.detail,/第二阶段：目标块确认 35\/100 blue score/);
  const stage2Html=roundView(stage2Ctx).s;
  assert.match(stage2Html,/开奖倒计时 · 目标块确认/);
  assert.match(stage2Html,/等待目标块确认/);
  assert.ok(!stage2Html.includes('data-act="DRAW"'));

  // Sealed Ready: both 100 DAA and 100 blue-score confirmations met
  const readyCtx=ctx({daa:1220n,daaObservedAt:now,drawProgress:{phase:'READY',confirmations:105n,requiredConfirmations:100n,observedAt:now},detail:sealedD});
  const ready=drawReadiness(sealedD,readyCtx,now+1000);
  assert.equal(ready.ready,true);
  assert.equal(ready.percent,100);
  const readyHtml=roundView(readyCtx).s;
  assert.match(readyHtml,/开奖条件已就绪/);
  assert.match(readyHtml,/data-act="DRAW"/);
  assert.match(readyHtml,/核验并开奖/);
});
