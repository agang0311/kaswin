// 清理未终局轮次（phase 1 售票中 / 2 已封存 / 5 退款中）→ 推进到终局
// 单步 RPC / 等待一律 <= 30s；DAA 时间锁由 closeRound()/draw() 内部按步推进。
//
// 用法:
//   node tests/web/cleanup.mjs              # 处理全部未终局轮次
//   node tests/web/cleanup.mjs --dry        # 只扫描并打印计划，不提交任何交易
//   node tests/web/cleanup.mjs --only=<CID> # 只处理指定 CID（可重复）
//   node tests/web/cleanup.mjs --phases=1   # 只处理指定 phase（逗号分隔）
import fs from 'node:fs';
import {launch, User, W, IDX, CONTRACT_PREFIX, waitTerminal, st, log, withHeartbeat} from './harness.mjs';
import {CLEANUP, TIMING} from './config.mjs';
import {createRun, finishRun, teeTo} from './run-archive.mjs';

const STEP_MS = TIMING.stepMs;
const CLEAN = CLEANUP.cleanup || {};
const MAX_REFUND_BATCHES = CLEAN.maxRefundBatches ?? 12;
const SETTLE_BUDGET_MS = CLEAN.settleBudgetMs ?? 120_000;
const say = log;

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const onlyArg = args.filter(a => a.startsWith('--only=')).map(a => a.slice(7));
const phasesArg = args.find(a => a.startsWith('--phases='));
const PHASES = phasesArg ? phasesArg.slice(9).split(',').map(Number) : (CLEAN.phases || [1, 2, 5]);

const kas = v => (Number(BigInt(v || 0)) / 1e8).toFixed(2);

// ---------------------------------------------------------------- 1) 扫描
const RUN = createRun('cleanup', PHASES.join('-'), { phases: PHASES, dry: DRY });
teeTo(RUN);
say(`本次运行目录: ${RUN.dir}`);
say('=== 扫描未终局轮次 ===');
const list = await fetch(`${IDX}/v1/rounds?limit=200`, {signal: AbortSignal.timeout(STEP_MS)}).then(r => r.json());
const all = (list.items || []).filter(i =>
  (i.contract || '').startsWith(CONTRACT_PREFIX) && !i.terminal && PHASES.includes(i.phase));
say(`发现 ${all.length} 个未终局轮次（phase ∈ ${PHASES.join('/')}）`);

const rows = [];
for (const it of all) {
  if (onlyArg.length && !onlyArg.some(c => it.cid.startsWith(c))) continue;
  try {
    const r = await fetch(`${IDX}/v1/rounds/${it.cid}`, {signal: AbortSignal.timeout(STEP_MS)}).then(x => x.json());
    const s = r.item?.state || {};
    rows.push({
      cid: it.cid, phase: it.phase,
      sold: s.sold ?? 0, pc: s.purchaseCount ?? 0, cursor: s.cursor ?? 0,
      value: BigInt(r.item?.value || 0),
    });
  } catch (e) {
    say(`  ${it.cid.slice(0, 16)} 读取失败: ${String(e.message).slice(0, 50)}`);
  }
}
rows.sort((a, b) => a.phase - b.phase || a.sold - b.sold);
say(`待处理 ${rows.length} 个:`);
for (const r of rows) {
  say(`  ${r.cid.slice(0, 16)}  phase=${r.phase}  sold=${String(r.sold).padStart(3)}  pc=${r.pc}  cursor=${r.cursor}  value=${kas(r.value)} TKAS`);
}

/** Finish the run record even when nothing is submitted, so every run leaves evidence. */
function endEarly(reason) {
  const counts = finishRun(RUN, {
    results: [],
    extra: { rows: rows.map(x => ({ ...x, value: x.value.toString() })), endedEarly: reason },
  });
  say(`结果: ${reason}（耗时 ${counts.elapsedSec}s）`);
  say(`  ${RUN.runFile}`);
  say(`  ${RUN.summaryFile}`);
  say(`  日志: ${RUN.logFile}`);
  process.exit(0);
}
if (!rows.length) endEarly('没有需要清理的轮次');
if (DRY) endEarly('--dry：只扫描，未提交任何交易');

// ---------------------------------------------------------------- 2) 清理
say('=== 启动浏览器 ===');
const browser = await launch();
const u = await new User(browser, 'cleanup').open();
say('页面就绪, endpoints:', JSON.stringify(u.endpoints));

const results = [];

/** 读取页面 phase 文案；页面同步中时重开轮次再读。 */
async function phaseOf(cid) {
  for (let i = 0; i < 3; i++) {
    const f = await u.figures().catch(() => null);
    if (f && !/同步中/.test(f.phase)) return f;
    u.roundCid = null;
    await u.round(cid).catch(() => {});
    await u.page.waitForTimeout(1200);
  }
  return u.figures().catch(() => ({ phase: '?', sold: null }));
}

