// 同一个钱包、两个页面（两份独立的浏览器 profile）操作同一钱包时的双花冲突测试。真实页面、真实 Testnet 10 节点、真实交易。
//
// 背景（tests/redteam/ROLLING-WEB-TEST.md §16）：两个页面各自只记得自己占用了哪些输入，选中同一个资金 UTXO，节点回
//   "output (txid, i) already spent by transaction … in the mempool"。页面既没有避开，也没有识别这类拒绝。
// 页面现在做两件事（docs/rolling/VALIDATION.md「双花冲突识别」）：选资金时排除内存池已花费的输出；被拒时按节点原文分类并给出具体说明。
//
// 阶段 1（真实冲突）：两页各自先备好 GENESIS 报价（此时都选中同一个 UTXO），然后同一时刻点“发送”。
//   期望：节点收一笔、拒一笔；输家页面识别为“钱包资金被占用”并指出占用方交易（应等于赢家的 txid）；放弃后能重新创建；
//   节点侧只读核对：赢家的交易被接受，输家被拒绝的那笔既未被接受也不在内存池。
// 阶段 2（预防）：A 发送，在节点应答 submitTransaction 的瞬间让 B 去准备交易。期望 B 看到内存池里 A 的占用，拒绝选用那笔资金
//   （WALLET_FUNDS_PENDING 提示）。交易在内存池里停留很短，这个窗口可能抓不到：结果如实记录（PENDING / QUOTE / NONE），并同时测量停留时间。
//
// 全部轮次最后都用 CLOSE 走到 EMPTY，退回保证金。花费仅限 creator 专用测试钱包的网络费（每笔约 0.01 TKAS）。
// 用法：node tests/web/double-spend.mjs [--node=wss://…] [--phases=1,2] [--attempts=3]
import fs from 'node:fs';
import path from 'node:path';
import {RollingPage, walletAddress} from './harness.mjs';
import {acquireWalletLock} from './lock.mjs';
import {connectTN10} from '../../scripts/round/prepare.mjs';
import {searchAccepted, acceptedAt, mempoolEntry} from '../../scripts/chain/chain.mjs';
import {decodeTagged} from '../../scripts/store/codec.mjs';
import {quoteId,finalizedRound} from './evidence.mjs';
import {classifyRejection} from '../../scripts/tracking/conflict.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const arg = (k, d) => process.argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const URL_ = arg('url', 'https://cd311.cn:888/www/rolling-tn10/');
const NODE = arg('node', 'wss://cd311.cn:888/www/rolling-tn10/node');
const PHASES = arg('phases', '1,2').split(',').map(s => s.trim());
const ATTEMPTS = Number(arg('attempts', '3'));
if(!PHASES.length||PHASES.some(x=>!['1','2','3'].includes(x))||!Number.isSafeInteger(ATTEMPTS)||ATTEMPTS<1||ATTEMPTS>6)throw new Error('DOUBLE_SPEND_ARGUMENTS');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
const ROOT = path.join(HERE, '../output/rolling-runs');
acquireWalletLock(ROOT, 'creator', 'double-spend');
const RUN = path.join(ROOT, `${stamp}-double-spend`);
fs.mkdirSync(RUN, {recursive: true});
const logPath = path.join(RUN, 'run.log');
const log = (...a) => { const line = `${new Date().toISOString().slice(11, 23)} ${a.join(' ')}`; console.log(line); fs.appendFileSync(logPath, line + '\n'); };
const result = {schema: 'KASWIN_ROLLING_DOUBLE_SPEND_1', startedAt: stamp, url: URL_, node: NODE, phase1: null, phase2: [], phase3: null};
const save = () => fs.writeFileSync(path.join(RUN, 'result.json'), JSON.stringify(result, null, 1) + '\n');

// Same one-TKAS price; distinct capacities make the GENESIS transaction bodies different.
const CFG_A = {price: '1', cap: 5, min: 3, minutes: 1};
const CFG_B = {price: '1', cap: 6, min: 3, minutes: 1};

