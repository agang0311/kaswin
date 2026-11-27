import test from 'node:test';
import assert from 'node:assert/strict';
import {html} from '../../web/ui/ui.ts';
import {errText,errCode,phaseOf,ACTION_INFO} from '../../web/ui/messages.ts';
import {makeShare,parseShare,MAX_SHARE_TEXT} from '../../web/app/share.ts';
import {ACTIONS} from '../../scripts/round/round.mjs';
import {drawReadiness} from '../../web/ui/draw-readiness.ts';
import {exploreView,createView,roundView,mineView,rulesView,walletBody,settingsBody,confirmBody,parseCreate,qtyCost,buyReceiptForRound,refundReceiptForRound,MAX_TICKET_CAP,VERIFIED_TICKET_CAP} from '../../web/ui/views.ts';
import {TN10_ROLLING_REGISTRY} from '../../scripts/contract/protocol.mjs';
import {MAINNET} from '../../scripts/chain/mainnet.mjs';
import {TN10} from '../../scripts/chain/tn10.mjs';
import {parseNodeList} from '../../web/app/settings.ts';
import {LOCALES,ZH_CN,EN,resolveLocale,nextLocale} from '../../web/ui/locales/index.ts';
import {defaultSequentialCreateSpec} from '../../scripts/protocols/registry.mjs';
import {kusdtV2InteractiveModel} from '../../scripts/protocols/kusdt-v2.mjs';
import {pickRandomBuyShard,isShardUtxoConflict,shouldWarnShardCongestion} from '../../web/app/buy-shard.ts';
import {recomputeDrawProof,buildPythonVerifyScript} from '../../web/app/draw-verify.ts';
import {formatTkasFixed} from '../../web/ui/format.mjs';

/* The views are pure (data in, HTML string out): no DOM, controller, node or wallet is needed. */
const hex=c=>c.repeat(64),price=100000000n;
const parallelMeta={protocolId:'kusdt-v2',profileId:hex('b'),displayName:'kUSDT v2 (KCC-20)',shardModel:'parallel',maxShards:256,supportsBatchSettlement:false,supportsIntentResend:false,freeActions:[],actionStyle:'parallel_dispatch'};
const EX={tx:id=>`https://explorer.test/transactions/${id}`,addr:a=>`https://explorer.test/addresses/${a}`,addrOfKey:k=>k?`kaspatest:q${k.slice(0,8)}`:null,addrOfScript:s=>s};
const NO=reason=>({ok:false,reason});
const actions=(over={})=>({BUY:NO('x'),CLOSE:NO('x'),DRAW:NO('x'),TIMEOUT:NO('x'),PAY_OLD:NO('x'),PAY_SELF:NO('x'),REFUND_OLD:NO('x'),REFUND_SELF:NO('x'),...over});
const roundFixture=(over={})=>({cid:hex('a'),source:'local',terminal:null,halted:null,intent:null,
  manager:{value:400000000n,outpoint:{transactionId:hex('b'),index:0},utxoDaa:100n},frozen:[],receipts:[],pending:[],fees:0n,origin:{transactionId:hex('c'),index:0},settings:{},bought:0,...over});
const facts=(over={})=>({module:'sales',ticketPrice:price,ticketCap:100,minTickets:3,closeEligibleDaa:1000n,tickets:5,shards:0,localRecords:5,owner:hex('d'),winnerKey:null,payCursor:null,refundShard:null,...over});
const item=(r,f,a,extra={})=>({r,f,a,ph:phaseOf(r,f),value:r.manager?.value??0n,at:1,...extra});
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
  assert.ok(!out.includes('<script>'));assert.ok(out.includes('&lt;script&gt;'));assert.match(out,/没有.*轮次/);
  const r=roundFixture();
  out=exploreView(ctx({items:[item(r,facts(),actions())]})).s;
  assert.ok(out.includes(`data-open="${r.cid}"`));assert.match(out,/售票中/);assert.match(out,/已售 5 \/ 100 张/);
  assert.match(out,/data-filter="live"/);assert.match(out,/data-act="toggleSearch"/);assert.doesNotMatch(out,/我的轮次|索引发现（链上共|plaza-head/);
  // Unified plaza merges local rounds (data-open, deduplicated) and unjoined indexed rounds (data-indexed) as cards
  const dOut=exploreView(ctx({conn:{indexer:true},indexerMore:true,items:[item(r,facts(),actions())],discovered:[
    {cid:r.cid,terminal:'PAID',bought:4355,buys:4353,updatedAt:500},
    {cid:hex('b'),terminal:'PAID',bought:4355,buys:4353,shards:17,updatedAt:900},
    {cid:hex('c'),terminal:'EMPTY',bought:0,buys:0,updatedAt:200},
    {cid:hex('f'),module:'sales',tickets:12,managerValue:'1600000000',updatedAt:1000},
  ]})).s;
  assert.match(dOut,/进行中<span class="c">1<\/span>/);
  assert.match(dOut,/data-act="refreshIndex"/);
  assert.match(dOut,/data-act="moreIndex"/);
  assert.equal((dOut.match(new RegExp(`data-(?:open|indexed)="${r.cid}"`,'g'))??[]).length,1);
  assert.ok(dOut.includes(`data-indexed="${hex('b')}"`));
  assert.doesNotMatch(dOut,/17 片/); // shard counts hidden on plaza cards
  assert.ok(dOut.includes(`data-indexed="${hex('c')}"`));
  assert.ok(dOut.includes(`data-indexed="${hex('f')}"`));
  assert.match(dOut,/12<small>TKAS<\/small>/);
  // Done filter keeps finished local and indexed cards only
  const doneOut=exploreView(ctx({conn:{indexer:true},S:{...BASE_S,filter:'done'},items:[item(r,facts(),actions())],discovered:[
    {cid:hex('b'),terminal:'PAID',bought:4355,buys:4353},
    {cid:hex('c'),terminal:'EMPTY',bought:0,buys:0},
  ]})).s;
  assert.ok(!doneOut.includes(`data-open="${r.cid}"`));
  assert.ok(doneOut.includes(`data-indexed="${hex('b')}"`));
  assert.ok(doneOut.includes(`data-indexed="${hex('c')}"`));
  // REST fallback cards render cleanly without technical REST banners
  const restOut=exploreView(ctx({conn:{node:true,discoveredSource:'rest'},discovered:[
    {cid:hex('e'),module:'sales',tickets:0,managerValue:'400000000',source:'rest',updatedAt:1200},
  ]})).s;
  assert.ok(restOut.includes(`data-indexed="${hex('e')}"`));
  assert.match(restOut,/点击查看最新进度/);
  // Local storage cached Plaza renders immediately on reload before live indexer responds, and when indexer is offline
  const cacheOut=exploreView(ctx({conn:{discoveredSource:'cache'},discovered:[
    {cid:hex('d'),terminal:'PAID',module:'win',bought:10,buys:1,updatedAt:1500},
  ]})).s;
  assert.ok(!cacheOut.includes('已从本地存储恢复广场列表'));
  assert.match(cacheOut,/data-act="refreshIndex"/);
  assert.ok(cacheOut.includes(`data-indexed="${hex('d')}"`));
  const offlineCacheOut=exploreView(ctx({conn:{discoveredSource:'cache',indexerStale:true},discovered:[
    {cid:hex('d'),terminal:'PAID',module:'win',bought:10,buys:1,updatedAt:1500},
  ]})).s;
  assert.match(offlineCacheOut,/当前展示本机缓存/);
  // Starred filter & collapsed incompatible rounds (pending GENESIS and valid kUSDT rounds must NOT collapse into 旧版历史轮次)
  const pendingGenesis={...r,cid:hex('8'),manager:null,intent:{status:'SUBMITTED',action:'GENESIS',txid:hex('7')}};
  const kusdtTokAsset={kind:'KCC20',symbol:'kUSDT',decimals:6,tokenCovenantId:hex('4')};
  const kusdtLocal={...r,cid:hex('7'),kusdt:{stage:1,price:1_000_000n,closeDaa:900n,openedCount:0,cursor:0,totalTickets:2,decision:0,creatorPk:hex('2'),winnerPk:null,nodeVerified:true,shards:[]}};
  const legacyDisc={cid:hex('6'),protocolId:'kusdt-v2',profileId:hex('5'),phase:'DONE',terminal:'REFUNDED',ticketsSold:1,ticketPrice:'1000000',asset:kusdtTokAsset,updatedAt:100};
  const savedOut=exploreView(ctx({S:{...BASE_S,filter:'saved'},saved:new Set([r.cid]),supportedProfiles:new Set([hex('1')]),discovered:[legacyDisc],items:[
    item(r,facts(),actions()),
    item(pendingGenesis,{module:null},actions()),
    item(kusdtLocal,facts({ticketPrice:1_000_000n,tickets:2}),actions(),{asset:kusdtTokAsset,protocolMeta:parallelMeta}),
    item({...r,cid:hex('9')},{module:null},actions()),
  ]})).s;
  assert.match(savedOut,/★ 关注/);
  assert.ok(savedOut.includes(`data-open="${r.cid}"`));
  assert.match(savedOut,/旧版历史轮次 \(2\)/);
  assert.ok(savedOut.includes(`data-indexed="${legacyDisc.cid}"`));
  const kusdtAllOut=exploreView(ctx({S:{...BASE_S,filter:'all'},supportedProfiles:new Set([hex('1')]),items:[item(kusdtLocal,facts({ticketPrice:1_000_000n,tickets:2}),actions(),{asset:kusdtTokAsset,protocolMeta:parallelMeta})]})).s;
  assert.match(kusdtAllOut,/kUSDT/);
  assert.match(kusdtAllOut,/每张 1 kUSDT/);
  assert.doesNotMatch(kusdtAllOut,/旧版历史轮次/);
});

