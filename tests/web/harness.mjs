// Rolling TN10 页面驱动。只通过页面 UI 操作，不直接构造交易、不读私钥以外的内部状态。
// 密钥仅在内存中传给页面输入框；不打印、不落盘。
import {chromium} from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import {parseJson,jsonText} from '../../scripts/chain/json.mjs';
import {RpcError} from '../../scripts/chain/nodes.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const WALLETS = path.join(HERE, './wallets');
const wallet = name => JSON.parse(fs.readFileSync(path.join(WALLETS, `${name}.json`), 'utf8'));

/** 仅公开地址（不把私钥交给只需要地址的调用方）。 */
export const walletAddress = role => wallet(ROLES[role]).address;

export const ROLES = {
  creator: 'tn10-test-only',
  b1: 'tn10-f3-buyer-1',
  b2: 'tn10-f3-buyer-2',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString().slice(11, 19);

export class RollingPage {
  constructor(opts) { this.o = opts; this.log = opts.log ?? (() => {}); }

  async open() {
    // A persistent profile keeps the round record on disk, so a failed run can be reopened and settled
    // instead of leaving the deposit locked in a covenant nobody has the state for.
    // Background tabs get their timers throttled (the page polls every 8s), which made confirmation
    // take minutes in automation. Disable that throttling and keep the page in front.
    const args = ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'];
    if (this.o.profileDir) {
      fs.mkdirSync(this.o.profileDir, {recursive: true});
      this.ctx = await chromium.launchPersistentContext(this.o.profileDir, {viewport: {width: 1280, height: 1100}, locale: 'zh-CN', args});
      this.p = this.ctx.pages()[0] ?? await this.ctx.newPage();
    } else {
      this.browser = await chromium.launch({args});
      this.ctx = await this.browser.newContext({viewport: {width: 1280, height: 1100}, locale: 'zh-CN'});
      this.p = await this.ctx.newPage();
    }
    if (this.o.wsTap || this.o.submitGate) {
      // Forward original page frames; optional read-only probes use this same node connection for identity/mempool evidence.
      await this.p.routeWebSocket(/.*/, ws => {
        const server = ws.connectToServer(), sent = new Map(),probes=new Map();let probeId=8000000000000000n;
        this.probeConnectionUrl=ws.url();
        const probeCall=(method,params={})=>new Promise((resolve,reject)=>{
          if(!['getInfo','getMempoolEntry'].includes(method)){reject(new Error('READ_ONLY_PROBE_METHOD'));return;}
          const id=String(++probeId),timer=setTimeout(()=>{probes.delete(id);reject(new Error('NODE_PROBE_TIMEOUT'));},10000);
          probes.set(id,{method,resolve,reject,timer});server.send(`{"id":${id},"method":${JSON.stringify(method)},"params":${jsonText(params)}}`);
        });
        this.probeCall=probeCall;
        ws.onMessage(m => {
          let submitting=false;
          try { const j = parseJson(String(m)); if (j.method === 'submitTransaction') { submitting=true;sent.set(String(j.id), Date.now());this.o.wsTap?.({kind: 'submit', at: Date.now()}); } } catch {}
          // Optional test barrier holds already-signed RPC bytes briefly so distinct real nodes can receive conflicting spends together.
          // No frame content is changed, and no node result is fabricated.
          if(submitting&&this.o.submitGate){let released=false;const send=()=>{if(!released){released=true;server.send(m);}};this.o.submitGate(send,{probeCall,url:ws.url()});return;}
          server.send(m);
        });
        server.onMessage(m => {
          try {
            const j=parseJson(String(m)),id=String(j.id),probe=probes.get(id);
            if(probe){clearTimeout(probe.timer);probes.delete(id);if(j.error)probe.reject(new RpcError(probe.method,j.error));else probe.resolve(j.params);return;}
            if(sent.has(id)){this.o.wsTap?.({kind:'submitReply',at:Date.now(),txid:j.params?.transactionId??null,error:j.error?jsonText(j.error).slice(0,400):null});sent.delete(id);}
          }catch{}
          ws.send(m);
        });
        ws.onClose((code, reason) => server.close({code, reason}));
        server.onClose((code, reason) => ws.close({code, reason}));
      });
    }
    this.errors = [];
    this.p.on('pageerror', e => this.errors.push(String(e).slice(0, 200)));
    this.p.on('console', m => { if (m.type() === 'error') this.errors.push('[console] ' + m.text().slice(0, 160)); });
    await this.p.goto(this.o.url, {waitUntil: 'domcontentloaded'});
    await this.p.bringToFront().catch(() => {});
    await this.p.waitForTimeout(2500);
    const langBtn = this.p.locator('#languageBtn');
    if (await langBtn.count()) {
      const lang = await this.p.evaluate(() => document.documentElement.lang).catch(() => '');
      if (lang === 'en') { await langBtn.click().catch(() => {}); await this.p.waitForTimeout(400); }
    }
    return this;
  }

  /** Switch this page's Testnet 10 node; all transaction actions continue through the page. */
  async setNode(url) {
    await this.p.click('#settingsBtn');
    await this.p.waitForTimeout(700);
    await this.p.locator('#sNodes').fill(url);
    await this.p.locator('[data-act=applyConn]').click();
    await this.p.waitForTimeout(6000);
    await this.p.keyboard.press('Escape');
    await this.p.waitForTimeout(800);
    const chip = await this.p.evaluate(() => document.getElementById('nodeChip').innerText.trim());
    this.log(`  节点: ${chip}`);
    return chip;
  }

  /** Apply node / service / indexer settings via the real UI and require zero inline error. */
  async setSettings({node = null, service = null, indexer = null} = {}) {
    await this.p.click('#settingsBtn');
    await this.p.waitForTimeout(700);
    if (node !== null) await this.p.locator('#sNodes').fill(node);
    if (service !== null) await this.p.locator('#sSvc').fill(service);
    if (indexer !== null) await this.p.locator('#sIndexer').fill(indexer);
    await this.p.locator('[data-act=applyConn]').click();
    await this.p.waitForTimeout(6000);
    const err = (await this.p.locator('#sErr').innerText().catch(() => '')).trim();
    if (err) throw new Error(`SETTINGS_APPLY_FAILED ${err}`);
    await this.p.keyboard.press('Escape');
    await this.p.waitForTimeout(800);
    const chip = await this.p.evaluate(() => document.getElementById('nodeChip').innerText.trim());
    this.log(`  设置已保存，节点: ${chip}`);
    return chip;
  }

  async text() { return (await this.p.evaluate(() => document.body.innerText)).replace(/\n{2,}/g, '\n'); }

  async actions() {
    return this.p.evaluate(() => [...document.querySelectorAll('[data-act]')].filter(e => e.offsetParent)
      .map(e => ({act: e.dataset.act, text: (e.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 20), dis: !!e.disabled})));
  }

  async enabled(act) {
    const b = this.p.locator(`[data-act=${act}]`).first();
    if ((await b.count()) === 0) return false;
    // The element can detach between count() and isDisabled(); never let that wait 30s.
    return !(await b.isDisabled({timeout: 2000}).catch(() => true));
  }

  async waitEnabled(act, ms, every = 2500) {
    const t = Date.now();
    while (Date.now() - t < ms) { if (await this.enabled(act)) return true; await this.p.waitForTimeout(every); }
    return false;
  }

  /** 页面每 8 秒整体重渲染，动作按钮常常在 Playwright 的 stability 等待中失效：强制点击并重试。 */
  async clickAct(act, tries = 6) {
    for (let i = 0; i < tries; i++) {
      const b = this.p.locator(`[data-act=${act}]`).first();
      if ((await b.count()) === 0) { await this.p.waitForTimeout(1200); continue; }
      try { await b.click({force: true, timeout: 4000}); return true; } catch {}
      await this.p.waitForTimeout(1500);
    }
    return false;
  }

  /** 连接钱包（私钥或仅收款地址）。key 只在内存中传给输入框。 */
  async connect(role, {publicOnly = false} = {}) {
    const w = wallet(ROLES[role]);
    await this.p.click('#walletBtn');
    await this.p.waitForTimeout(600);
    if(await this.p.locator('[data-act=disconnect]').count()){
      await this.p.locator('[data-act=disconnect]').click();await this.p.waitForTimeout(300);
      await this.p.click('#walletBtn');await this.p.waitForTimeout(300);
    }
    if (publicOnly) {
      await this.p.click('[data-wtab=addr]');
      await this.p.waitForTimeout(300);
      await this.p.fill('#wAddr', w.address);
    } else {
      await this.p.click('[data-wtab=key]');await this.p.waitForTimeout(300);
      try{await this.p.fill('#wKey',w.privateKey);}catch{throw new Error('TEST_WALLET_KEY_INPUT_FAILED');}
    }
    await this.p.click('[data-act=connectWallet]');
    await this.p.waitForTimeout(4000);
    const btn = await this.p.evaluate(() => document.getElementById('walletBtn').innerText.trim());
    this.log(`  钱包 ${role}: ${btn}`);
    return btn;
  }

  /** 创建后等到轮次页就绪。只点开轮次一次：反复点卡片会让页面不断重渲染并打断意图确认。 */
  async waitRoundReady(ms = 220000, every = 2500) {
    const t = Date.now();
    let clicked = false;
    while (Date.now() - t < ms) {
      if (await this.enabled('BUY') || await this.enabled('CLOSE') || await this.enabled('DRAW')) return true;
      if (!clicked) {
        const card = this.p.locator('[data-open]').first();
        if (await card.count()) { await card.click().catch(() => {}); clicked = true; await this.p.waitForTimeout(3000); continue; }
      }
      await this.p.waitForTimeout(every);
    }
    return false;
  }

  /** 报价弹窗：等 send 可用再点。返回报价文本。 */
  async confirmSend(label, ms = 150000) {
    const t = Date.now();
    let opened = false;
    while (Date.now() - t < ms) {
      if (!opened) {
        if (await this.p.locator('#modal[open]').count()) opened = true;
        else { await this.p.waitForTimeout(700); continue; }
      }
      const s = this.p.locator('#modal[open] [data-act=send]');
      if (await s.count() && !(await s.isDisabled())) {
        const body = (await this.p.locator('#modal[open]').innerText()).replace(/\n{2,}/g, '\n');
        await s.click();
        return body;
      }
      await this.p.waitForTimeout(700);
    }
    this.log(`  ${label}: 报价超时`);
    return null;
  }

  async create({price, cap, min, minutes}) {
    await this.p.locator('button[data-go="create"]').first().click();
    await this.p.waitForTimeout(500);
    const protoBtn = this.p.locator('[data-proto="rolling-v1"]').first();
    if (await protoBtn.count()) { await protoBtn.click(); await this.p.waitForTimeout(250); }
    const set = async (sel, v) => { const e = this.p.locator(sel); await e.fill(''); await e.fill(String(v)); await this.p.waitForTimeout(120); };
    await set('#cPrice', price); await set('#cCap', cap); await set('#cMin', min);
    await this.p.locator('button[data-dur="custom"]').first().click();
    await this.p.waitForTimeout(300);
    await this.p.locator('#cCustom').fill(String(minutes));
    await this.p.waitForTimeout(300);
    await this.p.locator('button[data-act=create]').click();
    return this.confirmSend('GENESIS');
  }

  /** 创建轮次，遇到节点拒绝时放弃并重试（拒绝通常来自过期的资金 UTXO 视图）。 */
  async createRobust(cfg, tries = 1) {
    for (let i = 1; i <= tries; i++) {
      await this.create(cfg);
      const t = Date.now();
      while (Date.now() - t < 240000) {
        if (await this.enabled('BUY') || await this.enabled('CLOSE') || await this.enabled('DRAW')) return true;
        const txt = await this.text();
        if (/被节点拒绝/.test(txt)) {
          this.log(`  GENESIS 被节点拒绝（第 ${i}/${tries} 次），放弃后重试`);
          if (await this.enabled('discard')) {
            await this.p.locator('[data-act=discard]').first().click().catch(() => {});
            await this.p.waitForTimeout(4000);
          }
          break;
        }
        await this.p.waitForTimeout(3000);
      }
      if (await this.enabled('BUY') || await this.enabled('CLOSE')) return true;
      await this.p.locator('button[data-go="create"]').first().click().catch(() => {});
      await this.p.waitForTimeout(1500);
    }
    return false;
  }

  /** 买 1 张（页面每次购买固定 1 张；数量控件在动作卡 #qty）。 */
  async buy() {
    if (!await this.waitEnabled('BUY', 180000)) return false;
    if (!await this.clickAct('BUY')) return false;
    await this.p.waitForTimeout(1200);
    const q = this.p.locator('#qty');
    if (await q.count()) { await q.fill('1'); await this.p.waitForTimeout(600); }
    const r = await this.confirmSend('BUY');
    return !!r;
  }

  /** 连续买 n 笔（每笔一条购买记录）。 */
  async buyMany(n, onEach) {
    let done = 0;
    for (let i = 0; i < n; i++) {
      if (!await this.buy()) { this.log(`  买票在第 ${i + 1} 笔失败`); break; }
      done++;
      if (onEach) await onEach(done);
    }
    return done;
  }

  async close(maxMs = 240000) {
    if (!await this.waitEnabled('CLOSE', maxMs)) return false;
    if (!await this.clickAct('CLOSE')) return false;
    await this.p.waitForTimeout(1200);
    return !!(await this.confirmSend('CLOSE'));
  }

  async draw(maxMs = 240000) {
    if (!await this.waitEnabled('DRAW', maxMs)) return false;
    if (!await this.clickAct('DRAW')) return false;
    await this.p.waitForTimeout(1500);
    return !!(await this.confirmSend('DRAW'));
  }

  async act(name, maxMs = 240000) {
    if (!await this.waitEnabled(name, maxMs)) return false;
    if (!await this.clickAct(name)) return false;
    await this.p.waitForTimeout(1500);
    return !!(await this.confirmSend(name));
  }

  /** 反复执行某个动作直到出现终局或次数用尽。页面可能跳回广场，先自动打开轮次。 */
  async actUntilTerminal(names, maxRounds, maxMs = 240000) {
    for (let i = 0; i < maxRounds; i++) {
      const t0 = await this.text();
      const term0 = /空轮结束/.test(t0) ? 'EMPTY' : /退款完成/.test(t0) ? 'REFUNDED' : /已派奖/.test(t0) ? 'PAID' : null;
      if (term0) return {rounds: i, terminal: term0, text: t0};
      // A pending intent hides every action behind "等待确认"; that is not a terminal state.
      if (/等待确认|确认中|正在提交/.test(t0)) { await this.p.waitForTimeout(6000); continue; }
      let acts = await this.actions();
      if (!acts.some(a => names.includes(a.act) && !a.dis)) {
        const card = this.p.locator('[data-open]').first();
        if (await card.count()) { await card.click().catch(() => {}); await this.p.waitForTimeout(3500); continue; }
      }
      const act = (await this.actions()).find(a => names.includes(a.act) && !a.dis);
      // Nothing clickable yet (page still reconciling, or the round view is loading): keep waiting,
      // the page's acceptance tracking can take minutes on TN10.
      if (!act) { await this.p.waitForTimeout(8000); continue; }
      if (!await this.act(act.act, maxMs)) return {rounds: i, terminal: null, text: await this.text()};
      await this.p.waitForTimeout(7000);
    }
    return {rounds: maxRounds, terminal: null, text: await this.text()};
  }

  /** 轮次页关键数字。 */
  /** Phase comes from which actions the page offers, not from page copy: the progress stepper always
   *  contains "封盘 · 待开奖" and "派奖", so text matching mislabels every round. */
  async state() {
    const t = await this.text();
    const acts = (await this.actions()).map(a => a.act);
    const has = a => acts.includes(a);
    const sold = (t.match(/售出\s*\/\s*上限\n?(\d+)\s*\/\s*(\d+)/) || [])[1];
    const terminal = /空轮结束/.test(t) ? 'EMPTY' : /退款完成/.test(t) ? 'REFUNDED' : /已派奖/.test(t) ? 'PAID' : null;
    const phase = terminal ? 'terminal'
      : has('BUY') || has('CLOSE') ? 'sales'
      : has('DRAW') || has('TIMEOUT') ? 'sealed'
      : has('PAY_OLD') || has('PAY_SELF') ? 'win'
      : has('REFUND_OLD') || has('REFUND_SELF') ? 'refund' : 'unknown';
    const fees = (t.match(/累计网络费\n([\d.]+)/) || [])[1];
    return {sold: sold ? Number(sold) : null, phase, terminal, fees, acts, text: t};
  }

  /** 填写创建表单但不点“创建”（双页测试要在同一时刻才点）。 */
  async fillCreate({price, cap, min, minutes}) {
    await this.p.locator('button[data-go="create"]').first().click();
    await this.p.waitForTimeout(500);
    const protoBtn = this.p.locator('[data-proto="rolling-v1"]').first();
    if (await protoBtn.count()) { await protoBtn.click(); await this.p.waitForTimeout(250); }
    const set = async (sel, v) => { const e = this.p.locator(sel); await e.fill(''); await e.fill(String(v)); await this.p.waitForTimeout(120); };
    await set('#cPrice', price); await set('#cCap', cap); await set('#cMin', min);
    await this.p.locator('button[data-dur="custom"]').first().click();
    await this.p.waitForTimeout(300);
    await this.p.locator('#cCustom').fill(String(minutes));
    await this.p.waitForTimeout(300);
  }
  async clickCreate() { await this.p.locator('button[data-act=create]').click(); }

  /** 报价弹窗已打开且“发送”可用时返回弹窗文本（不点击），否则 null。 */
  async quoteText() {
    const s = this.p.locator('#modal[open] [data-act=send]');
    if (!(await s.count()) || await s.isDisabled().catch(() => true)) return null;
    return (await this.p.locator('#modal[open]').innerText()).replace(/\n{2,}/g, '\n');
  }
  async waitQuote(ms = 150000) {
    const t = Date.now();
    while (Date.now() - t < ms) { const q = await this.quoteText(); if (q) return q; await this.p.waitForTimeout(300); }
    return null;
  }
  async clickSend() { await this.p.locator('#modal[open] [data-act=send]').click({timeout: 5000}); }

  /** 发送之后的结果：'REJECTED'（页面显示被节点拒绝）/ 'OK'（轮次已可操作）/ null（超时）。
   *  只适用于创建（GENESIS）：创建之前轮次页上没有 BUY。**不适用于买票**——弹窗后面的 BUY 按钮仍然可点，会在发送还没完成时就返回 'OK'；买票请用 sendResult()。 */
  async waitSendOutcome(ms = 120000) {
    const t = Date.now();
    while (Date.now() - t < ms) {
      if (/被节点拒绝/.test(await this.text())) return 'REJECTED';
      if (await this.enabled('BUY') || await this.enabled('CLOSE')) return 'OK';
      await this.p.waitForTimeout(400);
    }
    return null;
  }
  /** 点“发送”之后的结果，按页面自己的流程判定：发送期间弹窗一直打开（显示正在签名/提交），结束后关闭并弹出结果提示。
   *  不能用“BUY 按钮可用”判断——轮次页后面的 BUY 在弹窗打开时仍然是可点的。
   *  status: SUBMITTED | REJECTED | UNSENT | UNKNOWN（页面自己报告的），CLOSED_NO_TOAST（弹窗关了但没抓到提示），null（超时）。 */
  async sendResult(ms = 120000) {
    const t = Date.now(), seen = new Set();
    let closed = false;
    while (Date.now() - t < ms) {
      const toast = await this.toastText(); if (toast) seen.add(toast);
      if (!(await this.p.locator('#modal[open]').count())) { closed = true; break; }
      await this.p.waitForTimeout(100);
    }
    if (closed) {                       // 弹窗关闭后提示还会显示几秒：再采样一会儿
      const t2 = Date.now();
      while (Date.now() - t2 < 1500) { const x = await this.toastText(); if (x) seen.add(x); await this.p.waitForTimeout(150); }
    }
    const all = [...seen].join(' ');
    const status = !closed ? null : /交易被节点拒绝/.test(all) ? 'REJECTED' : /已提交，等待节点确认/.test(all) ? 'SUBMITTED' : /没有发出/.test(all) ? 'UNSENT'
      : /暂未确认/.test(all) ? 'UNKNOWN' : 'CLOSED_NO_TOAST';
    return {status, toasts: [...seen].map(s => s.slice(0, 200))};
  }
  /** 被拒面板：文字与其中带 data-copy 的完整哈希（占用方交易）。 */
  async noticeInfo() {
    return this.p.evaluate(() => {
      const n = document.querySelector('.notice.bad'); if (!n) return null;
      return {text: n.innerText.replace(/\s+/g, ' ').trim(), copies: [...n.querySelectorAll('[data-copy]')].map(e => e.dataset.copy)};
    });
  }
  /** 当前可见的提示（弹窗内外两处容器）。 */
  async toastText() {
    return this.p.evaluate(() => ['toasts', 'mToasts'].map(id => document.getElementById(id)?.innerText ?? '').join(' ').replace(/\s+/g, ' ').trim());
  }
  /** 运行日志（折叠的 <details> 里，用 textContent 读）。 */
  async logLines() {
    await this.p.click('#settingsBtn'); await this.p.waitForTimeout(600);
    const lines = await this.p.evaluate(() => [...document.querySelectorAll('.log > div')].map(d => d.textContent.trim()));
    await this.p.keyboard.press('Escape'); await this.p.waitForTimeout(500);
    return lines;
  }
  /** 轮次页“导出”：返回导出文本（含签名脚本，调用方只应取需要的字段，不要整体打印）。 */
  async exportRoundText() {
    // A focused quantity input is restored by background renders and can scroll the export button away mid-click.
    // Blur before the real UI click; retry detached/invisible targets without accumulating timed-out download promises.
    await this.p.evaluate(()=>document.activeElement?.blur());
    const downloads=[],receive=download=>downloads.push(download);
    const visibleExportSel='#view [data-act=export], #modal[open] [data-act=export]';
    let openedTools=false;
    this.p.on('download',receive);
    try {
      for(let attempt=0;attempt<6;attempt++) {
        if(!(await this.p.locator(visibleExportSel).count())&&(await this.p.locator('#view [data-act=moreRound]:not([disabled])').count())) {
          await this.p.locator('#view [data-act=moreRound]').first().click({force:true,timeout:2000}).catch(()=>{});
          openedTools=true;
          await this.p.waitForTimeout(250);
        }
        if(await this.p.locator(visibleExportSel).count()) {
          await this.p.locator(visibleExportSel).first().click({force:true,timeout:2000}).catch(()=>{});
        }
        for(let n=0;n<12&&!downloads.length;n++)await this.p.waitForTimeout(50);
        if(downloads.length)return fs.readFileSync(await downloads[0].path(),'utf8');
      }
      throw new Error('ROUND_EXPORT_UI_RETRY_EXHAUSTED');
    } finally{
      this.p.off('download',receive);
      if(openedTools&&await this.p.locator('#modal[open]').count().catch(()=>0)) {
        await this.p.locator('#modal[open] [data-act=closeModal]').first().click({force:true,timeout:1500}).catch(()=>this.p.keyboard.press('Escape').catch(()=>{}));
        await this.p.waitForTimeout(200);
      }
    }
  }

  /** Fill quantity before a real button click; an existing preparing modal means the first request is still running. */
  async prepareBuy() {
    if(await this.p.locator('#modal[open]').count())return true;
    if (!await this.waitEnabled('BUY', 180000)) return false;
    const q=this.p.locator('#qty');if(await q.count())await q.fill('1');
    await this.p.locator('[data-act=BUY]').first().click({timeout:5000});
    this.buyPrepareClicks=(this.buyPrepareClicks??0)+1;
    return true;
  }
  /** Count click attempts separately from quote wait windows; never re-click BUY behind an active preparation modal. */
  async buyQuote(tries = 6, waitMs = 8000) {
    let clicks=0;
    for (let i = 1; i <= tries; i++) {
      if(!await this.p.locator('#modal[open]').count()) {if(!await this.prepareBuy())return null;clicks++;}
      const q = await this.waitQuote(waitMs);
      if (q) return {quote: q, clicks};
    }
    return null;
  }
  async modalInfo() {
    return this.p.evaluate(()=>{const d=document.querySelector('#modal');return d?.open?{title:document.querySelector('#mTitle')?.textContent??'',body:(document.querySelector('#mBody')?.textContent??'').slice(0,600)}:null;});
  }
  /** “加入轮次”：把轮次文本（分享链接或导出的轮次数据）填进广场页的输入框并加入，页面会自动进入这一轮。 */
  async joinText(text) {
    await this.p.locator('button[data-go="explore"]').first().click().catch(() => {});
    await this.p.waitForTimeout(600);
    await this.p.locator('#joinText').fill(text);
    await this.p.waitForTimeout(300);
    await this.p.locator('[data-act=join]').click();
    await this.p.waitForTimeout(2500);
  }

  async shot(dir, name) {
    fs.mkdirSync(dir, {recursive: true});
    await this.p.screenshot({path: path.join(dir, `${name}.png`), fullPage: true});
  }

  async close_() { await this.ctx?.close().catch(() => {}); await this.browser?.close().catch(() => {}); }
}