// ---- 只读的节点访问（无密钥、无签名、无提交） ----
const ADDR = walletAddress('creator');
const rpc = await connectTN10([NODE]);
const creatorMempool = async () => {
  const r = await rpc.call('getMempoolEntriesByAddresses', {addresses: [ADDR], includeOrphanPool: true, filterTransactionPool: false});
  return (r?.entries ?? []).flatMap(g => g.sending ?? []).map(e => e.transaction?.verboseData?.transactionId).filter(Boolean);
};
/** 对账起点：链尖（sink）可能被浅层重组掉，沿选中链往回走一段再用。 */
const stableCursor = async (back = 300) => {
  let h = (await rpc.call('getSink')).sink;
  for (let i = 0; i < back; i++) h = (await rpc.call('getBlock', {hash: h, includeTransactions: false})).block.verboseData.selectedParentHash;
  return h;
};
const verifyTx = async (txid, cursor) => {
  const s = await searchAccepted(rpc, txid, cursor);
  const r = {accepted: !!s.accepting, searchComplete: s.complete, inMempool: !!(await mempoolEntry(rpc, txid))};
  if (s.accepting) {   // 被接受的交易花了哪些输出（节点给出的数据）
    const ev = await acceptedAt(rpc, txid, s.accepting);
    r.inputs = ev.tx.inputs.map(i => `${i.previousOutpoint.transactionId}:${i.previousOutpoint.index}`);
  }
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
const loggedTx = lines => lines.map(l => /已提交 ([0-9a-f]{64})/.exec(l)?.[1]).find(Boolean) ?? null;

/** 点“创建”后：弹出报价（QUOTE）、提示资金被占用（PENDING）或都没有（NONE）。 */
async function quoteOrPending(page, ms) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await page.quoteText()) return {kind: 'QUOTE'};
    const toast = await page.toastText();
    if (/钱包里的资金正被另一笔还没确认的交易占用/.test(toast)) return {kind: 'PENDING', toast};
    await page.p.waitForTimeout(150);
  }
  return {kind: 'NONE', toast: await page.toastText()};
}

/** 把这一页的唯一轮次走到终局（EMPTY）：等到可封盘、CLOSE。 */
async function settle(page, label, cursor) {
  if (!await page.waitRoundReady(240000)) { log(`  ${label}: 轮次未就绪`); return null; }
  let closed = false;
  for (let i = 0; i < 4 && !closed; i++) { closed = await page.close(240000); if (!closed) await page.p.waitForTimeout(6000); }
  const after = await page.actUntilTerminal(['PAY_OLD', 'PAY_SELF', 'REFUND_OLD', 'REFUND_SELF'], 20);
  const st = await page.state();
  const term = st.terminal ?? after.terminal;
  log(`  ${label}: 终局 ${term ?? st.phase}`);
  if(term!=='EMPTY')throw new Error(`ROUND_NOT_EMPTY_${label}`);
  const dir=path.join(RUN,label.replace(/\s+/g,'-'));fs.mkdirSync(dir,{recursive:true});
  const verified=await finalizedRound(page,rpc,{cursor,dir,log});
  if(verified.evidence.length!==2)throw new Error('EMPTY_TRANSACTION_COUNT');
  (result.rounds??=[]).push({label,cid:verified.round.cid,terminal:verified.round.terminal,transactions:2,feeSompi:verified.round.fees.toString(),allAccepted:true,dir});
  return term;
}

async function openPair(tag, tapA = null) {
  const trace={A:[],B:[]};
  const mk = (n, tap) => new RollingPage({url:URL_,log:(...a)=>log(`[${n}]`,...a),profileDir:path.join(RUN,`${tag}-${n}`),wsTap:e=>{trace[n].push(e);tap?.(e);}});
  const A = mk('A', tapA), B = mk('B', null);
  await Promise.all([A.open(), B.open()]);
  await A.setNode(NODE); await B.setNode(NODE);
  await A.connect('creator'); await B.connect('creator');
  return {A,B,trace};
}