test('create form: bounds are enforced, bad input never throws, and values are escaped in the page',()=>{
  const base={price:'1',cap:'100',min:'3',dur:'60',custom:''};
  // Custom duration units: minutes, hours, days + exact 2-decimal balance formatting
  assert.equal(parseCreate({...base,dur:'custom',custom:'12',customUnit:'m'}).mins,12);
  assert.equal(parseCreate({...base,dur:'custom',custom:'2',customUnit:'h'}).mins,120);
  assert.equal(parseCreate({...base,dur:'custom',custom:'7',customUnit:'d'}).mins,10080);
  assert.equal(parseCreate({...base,dur:'custom',custom:'8',customUnit:'d'}).ok,false);
  const customUnitHtml=createView(ctx({S:{...BASE_S,form:{...BASE_S.form,dur:'custom',custom:'2',customUnit:'h'}}})).s;
  assert.match(customUnitHtml,/data-durunit="m"/);
  assert.match(customUnitHtml,/data-durunit="h" aria-pressed="true"/);
  assert.match(customUnitHtml,/data-durunit="d"/);
  assert.equal(formatTkasFixed(102030027580n,2),'1,020.30');
  assert.equal(formatTkasFixed(0n,2),'0.00');

  assert.equal(parseCreate(base).ok,true);assert.equal(parseCreate({...base,price:'2'}).ok,true);assert.equal(MAX_TICKET_CAP,10000000);assert.equal(parseCreate({...base,cap:'10000000'}).ok,true);assert.equal(parseCreate({...base,cap:String(VERIFIED_TICKET_CAP)}).ok,true);
  for(const bad of [{cap:String(MAX_TICKET_CAP+1)},{cap:'2'},{min:'2'},{min:'101'},{price:'0'},{price:'1.5'},{price:'1.'},{price:'0.99999999'},{price:'abc'},{price:'1.123456789'},{price:''},
    {dur:'custom',custom:'0'},{dur:'custom',custom:'99999'},{dur:'custom',custom:'-1'},{dur:'custom',custom:''}])
    assert.equal(parseCreate({...base,...bad}).ok,false,JSON.stringify(bad));
  const KEYED={kind:'key',address:'kaspatest:qabc',key:hex('1'),spk:{script:'x'}};
  const out=createView(ctx({wallet:KEYED,S:{...BASE_S,form:{...base,price:'<x>'}}})).s;
  assert.ok(!out.includes('<x>'));assert.match(out,/data-act="create"/);assert.match(out,/disabled/);   // invalid form: the send button is disabled
  // large ticket caps are allowed without a scary ticket-count warning
  assert.doesNotMatch(createView(ctx({wallet:KEYED})).s,/超出已验证范围/);
  const big=createView(ctx({wallet:KEYED,S:{...BASE_S,form:{...base,cap:'10000000',min:'3'}}})).s;
  assert.doesNotMatch(big,/超出已验证范围|notice warn/);assert.doesNotMatch(big,/39063|39,063/);assert.doesNotMatch(big,/disabled/);
  // an illegal cap (10000001) shows the error
  const over=createView(ctx({wallet:KEYED,S:{...BASE_S,form:{...base,cap:'10000001'}}})).s;
  assert.match(over,/票数上限需在 3 – 10,000,000 之间/);
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
  assert.match(createView(ctx({wallet:KEYED,S:{...BASE_S,form:{...base,registry:false}}})).s,/id="cRegBox" hidden/);
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
  assert.match(out,/参与抽奖/);assert.match(out,/data-act="BUY"/);assert.ok(!out.includes('<b>尚未到可关闭'));
  assert.ok(!out.includes('data-act="DRAW"'));assert.ok(!out.includes('data-act="CLOSE"'));   // CLOSE is blocked -> hidden in sales phase
  const blockedBuy=roundView(ctx({detail:{...item(r,facts(),actions({BUY:NO('<b>票池已满</b>'),CLOSE:NO('wait')})),mine:null,isWinner:false}})).s;
  assert.match(blockedBuy,/&lt;b&gt;票池已满&lt;\/b&gt;/);assert.ok(!blockedBuy.includes('<b>票池已满'));
  assert.ok(!out.includes('data-act="verify"'));assert.ok(!out.includes('data-act="syncIndex"'));
  assert.match(out,/<button[^>]*data-act="moreRound"[^>]*aria-haspopup="dialog"/);
  // unmet wallet: the same action turns into a "connect wallet" hook instead of a send hook
  out=roundView(ctx({gate:()=>({ok:false,reason:'需要先连接钱包。',fix:'wallet'}),detail:{...item(r,facts(),a),mine:null,isWinner:false}})).s;
  assert.match(out,/data-fix="wallet"/);assert.ok(!out.includes('data-act="BUY"'));
  // finished round
  const done=roundFixture({manager:null,terminal:'PAID'});
  out=roundView(ctx({detail:{...item(done,facts({module:null,tickets:7}),actions()),mine:null,isWinner:false}})).s;
  assert.match(out,/已派奖/);assert.ok(!out.includes('data-act="BUY"'));
  assert.match(roundView(ctx({detail:null})).s,/没有找到这一轮/);
});

test('round view: verification and pending-intent notices',()=>{
  const r=roundFixture({source:'imported',intent:{status:'REJECTED',action:'BUY'}}),D={...item(r,facts(),actions()),mine:null,isWinner:false};
  let out=roundView(ctx({detail:D,verify:{state:'bad',code:'STALE_INPUT'}})).s;
  assert.match(out,/与链上状态不一致/);assert.match(out,/被节点拒绝/);assert.match(out,/data-act="discard"/);assert.ok(!out.includes('data-act="recover"'));
  out=roundView(ctx({detail:{...D,r:{...r,intent:{status:'UNKNOWN',action:'BUY'}}},verify:{state:'ok',at:Date.now()}})).s;
  assert.match(out,/data-act="recover"/);assert.match(out,/data-act="discard"/);
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
  assert.match(discSummary,/10 TKAS/);
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
  const compatProfiles=[
    {protocolId:'rolling-v1',name:'Rolling v1',asset:'KAS',profileId:hex('a'),tokenCovenantId:null},
    {protocolId:'kusdt-v2',name:'kUSDT v2',asset:'kUSDT',profileId:hex('b'),tokenCovenantId:hex('c')},
  ];
  const rules=rulesView(ctx({compatibleProfiles:compatProfiles})).s;assert.match(rules,/未经第三方安全审计/);assert.match(rules,/256 个封存分片/);assert.match(rules,/安全与使用须知/);assert.doesNotMatch(rules,/515 张票|超过 2 个封存分片/);assert.doesNotMatch(rules,/已全部验证|已通过全部验证|fully validated/i);
  assert.match(rules,/本版本兼容的合约 Profile/);assert.ok(rules.includes(hex('a')));assert.ok(rules.includes(hex('b')));
  assert.doesNotMatch(rules,/id="budgetPc"|<svg class="chart"/); // SVG budget slider removed from simplified how-it-works modal
  const rulesTab=roundView(ctx({S:{...BASE_S,view:'round',cid:r.cid,detailTab:'rules'},compatibleProfiles:compatProfiles,detail:{...item({...r,profileId:hex('a')},facts(),actions()),preview:false,mine:null,isWinner:false,shards:null}})).s;
  assert.match(rulesTab,/合约 Profile/);assert.ok(rulesTab.includes(hex('a')));
  const incompatDetail=roundView(ctx({S:{...BASE_S,view:'round',cid:hex('6')},supportedProfiles:new Set([hex('a')]),compatibleProfiles:compatProfiles,discovered:[{cid:hex('6'),protocolId:'kusdt-v2',profileId:hex('5'),phase:'DONE',terminal:'REFUNDED',ticketsSold:1,ticketPrice:'1000000',asset:{kind:'KCC20',symbol:'kUSDT',decimals:6,tokenCovenantId:hex('c')}}]})).s;
  assert.match(incompatDetail,/不兼容轮次（只读）/);assert.match(incompatDetail,/当前版本不兼容此轮次的合约 Profile/);assert.ok(incompatDetail.includes(`data-copy="${hex('5')}"`));assert.ok(incompatDetail.includes('https://github.com/agang0311/kaswin/releases'));
  assert.match(walletBody(ctx()).s,/type="password"/);
  assert.match(walletBody(ctx({S:{...BASE_S,wtab:'extension'}})).s,/data-connect="kaspire"/);
  const connected=walletBody(ctx({wallet:{kind:'key',address:'kaspatest:qabc',key:hex('1')},balance:5n})).s;
  assert.ok(!connected.includes('<input'));
  const settingsHtml=settingsBody(ctx({conn:{node:true,indexer:true},lang:'zh-CN'})).s;
  assert.match(settingsHtml,/id="sProbe"/);
  assert.match(settingsHtml,/id="sNodes"/);
  assert.match(settingsHtml,/data-act="switchLang"/);
  assert.match(settingsHtml,/data-act="switchTheme"/);
  assert.match(settingsHtml,/data-act="openHelp"/);
  assert.match(settingsHtml,/当前语言：简体中文/);
  assert.match(settingsBody(ctx({conn:{node:true,indexer:true},lang:'en'})).s,/Current language: English/);
  const settingsCovered=settingsBody(ctx({net:MAINNET,compatibleProfiles:compatProfiles,conn:{node:true,indexer:true,indexerProfiles:[{protocolId:'rolling-v1',profileId:hex('a')},{protocolId:'kusdt-v2',profileId:hex('b')}]}})).s;
  assert.match(settingsCovered,/已覆盖全部兼容 Profile/);
  const settingsMissing=settingsBody(ctx({net:MAINNET,compatibleProfiles:compatProfiles,conn:{node:true,indexer:true,indexerProfiles:[{protocolId:'rolling-v1',profileId:hex('a')}]}})).s;
  assert.match(settingsMissing,/未覆盖 kUSDT Profile/);
  const exploreMissing=exploreView(ctx({net:MAINNET,compatibleProfiles:compatProfiles,conn:{node:true,indexer:true,indexerStale:false,indexerProfiles:[{protocolId:'rolling-v1',profileId:hex('a')}]}})).s;
  assert.match(exploreMissing,/当前索引尚未收录 kUSDT/);
  assert.ok(!settingsBody(ctx()).s.includes('sSvc'));
});

test('foreground work visibly disables transaction buttons; background verification keeps round actions enabled',()=>{
  const r=roundFixture(),D={...item(r,facts(),actions({BUY:{ok:true},CLOSE:{ok:true}})),mine:null,isWinner:false};
  let out=roundView(ctx({detail:D,busy:true,gate:()=>({ok:false,reason:'正在准备交易，请稍候。'})})).s;
  assert.match(out,/正在准备交易，请稍候/);assert.match(out,/<button[^>]*disabled aria-busy="true"[^>]*>处理中…<\/button>/);
  assert.ok(!out.includes('data-act="BUY"'));assert.ok(!out.includes('data-act="CLOSE"'));
  out=roundView(ctx({detail:D,verify:{state:'checking'}})).s;
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
  const G=hex('e'),O=hex('c'),mk=receipts=>{const r=roundFixture({receipts,origin:{transactionId:O,index:3}});return roundView(ctx({S:{...BASE_S,detailTab:'info'},detail:{...item(r,facts(),actions()),mine:null,isWinner:false}})).s;};
  const row=s=>(/<dt>创建交易<\/dt><dd>([\s\S]*?)<\/dd>/.exec(s)??[])[1]??'';
  let s=mk([{action:'GENESIS',txid:G,feeSompi:'1000000',finalized:true},{action:'BUY',txid:hex('d'),feeSompi:'1000000',finalized:true}]);
  assert.ok(row(s).includes(G.slice(0,10))&&row(s).includes(G));assert.ok(!row(s).includes(O)); // the row points at the GENESIS transaction
  assert.match(s,/创世输出/);assert.ok(s.includes(`${O.slice(0,10)}`)&&/:3</.test(s)); // the origin outpoint is still shown, labelled as what it is
  s=mk([]);assert.ok(!row(s).includes(O));assert.match(row(s),/—/); // no GENESIS receipt: nothing is claimed
});

