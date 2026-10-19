// Master scenario runner on live Testnet 10 via the local node + indexer (127.0.0.1).
// Supports running individual scenarios or a list: --scenarios=1,2,3,4
import {launch, User, W, txOf, waitState, waitTerminal, st, IDX, NODE, PAGE, log,
  installInterruptGuard, scanOpenRounds, trackRound, untrackRound} from './harness.mjs';
import {decodeAddress} from '../../scripts/wallet/address.mjs';
import {scenarioParams, scenarioEnabled, CLEANUP, TIMING} from './config.mjs';
import fs from 'node:fs';
import {createRun, finishRun, teeTo} from './run-archive.mjs';

const say = log;

/** Current phase from the chain, so a resumed run skips steps that already happened. */
async function chainPhase(cid) {
  const v = await st(cid).catch(() => null);
  return { phase: v?.phase ?? null, terminal: v?.terminal ?? null, sold: v?.sold ?? null };
}

// ---- budgets: every scenario prints its own elapsed time, and the whole run is bounded so a
// stall surfaces as a clear failure instead of an outer tool timeout.
const budgetArg = process.argv.find(a => a.startsWith('--budget='));
const BUDGET_S = budgetArg ? Number(budgetArg.slice(9)) : 0;   // 0 = no overall cap
const RUN_T0 = Date.now();
const budgetLeft = () => BUDGET_S ? BUDGET_S * 1000 - (Date.now() - RUN_T0) : Infinity;
function checkBudget(where) {
  if (budgetLeft() <= 0) throw Error(`总预算 ${BUDGET_S}s 已用尽（停在 ${where}）`);
}
if (BUDGET_S) say(`总预算 ${BUDGET_S}s（超出即中止并报告）`);

const args = process.argv.slice(2);
const scArg = args.find(a => a.startsWith('--scenarios='));
const resumeArg = args.find(a => a.startsWith('--resume='));
const resumeCid = resumeArg ? resumeArg.slice(9) : null;
const selected = scArg ? scArg.slice(12).split(',').map(Number) : [1, 2, 3, 4, 9];

// Reject scenarios the config marks as not automatable (8: needs a 12h physical DAA wait).
const blocked = selected.filter(n => !scenarioEnabled(n));
if (blocked.length) {
  for (const n of blocked) {
    const P = scenarioParams(n);
    say(`⛔ 场景 ${n}（${P.name}）不可自动执行：${P.reason || '配置已禁用'}`);
  }
  say(`   可执行场景：${Object.keys((await import('./config.mjs')).SCENARIOS).filter(k => scenarioEnabled(Number(k))).join(', ')}`);
  process.exit(2);
}

const RUN = createRun('scenarios', selected.join('-'), {
  scenarios: selected,
  resumeCid: resumeCid || null,
  budgetSec: BUDGET_S || null,
  network: { indexer: IDX, node: NODE, page: PAGE },
});
teeTo(RUN);
say(`本次运行目录: ${RUN.dir}`);
say(`  run.json / run.log / summary.md`);

say('=== 启动场景测试 ===');
say('选中场景:', selected.join(', '));
say('节点:', NODE);
say('索引器:', IDX);

// Interrupted runs leave rounds with their GENESIS already on chain. Make that impossible to miss.
installInterruptGuard();

say('=== 预检：链上未终局轮次 ===');
const preOpen = await scanOpenRounds().catch(e => { say(`  预检失败（不阻塞）: ${String(e.message).slice(0, 60)}`); return []; });
if (!preOpen.length) {
  say('  无未终局轮次 ✅');
} else {
  say(`  ⚠️  发现 ${preOpen.length} 个未终局轮次（可能是上次中断留下的）：`);
  for (const r of preOpen) {
    const ago = Math.round((Date.now() - r.updatedAt) / 1000);
    say(`     ${r.cid}  phase=${r.phase}  value=${(Number(BigInt(r.value || 0)) / 1e8).toFixed(2)} TKAS  ${ago}s 前更新`);
  }
  say('  收尾：node tests/web/cleanup.mjs');
  if (!args.includes('--allow-open')) {
    say('  继续本次测试（如需先清理请 Ctrl-C，然后运行上面的命令）');
    say('  提示：加 --allow-open 可跳过此提示');
  }
}

const browser = await launch();
const user = await new User(browser, 'runner').open();
if (BUDGET_S) user.deadline = RUN_T0 + BUDGET_S * 1000;
say('测试页面已打开并纠正端点配置');