// ================= 阶段 1 =================
async function phase1() {
  const out = {name: 'concurrent-send'};
  result.phase1 = out;
  const {A,B,trace} = await openPair('p1');
  try {
    await A.fillCreate(CFG_A); await B.fillCreate(CFG_B);
    await Promise.all([A.clickCreate(), B.clickCreate()]);
    const [qa, qb] = await Promise.all([A.waitQuote(), B.waitQuote()]);
    out.quotesReady = {A: !!qa, B: !!qb};
    log(`  两页报价就绪: A=${!!qa} B=${!!qb}`);
    if (!qa || !qb) throw new Error('报价未就绪');
    const cursor = await stableCursor();
    out.startSink = cursor;
    const t0 = Date.now();
    const [ca, cb] = await Promise.all([A.clickSend().then(() => Date.now() - t0), B.clickSend().then(() => Date.now() - t0)]);
    out.clickOffsetsMs = {A: ca, B: cb};
    log(`  同时点击发送（点击时间差 ${Math.abs(ca - cb)} ms）`);
    const [oa, ob] = await Promise.all([A.waitSendOutcome(), B.waitSendOutcome()]);
    out.outcome = {A: oa, B: ob};
    log(`  结果: A=${oa} B=${ob}`);
    const loser = oa === 'REJECTED' && ob !== 'REJECTED' ? A : ob === 'REJECTED' && oa !== 'REJECTED' ? B : null;
    if (!loser) { out.note = '没有恰好一方被拒，无法检验冲突识别'; log(`  ${out.note}`); }
    else {
      const winner = loser === A ? B : A;
      out.roles = {loser: loser === A ? 'A' : 'B', winner: winner === A ? 'A' : 'B'};
      // 输家：面板、日志、导出的意图（节点原文）
      const notice = await loser.noticeInfo();
      const lLogs = await loser.logLines(), wLogs = await winner.logLines();
      const intent = await loser.exportRoundText().then(intentOf).catch(e => { out.exportError = String(e.message).slice(0, 120); return null; });
      const winnerTx = loggedTx(wLogs);
      const cls = intent ? classifyRejection({nodeError: intent.nodeError, draft: intent._draft}) : null;
      if (intent) delete intent._draft;
      out.loser = {panel: notice?.text ?? null, panelHashes: notice?.copies ?? [], intent, classification: cls, logs: lLogs.filter(l => /拒绝|占用|已提交/.test(l)).slice(0, 8)};
      out.winnerTx = winnerTx;
      out.check = {
        panelNamesFundsConflict: /钱包里的一笔资金已被另一笔还没确认的交易/.test(notice?.text ?? ''),
        classificationKind: cls?.kind ?? null,
        spenderEqualsWinnerTx: !!winnerTx && cls?.spender === winnerTx,
        panelShowsWinnerTx: !!winnerTx && (notice?.copies ?? []).includes(winnerTx),
        logNamesCause: lLogs.some(l => /资金输入.*占用/.test(l)),
      };
      log(`  输家面板: ${notice?.text?.slice(0, 160) ?? '（无）'}`);
      log(`  节点原文: ${intent?.nodeError ?? '（无）'}`);
      log(`  分类=${cls?.kind} 占用方=${cls?.spender?.slice(0, 12)}… 赢家交易=${winnerTx?.slice(0, 12)}… 相等=${out.check.spenderEqualsWinnerTx}`);
      // 放弃，再重新创建
      await loser.clickAct('discard'); await loser.p.waitForTimeout(700);
      out.discardToast = await loser.toastText();
      log(`  放弃后的提示: ${out.discardToast}`);
      out.retry = [];
      for (let i = 1; i <= 10; i++) {
        await loser.fillCreate(CFG_B);
        const t1 = Date.now(); await loser.clickCreate();
        const r = await quoteOrPending(loser, 15000);
        out.retry.push({try: i, result: r.kind, ms: Date.now() - t1, toast: r.toast?.slice(0, 140) ?? null});
        log(`  重新创建第 ${i} 次: ${r.kind}${r.toast ? ' · ' + r.toast.slice(0, 80) : ''}`);
        if (r.kind === 'QUOTE') { await loser.clickSend(); out.retryOutcome = await loser.waitSendOutcome(); log(`  重新创建发送结果: ${out.retryOutcome}`); break; }
        await loser.p.waitForTimeout(3000);
      }
    }
    // 收尾：两个轮次依次走到 EMPTY
    out.settle = {};
    out.settle[out.roles?.winner ?? 'A'] = await settle(out.roles?.winner === 'B' ? B : A, `阶段1 ${out.roles?.winner ?? 'A'}`,cursor);
    const other = (out.roles?.winner ?? 'A') === 'A' ? 'B' : 'A';
    out.settle[other] = await settle(other === 'A' ? A : B, `阶段1 ${other}`,cursor);
    // 节点侧只读核对
    if (out.winnerTx) out.verifyWinner = await verifyTx(out.winnerTx, cursor);
    if (out.loser?.intent?.txid) out.verifyLoserRejected = await verifyTx(out.loser.intent.txid, cursor);
    log(`  节点核对: 赢家 ${JSON.stringify(out.verifyWinner)} · 被拒的那笔 ${JSON.stringify(out.verifyLoserRejected)}`);
    const c=out.check,l=out.verifyLoserRejected;
    out.pass=c?.classificationKind==='FUNDS_INPUT'&&c.panelNamesFundsConflict&&c.spenderEqualsWinnerTx&&c.panelShowsWinnerTx&&c.logNamesCause
      &&out.verifyWinner?.accepted===true&&l?.accepted===false&&l.searchComplete===true&&!l.inMempool&&out.retryOutcome==='OK'&&Object.values(out.settle).every(t=>t==='EMPTY');
  } catch (e) { out.pass=false;out.error = String(e.message).slice(0, 300); log(`  阶段 1 异常: ${out.error}`); }
  finally { out.frames=trace;await A.close_(); await B.close_(); save(); }
  return out;
}

