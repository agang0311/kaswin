// 钱包独占锁。同一钱包的重叠任务可能选中同一资金输入；同一节点可拒绝冲突方，
// 不同节点可能分别接收，仍须按所选链接受情况对账。
// 2026-11-14 的 rolling-web 早期失败就是这样产生的：两次套件重叠运行约 16 分钟，共用创建者钱包。
// 每个浏览器 profile 的页面只知道自己占用了哪些输入，看不到另一个 profile 的，所以只能在进程层面互斥。
// 2026-11-15：网页与 CLI 运行器已共享使用；锁只约束采用该锁的进程。
import fs from 'node:fs';
import path from 'node:path';

const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** 取得钱包 `name` 的独占锁；已被存活的进程持有则抛错。返回 release()，进程退出/收到信号时也会自动释放。 */
export function acquireWalletLock(dir, name, what) {
  fs.mkdirSync(dir, {recursive: true});
  const file = path.join(dir, `.wallet-${name}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, JSON.stringify({pid: process.pid, what, since: new Date().toISOString()}));
      fs.closeSync(fd);
      const release = () => {
        try { if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.unlinkSync(file); } catch { /* already gone */ }
      };
      process.on('exit', release);
      for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { release(); process.exit(130); });
      return release;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* unreadable: treat as stale */ }
      if (holder && alive(holder.pid)) {
        throw new Error(`钱包 ${name} 正被另一个运行占用（pid ${holder.pid}，${holder.what}，自 ${holder.since}）。` +
          '同一钱包的并发运行会选中同一个资金 UTXO，互相双花；请等它结束，或确认它已死后删除 ' + file);
      }
      try { fs.unlinkSync(file); } catch { /* raced with another cleaner: retry */ }
    }
  }
  throw new Error(`无法取得钱包锁 ${file}`);
}