/** Scenario 9 uses two extra sessions: they inherit the same deadline. */
async function newSession(label) {
  const u = await new User(browser, label).open();
  if (BUDGET_S) u.deadline = RUN_T0 + BUDGET_S * 1000;
  return u;
}

const results = [];

// ========================================================
// 场景 1: 空轮退盘 (empty)
// 购买 0 次, 0 票, 封盘后全额退还押金 4 TKAS -> EMPTY
// ========================================================
if (selected.includes(1)) {
  checkBudget('场景 1 开始前');
  say('\n========================================');
  say('★ 场景 1: 空轮退盘 (empty)');
  say('========================================');
  const tSc = Date.now();
  await user.use(W.creator);
  const P = scenarioParams(1);
  const g = await user.createRound(P.cap, P.min, P.minutes);
  const cid = g.cid;
  say(`[S1] ${P.title} cap=${P.cap} min=${P.min} ${P.minutes}min`);
  say(`[S1] GENESIS tx=${g.tx?.slice(0, 16)} ms=${g.ms} CID=${cid}`);
  await user.round(cid);

  say('[S1] 等待 1 分钟封盘时间锁到期并执行封盘...');
  const c = await user.closeRound({
    maxMs: 30_000,
    onWait: daa => say(`  [S1] 等待封盘时间锁: 还差约 ${daa} DAA`)
  });
  say(`[S1] CLOSE tx=${c.tx?.slice(0, 16)} state=${c.state} ms=${c.actionMs}`);

  const s = await waitTerminal(cid, x => x.terminal === 'EMPTY');
  const pass = s?.terminal === 'EMPTY';
  say(`[S1] 终局结果: terminal=${s?.terminal} value=${s?.value} -> ${pass ? '✅ 通过' : '❌ 失败'}`);
  results.push({scenario: 1, name: 'empty', cid, genesis: g.tx, close: c.tx, state: s, pass, elapsed: Math.round((Date.now() - tSc) / 1000)});
  untrackRound(cid);
}

// ========================================================
// 场景 2: 单笔多票不足额退款 (refund-2ticket)
// 购买 1 次 (单笔 2 张), 总票数 2 < 3 门槛, 封盘转退款, 退还 1.98 + 3.98 -> REFUNDED
// ========================================================
if (selected.includes(2)) {
  checkBudget('场景 2 开始前');
  say('\n========================================');
  say('★ 场景 2: 单笔多票不足额退款 (refund-2ticket)');
  say('========================================');
  const tSc = Date.now();
  await user.use(W.creator);
  const P = scenarioParams(2);
  const g = await user.createRound(P.cap, P.min, P.minutes);
  const cid = g.cid;
  say(`[S2] ${P.title} cap=${P.cap} min=${P.min} ${P.minutes}min`);
  say(`[S2] GENESIS tx=${g.tx?.slice(0, 16)} ms=${g.ms} CID=${cid}`);

  await user.use(W.b1);
  await user.round(cid);
  say('[S2] 买家 1 单笔购买 2 张票...');
  const b = await user.buy(2);
  say(`[S2] BUY(2) tx=${b.tx?.slice(0, 16)} state=${b.state} ms=${b.ms}`);

  await user.use(W.creator);
  await user.round(cid);
  say('[S2] 等待 1 分钟封盘时间锁到期并执行封盘 (2票 < 3票门槛 -> 转退款)...');
  const c = await user.closeRound({
    maxMs: 30_000,
    onWait: daa => say(`  [S2] 等待封盘时间锁: 还差约 ${daa} DAA`)
  });
  say(`[S2] CLOSE tx=${c.tx?.slice(0, 16)} state=${c.state} ms=${c.actionMs}`);

  await user.round(cid);
  say('[S2] 执行退款批次...');
  const r = await user.refund();
  say(`[S2] REFUND tx=${r.tx?.slice(0, 16)} state=${r.state} ms=${r.ms}`);

  const s = await waitTerminal(cid, x => x.terminal === 'REFUNDED');
  const pass = s?.terminal === 'REFUNDED';
  say(`[S2] 终局结果: terminal=${s?.terminal} value=${s?.value} -> ${pass ? '✅ 通过' : '❌ 失败'}`);
  results.push({scenario: 2, name: 'refund-2ticket', cid, genesis: g.tx, buy: b.tx, close: c.tx, refund: r.tx, state: s, pass, elapsed: Math.round((Date.now() - tSc) / 1000)});
  untrackRound(cid);
}

