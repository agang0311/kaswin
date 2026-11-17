// 轮次自己的 UTXO（管理 UTXO）被双花：两个买家（两个不同的钱包、两个独立页面）同时对同一轮操作。真实页面、真实 Testnet 10 节点、真实交易。
//
// 与 double-spend.mjs 的区别：那个测的是“同一个钱包的资金输入”冲突（FUNDS_INPUT）；这里两个买家用不同的钱包，资金输入不会冲突，
// 冲突只可能出在轮次的管理 UTXO 上（页面分类 ROUND_INPUT）。
//
// R1（真实冲突）：创建者开一轮并导出状态，买家 A/B 各自“加入轮次”；两人各自备好“买 1 张”的报价（花的是同一个管理 UTXO），同一时刻点发送。
//   期望：节点收一笔、拒一笔；输家页面分类为 ROUND_INPUT，占用方 = 赢家的 txid，被争的输出 = 赢家这笔交易的第 0 个输入（管理 UTXO）；
//   输家放弃、导入赢家的最新状态后能重新买。节点侧只读核对：赢家被接受，被拒的那笔既未被接受也不在内存池。
// R2（过期报价）：两页都同步到最新状态并备好报价；一方先发并被确认，另一方再用旧报价发送。观察页面的处理与用户看到的提示，以及节点上没有这笔交易。
// 收尾：卖出 3 张（最低 5 张）→ 封盘 → 退款，到 REFUNDED，保证金与票款退回。
//
// 用法：node tests/rolling-web/round-double-spend.mjs [--node=wss://…]
import fs from 'node:fs';
import path from 'node:path';
import {RollingPage} from './harness.mjs';
import {acquireWalletLock} from './lock.mjs';
import {connectTN10} from '../../web/rolling-tn10/prepare.mjs';
import {searchAccepted, acceptedAt, mempoolEntry,verifyInputsLive} from '../../scripts/chain/chain.mjs';
import {decodeTagged} from '../../web/rolling-tn10/codec.mjs';
import {quoteId,finalizedRound,acceptanceEvidence} from './evidence.mjs';
import {classifyRejection} from '../../web/rolling-tn10/conflict.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const arg = (k, d) => process.argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const URL_ = arg('url', 'https://cd311.cn:888/www/rolling-tn10/');
const NODE = arg('node', 'wss://cd311.cn:888/www/rolling-tn10/node');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PHASES = arg('phases', 'r1,r2').split(',').map(s => s.trim());

const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
const ROOT = path.join(HERE, '../output/rolling-runs');
for (const w of ['creator', 'b1', 'b2']) acquireWalletLock(ROOT, w, 'round-double-spend');
const RUN = path.join(ROOT, `${stamp}-round-double-spend`);
fs.mkdirSync(RUN, {recursive: true});
const logPath = path.join(RUN, 'run.log');
const log = (...a) => { const line = `${new Date().toISOString().slice(11, 23)} ${a.join(' ')}`; console.log(line); fs.appendFileSync(logPath, line + '\n'); };
const result = {schema: 'KASWIN_ROLLING_ROUND_DOUBLE_SPEND_1', startedAt: stamp, url: URL_, node: NODE, setup: {}, r1: null, r2: null, final: null};
const save = () => fs.writeFileSync(path.join(RUN, 'result.json'), JSON.stringify(result, null, 1) + '\n');
const CFG = {price: '1', cap: 5, min: 5, minutes: 1};

// ---- 只读的节点访问（无密钥、无签名、无提交） ----
const rpc = await connectTN10([NODE]);
const stableCursor = async (back = 300) => {
  let h = (await rpc.call('getSink')).sink;
  for (let i = 0; i < back; i++) h = (await rpc.call('getBlock', {hash: h, includeTransactions: false})).block.verboseData.selectedParentHash;
  return h;
};
const verifyTx = async (txid, cursor) => {
  const s = await searchAccepted(rpc, txid, cursor);
  const r = {accepted: !!s.accepting, searchComplete: s.complete, inMempool: !!(await mempoolEntry(rpc, txid))};
  if (s.accepting) { const ev = await acceptedAt(rpc, txid, s.accepting); r.inputs = ev.tx.inputs.map(i => `${i.previousOutpoint.transactionId}:${i.previousOutpoint.index}`); }
  return r;
};