// ================= 阶段 2 =================
async function phase2Attempt(n) {
  const out = {attempt: n};
  result.phase2.push(out);
  const tap = {replyAt: null, submitAt: null, replyError: null, onReply: null};
  const replied = new Promise(res => { tap.onReply = res; });
  const {A,B,trace} = await openPair(`p2-${n}`, e => {
    if (e.kind === 'submit') tap.submitAt = e.at; else { tap.replyAt = e.at; tap.replyError = e.error; tap.onReply(); }
  });
  try {
    await B.fillCreate(CFG_B);                       // B 停在创建表单上，只差一次点击
    await A.fillCreate(CFG_A); await A.clickCreate();
    if (!await A.waitQuote()) throw new Error('A 报价未就绪');
    const cursor=await stableCursor();out.aQuoteTxid=await quoteId(A);
    await A.clickSend();
    await Promise.race([replied, sleep(60000)]);
    if (!tap.replyAt) throw new Error('没有观察到 A 的 submitTransaction 应答');
    out.aSubmitToReplyMs = tap.replyAt - tap.submitAt; out.aReplyError = tap.replyError;
    // A 的交易此刻已在内存池：B 马上去准备；同时量它在内存池里停留多久
    const tReply = tap.replyAt;
    let residency = null;
    const poller = (async () => { while (Date.now() - tReply < 12000) { if (!(await creatorMempool()).length) { residency = Date.now() - tReply; return; } await sleep(30); } })();
    // 旧算法（最大的先选，只看已确认输出）此刻会选哪个：与 B 实际用的输入对照，才能区分“排除生效”与“碰巧没撞上”。
    const snapP = rpc.call('getUtxosByAddresses', {addresses: [ADDR]});
    const tClick = Date.now(); await B.clickCreate();
    out.bClickAfterReplyMs = tClick - tReply;
    const big = ((await snapP)?.entries ?? []).filter(e => !e.utxoEntry.covenantId && !e.utxoEntry.isCoinbase)
      .map(e => ({outpoint: `${e.outpoint.transactionId}:${e.outpoint.index}`, v: BigInt(e.utxoEntry.amount)})).sort((x, y) => x.v > y.v ? -1 : x.v < y.v ? 1 : 0);
    out.oldSelectionWouldPick = big.slice(0, 3).map(x => ({outpoint:x.outpoint,tkas:`${x.v/100000000n}.${(x.v%100000000n).toString().padStart(8,'0')}`}));
    const r = await quoteOrPending(B, 20000);
    out.bResult = r.kind; out.bToast = r.toast?.slice(0, 200) ?? null;
    const aAtQuote=out.aQuoteTxid;out.aInMempoolAtBQuote=r.kind==='QUOTE'&&!!aAtQuote&&(await creatorMempool()).includes(aAtQuote);
    await poller;
    out.aTxInMempoolMs = residency;   // 应答后到该钱包的 sending 清空；null = 12 秒内没有清空
    log(`  A 应答后 B 点击间隔 ${out.bClickAfterReplyMs} ms → B: ${r.kind}${r.toast ? ' · ' + r.toast.slice(0, 80) : ''}；A 的交易在内存池停留 ≈ ${residency ?? '>12000'} ms`);
    if (r.kind === 'PENDING') {
      for (let i = 1; i <= 12; i++) {                // 等 A 的交易确认后，B 应能正常创建
        await B.p.waitForTimeout(3000); await B.fillCreate(CFG_B); await B.clickCreate();
        const q = await quoteOrPending(B, 12000); (out.bRetries ??= []).push(q.kind);
        if (q.kind === 'QUOTE') { await B.clickSend(); out.bAfterPending = await B.waitSendOutcome(); break; }
      }
      log(`  B 等待后: ${JSON.stringify(out.bRetries)} → ${out.bAfterPending ?? '（未发送）'}`);
    } else if (r.kind === 'QUOTE') {
      await B.clickSend(); out.bSendOutcome = await B.waitSendOutcome();
      log(`  B 报价后发送: ${out.bSendOutcome}`);
      if (out.bSendOutcome === 'REJECTED') {
        const notice = await B.noticeInfo(); out.bRejectedPanel = notice?.text ?? null;
        const intent = await B.exportRoundText().then(intentOf).catch(() => null); out.bRejectedNodeError = intent?.nodeError ?? null;
        out.bRejectedKind = intent ? classifyRejection({nodeError: intent.nodeError, draft: intent._draft}).kind : null;
        log(`  B 被拒: ${out.bRejectedKind} · ${out.bRejectedNodeError}`);
        await B.clickAct('discard'); await B.p.waitForTimeout(700);
      }
    }
    out.txA = loggedTx(await A.logLines()); out.txB = loggedTx(await B.logLines());   // 此时各页日志里只有 GENESIS 一笔“已提交”
    out.settle = {A: await settle(A, `阶段2#${n} A`,cursor)};
    if (await B.waitRoundReady(20000)) out.settle.B = await settle(B, `阶段2#${n} B`,cursor);
    const {txA, txB} = out;
    out.verifyA = txA ? await verifyTx(txA, cursor).catch(e => ({error: String(e.message).slice(0, 100)})) : null;
    out.verifyB = txB ? await verifyTx(txB, cursor).catch(e => ({error: String(e.message).slice(0, 100)})) : null;
    const ia = out.verifyA?.inputs, ib = out.verifyB?.inputs, top = out.oldSelectionWouldPick?.[0]?.outpoint;
    if (ia && ib) {
      out.check = {aSpendsOldTopPick: ia.includes(top), bSpendsOldTopPick: ib.includes(top), fundingInputsDisjoint: !ia.some(o => ib.includes(o)), aInputs: ia.length, bInputs: ib.length};
      log(`  输入对比: 旧算法首选 ${top?.slice(0, 12)}… · A 用了它=${out.check.aSpendsOldTopPick} · B 用了它=${out.check.bSpendsOldTopPick} · 两笔输入完全不相交=${out.check.fundingInputsDisjoint}（A ${ia.length} 个输入，B ${ib.length} 个）`);
    }
    out.preventionObserved=r.kind==='PENDING'||(out.check?.aSpendsOldTopPick===true&&out.check?.bSpendsOldTopPick===false&&out.aInMempoolAtBQuote===true);
    out.pass=!out.aReplyError&&['QUOTE','PENDING'].includes(r.kind)&&out.verifyA?.accepted===true&&out.verifyB?.accepted===true&&out.check?.fundingInputsDisjoint===true&&out.settle.A==='EMPTY'&&out.settle.B==='EMPTY';
  } catch (e) { out.pass=false;out.error = String(e.message).slice(0, 300); log(`  阶段 2 第 ${n} 次异常: ${out.error}`); }
  finally { out.frames=trace;await A.close_(); await B.close_(); save(); }
  return out;
}