// ========================================================
// 场景 3: 标准开奖派奖 (payout)
// 购买 2 次 (b1买2, b2买1), 总票数 3 (=门槛3), 封盘封存, 100 DAA开奖 -> PAID
// ========================================================
if (selected.includes(3)) {
  checkBudget('场景 3 开始前');
  say('\n========================================');
  say('★ 场景 3: 标准开奖派奖 (payout)');
  say('========================================');
  const tSc = Date.now();
  await user.use(W.creator);
  const P = scenarioParams(3);
  const g = await user.createRound(P.cap, P.min, P.minutes);
  const cid = g.cid;
  say(`[S3] ${P.title} cap=${P.cap} min=${P.min} ${P.minutes}min`);
  say(`[S3] GENESIS tx=${g.tx?.slice(0, 16)} ms=${g.ms} CID=${cid}`);

  await user.use(W.b1);
  await user.round(cid);
  say('[S3] 买家 1 购买 2 张票...');
  const b1 = await user.buy(2);
  say(`[S3] BUY(2) tx=${b1.tx?.slice(0, 16)} state=${b1.state} ms=${b1.ms}`);

  await user.use(W.b2);
  await user.round(cid);
  say('[S3] 买家 2 购买 1 张票...');
  const b2 = await user.buy(1);
  say(`[S3] BUY(1) tx=${b2.tx?.slice(0, 16)} state=${b2.state} ms=${b2.ms}`);

  await user.use(W.creator);
  await user.round(cid);
  say('[S3] 等待 1 分钟封盘时间锁到期并执行封盘 (3票 >= 3票门槛 -> 封存)...');
  const c = await user.closeRound({
    maxMs: 30_000,
    onWait: daa => say(`  [S3] 等待封盘时间锁: 还差约 ${daa} DAA`)
  });
  say(`[S3] CLOSE tx=${c.tx?.slice(0, 16)} state=${c.state} ms=${c.actionMs}`);

  await user.round(cid);
  say('[S3] 执行开奖 (等待 100 DAA + 100 blueScore 目标确认)...');
  const d = await user.draw({
    roundCid: cid,
    onWait: daa => say(`  [S3] 等待开奖 100 DAA: 还差 ${daa}`)
  });
  say(`[S3] DRAW tx=${d.tx?.slice(0, 16)} state=${d.state} ms=${d.ms}`);

  const s = await waitTerminal(cid, x => x.terminal === 'PAID');
  const pass = s?.terminal === 'PAID';
  say(`[S3] 终局结果: terminal=${s?.terminal} value=${s?.value} -> ${pass ? '✅ 通过' : '❌ 失败'}`);
  results.push({scenario: 3, name: 'payout', cid, genesis: g.tx, buy1: b1.tx, buy2: b2.tx, close: c.tx, draw: d.tx, state: s, pass, elapsed: Math.round((Date.now() - tSc) / 1000)});
  untrackRound(cid);
}

// ========================================================
// 场景 4: 临界卖满开奖 (A4)
// 购买 5 次各1票, 上限5票, 卖满立即封盘 (无需等时间), 100 DAA开奖 -> PAID
// ========================================================
if (selected.includes(4)) {
  checkBudget('场景 4 开始前');
  say('\n========================================');
  say('★ 场景 4: 临界卖满开奖 (A4)');
  say('========================================');
  const tSc = Date.now();
  await user.use(W.creator);
  const P = scenarioParams(4);
  const g = await user.createRound(P.cap, P.min, P.minutes);
  const cid = g.cid;
  say(`[S4] ${P.title} cap=${P.cap} min=${P.min} ${P.minutes}min`);
  say(`[S4] GENESIS tx=${g.tx?.slice(0, 16)} ms=${g.ms} CID=${cid}`);

  const buys = [];
  const plan4 = P.buy.length ? P.buy : Array.from({length: P.cap}, (_, i) => ({who: i % 2 === 0 ? 'b1' : 'b2', qty: 1}));
  for (let i = 0; i < plan4.length; i++) {
    const who = plan4[i].who;
    await user.use(W[who]);
    await user.round(cid);
    say(`[S4] 买家 ${who} 购买第 ${i + 1} 张票...`);
    const b = await user.buy(1);
    buys.push(b.tx);
    say(`  [S4] BUY #${i + 1} tx=${b.tx?.slice(0, 16)} state=${b.state} ms=${b.ms}`);
  }

  await user.use(W.creator);
  await user.round(cid);
  say('[S4] 卖满 5 票立即封盘 (验证 lockTime=0 免等时间)...');
  const c = await user.closeRound();
  say(`[S4] CLOSE tx=${c.tx?.slice(0, 16)} state=${c.state} ms=${c.actionMs}`);

  await user.round(cid);
  say('[S4] 执行开奖 (等待 100 DAA + 100 blueScore 目标确认)...');
  const d = await user.draw({
    roundCid: cid,
    onWait: daa => say(`  [S4] 等待开奖 100 DAA: 还差 ${daa}`)
  });
  say(`[S4] DRAW tx=${d.tx?.slice(0, 16)} state=${d.state} ms=${d.ms}`);

  const s = await waitTerminal(cid, x => x.terminal === 'PAID');
  const pass = s?.terminal === 'PAID';
  say(`[S4] 终局结果: terminal=${s?.terminal} value=${s?.value} -> ${pass ? '✅ 通过' : '❌ 失败'}`);
  results.push({scenario: 4, name: 'A4', cid, genesis: g.tx, buys, close: c.tx, draw: d.tx, state: s, pass, elapsed: Math.round((Date.now() - tSc) / 1000)});
  untrackRound(cid);
}