// ---- 从页面取证据 ----
/** 导出文本里只取需要的字段（导出含签名脚本，不整体打印）。 */
function intentOf(text) {
  const i = decodeTagged(text).intent;
  if (!i) return null;
  return {status: i.status, action: i.action, txid: i.txid, errorCode: i.errorCode ?? null, nodeError: i.nodeError ?? null,
    inputs: (i.draft?.inputUtxos ?? []).map(u => ({outpoint: `${u.outpoint.transactionId}:${u.outpoint.index}`, covenant: !!u.covenantId})), _draft: i.draft};
}
const newestSubmitted = lines => lines.map(l => /已提交 ([0-9a-f]{64})/.exec(l)?.[1]).find(Boolean) ?? null;   // 日志是新的在前
const notices = page => page.p.evaluate(() => [...document.querySelectorAll('.notice')].map(n => n.innerText.replace(/\s+/g, ' ').trim()));

const mk = (n, role) => {
  const frames=[];
  return {n,role,frames,page:new RollingPage({url:URL_,log:(...a)=>log(`[${n}]`,...a),profileDir:path.join(RUN,`profile-${n}`),wsTap:event=>frames.push(event)})};
};

async function waitIntentCleared(page,timeout=20000) {
  const until=Date.now()+timeout;
  while(Date.now()<until){const r=decodeTagged(await page.exportRoundText());if(!r.intent)return r;await sleep(200);}
  throw new Error('DISCARD_NOT_COMPLETED');
}

async function settledAll(tasks){const rows=await Promise.allSettled(tasks),bad=rows.find(x=>x.status==='rejected');if(bad)throw bad.reason;return rows.map(x=>x.value);}

async function settleAfterFailure(all,cursor) {
  const until=Date.now()+90000;
  while(Date.now()<until){
    const snapshots=[];let foreground=false,incomplete=false;
    for(const x of all)try{
      if(await x.page.p.locator('[aria-busy="true"]').count()){foreground=true;continue;}
      if(await x.page.p.locator('#modal[open]').count()){
        if(await x.page.p.locator('#mClose').isEnabled())await x.page.p.locator('#mClose').click();else{foreground=true;continue;}
      }
      snapshots.push({...x,round:decodeTagged(await x.page.exportRoundText())});
    }catch{incomplete=true;}
    if(foreground||incomplete){await sleep(500);continue;}
    for(const x of snapshots){const r=x.round;if(r.intent||(!r.manager&&!r.terminal))continue;
      if(r.manager){
        const point=`${r.manager.outpoint.transactionId}:${r.manager.outpoint.index}`;
        if(snapshots.some(y=>y.round.intent&&!['UNSENT','REJECTED'].includes(y.round.intent.status)&&y.round.intent.draft?.inputUtxos?.some(u=>`${u.outpoint.transactionId}:${u.outpoint.index}`===point)))continue;
        try{await verifyInputsLive(rpc,[r.manager],{allowDaaDrift:true});}catch{continue;}
        const receipt=r.receipts.find(q=>q.txid===r.manager.outpoint.transactionId);if(!receipt)continue;
        await acceptanceEvidence(rpc,receipt.txid,{block:receipt.acceptingBlock,cursor,minDepth:100n});
      }
      const dir=path.join(RUN,`recovery-${x.n}`);fs.mkdirSync(dir,{recursive:true});
      await x.page.actUntilTerminal(['CLOSE','DRAW','PAY_OLD','PAY_SELF','REFUND_OLD','REFUND_SELF'],40);
      const v=await finalizedRound(x.page,rpc,{cursor,dir,log});
      return {owner:x.n,cid:v.round.cid,terminal:v.round.terminal,transactions:v.evidence.length,feeSompi:v.round.fees.toString(),allAccepted:true,dir};
    }
    await sleep(500);
  }
  throw new Error('RECOVERY_REQUIRES_ORIGINAL_INTENT_RECONCILIATION');
}