// ================= 阶段 3 =================
// 更常见的双花：标签页 B 的报价是早先备好的；A 先发送并已被确认，B 才点“发送”。此时 B 的输入已被一笔已确认的交易花掉。
async function phase3() {
  const out = {name: 'stale-quote'};
  result.phase3 = out;
  const {A,B,trace} = await openPair('p3');
  try {
    await A.fillCreate(CFG_A); await B.fillCreate(CFG_B);
    await Promise.all([A.clickCreate(), B.clickCreate()]);
    const [qa, qb] = await Promise.all([A.waitQuote(), B.waitQuote()]);
    if (!qa || !qb) throw new Error('报价未就绪');
    const cursor = await stableCursor();out.staleQuoteTxid=await quoteId(B);
    await A.clickSend(); out.aOutcome = await A.waitSendOutcome();
    out.txA = loggedTx(await A.logLines());
    // Wait for pool departure, then independently require selected-chain acceptance before the stale send.
    const t = Date.now(); while (Date.now() - t < 30000 && (await creatorMempool()).length) await sleep(200);
    await sleep(3000);
    out.aVerifiedBeforeB = out.txA ? await verifyTx(out.txA, cursor) : null;
    for(let n=0;n<60&&!out.aVerifiedBeforeB?.accepted;n++){await sleep(500);out.aVerifiedBeforeB=out.txA?await verifyTx(out.txA,cursor):null;}
    if(!out.aVerifiedBeforeB?.accepted)throw new Error('PHASE3_FIRST_TRANSACTION_NOT_ACCEPTED');
    log(`  A: ${out.aOutcome}，交易 ${out.txA?.slice(0, 12)}… 已离开内存池（接受=${out.aVerifiedBeforeB?.accepted}）；B 现在用旧报价发送`);
    const framesBefore=trace.B.filter(e=>e.kind==='submit').length;
    await B.clickSend();
    const seen = new Set(), t1 = Date.now();
    while (Date.now() - t1 < 25000) {            // 收集 B 页面上出现过的提示
      const toast = await B.toastText(); if (toast) seen.add(toast);
      if (/被节点拒绝/.test(await B.text())) break;
      await B.p.waitForTimeout(250);
    }
    out.bToasts = [...seen].map(s => s.slice(0, 200));
    out.bPanel = (await B.noticeInfo())?.text ?? null;
    out.bPageActions = (await B.actions()).map(a => a.act).slice(0, 12);
    out.bLogs = (await B.logLines()).filter(l => /拒绝|占用|未发出|提交|STALE|过期/.test(l)).slice(0, 8);
    const intent = await B.exportRoundText().then(intentOf).catch(() => null);
    if (intent) { out.bIntent = {status: intent.status, errorCode: intent.errorCode, nodeError: intent.nodeError, txid: intent.txid, inputs: intent.inputs}; delete intent._draft; }
    log(`  B 提示: ${JSON.stringify(out.bToasts)}`);
    log(`  B 面板: ${out.bPanel?.slice(0, 200) ?? '（无）'}`);
    log(`  B 意图: ${JSON.stringify(out.bIntent && {status: out.bIntent.status, errorCode: out.bIntent.errorCode, nodeError: out.bIntent.nodeError?.slice(0, 200)})}`);
    // 收尾：B 放弃这笔（若有放弃按钮），A 的轮次走到 EMPTY
    if (await B.enabled('discard')) { await B.clickAct('discard'); await B.p.waitForTimeout(800); out.bDiscardToast = await B.toastText(); log(`  B 放弃后: ${out.bDiscardToast}`); }
    out.staleSubmitFrames=trace.B.filter(e=>e.kind==='submit').length-framesBefore;
    out.settle = {A: await settle(A, '阶段3 A',cursor)};
    out.verifyBTx=await verifyTx(out.staleQuoteTxid,cursor);
    out.bCleared=await B.p.locator('[data-act="discard"]').count()===0;
    out.pass=out.aOutcome==='OK'&&out.aVerifiedBeforeB?.accepted===true&&out.staleSubmitFrames===0&&out.bLogs.some(l=>l.includes('STALE_INPUT'))&&out.bCleared
      &&out.verifyBTx.accepted===false&&out.verifyBTx.searchComplete===true&&!out.verifyBTx.inMempool&&out.settle.A==='EMPTY';
    log(`  B 那笔交易的节点核对: ${JSON.stringify(out.verifyBTx)}`);
  } catch (e) { out.pass=false;out.error = String(e.message).slice(0, 300); log(`  阶段 3 异常: ${out.error}`); }
  finally { out.frames=trace;await A.close_(); await B.close_(); save(); }
  return out;
}