// ========================================================
// 场景 9: 多用户并发竞争 (concurrent-race)
// 购买 33 票并发抢购, 同时封盘 (1胜1负), 同时开奖 (1胜1负) -> PAID
// ========================================================
if (selected.includes(9)) {
  checkBudget('场景 9 开始前');
  say('\n========================================');
  say('★ 场景 9: 多用户并发竞争 (concurrent-race)');
  say('========================================');
  const tSc = Date.now();
  await user.use(W.creator);
  const P = scenarioParams(9);
  const CAP = P.cap;
  const g = await user.createRound(CAP, P.min, P.minutes);
  const cid = g.cid;
  say(`[S9] GENESIS tx=${g.tx?.slice(0, 16)} ms=${g.ms} CID=${cid}`);

  say('[S9] 打开两个买家并发会话...');
  const uB1 = await newSession('b1');
  const uB2 = await newSession('b2');
  await uB1.use(W.b1);
  await uB2.use(W.b2);
  await uB1.round(cid);
  await uB2.round(cid);

  const buyStats = {b1: {ok: 0, lost: 0, fail: 0}, b2: {ok: 0, lost: 0, fail: 0}};
  let lastSold = 0;
  const deadline = Date.now() + 180_000;

  async function buyLoop(u, who) {
    let n = 0;
    while (Date.now() < deadline && n++ < 200) {
      const f = await u.figures().catch(() => null);
      if (!f) { await u.waitUsable(8000).catch(() => {}); continue; }
      if (f.sold != null && f.sold >= CAP) return 'SOLD_OUT';
      if (/已派奖|空轮|全部购买记录已退款|已封存/.test(f.phase)) return 'CLOSED';
      try {
        const r = await u.buy(1);
        if (r.ok) {
          buyStats[who].ok++;
          const f2 = await u.figures().catch(() => null);
          const curSold = f2?.sold ?? lastSold + 1;
          if (curSold !== lastSold) { lastSold = curSold; say(`  [S9] sold=${curSold}/${CAP} (${who}, ${r.ms}ms)`); }
        } else {
          buyStats[who].lost++;
        }
      } catch (e) {
        buyStats[who].fail++;
        u.roundCid = null;
        await u.round(cid).catch(() => {});
        await u.waitUsable(10_000).catch(() => {});
      }
    }
    return 'DONE';
  }

  say('[S9] 开始并发购票至 33 票售罄...');
  await Promise.all([buyLoop(uB1, 'b1'), buyLoop(uB2, 'b2')]);
  say(`[S9] 前端购票统计: b1=${buyStats.b1.ok}成功/${buyStats.b1.lost}未生效  b2=${buyStats.b2.ok}成功/${buyStats.b2.lost}未生效`);

  // 链上精确购票归属
  const b1Key = Buffer.from(decodeAddress(W.b1.address).payload).toString('hex');
  const b2Key = Buffer.from(decodeAddress(W.b2.address).payload).toString('hex');
  let onChainAttribution = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const it = (await fetch(`${IDX}/v1/rounds/${cid}`).then(x => x.json())).item;
      if (it && it.purchases && it.purchases.length >= CAP) {
        let b1Sold = 0, b2Sold = 0;
        for (const p of it.purchases) {
          if (p.key === b1Key) b1Sold += p.count;
          else if (p.key === b2Key) b2Sold += p.count;
        }
        onChainAttribution = {b1: b1Sold, b2: b2Sold, total: b1Sold + b2Sold};
        break;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  if (onChainAttribution) {
    say(`★ [S9] 链上精确购票归属: b1=${onChainAttribution.b1}张  b2=${onChainAttribution.b2}张  总计=${onChainAttribution.total}/${CAP}`);
  }

  say('[S9] === 同时封盘 ===');
  const [c1, c2] = await Promise.all([
    uB1.closeRound().catch(e => ({error: e.message, state: '异常'})),
    uB2.closeRound().catch(e => ({error: e.message, state: '异常'}))
  ]);
  const cSuccess = c1.ok ? 'b1' : (c2.ok ? 'b2' : 'none');
  say(`[S9] 封盘竞争结果: b1=${c1.state || c1.error?.slice(0, 30)} (${c1.actionMs}ms), b2=${c2.state || c2.error?.slice(0, 30)} (${c2.actionMs}ms) -> 胜者: ${cSuccess}`);

  say('[S9] === 同时开奖 ===');
  const [d1, d2] = await Promise.all([
    uB1.draw({roundCid: cid, onWait: daa => say(`  [S9] b1 等待开奖 100 DAA: 还差 ${daa}`)}).catch(e => ({error: e.message, state: '异常'})),
    uB2.draw({roundCid: cid, onWait: daa => say(`  [S9] b2 等待开奖 100 DAA: 还差 ${daa}`)}).catch(e => ({error: e.message, state: '异常'}))
  ]);
  const dSuccess = d1.ok ? 'b1' : (d2.ok ? 'b2' : 'none');
  say(`[S9] 开奖竞争结果: b1=${d1.state || d1.error?.slice(0, 30)} (${d1.ms}ms), b2=${d2.state || d2.error?.slice(0, 30)} (${d2.ms}ms) -> 胜者: ${dSuccess}`);

  const s = await waitTerminal(cid, x => x.terminal === 'PAID');
  const pass = s?.terminal === 'PAID';
  say(`[S9] 终局结果: terminal=${s?.terminal} value=${s?.value} -> ${pass ? '✅ 通过' : '❌ 失败'}`);

  await uB1.dispose();
  await uB2.dispose();
  results.push({scenario: 9, name: 'concurrent-race', cid, genesis: g.tx, buyStats, onChainAttribution, closeWinner: cSuccess, drawWinner: dSuccess, state: s, pass, elapsed: Math.round((Date.now() - tSc) / 1000)});
  untrackRound(cid);
}


// ========================================================
// 场景 5: 225 笔多批退款 (R225)
// 购买 225 次各1票, 最低300票, 封盘转退款, 8 批退款 -> REFUNDED
// ========================================================
if (selected.includes(5)) {
  checkBudget('场景 5 开始前');
  say('\n========================================');
  say('★ 场景 5: 225 笔多批退款 (R225)');
  say('========================================');
  const tSc = Date.now();
  await user.use(W.creator);
  const P = scenarioParams(5);
  const CAP = P.cap, MIN = P.min, N = P.buys;
  let cid = resumeCid;
  let gTx = null;
  let startSold = 0;
  if (!cid) {
    const g = await user.createRound(CAP, MIN, P.minutes);
    cid = g.cid;
    gTx = g.tx;
    say(`[S5] GENESIS tx=${g.tx?.slice(0, 16)} ms=${g.ms} CID=${cid}`);
  } else {
    const cur = await st(cid);
    startSold = cur?.sold ?? 0;
    say(`[S5] 断点续跑 CID=${cid}, 当前 sold=${startSold}/${N}`);
  }

  say(`[S5] 交替执行购票至 ${N} 票 (从第 ${startSold + 1} 票开始)...`);
  // Drive by the authoritative on-chain `sold`, never by a loop index: a retry or a
  // concurrent buy can make the index and the real ticket count diverge, which is how a
  // sold-out round used to be retried five times and abort the whole scenario.
  let sold = startSold;
  let guard = 0;
  while (sold < N) {
    if (++guard > N * 2) throw new Error(`[S5] 购票循环超出上限（sold=${sold}/${N}）`);
    const cur = await st(cid).catch(() => null);
    const onChain = cur?.sold ?? sold;
    if (onChain >= N) { say(`  [S5] 链上已达 ${onChain}/${N} 票，停止购票`); sold = onChain; break; }
    sold = onChain;
    let ok = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await user.use(sold % 2 === 0 ? W.b1 : W.b2);
        await user.round(cid);
        const r = await user.buy(1);
        if (r.ok) {
          ok = true;
          sold = Math.max(sold + 1, (await st(cid).catch(() => null))?.sold ?? sold + 1);
          say(`  [S5] 购票 ${sold}/${N} (tx=${r.tx?.slice(0, 12)}, ${r.ms}ms, 剩余预算 ${budgetLeft()===Infinity?'∞':Math.round(budgetLeft()/1000)+'s'})`);
          break;
        }
      } catch (e) {
        const msg = String(e.message);
        // Terminal for BUY: tickets sold out, OR the purchase-record cap reached (purchaseCap),
        // OR the action button is gone. None of these is retryable.
        if (/售罄|SOLD_OUT|票已售完|购买记录已满|记录已满|purchaseCap/.test(msg)) {
          say(`  [S5] 已到购买上限（${msg.slice(0, 40)}），停止购票`);
          sold = N; ok = true; break;
        }
        say(`  [S5] 购票重试 (${attempt + 1}/5): ${msg.slice(0, 70)}`);
        await user.page.waitForTimeout(1500);
      }
    }
    if (!ok) throw new Error(`[S5] 购票 5 次重试均失败（sold=${sold}/${N}）`);
  }
  say(`  [S5] 购票阶段完成: sold=${sold}/${N}`);

  await user.use(W.creator);
  await user.round(cid);
  const prePhase = await chainPhase(cid);
  let c = { tx: null, state: '(已封存，跳过)', actionMs: 0 };
  if (prePhase.phase === 1) {
    say('[S5] 等待 1 分钟封盘时间锁到期并执行封盘 (225 < 300 -> 转退款)...');
    c = await user.closeRound({
      maxMs: 30_000,
      onWait: daa => say(`  [S5] 等待封盘时间锁: 还差约 ${daa} DAA`)
    });
    say(`[S5] CLOSE tx=${c.tx?.slice(0, 16)} state=${c.state} ms=${c.actionMs}`);
  } else {
    say(`[S5] 链上 phase=${prePhase.phase}，已过售票阶段，跳过封盘`);
  }

  say(`[S5] 执行 ${P.refundBatches} 批退款...`);
  const refTxs = [];
  for (let b = 1; b <= P.refundBatches; b++) {
    await user.use(b % 2 === 1 ? W.b1 : W.b2);
    await user.round(cid);
    const r = await user.refund();
    refTxs.push(r.tx);
    say(`  [S5] REFUND 批次 ${b}/${P.refundBatches}: tx=${r.tx?.slice(0, 12)} state=${r.state} ms=${r.ms}`);
  }

  const s = await waitTerminal(cid, x => x.terminal === 'REFUNDED');
  const pass = s?.terminal === 'REFUNDED';
  say(`[S5] 终局结果: terminal=${s?.terminal} value=${s?.value} -> ${pass ? '✅ 通过' : '❌ 失败'}`);
  results.push({scenario: 5, name: 'R225', cid, genesis: gTx, close: c.tx, refunds: refTxs, state: s, pass, elapsed: Math.round((Date.now() - tSc) / 1000)});
  untrackRound(cid);
}