test('round view: defaults to round info (rules) and renders 16x16 pixel shard wall on secondary map tab',()=>{
  const mkShard=(index,count=256)=>{
    const startTicket=index*count+1,endTicket=(index+1)*count;
    return {index,kind:'frozen',status:'frozen',startTicket,endTicket,tickets:count,recordCount:count,hash:hex('f'),refundedRecords:0,mineCount:index===1?3:0,
      records:index===1?Array.from({length:count},(_,i)=>({index:i,startTicket:startTicket+i,endTicket:startTicket+i,count:1,key:hex(i===0?'1':'2'),mine:i===0,refunded:false})):[]};
  };
  const allShards=Array.from({length:256},(_,j)=>mkShard(j));
  const r=roundFixture();
  const fBig=facts({ticketCap:65536,tickets:65536,shards:256,localRecords:0});
  const baseD={...item(r,fBig,actions()),mine:null,isWinner:false,shards:allShards};
  // Default tab ('rules'): shows round info & compact summary without inflating participant DOM rows.
  const infoOut=roundView(ctx({S:{...BASE_S,view:'round',cid:r.cid},detail:baseD})).s;
  assert.match(infoOut,/data-dtab="rules"[^>]*aria-selected="true"/);
  assert.ok(!infoOut.includes('data-dtab="entries"'));
  assert.ok(!infoOut.includes('data-shard='));
  assert.match(infoOut,/最低开奖票数/);
  // Secondary tab ('map'): 256 shard dots only; zero individual purchase dots/rows in DOM.
  let out=roundView(ctx({S:{...BASE_S,view:'round',cid:r.cid,shard:null,purchase:null,detailTab:'map'},detail:baseD})).s;
  assert.equal((out.match(/data-shard="/g)??[]).length,256);
  assert.ok(!out.includes('data-purchase="'));
  assert.match(out,/点击任意分片点图/);
  // Selecting shard #1 (index=1) on 'map': displays that shard's 256 purchases dot-map and details.
  out=roundView(ctx({S:{...BASE_S,view:'round',cid:r.cid,shard:1,purchase:0,detailTab:'map'},detail:baseD})).s;
  assert.match(out,/封存分片 #2/);
  assert.match(out,/data-shard="close"/);
  assert.equal((out.match(/data-purchase="/g)??[]).length,256);
  assert.match(out,/票号 #257/);
  assert.match(out,/第 1 笔购买/);
  const shardDetail=out.slice(out.indexOf('<div class="shard-detail">'));
  assert.doesNotMatch(shardDetail,/位买家|<div class="legend">/);
  // Untrusted key / HTML inside key must be escaped on both entries and map tabs.
  const evilShards=[{index:0,kind:'active',status:'active',startTicket:1,endTicket:1,tickets:1,recordCount:1,hash:null,refundedRecords:0,mineCount:0,
    records:[{index:0,startTicket:1,endTicket:1,count:1,key:'<script>x</script>',mine:false,refunded:false}]}];
  assert.ok(!roundView(ctx({S:{...BASE_S,view:'round',cid:r.cid},detail:{...baseD,shards:evilShards}})).s.includes('<script>'));
  out=roundView(ctx({S:{...BASE_S,view:'round',cid:r.cid,shard:0,purchase:0,detailTab:'map'},detail:{...baseD,shards:evilShards}})).s;
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
  out=roundView(ctx({S:{...BASE_S,view:'round',cid:doneR.cid,shard:1,purchase:null,detailTab:'txs'},detail:doneD})).s;
  // Confirmed BUY receipts are omitted from txTable (only GENESIS/CLOSE/DRAW/PAY_SELF = 4 rows + 1 header = 5 rows), and no shard text table
  assert.ok(!out.includes('<th>票号</th>'));
  assert.ok(!out.includes('data-shardtable='));
  assert.equal((out.match(/<tr>/g)??[]).length,5);
  assert.match(out,/已省略 300 笔已确认购买交易/);
  assert.doesNotMatch(out,/<td>参与抽奖<\/td>/);
  out=roundView(ctx({S:{...BASE_S,view:'round',cid:doneR.cid,shard:1,purchase:null,detailTab:'map'},detail:doneD})).s;
  assert.equal((out.match(/data-shard="/g)??[]).length,18); // 17 shard dots + 1 close button
  assert.match(out,/本轮已结束（已派奖）/);
  assert.match(out,/封存分片 #2/);
  // Winning mark targets ONLY the specific winning purchase record (not all purchases by winnerKey), and purchaseTip shows the exact BUY txid
  const buyTx0=hex('1'),buyTx1=hex('2'),winBuyer=hex('9');
  const twoShards=[{index:0,kind:'frozen',status:'settled',startTicket:1,endTicket:2,tickets:2,recordCount:2,hash:hex('f'),refundedRecords:0,mineCount:0,
    records:[{index:0,startTicket:1,endTicket:1,count:1,key:winBuyer,mine:false,refunded:false},{index:1,startTicket:2,endTicket:2,count:1,key:winBuyer,mine:false,refunded:false}]}];
  const winR=roundFixture({manager:null,terminal:'PAID',bought:2,draw:{txid:hex('d'),shard:0,record:1,ticket:1},
    receipts:[{action:'BUY',txid:buyTx0,feeSompi:'1000000',finalized:true},{action:'BUY',txid:buyTx1,feeSompi:'1000000',finalized:true}]});
  const winD={...item(winR,facts({module:null,tickets:2,shards:1,localRecords:0,winnerKey:winBuyer}),actions()),mine:null,isWinner:false,shards:twoShards};
  // Purchase 0 by the same winnerKey is NOT marked as winning on 'map', and its tip shows buyTx0
  out=roundView(ctx({S:{...BASE_S,view:'round',cid:winR.cid,shard:0,purchase:0,detailTab:'map'},detail:winD})).s;
  assert.match(out,/第 1 笔购买/);
  assert.doesNotMatch(out,/中奖记录/);
  assert.ok(out.includes(`data-copy="${buyTx0}"`)&&!out.includes(`data-copy="${buyTx1}"`));
  assert.equal((out.match(/data-purchase="\d+"[^>]*>🏆/g)??[]).length,1); // only purchase 1 cell has the trophy, not purchase 0
  // Purchase 1 is the exact winner; shard detail keeps winning-ticket legend without per-address ticket counts
  out=roundView(ctx({S:{...BASE_S,view:'round',cid:winR.cid,shard:0,purchase:1,detailTab:'map'},detail:winD})).s;
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
  let out=roundView(ctx({S:{...BASE_S,view:'round',cid:refR.cid,shard:0,purchase:35,detailTab:'txs'},detail:refD})).s;
  assert.equal((out.match(/<tr>/g)??[]).length,4);
  assert.doesNotMatch(out,/<td>退款：/);
  assert.match(out,/已省略 259 笔已确认购买交易、9 笔已确认退款交易/);
  // Purchase index 35 (ticket #36) maps to batch 1 (refOldTxs[1]) alongside buyTxs[35]
  out=roundView(ctx({S:{...BASE_S,view:'round',cid:refR.cid,shard:0,purchase:35,detailTab:'map'},detail:refD})).s;
  assert.match(out,/退款交易：/);
  assert.ok(out.includes(`data-copy="${buyTxs[35].txid}"`));
  assert.ok(out.includes(`data-copy="${refOldTxs[1].txid}"`));
  assert.ok(!out.includes(`data-copy="${refOldTxs[0].txid}"`));

  // Tail purchase index 1 maps to refSelfTx
  out=roundView(ctx({S:{...BASE_S,view:'round',cid:refR.cid,shard:1,purchase:1,detailTab:'map'},detail:refD})).s;
  assert.ok(out.includes(`data-copy="${buyTxs[257].txid}"`));
  assert.ok(out.includes(`data-copy="${refSelfTx.txid}"`));

  // Tail-merged refund (activeCount <= 2 -> last REFUND_OLD handles tail with 0 REFUND_SELF)
  const mergedShards=[refShards[0],{...refShards[1],endTicket:258,tickets:2,recordCount:2,refundedRecords:2,records:tailRecs.slice(0,2)}];
  const mergedR={...refR,bought:258,receipts:[{action:'GENESIS',txid:mkTx(1),feeSompi:'1000000',finalized:true},...buyTxs.slice(0,258),{action:'CLOSE',txid:mkTx(2),feeSompi:'1000000',finalized:true},...refOldTxs]};
  const mergedD={...item(mergedR,facts({module:null,tickets:258,shards:1,localRecords:2}),actions()),mine:null,isWinner:false,shards:mergedShards};
  out=roundView(ctx({S:{...BASE_S,view:'round',cid:mergedR.cid,shard:1,purchase:0,detailTab:'map'},detail:mergedD})).s;
  assert.ok(out.includes(`data-copy="${refOldTxs[7].txid}"`));

  // Active refund round with records:null on already-refunded frozen shard shows shard-level refund txs, and unfinalized REFUND_OLD remains in txTable
  const activeShards=[{...refShards[0],records:null},{...refShards[1],status:'refunding',refundedRecords:0,records:tailRecs.map(x=>({...x,refunded:false}))}];
  const pendingRef={...refOldTxs[7],finalized:false};
  const activeR=roundFixture({terminal:null,bought:259,receipts:[{action:'GENESIS',txid:mkTx(1),feeSompi:'1000000',finalized:true},...refOldTxs.slice(0,7),pendingRef]});
  const activeD={...item(activeR,facts({module:'refund',tickets:259,shards:1,localRecords:3,refundShard:1}),actions()),mine:null,isWinner:false,shards:activeShards};
  out=roundView(ctx({S:{...BASE_S,view:'round',cid:activeR.cid,shard:0,purchase:null,detailTab:'map'},detail:activeD})).s;
  assert.match(out,/退款交易（8 批）/);
  assert.ok(out.includes(`data-copy="${refOldTxs[0].txid}"`));
  out=roundView(ctx({S:{...BASE_S,view:'round',cid:activeR.cid,shard:0,purchase:null,detailTab:'txs'},detail:activeD})).s;
  assert.match(out,/<td>退回票款（分批）<\/td>/);
});

test('mainnet views: disable memory private key tab, use KAS unit and mainnet registry/prefix',()=>{
  const w=walletBody(ctx({net:MAINNET,S:{...BASE_S,wtab:'key'}})).s;
  assert.doesNotMatch(w,/data-wtab="key"|测试私钥/);
  assert.match(w,/Kaspa mainnet/);
  const wAddr=walletBody(ctx({net:MAINNET,S:{...BASE_S,wtab:'addr'}})).s;
  assert.match(wAddr,/kaspa:q/);
  const c=createView(ctx({net:MAINNET})).s;
  assert.match(c,/单张票价（KAS）/);
  assert.ok(c.includes(MAINNET.registry.address));
  const s=settingsBody(ctx({net:MAINNET})).s;
  assert.match(s,/切换到 Testnet 10/);
  assert.match(s,/data-act="switchNet"/);
});

test('round countdown: sales close countdown and two-stage sealed draw readiness never unlock DRAW from wall-clock elapsed time alone',()=>{
  const r=roundFixture({manager:{value:400000000n,outpoint:{transactionId:hex('b'),index:0},utxoDaa:1000n}});
  // Sales countdown appears prominently in round-hero
  const salesD={...item(r,facts({module:'sales',closeEligibleDaa:1600n}),actions({BUY:{ok:true,maxQuantity:95},CLOSE:NO('尚未到可关闭 DAA')})),mine:null,isWinner:false};
  const salesHtml=roundView(ctx({daa:1000n,detail:salesD})).s;
  assert.match(salesHtml,/class="hero-countdown"/);
  assert.match(salesHtml,/距最早可封盘约 1 分 0 秒/);
  assert.doesNotMatch(salesHtml,/尚未到可关闭 DAA/);
  assert.match(salesHtml,/class="btn sm star-btn" data-act="toggleStar" aria-pressed="false"/);
  const starredHtml=roundView(ctx({daa:1000n,detail:salesD,saved:new Set([r.cid])})).s;
  assert.match(starredHtml,/class="btn sm star-btn starred" data-act="toggleStar" aria-pressed="true"/);

  // Sealed Stage 1: works for BOTH sequential (KAS) and parallel (kUSDT v2) protocols!
  const kusdtAsset={kind:'KCC20',symbol:'kUSDT',decimals:6,tokenCovenantId:hex('5')};
  const sealedKusdtD={...item(r,facts({module:'sealed'}),actions({DRAW:{ok:true},TIMEOUT:NO('wait')})),mine:null,isWinner:false,asset:kusdtAsset,protocolMeta:parallelMeta};
  const sealedKusdtHtml=roundView(ctx({net:MAINNET,daa:1040n,daaObservedAt:1000,detail:sealedKusdtD})).s;
  assert.match(sealedKusdtHtml,/开奖倒计时/);
  assert.match(sealedKusdtHtml,/<progress max="100" value="40"/);
  assert.ok(!sealedKusdtHtml.includes('data-act="DRAW"'));

  // Sealed Stage 1: DAA wait (even after wall-clock elapsed > 20s, never becomes ready without node DAA >= 1100n)
  const sealedD={...item(r,facts({module:'sealed'}),actions({DRAW:{ok:true},TIMEOUT:NO('wait')})),mine:null,isWinner:false};
  const stage1=drawReadiness(sealedD,ctx({daa:1040n,daaObservedAt:1000}),30000);
  assert.equal(stage1.ready,false);
  assert.equal(stage1.percent,40);
  assert.match(stage1.detail,/正在等待最新区块确认/);
  const stage1Html=roundView(ctx({daa:1040n,daaObservedAt:1000,detail:sealedD})).s;
  assert.match(stage1Html,/开奖倒计时/);
  assert.match(stage1Html,/<progress max="100" value="40"/);
  assert.ok(!stage1Html.includes('data-act="DRAW"'));

  // Sealed Stage 2: Target block confirmations wait (daa >= 1100n, confirmations 35/100)
  const now=Date.now();
  const stage2Ctx=ctx({daa:1120n,daaObservedAt:now,drawProgress:{phase:'TARGET_WAIT',confirmations:35n,requiredConfirmations:100n,observedAt:now},detail:sealedD});
  const stage2=drawReadiness(sealedD,stage2Ctx,now+2000);
  assert.equal(stage2.ready,false);
  assert.equal(stage2.percent,35);
  assert.match(stage2.detail,/区块安全确认 35\/100/);
  const stage2Html=roundView(stage2Ctx).s;
  assert.match(stage2Html,/开奖倒计时/);
  assert.match(stage2Html,/等待区块确认/);
  assert.ok(!stage2Html.includes('data-act="DRAW"'));

  // Sealed Ready: both 100 DAA and 100 blue-score confirmations met
  const readyCtx=ctx({daa:1220n,daaObservedAt:now,drawProgress:{phase:'READY',confirmations:105n,requiredConfirmations:100n,observedAt:now},detail:sealedD});
  const ready=drawReadiness(sealedD,readyCtx,now+1000);
  assert.equal(ready.ready,true);
  assert.equal(ready.percent,100);
  const readyHtml=roundView(readyCtx).s;
  assert.match(readyHtml,/已到开奖时间/);
  assert.match(readyHtml,/data-act="DRAW"/);
  assert.match(readyHtml,/立即开奖/);
});

test('kusdt-v2 purchaseTip and receipt helpers match OPEN_SHARD, BUY, and CLAIM_REFUND per shard (including interleaved multi-shard rounds)',()=>{
  const scidA=hex('1'),scidB=hex('2');
  const txGen=hex('a'),txOpenA=hex('b'),txOpenB=hex('c'),txBuyA1=hex('d'),txClaimA0=hex('e'),txClaimA1=hex('f');
  const buyer1=hex('9'),buyer2=hex('8');
  const shA={index:0,kind:'frozen',status:'refunded',startTicket:1,endTicket:2,tickets:2,recordCount:2,hash:scidA,refundedRecords:2,mineCount:1,
    records:[
      {index:0,startTicket:1,endTicket:1,count:1,key:buyer1,mine:true,refunded:true},
      {index:1,startTicket:2,endTicket:2,count:1,key:buyer2,mine:false,refunded:true},
    ]};
  const shB={index:1,kind:'frozen',status:'frozen',startTicket:3,endTicket:3,tickets:1,recordCount:1,hash:scidB,refundedRecords:0,mineCount:0,
    records:[{index:0,startTicket:3,endTicket:3,count:1,key:buyer2,mine:false,refunded:false}]};
  const r=roundFixture({
    terminal:'REFUNDED',
    manager:null,
    kusdt:{cid:hex('a'),loading:false,stage:null,price:1_000_000n,closeDaa:100n,openedCount:2,cursor:2,totalTickets:3,decision:2,creatorPk:buyer1,winnerPk:null,shards:[]},
    receipts:[
      {action:'GENESIS',txid:txGen,feeSompi:'1000000',finalized:true},
      {action:'OPEN_SHARD',txid:txOpenA,feeSompi:'8951000',finalized:true,shardCid:scidA,recordIndex:0},
      {action:'OPEN_SHARD',txid:txOpenB,feeSompi:'8951000',finalized:true,shardCid:scidB,recordIndex:0},
      {action:'BUY',txid:txBuyA1,feeSompi:'4200000',finalized:true,shardCid:scidA,recordIndex:1},
      {action:'CLAIM_REFUND',txid:txClaimA1,feeSompi:'3300000',finalized:true,shardCid:scidA,recIdx:1},
      {action:'CLAIM_REFUND',txid:txClaimA0,feeSompi:'4500000',finalized:true,shardCid:scidA,recIdx:0},
    ],
  });
  const shards=[shA,shB];
  // Interleaved parallel shard receipts resolve strictly to their owning shard & record
  assert.equal(buyReceiptForRound(shA,shA.records[0],r,shards,true)?.txid,txOpenA);
  assert.equal(buyReceiptForRound(shA,shA.records[1],r,shards,true)?.txid,txBuyA1);
  assert.equal(buyReceiptForRound(shB,shB.records[0],r,shards,true)?.txid,txOpenB);
  assert.equal(refundReceiptForRound(shA,shA.records[0],r,shards,true)?.txid,txClaimA0);
  assert.equal(refundReceiptForRound(shA,shA.records[1],r,shards,true)?.txid,txClaimA1);

  // Without shardCid on a multi-shard round, must return null rather than misattributing across shards
  const unlabelled={...r,receipts:r.receipts.map(({shardCid:_s,recordIndex:_i,recIdx:_r,...rest})=>rest)};
  assert.equal(buyReceiptForRound(shA,shA.records[0],unlabelled,shards,true),null);
  assert.equal(refundReceiptForRound(shA,shA.records[0],unlabelled,shards,true),null);

  // Single-shard fallback works even without shardCid/recordIndex/recIdx
  const singleSh={...shA,tickets:1,recordCount:1,refundedRecords:1,records:[shA.records[0]]};
  const singleR={...r,receipts:[
    {action:'GENESIS',txid:txGen,feeSompi:'1000000',finalized:true},
    {action:'OPEN_SHARD',txid:txOpenA,feeSompi:'8951000',finalized:true},
    {action:'CLAIM_REFUND',txid:txClaimA0,feeSompi:'4500000',finalized:true},
  ]};
  assert.equal(buyReceiptForRound(singleSh,singleSh.records[0],singleR,[singleSh],true)?.txid,txOpenA);
  assert.equal(refundReceiptForRound(singleSh,singleSh.records[0],singleR,[singleSh],true)?.txid,txClaimA0);

  // Rendered purchaseTip shows BOTH 购买交易 (OPEN_SHARD) and 退款交易 (CLAIM_REFUND) with 1 kUSDT and zero "本机未保留" text
  const D={
    ...item(r,facts({module:null,ticketPrice:1_000_000n,tickets:3,shards:2}),actions()),
    mine:null,isWinner:false,shards,
    asset:{kind:'KCC20',symbol:'kUSDT',decimals:6,tokenCovenantId:hex('5')},
    protocolMeta:parallelMeta,
    interactive:kusdtV2InteractiveModel(r),
  };
  const tipHtml=roundView(ctx({net:MAINNET,S:{...BASE_S,view:'round',cid:r.cid,shard:0,purchase:0,detailTab:'map'},detail:D})).s;
  assert.ok(tipHtml.includes(txOpenA.slice(0,10)));
  assert.ok(tipHtml.includes(txClaimA0.slice(0,10)));
  assert.match(tipHtml,/1 kUSDT/);
  assert.ok(!tipHtml.includes('本机未保留完整购买交易索引'));
  assert.ok(!tipHtml.includes('本机未保留完整退款交易索引'));

  // txTable omits finalized OPEN_SHARD/BUY/CLAIM_REFUND just like KAS rounds, keeping GENESIS in table and summarizing omitted buys/refunds
  const txsHtml=roundView(ctx({net:MAINNET,S:{...BASE_S,view:'round',cid:r.cid,shard:null,purchase:null,detailTab:'txs'},detail:D})).s;
  assert.match(txsHtml,/发起轮次/);
  assert.match(txsHtml,/3 笔已确认购买交易/);
  assert.match(txsHtml,/2 笔已确认退款交易/);

  // Post-DISPATCH_BATCH kusdt-v2 round (manager=null, terminal=null, module='refund'|'win') must show 退款中 / 派奖中, NOT 等待创建确认!
  const postDispatchRefundR=roundFixture({
    terminal:null,manager:null,
    kusdt:{cid:hex('a'),loading:false,stage:3,price:1_000_000n,closeDaa:100n,openedCount:1,cursor:1,totalTickets:1,decision:2,creatorPk:buyer1,winnerPk:null,nodeVerified:true,shards:[]},
  });
  assert.deepEqual(phaseOf(postDispatchRefundR,{module:'refund'}),{key:'refund',label:'退款中',tone:'amber'});
  assert.deepEqual(phaseOf(postDispatchRefundR,{module:'win'}),{key:'paying',label:'派奖中',tone:'gold'});
  const postDispatchHtml=roundView(ctx({
    net:MAINNET,
    S:{...BASE_S,view:'round',cid:postDispatchRefundR.cid,detailTab:'map'},
    detail:{...item(postDispatchRefundR,facts({module:'refund',ticketPrice:1_000_000n,tickets:1,shards:1}),actions()),mine:null,isWinner:false,shards:[singleSh],asset:D.asset,protocolMeta:parallelMeta,interactive:kusdtV2InteractiveModel(postDispatchRefundR)},
  })).s;
  assert.match(postDispatchHtml,/退款中/);
  assert.ok(!postDispatchHtml.includes('等待创建确认'));
});

test('kusdt-v2 BUY renders collapsed advanced channel selector, compact hero-kpis, and random shard / 3-strike congestion rules',()=>{
  const mkOpenShard=(i,recordCount)=>({
    shardCid:`${i.toString(16).padStart(2,'0')}${'ab'.repeat(31)}`,
    stage:0x11,terminal:false,tickets:recordCount,recordCount,
  });
  const kusdtAsset={kind:'KCC20',symbol:'kUSDT',decimals:6,tokenCovenantId:hex('5')};
  const renderWith=(shards,openedCount,buyShard='auto')=>{
    const r=roundFixture({
      kusdt:{cid:hex('a'),loading:false,stage:1,price:1_000_000n,closeDaa:5000n,openedCount,cursor:0,totalTickets:shards.reduce((s,x)=>s+x.tickets,0),decision:0,creatorPk:hex('1'),winnerPk:null,nodeVerified:true,shards},
    });
    const D={
      ...item(r,facts({module:'sales',ticketPrice:1_000_000n,tickets:r.kusdt.totalTickets,shards:openedCount}),actions({BUY:{ok:true}})),
      mine:null,isWinner:false,shards:[],asset:kusdtAsset,protocolMeta:parallelMeta,interactive:kusdtV2InteractiveModel(r),
    };
    return {html:roundView(ctx({net:MAINNET,S:{...BASE_S,view:'round',cid:r.cid,buyShard},detail:D})).s,selector:D.interactive.buyShardSelector};
  };
  // 0 open shards -> compact hero-kpis + refundable deposit button & collapsed advanced options
  const {html:html0}=renderWith([],0);
  assert.match(html0,/class="hero-kpis"/);
  assert.match(html0,/<details class="adv-details buy-adv">/);
  assert.match(html0,/id="buyShardSelect"/);
  assert.match(html0,/立即购买（含 4 KAS 可退押金）/);

  // 7 active open shards -> default auto mode is deposit-free, advanced options collapsed with new-shard choice available
  const sevenActive=Array.from({length:7},(_,i)=>mkOpenShard(i+1,5));
  const {html:html7,selector:sel7}=renderWith(sevenActive,7,'auto');
  assert.match(html7,/<details class="adv-details buy-adv">/);
  assert.match(html7,/>立即购买<\/button>/);
  assert.match(html7,/<option value="new"/);
  // Explicitly selecting new shard in advanced options opens details & updates CTA to show refundable deposit
  const {html:html7New}=renderWith(sevenActive,7,'new');
  assert.match(html7New,/<details class="adv-details buy-adv" open>/);
  assert.match(html7New,/立即购买（含 4 KAS 可退押金）/);

  // 8 active open shards -> hides value="new" option in advanced selector
  const eightActive=Array.from({length:8},(_,i)=>mkOpenShard(i+1,5));
  const {html:html8,selector:sel8}=renderWith(eightActive,8,'auto');
  assert.ok(!html8.includes('<option value="new"'));
  assert.match(html8,/>立即购买<\/button>/);

  // 256 opened shards and all full (256 records) -> disables buySubmit
  const all256Full=[mkOpenShard(1,256)];
  const {html:htmlFull}=renderWith(all256Full,256);
  assert.match(htmlFull,/id="buySubmit"[^>]*disabled/);

  // Random shard selection excludes conflicted shards and avoids repeating them
  const opts=sel7.options;
  const p0=pickRandomBuyShard(opts,new Set(),()=>0.0);
  const pLast=pickRandomBuyShard(opts,new Set(),()=>0.99);
  assert.equal(p0.shardId,opts[0].shardId);
  assert.equal(pLast.shardId,opts[opts.length-1].shardId);
  const pExcl=pickRandomBuyShard(opts,new Set([opts[0].shardId]),()=>0.0);
  assert.equal(pExcl.shardId,opts[1].shardId);
  assert.equal(pickRandomBuyShard(opts,new Set(opts.map(o=>o.shardId)),()=>0.5),null);

  // UTXO conflict detector & 3-strike congestion threshold (only when conflicts >= 3 AND activeOpen < 8)
  assert.equal(isShardUtxoConflict({code:'STALE_INPUT'}),true);
  assert.equal(isShardUtxoConflict({message:'outpoint already spent'}),true);
  assert.equal(isShardUtxoConflict({code:'INSUFFICIENT_FUNDS'}),false);
  assert.equal(shouldWarnShardCongestion(2,sel7),false);
  assert.equal(shouldWarnShardCongestion(3,sel7),true);
  assert.equal(shouldWarnShardCongestion(3,sel8),false);
});

test('confirmBody for kusdt-v2 breaks down kUSDT flow, net KAS change (excluding contract rollovers), and splits rollover outputs',()=>{
  const mine='20'+'ab'.repeat(32)+'ac',other='20'+'cd'.repeat(32)+'ac';
  const wallet={kind:'key',address:'kaspa:qa',key:hex('1'),spk:{script:mine}};
  const kasAsset={kind:'KAS',symbol:'KAS',decimals:8,tokenCovenantId:null};
  const kusdtAsset={kind:'KCC20',symbol:'kUSDT',decimals:6,tokenCovenantId:hex('5')};
  const baseMass={computeMass:1,transientMass:2,storageMass:3};

  // 1) OPEN_SHARD: -1 kUSDT into new shard vault, -4.041 KAS net (-4 KAS refundable deposit, -0.041 KAS fee); 4 KAS MANAGER separated into rollover section!
  const openPrepared={
    op:{action:'BUY',quantity:1},subAction:'OPEN_SHARD',fee:4_100_000n,feerate:'100',mass:baseMass,targetCount:0,cid:hex('a'),
    review:{
      txid:hex('e'),fee:4_100_000n,
      assetDeltas:[
        {asset:kusdtAsset,amount:-1_000_000n,role:'NET'},
        {asset:kasAsset,amount:-400_000_000n,role:'REFUNDABLE_DEPOSIT'},
        {asset:kasAsset,amount:-4_100_000n,role:'FEE'},
      ],
      inputs:[
        {index:0,value:400_000_000n,kind:'合约 UTXO'},
        {index:1,value:100_000_000n,kind:'需签名（你的 kUSDT）'},
        {index:2,value:14_877_191_524n,kind:'需签名（你的钱包）'},
      ],
      outputs:[
        {role:'MANAGER',value:400_000_000n,script:'m',covenant:true,mine:false,rollover:true,note:'原轮次总管 4 KAS 押金滚存（创建者押金，非你支出）'},
        {role:'SHARD_DEPOSIT',value:200_000_000n,script:'s',covenant:true,mine:false,rollover:false,note:'你垫付的新分片账本押金（分片结清时原路退回给你）'},
        {role:'VAULT_DEPOSIT',value:200_000_000n,script:'v',covenant:true,mine:false,rollover:false,tokenAmount:1_000_000n,tokenSymbol:'kUSDT',tokenDecimals:6,note:'你支付的 1 kUSDT 票款存入新分片金库 + 你垫付 2 KAS 可退押金'},
        {role:'TOKEN_CHANGE',value:100_000_000n,script:'tc',covenant:true,mine:true,rollover:false,tokenAmount:4_000_000n,tokenSymbol:'kUSDT',tokenDecimals:6,note:'退回你的 4 kUSDT 找零（含 1 KAS 代币载体，仍归你所有）'},
        {role:'CHANGE',value:14_473_091_524n,script:mine,covenant:false,mine:true,rollover:false,note:'退回你钱包的普通 KAS 找零'},
      ],
    },
  };
  const openHtml=confirmBody({...ctx({net:MAINNET,wallet}),prepared:openPrepared,planText:'开新分片购票'}).s;
  assert.match(openHtml,/你的 kUSDT 支出[\s\S]*?-1 kUSDT/);
  assert.match(openHtml,/存入新分片金库/);
  assert.match(openHtml,/你的 KAS 净变动[\s\S]*?-4\.041 KAS/);
  assert.match(openHtml,/其中 · 暂锁可退押金[\s\S]*?-4 KAS/);
  assert.match(openHtml,/分片账本 2 \+ 分片金库 2/);
  assert.match(openHtml,/其中 · 网络费[\s\S]*?-0\.041 KAS/);
  const [openUserPart,openRolloverPart]=openHtml.split('合约原有状态滚存（非你支出，不从你钱包扣除）');
  assert.ok(openRolloverPart,'OPEN_SHARD should separate rollover outputs');
  assert.match(openUserPart,/涉及你的资金去向/);
  assert.match(openUserPart,/1 kUSDT/);
  assert.match(openUserPart,/4 kUSDT/);
  assert.ok(!openUserPart.includes('轮次状态（原押金滚存）'));
  assert.match(openRolloverPart,/轮次状态（原押金滚存）/);
  assert.match(openRolloverPart,/创建者押金，非你支出/);

  // 2) BUY (existing shard): -1 kUSDT into existing vault, -0.031 KAS net (no deposit), VAULT_DEPOSIT in user section & SHARD_DEPOSIT in rollover
  const buyPrepared={
    op:{action:'BUY',quantity:1},subAction:'BUY',fee:3_100_000n,feerate:'100',mass:baseMass,targetCount:0,cid:hex('a'),
    review:{
      txid:hex('e'),fee:3_100_000n,
      assetDeltas:[
        {asset:kusdtAsset,amount:-1_000_000n,role:'NET'},
        {asset:kasAsset,amount:-3_100_000n,role:'FEE'},
      ],
      inputs:[
        {index:0,value:200_000_000n,kind:'合约 UTXO'},
        {index:1,value:200_000_000n,kind:'合约 UTXO'},
        {index:2,value:100_000_000n,kind:'需签名（你的 kUSDT）'},
        {index:3,value:1_000_000_000n,kind:'需签名（你的钱包）'},
      ],
      outputs:[
        {role:'SHARD_DEPOSIT',value:200_000_000n,script:'s',covenant:true,mine:false,rollover:true,note:'原分片账本 2 KAS 押金滚存（首购者垫付，非你支出）'},
        {role:'VAULT_DEPOSIT',value:200_000_000n,script:'v',covenant:true,mine:false,rollover:false,tokenAmount:2_000_000n,tokenSymbol:'kUSDT',tokenDecimals:6,note:'你本次支付的 1 kUSDT 票款存入此金库（金库现存 2 kUSDT）；2 KAS 为原押金滚存，非你支出'},
        {role:'TOKEN_CHANGE',value:100_000_000n,script:'tc',covenant:true,mine:true,rollover:false,tokenAmount:4_000_000n,tokenSymbol:'kUSDT',tokenDecimals:6,note:'退回你的 4 kUSDT 找零（含 1 KAS 代币载体，仍归你所有）'},
        {role:'CHANGE',value:996_900_000n,script:mine,covenant:false,mine:true,rollover:false,note:'退回你钱包的普通 KAS 找零'},
      ],
    },
  };
  const buyHtml=confirmBody({...ctx({net:MAINNET,wallet}),prepared:buyPrepared,planText:'在已有分片购票'}).s;
  assert.match(buyHtml,/你的 kUSDT 支出[\s\S]*?-1 kUSDT/);
  assert.match(buyHtml,/存入已有分片金库/);
  assert.match(buyHtml,/你的 KAS 净变动[\s\S]*?-0\.031 KAS/);
  assert.ok(!buyHtml.includes('暂锁可退押金'));
  const [buyUserPart,buyRolloverPart]=buyHtml.split('合约原有状态滚存（非你支出，不从你钱包扣除）');
  assert.match(buyUserPart,/分片金库（存票款）/);
  assert.match(buyUserPart,/2 kUSDT/);
  assert.match(buyRolloverPart,/分片账本（原押金滚存）/);

  // 3) PAYOUT_EXECUTOR (3rd-party executor): +0.5 kUSDT, -1.546 KAS net (-1.5 KAS winner carrier + -0.046 KAS fee); first-buyer 4 KAS return in rollover
  const execPrepared={
    op:{action:'PAYOUT_EXECUTOR'},subAction:'PAYOUT_EXECUTOR',fee:4_600_000n,feerate:'100',mass:baseMass,targetCount:0,cid:hex('a'),
    review:{
      txid:hex('e'),fee:4_600_000n,
      assetDeltas:[
        {asset:kusdtAsset,amount:500_000n,role:'NET'},
        {asset:kasAsset,amount:-300_000_000n,role:'CARRIER'},
        {asset:kasAsset,amount:-4_600_000n,role:'FEE'},
      ],
      inputs:[
        {index:0,value:200_000_000n,kind:'合约 UTXO'},
        {index:1,value:200_000_000n,kind:'合约 UTXO'},
        {index:2,value:1_000_000_000n,kind:'需签名（你的钱包）'},
      ],
      outputs:[
        {role:'SHARD_DEPOSIT',value:400_000_000n,script:other,covenant:false,mine:false,rollover:true,note:'合约退回首购者的 4 KAS 分片押金（非你支出）'},
        {role:'WINNER',value:150_000_000n,script:'w',covenant:true,mine:false,rollover:false,tokenAmount:2_500_000n,tokenSymbol:'kUSDT',tokenDecimals:6,note:'发给中奖者的 2.5 kUSDT 奖金（含你垫付的 1.5 KAS 载体，不可退）'},
        {role:'EXECUTOR',value:150_000_000n,script:'ex',covenant:true,mine:true,rollover:false,tokenAmount:500_000n,tokenSymbol:'kUSDT',tokenDecimals:6,note:'你的 0.5 kUSDT 代推激励（含 1.5 KAS 代币载体，仍归你所有）'},
        {role:'CHANGE',value:695_400_000n,script:mine,covenant:false,mine:true,rollover:false,note:'退回你钱包的普通 KAS 找零'},
      ],
    },
  };
  const execHtml=confirmBody({...ctx({net:MAINNET,wallet}),prepared:execPrepared,planText:'代领派奖'}).s;
  assert.match(execHtml,/你的 kUSDT 到账[\s\S]*?\+0\.5 kUSDT/);
  assert.match(execHtml,/分片金库代推激励/);
  assert.match(execHtml,/你的 KAS 净变动[\s\S]*?-1\.546 KAS/);
  assert.match(execHtml,/其中 · 不可退支出[\s\S]*?-1\.5 KAS/);
  assert.match(execHtml,/中奖者代币细胞载体/);
  const [execUserPart,execRolloverPart]=execHtml.split('合约原有状态滚存（非你支出，不从你钱包扣除）');
  assert.match(execUserPart,/2\.5 kUSDT/);
  assert.match(execUserPart,/0\.5 kUSDT/);
  assert.match(execRolloverPart,/分片押金退回/);

  // 4) CLAIM_REFUND (final by first buyer): +1 kUSDT, +3.977 KAS net (+4 KAS deposit return, -0.023 KAS fee)
  const claimPrepared={
    op:{action:'CLAIM_REFUND'},subAction:'CLAIM_REFUND',fee:2_300_000n,feerate:'100',mass:baseMass,targetCount:0,cid:hex('a'),
    review:{
      txid:hex('e'),fee:2_300_000n,
      assetDeltas:[
        {asset:kusdtAsset,amount:1_000_000n,role:'NET'},
        {asset:kasAsset,amount:-150_000_000n,role:'CARRIER'},
        {asset:kasAsset,amount:-2_300_000n,role:'FEE'},
      ],
      inputs:[
        {index:0,value:200_000_000n,kind:'合约 UTXO'},
        {index:1,value:200_000_000n,kind:'合约 UTXO'},
        {index:2,value:1_000_000_000n,kind:'需签名（你的钱包）'},
      ],
      outputs:[
        {role:'SHARD_DEPOSIT',value:400_000_000n,script:mine,covenant:false,mine:true,rollover:true,note:'合约退回你的 4 KAS 分片押金'},
        {role:'BUYER_REFUND',value:150_000_000n,script:'br',covenant:true,mine:true,rollover:false,tokenAmount:1_000_000n,tokenSymbol:'kUSDT',tokenDecimals:6,note:'退回你的 1 kUSDT 票款（含 1.5 KAS 代币载体，仍归你所有）'},
        {role:'CHANGE',value:847_700_000n,script:mine,covenant:false,mine:true,rollover:false,note:'退回你钱包的普通 KAS 找零'},
      ],
    },
  };
  const claimHtml=confirmBody({...ctx({net:MAINNET,wallet}),prepared:claimPrepared,planText:'领取退款'}).s;
  assert.match(claimHtml,/你的 kUSDT 到账[\s\S]*?\+1 kUSDT/);
  assert.match(claimHtml,/你的 KAS 净变动[\s\S]*?\+3\.977 KAS/);
  assert.match(claimHtml,/其中 · 合约退回押金[\s\S]*?\+4 KAS/);
  assert.match(claimHtml,/其中 · 网络费[\s\S]*?-0\.023 KAS/);
  assert.match(claimHtml,/分片押金退回/);
  assert.ok(!claimHtml.includes('合约原有状态滚存（非你支出，不从你钱包扣除）'));

  // 5) CLAIM_REFUND by 3rd party (buyer != wallet): MUST NOT show "你的 kUSDT 到账", shows -1.5 KAS non-refundable carrier
  const claimOtherPrepared={
    ...claimPrepared,
    review:{
      ...claimPrepared.review,
      outputs:[
        {role:'SHARD_DEPOSIT',value:400_000_000n,script:other,covenant:false,mine:false,rollover:true,note:'合约退回首购者的 4 KAS 分片押金（非你支出）'},
        {role:'BUYER_REFUND',value:150_000_000n,script:'br',covenant:true,mine:false,rollover:false,tokenAmount:1_000_000n,tokenSymbol:'kUSDT',tokenDecimals:6,note:'退回买家的 1 kUSDT 票款（含 1.5 KAS 载体，不可退）'},
        {role:'CHANGE',value:847_700_000n,script:mine,covenant:false,mine:true,rollover:false,note:'退回你钱包的普通 KAS 找零'},
      ],
    },
  };
  const claimOtherHtml=confirmBody({...ctx({net:MAINNET,wallet}),prepared:claimOtherPrepared,planText:'代领退款'}).s;
  assert.ok(!claimOtherHtml.includes('你的 kUSDT 到账'));
  assert.match(claimOtherHtml,/合约退回给买家[\s\S]*?1 kUSDT/);
  assert.match(claimOtherHtml,/分片金库票款退回原买家（非你钱包）/);
  assert.match(claimOtherHtml,/你的 KAS 净变动[\s\S]*?-1\.523 KAS/);
  assert.match(claimOtherHtml,/其中 · 不可退支出[\s\S]*?-1\.5 KAS/);
  assert.match(claimOtherHtml,/买家退款代币细胞载体/);

  // 6) PAYOUT_SELF triggered by non-winner (e.g. first buyer recovering 4 KAS deposit): MUST show winner kUSDT destination & 1.5 KAS winner carrier
  const selfOtherPrepared={
    op:{action:'PAYOUT_SELF'},subAction:'PAYOUT_SELF',fee:2_863_800n,feerate:'100',mass:baseMass,targetCount:0,cid:hex('a'),
    review:{
      txid:hex('e'),fee:2_863_800n,
      assetDeltas:[{asset:kusdtAsset,amount:3_000_000n,role:'NET'},{asset:kasAsset,amount:-150_000_000n,role:'CARRIER'},{asset:kasAsset,amount:-2_863_800n,role:'FEE'}],
      inputs:[{index:0,value:200_000_000n,kind:'合约 UTXO'},{index:1,value:200_000_000n,kind:'合约 UTXO'},{index:2,value:1_000_000_000n,kind:'需签名（你的钱包）'}],
      outputs:[
        {role:'SHARD_DEPOSIT',value:400_000_000n,script:mine,covenant:false,mine:true,rollover:true,note:'合约退回你的 4 KAS 分片押金'},
        {role:'WINNER',value:150_000_000n,script:'win',covenant:true,mine:false,rollover:false,tokenAmount:3_000_000n,tokenSymbol:'kUSDT',tokenDecimals:6,note:'发给中奖者的 3 kUSDT 奖金（含你垫付的 1.5 KAS 载体，不可退）'},
        {role:'CHANGE',value:847_136_200n,script:mine,covenant:false,mine:true,rollover:false,note:'退回你钱包的普通 KAS 找零'},
      ],
    },
  };
  const selfOtherHtml=confirmBody({...ctx({net:MAINNET,wallet}),prepared:selfOtherPrepared,planText:'赢家自推派奖'}).s;
  assert.ok(!selfOtherHtml.includes('你的 kUSDT 到账'));
  assert.match(selfOtherHtml,/合约派发给中奖者[\s\S]*?3 kUSDT/);
  assert.match(selfOtherHtml,/分片金库奖金发给中奖者（非你钱包）/);
  assert.match(selfOtherHtml,/中奖者代币细胞载体（1\.5 KAS）/);
  assert.ok(!selfOtherHtml.includes('外部接收方'));
});

test('kusdt-v2 payout actions hide PAYOUT_SELF for non-winners and show it for the winner',()=>{
  const wallet={kind:'extension',address:'kaspa:qa',key:hex('1'),spk:{script:'20'+'ab'.repeat(32)+'ac'}};
  const kusdtAsset={kind:'KCC20',symbol:'kUSDT',decimals:6,tokenCovenantId:hex('5')};
  const rPay=roundFixture({manager:null,kusdt:{cid:hex('a'),loading:false,stage:3,price:1_000_000n,closeDaa:100n,openedCount:1,cursor:1,totalTickets:3,decision:1,creatorPk:hex('1'),winnerPk:hex('2'),nodeVerified:true,shards:[{shardCid:hex('3'),stage:0x13,terminal:false,tickets:3,recordCount:3}]}});
  const nonWinHtml=roundView(ctx({net:MAINNET,wallet,S:{...BASE_S,view:'round',cid:rPay.cid},detail:{...item(rPay,facts({module:'win',ticketPrice:1_000_000n,tickets:3,shards:1,winnerKey:hex('2')}),actions()),mine:null,isWinner:false,shards:[],asset:kusdtAsset,protocolMeta:parallelMeta,interactive:kusdtV2InteractiveModel(rPay,{isWinner:false})}})).s;
  assert.ok(!nonWinHtml.includes('data-proto-act="PAYOUT_SELF"'));
  assert.ok(nonWinHtml.includes('data-proto-act="PAYOUT_EXECUTOR"'));

  const winHtml=roundView(ctx({net:MAINNET,wallet,S:{...BASE_S,view:'round',cid:rPay.cid},detail:{...item(rPay,facts({module:'win',ticketPrice:1_000_000n,tickets:3,shards:1,winnerKey:hex('1')}),actions()),mine:null,isWinner:true,shards:[],asset:kusdtAsset,protocolMeta:parallelMeta,interactive:kusdtV2InteractiveModel(rPay,{isWinner:true})}})).s;
  assert.ok(winHtml.includes('data-proto-act="PAYOUT_SELF"'));
  assert.ok(winHtml.includes('领取全额奖金'));
  assert.ok(winHtml.includes('data-proto-act="PAYOUT_EXECUTOR"'));
});

test('Locale abstraction: ZH_CN and EN are structurally isomorphic and every EN view renders zero leftover Chinese',()=>{
  const checkShape=(a,b,path='')=>{
    assert.equal(typeof a,typeof b,`type mismatch at ${path}`);
    if(a&&typeof a==='object'&&!Array.isArray(a)){
      assert.deepEqual(Object.keys(a).sort(),Object.keys(b).sort(),`keys mismatch at ${path}`);
      for(const k of Object.keys(a))checkShape(a[k],b[k],path?`${path}.${k}`:k);
    }
  };
  checkShape(ZH_CN,EN);
  assert.equal(LOCALES.length,2);
  assert.equal(nextLocale(ZH_CN),EN);
  assert.equal(nextLocale(EN),ZH_CN);
  assert.equal(resolveLocale('en'),EN);
  assert.equal(resolveLocale('zh-CN'),ZH_CN);

  const checkNoChinese=(label,markup)=>{
    // Strip explicit language-switcher labels that intentionally name the Chinese language (e.g. "Switch to 简体中文").
    const cleaned=markup.replace(/简体中文/g,'Chinese');
    const chunks=cleaned.replace(/<[^>]+>/g,'\n').split('\n').map(s=>s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').trim()).filter(Boolean);
    const bad=chunks.filter(c=>/[\u4e00-\u9fff]/.test(c));
    assert.deepEqual(bad,[],`${label} rendered Chinese in EN locale:\n${bad.join('\n')}`);
  };

  const mine='20'+'ab'.repeat(32)+'ac';
  const wallet={kind:'extension',address:'kaspa:qa',key:hex('1'),spk:{script:mine}};
  const kusdtAsset={kind:'KCC20',symbol:'kUSDT',decimals:6,tokenCovenantId:hex('5')};
  const kasAsset={kind:'KAS',symbol:'KAS',decimals:8,tokenCovenantId:null};
  const compatProfiles=[
    {protocolId:'rolling-v1',name:'Rolling v1',displayName:'KAS (Rolling v1)',asset:'KAS',profileId:hex('a'),tokenCovenantId:null,supportsNet:true},
    {protocolId:'kusdt-v2',name:'kUSDT v2',displayName:'kUSDT v2 (KCC-20)',asset:'kUSDT',assetDescriptor:kusdtAsset,profileId:hex('b'),tokenCovenantId:hex('5'),supportsNet:true},
  ];
  const createSpecs=[
    {
      protocolId:'kusdt-v2',profileId:hex('b'),name:'kUSDT v2',displayName:'kUSDT v2 (KCC-20)',layout:'parallel_fixed_shards',
      supportedOnNet:true,asset:kusdtAsset,priceMin:1_000_000n,priceMax:500_000_000_000_000_000n,fixedTicketCap:65536,
      minTicketCap:3,maxTicketCap:65536,fixedMinTickets:3,minTicketsFloor:3,shardSize:256,maxShards:256,
      creatorDepositSompi:400_000_000n,minCloseMinutes:1,maxCloseMinutes:10080,
    },
    defaultSequentialCreateSpec(MAINNET,{protocolId:'rolling-v1',profileId:hex('a'),name:'Rolling v1'}),
  ];
  const enBase={net:MAINNET,wallet,L:EN,lang:'en',compatibleProfiles:compatProfiles,createSpecs,supportedProfiles:new Set([hex('a'),hex('b')])};

  // 1) Explore (with incompatible round & missing-profile notice)
  const rRoll=roundFixture({profileId:hex('a')});
  checkNoChinese('exploreView(en)',exploreView(ctx({...enBase,items:[item(rRoll,facts(),actions())],discovered:[{cid:hex('6'),protocolId:'kusdt-v2',profileId:hex('5'),phase:'DONE',terminal:'REFUNDED',ticketsSold:1,ticketPrice:'1000000',asset:kusdtAsset}],conn:{node:true,indexer:true,indexerStale:false,indexerProfiles:[{protocolId:'rolling-v1',profileId:hex('a')}]}})).s);

  // 2) Create (both protocols)
  checkNoChinese('createView(en, rolling-v1)',createView(ctx({...enBase,S:{...BASE_S,form:{...BASE_S.form,protocol:'rolling-v1'}}})).s);
  checkNoChinese('createView(en, kusdt-v2)',createView(ctx({...enBase,S:{...BASE_S,form:{...BASE_S.form,protocol:'kusdt-v2'}}})).s);

  // 3) Round detail: sales, refund, payout, rules tab, and incompatible read-only round
  const openShards=[{shardCid:hex('1'),stage:0x11,terminal:false,tickets:5,recordCount:2}];
  const rOpen=roundFixture({profileId:hex('b'),kusdt:{cid:hex('a'),loading:false,stage:1,price:1_000_000n,closeDaa:5000n,openedCount:1,cursor:0,totalTickets:5,decision:0,creatorPk:hex('1'),winnerPk:null,nodeVerified:true,shards:openShards}});
  const enShard=[{index:0,kind:'active',status:'active',startTicket:1,endTicket:5,tickets:5,recordCount:1,hash:hex('1'),refundedRecords:0,mineCount:5,records:[{index:0,startTicket:1,endTicket:5,count:5,key:hex('1'),mine:true,refunded:false}]}];
  checkNoChinese('roundView(en, kusdt-v2 sales default)',roundView(ctx({...enBase,S:{...BASE_S,view:'round',cid:rOpen.cid},detail:{...item(rOpen,facts({module:'sales',ticketPrice:1_000_000n,tickets:5,shards:1}),actions({BUY:{ok:true},CLOSE:{ok:true}})),mine:null,isWinner:false,shards:enShard,asset:kusdtAsset,protocolMeta:parallelMeta,interactive:kusdtV2InteractiveModel(rOpen)}})).s);
  checkNoChinese('roundView(en, kusdt-v2 sales map)',roundView(ctx({...enBase,S:{...BASE_S,view:'round',cid:rOpen.cid,detailTab:'map'},detail:{...item(rOpen,facts({module:'sales',ticketPrice:1_000_000n,tickets:5,shards:1}),actions({BUY:{ok:true},CLOSE:{ok:true}})),mine:null,isWinner:false,shards:enShard,asset:kusdtAsset,protocolMeta:parallelMeta,interactive:kusdtV2InteractiveModel(rOpen)}})).s);
  checkNoChinese('roundView(en, rules tab)',roundView(ctx({...enBase,S:{...BASE_S,view:'round',cid:rOpen.cid,detailTab:'rules'},detail:{...item(rOpen,facts({module:'sales',ticketPrice:1_000_000n,tickets:5,shards:1}),actions({BUY:{ok:true}})),mine:null,isWinner:false,shards:[],asset:kusdtAsset,protocolMeta:parallelMeta,interactive:kusdtV2InteractiveModel(rOpen)}})).s);

  const rRef=roundFixture({profileId:hex('b'),manager:null,kusdt:{cid:hex('a'),loading:false,stage:3,price:1_000_000n,closeDaa:100n,openedCount:1,cursor:1,totalTickets:1,decision:2,creatorPk:hex('1'),winnerPk:null,nodeVerified:true,shards:[{shardCid:hex('2'),stage:0x14,terminal:false,tickets:1,recordCount:1,claimedMask:0,records:[{buyerPk:hex('1'),cumTickets:1}]}]}});
  checkNoChinese('roundView(en, kusdt-v2 refund)',roundView(ctx({...enBase,S:{...BASE_S,view:'round',cid:rRef.cid},detail:{...item(rRef,facts({module:'refund',ticketPrice:1_000_000n,tickets:1,shards:1}),actions()),mine:null,isWinner:false,shards:[],asset:kusdtAsset,protocolMeta:parallelMeta,interactive:kusdtV2InteractiveModel(rRef)}})).s);

  checkNoChinese('roundView(en, incompatible)',roundView(ctx({...enBase,S:{...BASE_S,view:'round',cid:hex('6')},discovered:[{cid:hex('6'),protocolId:'kusdt-v2',profileId:hex('5'),phase:'DONE',terminal:'REFUNDED',ticketsSold:1,ticketPrice:'1000000',asset:kusdtAsset}]})).s);

  // 4) Mine, Help (How it works), Wallet, Settings
  checkNoChinese('mineView(en)',mineView(ctx({...enBase,balance:5_00000000n,items:[item(rRoll,facts(),actions())],mine:{rounds:[{item:item(rRoll,facts(),actions()),tickets:2,created:true,won:false}],txs:[]}})).s);
  checkNoChinese('rulesView(en)',rulesView(ctx({...enBase})).s);
  checkNoChinese('walletBody(en)',walletBody(ctx({...enBase,wallet:null,S:{...BASE_S,wtab:'extension'}})).s);
  checkNoChinese('settingsBody(en)',settingsBody(ctx({...enBase,conn:{node:true,nodeUrl:'wss://node',indexer:true,indexerProfiles:[{protocolId:'rolling-v1',profileId:hex('a')},{protocolId:'kusdt-v2',profileId:hex('b')}]}})).s);

  // 5) Confirm modal for OPEN_SHARD
  const openPrepared={
    op:{action:'BUY',quantity:1},subAction:'OPEN_SHARD',fee:4_100_000n,feerate:'100',mass:{computeMass:1,transientMass:2,storageMass:3},targetCount:0,cid:hex('a'),
    review:{
      txid:hex('e'),fee:4_100_000n,
      assetDeltas:[{asset:kusdtAsset,amount:-1_000_000n,role:'NET'},{asset:kasAsset,amount:-400_000_000n,role:'REFUNDABLE_DEPOSIT'},{asset:kasAsset,amount:-4_100_000n,role:'FEE'}],
      inputs:[{index:0,value:400_000_000n,kind:'合约 UTXO'},{index:1,value:100_000_000n,kind:'需签名（你的 kUSDT）'},{index:2,value:14_877_191_524n,kind:'需签名（你的钱包）'}],
      outputs:[
        {role:'MANAGER',value:400_000_000n,script:'m',covenant:true,mine:false,rollover:true,note:'原轮次总管 4 KAS 押金滚存（创建者押金，非你支出）'},
        {role:'SHARD_DEPOSIT',value:200_000_000n,script:'s',covenant:true,mine:false,rollover:false,note:'你垫付的新分片账本押金（分片结清时原路退回给你）'},
        {role:'VAULT_DEPOSIT',value:200_000_000n,script:'v',covenant:true,mine:false,rollover:false,tokenAmount:1_000_000n,tokenSymbol:'kUSDT',tokenDecimals:6,note:'你支付的 1 kUSDT 票款存入新分片金库 + 你垫付 2 KAS 可退押金'},
        {role:'TOKEN_CHANGE',value:100_000_000n,script:'tc',covenant:true,mine:true,rollover:false,tokenAmount:4_000_000n,tokenSymbol:'kUSDT',tokenDecimals:6,note:'退回你的 4 kUSDT 找零（含 1 KAS 代币载体，仍归你所有）'},
        {role:'CHANGE',value:14_473_091_524n,script:mine,covenant:false,mine:true,rollover:false,note:'退回你钱包的普通 KAS 找零'},
      ],
    },
  };
  const plan=EN.app.planAction('OPEN_SHARD',{qty:1,n:0,fee:'0.041',unit:'KAS',tokenUnit:'kUSDT',hasReg:false,isParallel:true});
  checkNoChinese('confirmBody(en, OPEN_SHARD)',confirmBody({...ctx(enBase),prepared:openPrepared,planText:plan}).s);
});

test('ProtocolPlugin UI decoupling: plugging a 3rd covenant (kUSDC v3 fixed-denomination) renders across explore, create, round, rules, and confirm without touching web/',()=>{
  const kusdcAsset={kind:'KCC20',symbol:'kUSDC',decimals:6,tokenCovenantId:hex('9')};
  const kusdcSpec={
    protocolId:'kusdc-v3',profileId:hex('8'),name:'kUSDC v3',displayName:'kUSDC v3 (KCC-20)',
    layout:'parallel_fixed_shards',supportedOnNet:true,asset:kusdcAsset,
    priceMin:5_000_000n,priceMax:100_000_000n,fixedTicketCap:16384,
    minTicketCap:10,maxTicketCap:16384,fixedMinTickets:10,minTicketsFloor:10,
    shardSize:256,maxShards:64,creatorDepositSompi:600_000_000n,minCloseMinutes:5,maxCloseMinutes:1440,
  };
  const kusdcMeta={protocolId:'kusdc-v3',profileId:hex('8'),displayName:'kUSDC v3 (KCC-20)',shardModel:'parallel',maxShards:64,supportsBatchSettlement:false,supportsIntentResend:false,freeActions:[],actionStyle:'parallel_dispatch'};
  const compat=[
    {protocolId:'rolling-v1',name:'Rolling v1',displayName:'KAS (Rolling v1)',asset:'KAS',profileId:hex('a'),tokenCovenantId:null,supportsNet:true},
    {protocolId:'kusdc-v3',name:'kUSDC v3',displayName:'kUSDC v3 (KCC-20)',asset:'kUSDC',assetDescriptor:kusdcAsset,profileId:hex('8'),tokenCovenantId:hex('9'),supportsNet:true},
  ];
  const specs=[kusdcSpec,defaultSequentialCreateSpec(MAINNET,{protocolId:'rolling-v1',profileId:hex('a'),name:'Rolling v1'})];

  // Create view renders 3rd covenant pill, 5 kUSDC min hint, no-ticket-cap 10-ticket threshold, and 6 KAS deposit
  const createHtml=createView(ctx({net:MAINNET,createSpecs:specs,S:{...BASE_S,form:{...BASE_S.form,protocol:'kusdc-v3',price:'5'}}})).s;
  assert.match(createHtml,/data-proto="kusdc-v3"/);
  assert.match(createHtml,/kUSDC/);
  assert.match(createHtml,/不限总票数 · 满 10 张开奖/);
  assert.ok(!createHtml.includes('65,536'));
  assert.match(createHtml,/需冻结 6 KAS 创建押金（结算后退回创建者）/);
  assert.equal(parseCreate({...BASE_S.form,protocol:'kusdc-v3',price:'4'},MAINNET,ZH_CN,kusdcSpec).ok,false);
  assert.equal(parseCreate({...BASE_S.form,protocol:'kusdc-v3',price:'5'},MAINNET,ZH_CN,kusdcSpec).ok,true);

  // Explore, Round detail, Rules, and Confirm all project kUSDC v3 cleanly
  const r3=roundFixture({cid:hex('7'),profileId:hex('8')});
  const it3=item(r3,facts({module:'sales',ticketPrice:5_000_000n,tickets:12,shards:2,minTickets:10}),actions({BUY:{ok:true}}),{asset:kusdcAsset,protocolMeta:kusdcMeta});
  const expHtml=exploreView(ctx({net:MAINNET,compatibleProfiles:compat,supportedProfiles:new Set([hex('a'),hex('8')]),items:[it3]})).s;
  assert.match(expHtml,/60<small>kUSDC<\/small>/);
  const rndHtml=roundView(ctx({net:MAINNET,compatibleProfiles:compat,S:{...BASE_S,view:'round',cid:r3.cid,detailTab:'rules'},detail:{...it3,mine:null,isWinner:false,shards:[]}})).s;
  assert.match(rndHtml,/kUSDC v3 \(KCC-20\)/);
  assert.match(rndHtml,/2 \/ 64/);
  const rulesHtml=rulesView(ctx({net:MAINNET,compatibleProfiles:compat})).s;
  assert.match(rulesHtml,/kUSDC v3 \(KCC-20\)/);
});

test('draw verification: independently recomputes BLAKE2b-256 winning ticket, builds zero-dep Python script, and renders in round info tab (zh & en)',()=>{
  const seedBase={
    scheme:'kusdt-v2',
    seedDomain:'KASWIN_KUSDT_DRAW_V1',
    sampleDomain:'KASWIN_KUSDT_SAMPLE_V1',
    cid:hex('a'),
    sealedTxid:hex('b'),
    sealedIndex:0,
    sealedDaa:'1000',
    boundaryDaa:'1100',
    targetBlockHash:hex('c'),
    targetBlockDaa:'1101',
    parentBlockDaa:'1099',
    sequenceCommitment:hex('d'),
    seed:'',
    digest:'',
    sample:'0',
    totalTickets:17,
    winningTicket:1,
    rejectionSampled:false,
  };
  const computed=recomputeDrawProof(seedBase);
  const validProof={...seedBase,seed:computed.seed,digest:computed.digest,sample:computed.sample,winningTicket:computed.winningTicket};
  assert.equal(recomputeDrawProof(validProof).ok,true);
  assert.equal(recomputeDrawProof({...validProof,winningTicket:(validProof.winningTicket%17)+1}).ok,false);
  assert.equal(recomputeDrawProof({...validProof,targetBlockDaa:'1099'}).ok,false);

  const py=buildPythonVerifyScript(validProof);
  assert.match(py,/hashlib\.blake2b/);
  assert.ok(py.includes(`b"KASWIN_KUSDT_DRAW_V1"`));
  assert.ok(py.includes(`assert winning_ticket == ${validProof.winningTicket}`));

  const rWin=roundFixture({
    terminal:'PAID',manager:null,bought:17,
    draw:{txid:hex('e'),shard:0,record:1,ticket:validProof.winningTicket-1,proof:validProof},
  });
  const dWin={...item(rWin,facts({module:null,tickets:17,shards:1,winnerKey:hex('1')}),actions()),mine:null,isWinner:false,shards:[]};
  const zhOut=roundView(ctx({S:{...BASE_S,view:'round',cid:rWin.cid},detail:dWin})).s;
  assert.match(zhOut,/draw-verify-box/);
  assert.match(zhOut,new RegExp(`本地 BLAKE2b-256 独立复算通过：中奖票 #${validProof.winningTicket}`));
  assert.match(zhOut,/复制 Python 3 独立验算脚本/);

  const enOut=roundView(ctx({L:EN,lang:'en',S:{...BASE_S,view:'round',cid:rWin.cid},detail:dWin})).s;
  assert.match(enOut,/Local BLAKE2b-256 recomputation passed/);
  assert.match(enOut,/Copy Python 3 verification script/);
  assert.doesNotMatch(enOut,/[\u4e00-\u9fff]/);
});