log(`双花测试：节点 ${NODE} · 页面 ${URL_} · 钱包 creator ${ADDR.slice(0, 14)}…${ADDR.slice(-4)} · 阶段 ${PHASES.join(',')}`);
const t00 = Date.now();let healthy=true;
if(PHASES.includes('1')){log('\n=== 阶段 1：两页同时发送（真实冲突）===');healthy=(await phase1()).pass===true;}
if(healthy&&PHASES.includes('2')){
  log('\n=== 阶段 2：A 发送后 B 立即准备（预防）===');
  for(let n=1;n<=ATTEMPTS;n++){
    log(`-- 第 ${n}/${ATTEMPTS} 次`);const o=await phase2Attempt(n);healthy=o.pass===true;
    if(!healthy||o.bResult==='PENDING')break;
  }
}
if(healthy&&PHASES.includes('3')){log('\n=== 阶段 3：B 用早先备好的报价，在 A 被确认之后发送 ===');healthy=(await phase3()).pass===true;}
result.preventionObserved=result.phase2.some(x=>x.preventionObserved===true);
result.pass=healthy&&(!PHASES.includes('2')||result.preventionObserved);
result.finalizedTransactions=(result.rounds??[]).reduce((n,r)=>n+r.transactions,0);
result.finalizedFeeSompi=(result.rounds??[]).reduce((n,r)=>n+BigInt(r.feeSompi),0n).toString();
result.accountingComplete=healthy;
result.totalSeconds = Math.round((Date.now() - t00) / 1000);
save();
log(`\n完成，通过=${result.pass}，用时 ${result.totalSeconds}s，归档: ${RUN}`);
rpc.close?.();
process.exit(result.pass?0:1);