// ========================================================
// 场景 6: 买满 256 笔派奖 (P256)
// 购买 256 次各1票, 上限256票, 卖满立即封盘 (lockTime=0), 100 DAA开奖 -> PAID
// ========================================================
if (selected.includes(6)) {
  checkBudget('场景 6 开始前');
  say('\n========================================');
  say('★ 场景 6: 买满 256 笔派奖 (P256)');
  say('========================================');
  const tSc = Date.now();
  await user.use(W.creator);
  const P = scenarioParams(6);
  const CAP = P.cap, MIN = P.min, N = P.buys;
  let cid = resumeCid;
  let gTx = null;
  let startSold = 0;
  if (!cid) {
    const g = await user.createRound(CAP, MIN, P.minutes);
    cid = g.cid;
    gTx = g.tx;
    say(`[S6] GENESIS tx=${g.tx?.slice(0, 16)} ms=${g.ms} CID=${cid}`);
  } else {
    const cur = await st(cid);
    startSold = cur?.sold ?? 0;
    say(`[S6] 断点续跑 CID=${cid}, 当前 sold=${startSold}/${N}`);
  }

  say(`[S6] 交替执行 ${N} 笔购票至卖满...`);
  // Drive by the authoritative on-chain `sold`, never by a loop index: a retry or a
  // concurrent buy can make the index and the real ticket count diverge, which is how a
  // sold-out round used to be retried five times and abort the whole scenario.
  let sold = startSold;
  let guard = 0;
  while (sold < N) {
    if (++guard > N * 2) throw new Error(`[S6] 购票循环超出上限（sold=${sold}/${N}）`);
    const cur = await st(cid).catch(() => null);
    const onChain = cur?.sold ?? sold;
    if (onChain >= N) { say(`  [S6] 链上已达 ${onChain}/${N} 票，停止购票`); sold = onChain; break; }
    sold = onChain;
    let ok = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await user.use(sold % 2 === 0 ? W.b1 : W.b2);
        await user.round(cid);
        const r = await user.buy(1);
        if (r.ok) {
          ok = true;
          sold = Math.max(sold + 1, (await st(cid).catch(() => null))?.sold ?? sold + 1);
          say(`  [S6] 购票 ${sold}/${N} (tx=${r.tx?.slice(0, 12)}, ${r.ms}ms, 剩余预算 ${budgetLeft()===Infinity?'∞':Math.round(budgetLeft()/1000)+'s'})`);
          break;
        }
      } catch (e) {
        const msg = String(e.message);
        // Terminal for BUY: tickets sold out, OR the purchase-record cap reached (purchaseCap),
        // OR the action button is gone. None of these is retryable.
        if (/售罄|SOLD_OUT|票已售完|购买记录已满|记录已满|purchaseCap/.test(msg)) {
          say(`  [S6] 已到购买上限（${msg.slice(0, 40)}），停止购票`);
          sold = N; ok = true; break;
        }
        say(`  [S6] 购票重试 (${attempt + 1}/5): ${msg.slice(0, 70)}`);
        await user.page.waitForTimeout(1500);
      }
    }
    if (!ok) throw new Error(`[S6] 购票 5 次重试均失败（sold=${sold}/${N}）`);
  }
  say(`  [S6] 购票阶段完成: sold=${sold}/${N}`);

  await user.use(W.creator);
  await user.round(cid);
  const prePhase = await chainPhase(cid);
  let c = { tx: null, state: '(已封存，跳过)', actionMs: 0 };
  if (prePhase.phase === 1) {
    say('[S6] 卖满 256 票立即封盘 (验证 lockTime=0 免等时间)...');
    c = await user.closeRound({
      maxMs: 30_000,
      onWait: daa => say(`  [S6] 等待封盘时间锁: 还差约 ${daa} DAA`)
    });
    say(`[S6] CLOSE tx=${c.tx?.slice(0, 16)} state=${c.state} ms=${c.actionMs}`);
  } else {
    say(`[S6] 链上 phase=${prePhase.phase}，已过售票阶段，跳过封盘`);
  }

  await user.round(cid);
  say('[S6] 执行开奖 (等待 100 DAA + 100 blueScore 目标确认)...');
  const d = await user.draw({
    roundCid: cid,
    onWait: daa => say(`  [S6] 等待开奖 100 DAA: 还差 ${daa}`)
  });
  say(`[S6] DRAW tx=${d.tx?.slice(0, 16)} state=${d.state} ms=${d.ms}`);

  const s = await waitTerminal(cid, x => x.terminal === 'PAID');
  const pass = s?.terminal === 'PAID';
  say(`[S6] 终局结果: terminal=${s?.terminal} value=${s?.value} -> ${pass ? '✅ 通过' : '❌ 失败'}`);
  results.push({scenario: 6, name: 'P256', cid, genesis: gTx, close: c.tx, draw: d.tx, state: s, pass, elapsed: Math.round((Date.now() - tSc) / 1000)});
  untrackRound(cid);
}

