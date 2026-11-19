// 结算遗留轮次：遍历运行归档里的浏览器 profile，把未终局的轮次推进到终局。
//   node tests/rolling-web/settle.mjs [--dry]
import fs from 'node:fs';
import path from 'node:path';
import {RollingPage} from './harness.mjs';
import {acquireWalletLock} from './lock.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.join(HERE, '../output/rolling-runs');
const dry = process.argv.includes('--dry');
// 结算会用 creator 钱包发交易；--dry 只读，不需要锁。
if (!dry) acquireWalletLock(ROOT, 'creator', 'settle');
const URL_ = 'https://cd311.cn:888/www/rolling-tn10/';
const NODE = process.argv.find(a => a.startsWith('--node='))?.slice(7) ?? 'ws://127.0.0.1:18210';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const dirs = fs.existsSync(ROOT) ? fs.readdirSync(ROOT, {withFileTypes: true}).filter(e => e.isDirectory()).map(e => e.name).sort() : [];   // 跳过 .wallet-*.lock
for (const d of dirs) {
  const base = path.join(ROOT, d);
  for (const sub of fs.readdirSync(base)) {
    if (!sub.startsWith('profile-')) continue;
    const dir = path.join(base, sub);
    const page = new RollingPage({url: URL_, log, profileDir: dir});
    try {
      await page.open();
      await page.setNode(NODE);
      await page.connect('creator');
      const cards = await page.p.evaluate(() => [...document.querySelectorAll('[data-open]')].map(e => ({cid: e.dataset.open, txt: (e.innerText || '').replace(/\s+/g, ' ').slice(0, 40)})));
      const open = cards.filter(c => /售票中|退款中|待开奖|派奖中/.test(c.txt));
      if (!open.length) { log(`${d}/${sub}: 无未终局轮次`); await page.close_(); continue; }
      for (const c of open) {
        log(`${d}/${sub}: ${c.cid.slice(0, 12)} ${c.txt.slice(0, 20)}`);
        if (dry) continue;
        await page.p.locator(`[data-open="${c.cid}"]`).click().catch(() => {});
        await page.p.waitForTimeout(4000);
        const r = await page.actUntilTerminal(['CLOSE', 'REFUND_OLD', 'REFUND_SELF', 'PAY_OLD', 'PAY_SELF', 'DRAW'], 40);
        log(`  → ${r.terminal ?? '仍未终局'}`);
        await page.p.getByRole('button', {name: '广场', exact: true}).first().click().catch(() => {});
        await page.p.waitForTimeout(2500);
      }
    } catch (e) { log(`${d}/${sub}: 异常 ${String(e.message).slice(0, 80)}`); }
    finally { await page.close_(); }
  }
}