async function run() {
  const C = mk('C', 'creator'), A = mk('A', 'b1'), B = mk('B', 'b2');
  const all = [C, A, B];
  try {
    await Promise.all(all.map(x => x.page.open()));
    for (const x of all) { await x.page.setNode(NODE); await x.page.connect(x.role); }

    // ---------- 准备：创建者开一轮并导出，买家加入 ----------
    log('\n=== 准备：创建轮次（cap 5，最低 5 张，1 分钟后可封盘）并让两个买家加入 ===');
    result.setup.cursor=await stableCursor();
    result.setup.created = await C.page.createRobust(CFG,1);
    log(`  创建完成: ${result.setup.created}`);
    if (!result.setup.created) throw new Error('创建失败');
    for (let i = 0; i < 30 && /确认中/.test(await C.page.text()); i++) await sleep(3000);   // 等 GENESIS 深度复核完成，导出的状态里不带待复核候选
    const T0 = await C.page.exportRoundText();result.cid=decodeTagged(T0).cid;
    await A.page.joinText(T0); await B.page.joinText(T0);
    const [ra, rb] = await Promise.all([A.page.waitEnabled('BUY', 180000), B.page.waitEnabled('BUY', 180000)]);
    result.setup.joined = {A: ra, B: rb};
    log(`  买家加入并核对完成: A=${ra} B=${rb}`);
    if (!ra || !rb) throw new Error('买家未能加入');

    // ---------- R1：同一时刻对同一个管理 UTXO 发送 ----------
    log('\n=== R1：两个买家同时买票（同一个管理 UTXO）===');
    const r1 = result.r1 = {};
    const [qa_, qb_] = await settledAll([A.page.buyQuote(), B.page.buyQuote()]);
    const qa = qa_?.quote, qb = qb_?.quote;
    r1.quotesReady = {A: !!qa, B: !!qb}; r1.clicksToQuote = {A: qa_?.clicks ?? null, B: qb_?.clicks ?? null};
    log(`  两页报价就绪: A=${!!qa} B=${!!qb}`);
    if (!qa || !qb) throw new Error('R1 报价未就绪');
    const cursor1 = await stableCursor(),frameStart=Object.fromEntries([A,B].map(x=>[x.n,x.frames.filter(e=>e.kind==='submit').length]));
    const t0 = Date.now();
    const [ca, cb] = await settledAll([A.page.clickSend().then(() => Date.now() - t0), B.page.clickSend().then(() => Date.now() - t0)]);
    r1.clickOffsetsMs = {A: ca, B: cb};
    log(`  同时点击发送（点击时间差 ${Math.abs(ca - cb)} ms）`);
    const [sa, sb] = await settledAll([A.page.sendResult(), B.page.sendResult()]);
    const oa = sa.status, ob = sb.status;
    r1.outcome = {A: oa, B: ob}; r1.sendToasts = {A: sa.toasts, B: sb.toasts};
    r1.actualSubmitFrames=Object.fromEntries([A,B].map(x=>[x.n,x.frames.filter(e=>e.kind==='submit').length-frameStart[x.n]]));
    log(`  结果: A=${oa} B=${ob}`);
    const L = oa === 'REJECTED' && ob === 'SUBMITTED' ? A : ob === 'REJECTED' && oa === 'SUBMITTED' ? B : null;
    if (!L) { r1.note = '没有恰好一方被拒、一方被提交，无法检验冲突识别'; log(`  ${r1.note}`); throw new Error(r1.note); }
    const W = L === A ? B : A;
    r1.roles = {loser: `${L.n}(${L.role})`, winner: `${W.n}(${W.role})`};
    const notice = await L.page.noticeInfo();
    const lLogs = await L.page.logLines(), wLogs = await W.page.logLines();
    const lIntent = await L.page.exportRoundText().then(intentOf).catch(e => { r1.exportError = String(e.message).slice(0, 120); return null; });
    const winnerTx = newestSubmitted(wLogs);
    const cls = lIntent ? classifyRejection({nodeError: lIntent.nodeError, draft: lIntent._draft}) : null;
    if (lIntent) delete lIntent._draft;
    r1.loser = {panel: notice?.text ?? null, panelHashes: notice?.copies ?? [], intent: lIntent, classification: cls, logs: lLogs.filter(l => /拒绝|占用|已提交/.test(l)).slice(0, 8)};
    r1.winnerTx = winnerTx;
    r1.check = {
      kind: cls?.kind ?? null,
      panelNamesRoundConflict: /这一轮的合约输出已被另一笔还没确认的交易/.test(notice?.text ?? ''),
      spenderEqualsWinnerTx: !!winnerTx && cls?.spender === winnerTx,
      panelShowsWinnerTx: !!winnerTx && (notice?.copies ?? []).includes(winnerTx),
      logNamesCause: lLogs.some(l => /合约输出.*占用/.test(l)),
      contestedInputIsCovenant: !!lIntent?.inputs.find(i => i.outpoint === cls?.outpoint)?.covenant,
    };
    log(`  输家面板: ${notice?.text?.slice(0, 200) ?? '（无）'}`);
    log(`  节点原文: ${lIntent?.nodeError ?? '（无）'}`);
    log(`  分类=${cls?.kind} 占用方=${cls?.spender?.slice(0, 12)}… 赢家交易=${winnerTx?.slice(0, 12)}… 相等=${r1.check.spenderEqualsWinnerTx}`);
    // 节点侧：被争的输出应是赢家交易的第 0 个输入（管理 UTXO）
    r1.verifyWinner = winnerTx ? await verifyTx(winnerTx, cursor1) : null;
    r1.contestedOutpointIsWinnersInput0 = !!cls?.outpoint && r1.verifyWinner?.inputs?.[0] === cls.outpoint;
    log(`  节点核对赢家: ${JSON.stringify(r1.verifyWinner)}；被争输出 = 赢家第 0 个输入: ${r1.contestedOutpointIsWinnersInput0}`);
    // 恢复：放弃 → 导入赢家的最新状态 → 重新买
    await L.page.clickAct('discard');await waitIntentCleared(L.page);
    r1.discardToast = await L.page.toastText();
    log(`  放弃后的提示: ${r1.discardToast}`);
    const TW = await W.page.exportRoundText();
    await L.page.joinText(TW);
    r1.loserSynced = await L.page.waitEnabled('BUY', 120000);
    log(`  输家导入赢家的最新状态后 BUY 可用: ${r1.loserSynced}`);
    if (r1.loserSynced) {
      // Record the first request before any retry; quote wait windows are not additional clicks while a modal is preparing.
      const beforeRebuyLogs=await L.page.logLines(),clickStart=L.page.buyPrepareClicks??0;
      await L.page.prepareBuy();r1.firstClickResponse=await L.page.modalInfo();
      r1.firstClickQuote=!!await L.page.waitQuote(8000);
      r1.beforeRetry={modal:await L.page.modalInfo(),toast:await L.page.toastText(),logs:beforeRebuyLogs.slice(0,10),logsCapturedBeforeRequest:true};
      const seenT = new Set(); let q = null;
      const bq = r1.firstClickQuote ? {quote: await L.page.quoteText(), clicks: 0} : await L.page.buyQuote(5, 8000);
      q = bq?.quote ?? null; r1.clicksToQuoteAfterImport=(L.page.buyPrepareClicks??0)-clickStart;
      const modal=await L.page.modalInfo(),toast = await L.page.toastText(); if (toast) seenT.add(toast.slice(0, 220));
      r1.rebuyDiag = {quote: !!q, toasts: [...seenT], modal, logs: beforeRebuyLogs.slice(0,10), logsCapturedBeforeRequest:true, actions: (await L.page.actions()).map(a => a.act + (a.dis ? '(disabled)' : '')).slice(0, 14), notices: await notices(L.page)};
      await L.page.shot(RUN, 'r1-rebuy');
      log(`  输家备好报价: ${!!q}；提示 ${JSON.stringify(r1.rebuyDiag.toasts)}；弹窗 ${JSON.stringify(modal)}`);
      if (r1.rebuyDiag.logs) log(`  输家页面日志: ${JSON.stringify(r1.rebuyDiag.logs.slice(0, 5))}`);
      if (q || await L.page.waitQuote(60000)) {
        await L.page.clickSend(); r1.rebuyOutcome = (await L.page.sendResult()).status;
        r1.rebuyTx = newestSubmitted(await L.page.logLines());
        log(`  输家重新买: ${r1.rebuyOutcome}，交易 ${r1.rebuyTx?.slice(0, 12)}…`);
      }
    }
    r1.verifyLoserRejected = lIntent?.txid ? await verifyTx(lIntent.txid, cursor1) : null;
    r1.verifyRebuy=r1.rebuyTx?await verifyTx(r1.rebuyTx,cursor1):null;
    r1.rebuyExtendsWinner=!!winnerTx&&r1.verifyRebuy?.inputs?.[0]===`${winnerTx}:0`;
    log(`  被拒的那笔交易的节点核对: ${JSON.stringify(r1.verifyLoserRejected)}`);
    save();

    const r2on = PHASES.includes('r2');
    // ---------- R2：过期报价 ----------
    if (r2on) {
    log('\n=== R2：两页都备好报价；一方先发并被确认，另一方再用旧报价发送 ===');
    const r2 = result.r2 = {};
    const T2 = await L.page.exportRoundText();     // 输家重新买之后，它的状态是最新的
    await W.page.joinText(T2);
    r2.wSynced = await W.page.waitEnabled('BUY', 120000);
    log(`  赢家页面同步到最新状态: ${r2.wSynced}`);
    if (!r2.wSynced) throw new Error('R2 同步失败');
    r2.quotesLogBaseline=await W.page.logLines();
    const [ql_, qw_] = await settledAll([L.page.buyQuote(), W.page.buyQuote()]);
    const ql = ql_?.quote, qw = qw_?.quote; r2.clicksToQuote = {first: ql_?.clicks ?? null, stale: qw_?.clicks ?? null};
    r2.quotesReady = {first: !!ql, stale: !!qw};
    log(`  两页报价就绪: 先发=${!!ql} 后发（将过期）=${!!qw}`);
    if (!ql || !qw) throw new Error('R2 报价未就绪');
    const cursor2=await stableCursor();r2.firstQuoteTxid=await quoteId(L.page);r2.staleQuoteTxid=await quoteId(W.page);
    await L.page.clickSend(); r2.firstOutcome = (await L.page.sendResult()).status;
    if(r2.firstOutcome!=='SUBMITTED')throw new Error('R2_FIRST_NOT_SUBMITTED');
    r2.firstTx=r2.firstQuoteTxid;
    for (let i = 0; i < 150 && r2.firstTx && await mempoolEntry(rpc, r2.firstTx); i++) await sleep(200);   // Wait for pool departure, then independently require selected-chain acceptance.
    await sleep(3000);
    r2.firstVerified = r2.firstTx ? await verifyTx(r2.firstTx, cursor2) : null;
    for(let n=0;n<60&&!r2.firstVerified?.accepted;n++){await sleep(500);r2.firstVerified=r2.firstTx?await verifyTx(r2.firstTx,cursor2):null;}
    if(!r2.firstVerified?.accepted)throw new Error('R2_FIRST_TRANSACTION_NOT_ACCEPTED');
    log(`  先发的一方: ${r2.firstOutcome}，交易 ${r2.firstTx?.slice(0, 12)}… 接受=${r2.firstVerified?.accepted}；另一方现在用旧报价发送`);
    const staleFramesBefore=W.frames.filter(e=>e.kind==='submit').length,staleLogsBefore=new Set(r2.quotesLogBaseline);
    await W.page.clickSend();
    const sres = await W.page.sendResult(); r2.staleSend = sres.status; const seen = new Set(sres.toasts);
    await W.page.p.waitForTimeout(1500);
    r2.staleToasts = [...seen].map(s => s.slice(0, 200));
    r2.stalePanels = (await notices(W.page)).map(s => s.slice(0, 300));
    r2.staleActions = (await W.page.actions()).map(a => a.act + (a.dis ? '(disabled)' : '')).slice(0, 12);
    r2.staleLogs = (await W.page.logLines()).filter(l => !staleLogsBefore.has(l)&&/拒绝|占用|未发出|提交|STALE|过期/.test(l)).slice(0, 8);
    const wIntent = await W.page.exportRoundText().then(intentOf).catch(() => null);
    if (wIntent) r2.staleIntent = {status: wIntent.status, errorCode: wIntent.errorCode, nodeError: wIntent.nodeError, txid: wIntent.txid};
    log(`  过期一方的提示: ${JSON.stringify(r2.staleToasts)}`);
    log(`  过期一方的面板: ${JSON.stringify(r2.stalePanels)}`);
    log(`  过期一方的意图: ${JSON.stringify(r2.staleIntent)}`);
    r2.staleSubmitFrames=W.frames.filter(e=>e.kind==='submit').length-staleFramesBefore;
    r2.verifyStaleTx=await verifyTx(r2.staleQuoteTxid,cursor2);log(`  旧报价 txid 节点核对: ${JSON.stringify(r2.verifyStaleTx)}；实际 submit 帧 ${r2.staleSubmitFrames}`);
    if (await W.page.enabled('discard')) { await W.page.clickAct('discard'); await waitIntentCleared(W.page); r2.discardToast = await W.page.toastText(); log(`  放弃后: ${r2.discardToast}`); }
    r2.intentCleared=!(await waitIntentCleared(W.page)).intent;
    save();

    }
    // ---------- 收尾：封盘 → 退款 ----------
    log('\n=== 收尾：封盘并退款（卖出张数 < 最低 5 张）===');
    const S = r2on || result.r1.rebuyOutcome === 'SUBMITTED' ? L : W;   // 状态最新的那一页
    const closed = await S.page.close(300000);
    const after = await S.page.actUntilTerminal(['PAY_OLD', 'PAY_SELF', 'REFUND_OLD', 'REFUND_SELF'], 30);
    const st = await S.page.state();
    result.final = {closed, terminal: st.terminal ?? after.terminal, phase: st.phase, fees: st.fees};
    const verified=await finalizedRound(S.page,rpc,{cursor:result.setup.cursor,dir:RUN,log});
    result.final.transactions=verified.evidence.length;result.final.feeSompi=verified.round.fees.toString();result.final.allAccepted=true;
    r1.earlyWinnerVerification=r1.verifyWinner;r1.earlyRebuyVerification=r1.verifyRebuy;
    const winnerEv=verified.evidence.find(x=>x.txid===r1.winnerTx),rebuyEv=verified.evidence.find(x=>x.txid===r1.rebuyTx);
    r1.verifyWinner=winnerEv?{accepted:true,inputs:winnerEv.inputs.map(x=>x.outpoint),depth:winnerEv.depth}:null;
    r1.verifyRebuy=rebuyEv?{accepted:true,inputs:rebuyEv.inputs.map(x=>x.outpoint),depth:rebuyEv.depth}:null;
    r1.contestedOutpointIsWinnersInput0=r1.verifyWinner?.inputs[0]===r1.loser?.classification?.outpoint;
    r1.rebuyExtendsWinner=r1.verifyRebuy?.inputs[0]===`${r1.winnerTx}:0`;
    r1.pass=r1.check.kind==='ROUND_INPUT'&&r1.check.spenderEqualsWinnerTx&&r1.check.contestedInputIsCovenant&&r1.contestedOutpointIsWinnersInput0
      &&r1.check.panelNamesRoundConflict&&r1.check.panelShowsWinnerTx&&r1.check.logNamesCause&&r1.actualSubmitFrames.A===1&&r1.actualSubmitFrames.B===1
      &&r1.verifyWinner?.accepted===true&&r1.verifyLoserRejected?.accepted===false&&r1.verifyLoserRejected?.searchComplete===true&&!r1.verifyLoserRejected?.inMempool
      &&r1.rebuyOutcome==='SUBMITTED'&&r1.verifyRebuy?.accepted===true&&r1.rebuyExtendsWinner&&!!r1.firstClickResponse&&r1.clicksToQuoteAfterImport===1;
    if(result.r2){const r=result.r2;r.pass=r.firstVerified?.accepted===true&&r.firstOutcome==='SUBMITTED'&&r.staleLogs.some(l=>l.includes('STALE_INPUT'))&&r.staleSend==='UNSENT'&&r.staleSubmitFrames===0&&r.verifyStaleTx?.accepted===false&&r.verifyStaleTx?.searchComplete===true&&!r.verifyStaleTx?.inMempool&&r.intentCleared;}
    result.pass=r1.pass&&(!r2on||result.r2?.pass===true)&&verified.round.terminal==='REFUNDED'&&verified.evidence.length===(r2on?6:5);
    log(`  终局: ${result.final.terminal ?? result.final.phase}（CLOSE 已发出=${closed}，累计网络费 ${st.fees ?? '?'} TKAS）`);
    await S.page.shot(RUN, 'final');
  } catch (e) {
    result.pass=false;result.error=String(e.message).slice(0,500);log(`  异常: ${result.error}`);
    try{result.recoverySettlement=await settleAfterFailure(all,result.setup.cursor);}catch(cleanup){result.recoveryError=String(cleanup.code??cleanup.safeCode??cleanup.message).slice(0,400);}
    result.recovery={profiles:all.map(x=>path.join(RUN,`profile-${x.n}`)),cid:result.cid??null};
    for(const x of all)if(!await x.page.p?.locator('#modal[open]').count().catch(()=>false))await x.page.exportRoundText().then(text=>fs.writeFileSync(path.join(RUN,`${x.n}-recovery-round.json`),text,{mode:0o600})).catch(()=>{});
  }
  finally { result.frames=Object.fromEntries(all.map(x=>[x.n,x.frames]));await Promise.all(all.map(x => x.page.close_())); save(); }
}

log(`轮次 UTXO 双花测试：节点 ${NODE} · 页面 ${URL_} · 创建者 creator，买家 b1(A) / b2(B)`);
const t00 = Date.now();
await run();
result.totalSeconds = Math.round((Date.now() - t00) / 1000);
save();
log(`\n完成，用时 ${result.totalSeconds}s，归档: ${RUN}`);
rpc.close?.();
process.exit(result.pass?0:1);