// ========================================================
// 场景 7: 买满 256 笔退款 (R256)
// 购买 256 次各1票, 最低300票, 封盘转退款, 8 批退款 -> REFUNDED
// ========================================================
if (selected.includes(7)) {
  checkBudget('场景 7 开始前');
  say('\n========================================');
  say('★ 场景 7: 买满 256 笔退款 (R256)');
  say('========================================');
  const tSc = Date.now();
  await user.use(W.creator);
  const P = scenarioParams(7);
  const CAP = P.cap, MIN = P.min, N = P.buys;
  let cid = resumeCid;
  let gTx = null;
  let startSold = 0;
  if (!cid) {
    const g = await user.createRound(CAP, MIN, P.minutes);
    cid = g.cid;
    gTx = g.tx;
    say(`[S7] GENESIS tx=${g.tx?.slice(0, 16)} ms=${g.ms} CID=${cid}`);
  } else {
    const cur = await st(cid);
    startSold = cur?.sold ?? 0;
    say(`[S7] 断点续跑 CID=${cid}, 当前 sold=${startSold}/${N}`);
  }

  say(`[S7] 交替执行购票至 ${N} 票 (从第 ${startSold + 1} 票开始)...`);
  // Drive by the authoritative on-chain `sold`, never by a loop index: a retry or a
  // concurrent buy can make the index and the real ticket count diverge, which is how a
  // sold-out round used to be retried five times and abort the whole scenario.
  let sold = startSold;
  let guard = 0;
  while (sold < N) {
    if (++guard > N * 2) throw new Error(`[S7] 购票循环超出上限（sold=${sold}/${N}）`);
    const cur = await st(cid).catch(() => null);
    const onChain = cur?.sold ?? sold;
    if (onChain >= N) { say(`  [S7] 链上已达 ${onChain}/${N} 票，停止购票`); sold = onChain; break; }
    sold = onChain;
    let ok = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await user.use(sold % 2 === 0 ? W.b1 : W.b2);
        await user.round(cid);
        const r = await user.buy(1);
        if (r.ok) {
          ok = true;
          sold = Math.max(sold + 1, (await st(cid).catch(() => null))?.sold ?? sold + 1);
          say(`  [S7] 购票 ${sold}/${N} (tx=${r.tx?.slice(0, 12)}, ${r.ms}ms, 剩余预算 ${budgetLeft()===Infinity?'∞':Math.round(budgetLeft()/1000)+'s'})`);
          break;
        }
      } catch (e) {
        const msg = String(e.message);
        // Terminal for BUY: tickets sold out, OR the purchase-record cap reached (purchaseCap),
        // OR the action button is gone. None of these is retryable.
        if (/售罄|SOLD_OUT|票已售完|购买记录已满|记录已满|purchaseCap/.test(msg)) {
          say(`  [S7] 已到购买上限（${msg.slice(0, 40)}），停止购票`);
          sold = N; ok = true; break;
        }
        say(`  [S7] 购票重试 (${attempt + 1}/5): ${msg.slice(0, 70)}`);
        await user.page.waitForTimeout(1500);
      }
    }
    if (!ok) throw new Error(`[S7] 购票 5 次重试均失败（sold=${sold}/${N}）`);
  }
  say(`  [S7] 购票阶段完成: sold=${sold}/${N}`);

  await user.use(W.creator);
  await user.round(cid);
  const prePhase = await chainPhase(cid);
  let c = { tx: null, state: '(已封存，跳过)', actionMs: 0 };
  if (prePhase.phase === 1) {
    say('[S7] 等待 1 分钟封盘时间锁到期并执行封盘 (256 < 300 -> 转退款)...');
    c = await user.closeRound({
      maxMs: 30_000,
      onWait: daa => say(`  [S7] 等待封盘时间锁: 还差约 ${daa} DAA`)
    });
    say(`[S7] CLOSE tx=${c.tx?.slice(0, 16)} state=${c.state} ms=${c.actionMs}`);
  } else {
    say(`[S7] 链上 phase=${prePhase.phase}，已过售票阶段，跳过封盘`);
  }

  say(`[S7] 执行 ${P.refundBatches} 批退款...`);
  const refTxs = [];
  for (let b = 1; b <= P.refundBatches; b++) {
    await user.use(b % 2 === 1 ? W.b1 : W.b2);
    await user.round(cid);
    const r = await user.refund();
    refTxs.push(r.tx);
    say(`  [S7] REFUND 批次 ${b}/${P.refundBatches}: tx=${r.tx?.slice(0, 12)} state=${r.state} ms=${r.ms}`);
  }

  const s = await waitTerminal(cid, x => x.terminal === 'REFUNDED');
  const pass = s?.terminal === 'REFUNDED';
  say(`[S7] 终局结果: terminal=${s?.terminal} value=${s?.value} -> ${pass ? '✅ 通过' : '❌ 失败'}`);
  results.push({scenario: 7, name: 'R256', cid, genesis: gTx, close: c.tx, refunds: refTxs, state: s, pass, elapsed: Math.round((Date.now() - tSc) / 1000)});
  untrackRound(cid);
}
await user.dispose();
await browser.close();

say('\n========================================');
say('=== 场景测试汇总 ===');
say('========================================');
for (const r of results) {
  say(`场景 ${r.scenario} [${r.name}]: ${r.pass ? '✅ PASSED' : '❌ FAILED'} (CID: ${r.cid?.slice(0, 16)}..., 耗时: ${r.elapsed}s)`);
}
const counts = finishRun(RUN, {results});
say(`结果: 通过 ${counts.pass} / 失败 ${counts.fail} / 跳过 ${counts.skip}，耗时 ${counts.elapsedSec}s`);
say(`  ${RUN.runFile}`);
say(`  ${RUN.summaryFile}`);
say(`  日志: ${RUN.logFile}`);