const TERMINAL = /已派奖|空轮|全部购买记录已退款/;
const SEALED = /已封存/;
const REFUNDING = /退款中/;

for (const [n, r] of rows.entries()) {
  const tag = `[${n + 1}/${rows.length}] ${r.cid.slice(0, 16)}`;
  const _t = Date.now();
  say(`${tag} 开始 (phase=${r.phase} sold=${r.sold} pc=${r.pc})`);
  try {
    // 权限无关：任意钱包都能封盘/开奖/退款
    await u.use(W.creator);
    u.roundCid = null;
    await u.round(r.cid);

    let f = await phaseOf(r.cid);
    if (TERMINAL.test(f.phase)) {
      say(`${tag} 已是 ${f.phase}，跳过`);
      results.push({ cid: r.cid, action: 'SKIP', phase: f.phase, sold: r.sold });
      continue;
    }

    // ---- 阶段 1：售票中 → 封盘
    if (r.phase === 1 || /售票中/.test(f.phase)) {
      say(`${tag} 封盘（未满票需等封盘时间锁，自动按步推进）...`);
      const c = await u.closeRound({ onWait: d => say(`  ${tag} 还差约 ${d} DAA`) });
      say(`${tag} 封盘 state=${c.state} ${c.actionMs}ms ok=${c.ok}`);
      f = await phaseOf(r.cid);
      say(`${tag} 封盘后 phase=${f.phase}`);
    }

    // ---- 阶段 2：已封存 → 开奖
    if (SEALED.test(f.phase)) {
      say(`${tag} 开奖（等 100 DAA + 100 blue-score，自动按步推进）...`);
      const d = await u.draw({ roundCid: r.cid, onWait: v => say(`  ${tag} 还差 ${v} DAA`) });
      say(`${tag} 开奖 state=${d.state} ${d.ms}ms ok=${d.ok}`);
      results.push({ cid: r.cid, action: 'CLOSE+DRAW', draw: d.state, sold: r.sold });
    }

    // ---- 阶段 5：退款中 → 分批退款
    f = await phaseOf(r.cid);
    if (REFUNDING.test(f.phase)) {
      let batch = 0;
      for (;;) {
        batch++;
        if (batch > MAX_REFUND_BATCHES) { say(`${tag} 退款批次超限`); break; }
        f = await phaseOf(r.cid);
        if (TERMINAL.test(f.phase)) break;
        if (!REFUNDING.test(f.phase)) { say(`${tag} 不在退款阶段(${f.phase})，停止`); break; }
        say(`${tag} 退款第 ${batch} 批...`);
        const rf = await u.refund();
        say(`${tag} 退款第 ${batch} 批 state=${rf.state} ${rf.ms}ms ok=${rf.ok}`);
        await u.page.waitForTimeout(1500);
      }
      results.push({ cid: r.cid, action: 'REFUND', batches: batch, sold: r.sold });
    }

    // ---- 终局核验
    const s = await waitTerminal(r.cid, x => !!x.terminal, { budgetMs: SETTLE_BUDGET_MS, onWait: () => { } });
    const ok = !!s?.terminal;
    say(`${tag} 终局=${s?.terminal ?? '(未达成)'} ${ok ? '✅' : '⚠️'} 用时 ${Math.round((Date.now()-_t)/1000)}s`);
    const last = results[results.length - 1];
    if (last && last.cid === r.cid) last.terminal = s?.terminal ?? null;
    else results.push({ cid: r.cid, action: 'CLOSE', terminal: s?.terminal ?? null, sold: r.sold });
  } catch (e) {
    const m = String(e.message || '');
    say(`${tag} 失败: ${m.slice(0, 120)}`);
    results.push({ cid: r.cid, action: 'FAIL', err: m.slice(0, 160), sold: r.sold });
  }
}

// ---------------------------------------------------------------- 3) 汇总
say('=== 汇总 ===');
const ok = results.filter(x => !['FAIL', 'SKIP'].includes(x.action)).length;
const fail = results.filter(x => x.action === 'FAIL').length;
const skip = results.filter(x => x.action === 'SKIP').length;
say(`成功 ${ok} / 失败 ${fail} / 跳过 ${skip}`);
for (const x of results.filter(y => y.action === 'FAIL')) say(`  FAIL ${x.cid.slice(0, 16)}: ${x.err}`);
for (const x of results.filter(y => !['FAIL', 'SKIP'].includes(y.action))) {
  say(`  OK   ${x.cid.slice(0, 16)} ${x.action} → ${x.terminal ?? '?'}`);
}

const counts = finishRun(RUN, {
  results,
  extra: { rows: rows.map(x => ({ ...x, value: x.value.toString() })) },
});
say(`结果: 成功 ${counts.pass} / 失败 ${counts.fail} / 跳过 ${counts.skip}，耗时 ${counts.elapsedSec}s`);
say(`  ${RUN.runFile}`);
say(`  ${RUN.summaryFile}`);
say(`  日志: ${RUN.logFile}`);

await u.dispose();
await browser.close();
