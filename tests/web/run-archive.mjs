/** Run archive: every run gets its own directory so nothing is ever overwritten.
 *
 *  tests/output/
 *    runs/
 *      2026-10-18T23-15-02Z-scenarios-1-2-3/
 *        run.json      结果汇总（机器可读）
 *        run.log       本次运行的完整 stdout 副本（含实时日志）
 *        summary.md    人读摘要
 *    latest -> runs/2026-10-18T23-15-02Z-scenarios-1-2-3   （符号链接，指向最近一次）
 *    index.jsonl     追加式索引：每次运行一行，永不重写
 *
 *  设计约束：
 *   - 任何一次运行都不会覆盖另一次的结果；
 *   - 同一秒内重复启动靠后缀 -2、-3 区分；
 *   - index.jsonl 用 append，历史保留；
 *   - 日志副本通过 tee 写入，脚本自身不缓冲。
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT_ROOT = path.join(ROOT, 'tests/output');
const RUNS_DIR = path.join(OUT_ROOT, 'runs');

/** 2026-10-18T23-15-02Z（文件名安全，无冒号） */
function stamp(d = new Date()) {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
}

function slug(s) {
  return String(s).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'run';
}

/** 创建本次运行目录。kind 例如 'scenarios' / 'cleanup'；label 例如 '1-2-3-9'。 */
export function createRun(kind, label, meta = {}) {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  const base = `${stamp()}-${slug(kind)}${label ? '-' + slug(label) : ''}`;
  let dir = path.join(RUNS_DIR, base);
  for (let i = 2; fs.existsSync(dir); i++) dir = path.join(RUNS_DIR, `${base}-${i}`);
  fs.mkdirSync(dir, { recursive: true });

  const run = {
    schema: 'KASWIN_TEST_RUN_1',
    kind,
    label,
    startedAt: new Date().toISOString(),
    dir,
    ...meta,
  };
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(run, null, 2) + '\n');

  // latest 指针（不覆盖历史，只移动链接）
  const latest = path.join(OUT_ROOT, 'latest');
  try { fs.unlinkSync(latest); } catch {}
  try { fs.symlinkSync(path.relative(OUT_ROOT, dir), latest, 'dir'); } catch {}

  return {
    dir,
    runFile: path.join(dir, 'run.json'),
    logFile: path.join(dir, 'run.log'),
    summaryFile: path.join(dir, 'summary.md'),
    meta: run,
  };
}

/** Tee stdout/stderr into run.log while keeping the console live.
 *  Called by the entry script before any other output. Idempotent. */
let teeInstalled = false;
export function teeTo(handle) {
  if (teeInstalled) return;
  teeInstalled = true;
  const fd = fs.openSync(handle.logFile, 'a');
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    stream.write = (chunk, enc, cb) => {
      try { fs.writeSync(fd, typeof chunk === 'string' ? chunk : chunk.toString()); } catch {}
      return write(chunk, enc, cb);
    };
  }
  const close = () => { try { fs.closeSync(fd); } catch {} };
  process.on('exit', close);
}

/** 写入最终结果（run.json 合并 + summary.md + index.jsonl 追加）。 */
export function finishRun(handle, { results, extra = {}, summaryLines = [] }) {
  const finishedAt = new Date().toISOString();
  const elapsedSec = Math.round((Date.parse(finishedAt) - Date.parse(handle.meta.startedAt)) / 1000);
  const pass = results.filter(r => r.pass === true || ['OK', 'CLOSE+DRAW', 'REFUND', 'CLOSE'].includes(r.action)).length;
  const fail = results.filter(r => r.pass === false || r.action === 'FAIL').length;
  const skip = results.filter(r => r.action === 'SKIP').length;

  const payload = {
    ...handle.meta,
    finishedAt,
    elapsedSec,
    counts: { total: results.length, pass, fail, skip },
    ...extra,
    results,
  };
  fs.writeFileSync(handle.runFile, JSON.stringify(payload, null, 2) + '\n');

  // 人读摘要
  const lines = [
    `# ${handle.meta.kind} ${handle.meta.label || ''}`.trim(),
    '',
    `- 开始: ${handle.meta.startedAt}`,
    `- 结束: ${finishedAt}`,
    `- 耗时: ${elapsedSec}s`,
    `- 结果: 共 ${results.length}，通过 ${pass}，失败 ${fail}，跳过 ${skip}`,
    '',
    ...(summaryLines.length ? [...summaryLines, ''] : []),
    '| 项目 | 结果 | 备注 |',
    '|---|---|---|',
    ...results.map(r => {
      const name = r.name || r.scenario || r.cid || '?';
      const ok = r.pass === true || ['OK', 'CLOSE+DRAW', 'REFUND', 'CLOSE'].includes(r.action);
      const state = r.state?.terminal || r.terminal || r.action || (ok ? 'OK' : '?');
      const note = [r.cid, r.elapsed != null ? `${r.elapsed}s` : null, r.err].filter(Boolean).join(' · ');
      return `| ${name} | ${ok ? '✅' : '❌'} ${state} | ${note} |`;
    }),
    '',
    `完整日志: \`${path.basename(handle.logFile)}\``,
    '',
  ];
  fs.writeFileSync(handle.summaryFile, lines.join('\n'));

  // 追加索引，永不重写
  fs.appendFileSync(path.join(OUT_ROOT, 'index.jsonl'),
    JSON.stringify({
      at: finishedAt, kind: handle.meta.kind, label: handle.meta.label,
      dir: path.relative(OUT_ROOT, handle.dir), elapsedSec, ...payload.counts,
    }) + '\n');

  return { pass, fail, skip, elapsedSec };
}

export { OUT_ROOT, RUNS_DIR };
