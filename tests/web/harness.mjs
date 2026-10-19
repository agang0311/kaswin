// Page-driven harness: every fact comes from the page's own DOM, not from polling the indexer.
//  - Full hashes (CID/txid) live in the `title` attribute of the truncated hash links.
//  - The round view auto-refreshes itself (RoundTracker), so no external state polling is needed.
//  - A freshly accepted state is usable at once: continue at 确认中 (CONFIRMING), not at the later 100-DAA recheck.
import {chromium} from 'playwright';
import fs from 'node:fs';
import {readQuoteState, waitForQuote} from './quote-state.mjs';
import {NETWORK, TIMING, walletDir, walletRoles} from './config.mjs';

export const IDX = NETWORK.indexer;
export const NODE = NETWORK.node;
export const PAGE = NETWORK.page;
export const CONTRACT_PREFIX = NETWORK.contractPrefix;

/** Test wallets (TN10 only). Directory resolution lives in config.mjs.
 *  Keys never leave this process and are never printed. */
const WDIR = walletDir();
const ROLES = walletRoles();
const readWallet = role => JSON.parse(fs.readFileSync(`${WDIR}/${ROLES[role]}`, 'utf8'));
export const W = {
  creator: readWallet('creator'),
  b1: readWallet('b1'),
  b2: readWallet('b2'),
};

// Policy (2026-10-18): no single step may block longer than 30s. Longer conditions (the contract's own
// DAA waits) are satisfied by repeating bounded steps, never by one long wait.
const STEP_MS = TIMING.stepMs;

// ---------------------------------------------------------------- live output
// Every long operation prints progress as it happens. Nothing is buffered: the caller
// must not pipe through `tail`, which would hide the stream until the process ends.
const T0 = Date.now();
const ts = () => `+${String(Math.round((Date.now() - T0) / 1000)).padStart(4)}s`;
/** Set KASWIN_LOG=0 to silence, KASWIN_LOG=verbose for per-poll detail. */
const LOG = process.env.KASWIN_LOG !== '0';
const VERBOSE = process.env.KASWIN_LOG === 'verbose';
export const log = (...a) => { if (LOG) console.log(`[${ts()}]`, ...a); };
export const logv = (...a) => { if (LOG && VERBOSE) console.log(`[${ts()}]`, ...a); };

/** Run `fn` while printing a heartbeat every `everyMs` so a stall is visible immediately.
 *  The heartbeat never extends the work: `fn` keeps its own bounded steps. */
export async function withHeartbeat(label, fn, { everyMs = 5000, getState = null } = {}) {
  let ticks = 0;
  const timer = setInterval(async () => {
    ticks++;
    let extra = '';
    if (getState) { try { const v = await getState(); if (v != null) extra = ` ${v}`; } catch {} }
    log(`  ⏳ ${label} 进行中 ${ticks * Math.round(everyMs / 1000)}s${extra}`);
  }, everyMs);
  if (timer.unref) timer.unref();
  try { return await fn(); } finally { clearInterval(timer); }
}

/** A stall guard: throws with the last observed state instead of hanging to the tool timeout. */
export function stallGuard(label, ms = STEP_MS) {
  const t = Date.now();
  return (what = '') => {
    if (Date.now() - t > ms) throw Error(`${label}: stalled ${Math.round((Date.now() - t) / 1000)}s${what ? ` (${what})` : ''}`);
  };
}

// ---------------------------------------------------------------- lifecycle
// A round's GENESIS is on chain the moment it is submitted. If the process dies between
// GENESIS and the terminal step, that round stays in 售票中 with its deposit locked. Two
// guards make that visible instead of silent:
//   1. scanOpenRounds() at start  — show anything a previous run left behind
//   2. installInterruptGuard()    — on SIGINT/SIGTERM print the in-flight CIDs and how to finish them
const inflight = new Map(); // cid -> {label, since}
export function trackRound(cid, label) { if (cid) inflight.set(cid, { label, since: Date.now() }); }
export function untrackRound(cid) { if (cid) inflight.delete(cid); }
export function inflightRounds() { return [...inflight.entries()].map(([cid, v]) => ({ cid, ...v })); }

let guardInstalled = false;
/** Print what is still unfinished when the process is asked to stop. Never pretends to clean up:
 *  a round needs a real transaction, so the operator gets the exact command instead. */
export function installInterruptGuard({ cleanupCmd = 'node tests/web/cleanup.mjs' } = {}) {
  if (guardInstalled) return;
  guardInstalled = true;
  let stopping = false;
  const handler = sig => {
    if (stopping) { console.log(`\n收到 ${sig}，强制退出`); process.exit(130); }
    stopping = true;
    const rows = inflightRounds();
    console.log('');
    log(`⚠️  收到 ${sig}，准备退出`);
    if (!rows.length) {
      log('   没有在途轮次，可安全退出');
    } else {
      log(`   有 ${rows.length} 个在途轮次（GENESIS 已上链，可能停在售票中）：`);
      for (const r of rows) log(`     ${r.cid}  (${r.label}, 已 ${Math.round((Date.now() - r.since) / 1000)}s)`);
      log('   收尾命令：');
      log(`     ${cleanupCmd}                      # 全部未终局轮次`);
      for (const r of rows) log(`     ${cleanupCmd} --only=${r.cid}`);
    }
    log('');
    log('   提示：不要用外层 timeout 硬杀；用 --budget=<秒> 让脚本自己报错并保留收尾信息。');
    process.exit(130);
  };
  process.on('SIGINT', () => handler('SIGINT'));
  process.on('SIGTERM', () => handler('SIGTERM'));
}

/** Non-terminal rounds currently on chain. A pre-flight check, not a source of truth:
 *  it only exists to make a previous interrupted run impossible to miss. */
export async function scanOpenRounds({ phases = [1, 2, 5] } = {}) {
  const r = await fetch(`${IDX}/v1/rounds?limit=200`, { signal: AbortSignal.timeout(STEP_MS) }).then(x => x.json());
  return (r.items || [])
    .filter(i => (i.contract || '').startsWith(CONTRACT_PREFIX) && !i.terminal && phases.includes(i.phase))
    .map(i => ({ cid: i.cid, phase: i.phase, value: i.value, updatedAt: i.updatedAt }))
    .sort((a, b) => a.updatedAt - b.updatedAt);
}

const HASH64=/^[0-9a-f]{64}$/;
const READY=/确认中|\d+ confirms|已接受/;
const STOP=/结果未知|待核验|失败|被拒绝|已失效|已归档|未生效/;

/** Read every 64-hex value exposed in the current modal (full value, from title/href). */
const modalHashes = page => page.evaluate(() => {
  const out=[];
  for(const el of document.querySelectorAll('#modal [title], #modal a[href]')){
    const t=el.getAttribute('title'); if(t&&/^[0-9a-f]{64}$/.test(t))out.push(t);
    const h=el.getAttribute('href')||''; const m=h.match(/[0-9a-f]{64}/); if(m)out.push(m[0]);
  }
  return [...new Set(out)];
});

export class User {
  /** Absolute wall-clock deadline (ms). Long loops consult this and fail fast. */
  set deadline(ms){ this._deadline=ms; }
  get deadline(){ return this._deadline ?? Infinity; }
  /** Throw when past the deadline. `where` names the step for the message. */
  checkDeadline(where=''){
    if(Date.now()>=this.deadline)
      throw Error(`${this.label}: 超出总预算${where?`（${where}）`:''}，已用 ${Math.round((Date.now()-(this._startedAt||Date.now()))/1000)}s`);
  }
  constructor(browser,label){
    this._startedAt=Date.now(); this.browser=browser; this.label=label; this.page=null; this.ctx=null; this.key=null; this.roundCid=null; }
  async open(){
    this.ctx=await this.browser.newContext({ignoreHTTPSErrors:true,locale:'zh-CN'});
    this.page=await this.ctx.newPage();
    this.errs=[];
    this.page.on('pageerror',e=>this.errs.push(e.message.slice(0,120)));
    await this.page.goto(PAGE,{waitUntil:'domcontentloaded',timeout:STEP_MS});
    await this.page.waitForTimeout(1000);
    // MANDATORY preflight: verify and correct the page's node + indexer endpoints before any operation.
    await this.page.locator('#settingsBtn').click(); await this.page.waitForTimeout(400);
    const curIdx=await this.page.locator('#sIdx').inputValue().catch(()=>'');
    const nf=this.page.locator('#sNodes');
    const curNodes=await nf.count()?await nf.inputValue().catch(()=>''):'';
    const idxOk=curIdx.replace(/\/+$/,'')===IDX;
    const nodeOk=curNodes.split(/\s+/).filter(Boolean)[0]===NODE;
    this.endpoints={indexer:{before:curIdx,ok:idxOk},node:{before:curNodes.split(/\s+/)[0]||'',ok:nodeOk}};
    if(!idxOk||!nodeOk){
      await this.page.locator('#sIdx').fill(IDX);
      if(await nf.count()) await nf.fill(NODE);
      await this.page.locator('#sSave, #saveSettings, button:has-text("保存")').first().click();
      await this.page.waitForTimeout(700);
      this.endpoints.corrected=true;
    }
    return this;
  }
  /** Connect (or switch) a wallet; reuses the session when the key is unchanged. */
  async use(key){
    if(this.key===key)return this;
    const p=this.page;
    if(await p.locator('#modal[open]').count()) await p.locator('#mClose').click().catch(()=>{});
    await p.locator('#walletBtn').click(); await p.waitForTimeout(350);
    if(await p.locator('#wDisc').count()){ await p.locator('#wDisc').click(); await p.waitForTimeout(250); await p.locator('#walletBtn').click(); await p.waitForTimeout(350); }
    await p.locator('#testWalletKey').fill(key.privateKey);
    await p.locator('#importTestWallet').click();
    for(let i=0;i<60;i++){ await p.waitForTimeout(200); const t=await p.locator('#walletBtn').innerText().catch(()=>''); if(/…/.test(t))break; }
    this.key=key; return this;
  }
  /** Open a round by CID. Waits for the action area instead of a fixed sleep. */
  async round(cid){
    const p=this.page;
    if(this.roundCid===cid)return this;
    if(await p.locator('#modal[open]').count()) await p.locator('#mClose').click().catch(()=>{});
    for(let a=0;a<8;a++){
      await p.locator('.nav [data-go="explore"]').click(); await p.waitForTimeout(400);
      const q=p.locator('#q'); if(await q.count()){ await q.fill(cid); await p.waitForTimeout(350); }
      const card=p.locator(`[data-cid="${cid}"]`);
      if(await card.count()){
        await card.first().click(); this.roundCid=cid; this.cid=cid;
        // Wait for a usable round view: either the action area or a terminal notice,
        // and not the "轮次正在补齐" placeholder (the page is still verifying on the node).
        for(let i=0;i<120;i++){
          await p.waitForTimeout(200);
          const txt=await p.locator('#view').innerText().catch(()=>'');
          if(/正在补齐|读取中|加载中/.test(txt))continue;
          if(await p.locator('#view .actions, #view .notice.ok').count())break;
        }
        return this;
      }
      if(await p.locator('#refreshRows').count()) await p.locator('#refreshRows').click().catch(()=>{});
      await p.waitForTimeout(700);
    }
    throw Error(`${this.label}: round not found ${cid}`);
  }
  quoteReady(maxMs=STEP_MS){ return waitForQuote(this.page,{timeoutMs:maxMs}); }
  /** Approve + sign + wait for FIRST acceptance. Optional DOM fields never inherit Locator's default wait. */
  async submit(){
    const p=this.page;
    const observe=()=>p.evaluate(()=>{
      const modal=document.querySelector('#modal[open]'), rec=modal?.querySelector('#recTx');
      let execution=null; try{ execution=JSON.parse(rec?.dataset.execution||'null'); }catch{}
      const rawMs=rec?.dataset.transportMs;
      return {text:modal?.innerText||'', machine:rec?.dataset.state||'', tx:rec?.dataset.tx||null,
        roundReady:rec?.dataset.roundReady==='true', transportMs:rawMs&&/^\d+$/.test(rawMs)?Number(rawMs):null,
        execution, phase:modal?.querySelector('#xprog')?.dataset.phase||'', observedAt:Date.now(),
        error:modal?.querySelector('#xErr')?.textContent?.trim()||'',
        rejectionReason:rec?.dataset.state==='REJECTED'?modal?.querySelector('.notice.bad')?.textContent?.trim().slice(0,8000)||null:null};
    });
    await p.locator('#modal[open] #approve').check();
    log(`    勾选批准 → 点签名并提交`);
    const t0=Date.now();
    await p.locator('#sign').click();
    let state='?', text='', machine='', roundReady=false, snapshot=null;
    while(Date.now()-t0<STEP_MS){
      await p.waitForTimeout(150);
      snapshot=await observe(); ({text,machine}=snapshot);
      const m=text.match(/状态\s*\n\s*(\S+)/); state=m?m[1]:'?';
      const done = snapshot.error || (machine ? ['CONFIRMING','ACCEPTED','REJECTED','CONFLICTED','DRIFTED','SUPERSEDED','ARCHIVED'].includes(machine) || (machine==='UNKNOWN' && Date.now()-t0>4000) : READY.test(state)||STOP.test(state));
      if(done){
        log(`    回执 machine=${machine||'-'} state=${state} ${Date.now()-t0}ms${snapshot.error?' err='+snapshot.error.slice(0,60):''}`);
        break;
      }
      if((Date.now()-t0)%3000<200) logv(`    等待回执 ${Math.round((Date.now()-t0)/1000)}s state=${state} machine=${machine||'-'}`);
    }
    snapshot??=await observe();
    const hashes=await modalHashes(p);
    const cidText=(text.match(/轮次 CID\s*\n\s*([0-9a-f]{6,})/)||[])[1]??'';
    const txid=snapshot.tx??hashes.find(h=>h.startsWith((text.match(/交易 ID\s*\n\s*([0-9a-f]{6,})/)||[])[1]??'\u0000'))??hashes[0];
    const cid=hashes.find(h=>h!==txid&&h.startsWith(cidText))??hashes.find(h=>h!==txid);
    const ms=Date.now()-t0, accepted=machine ? ['CONFIRMING','ACCEPTED'].includes(machine) : READY.test(state);
    const metrics={transportMs:snapshot.transportMs, execution:snapshot.execution, lastPhase:snapshot.phase,
      resultAgeMs:snapshot.execution?Math.max(0,snapshot.observedAt-snapshot.execution.finishedAt):null,
      error:snapshot.error||null,rejectionReason:snapshot.rejectionReason};
    if(!accepted)return {tx:txid,cid,state,machine,ms,syncMs:0,totalMs:Date.now()-t0,...metrics,roundReady:false,ok:false};
    const tSync=Date.now();
    while(Date.now()-tSync<8000){
      roundReady=(await observe()).roundReady;
      if(roundReady)break;
      await p.waitForTimeout(150);
    }
    const syncMs=Date.now()-tSync;
    if(await p.locator('#modal[open]').count())await p.locator('#mClose').click().catch(()=>{});
    return {tx:txid,cid,state,machine,ms,syncMs,totalMs:Date.now()-t0,...metrics,roundReady,ok:true};
  }
  /** Shared quote→approve→submit driver for BUY / CLOSE / REFUND / DRAW.
   * Error classification (same policy for every action):
   *   - sync-class error  → close modal, refresh the round, retry (bounded attempts)
   *   - any other error   → throw immediately (never wait out the full budget)
   *   - STALE_TIP text    → re-open the round, retry
   *   - ready             → submit
   * `fill` runs after the action button click (BUY needs a quantity).
   * `preCheck` may return a retry reason string; it runs before each click. */
  async quoteAction({act, fill=null, label, attempts=3, perTryMs=STEP_MS, preCheck=null}){
    const p=this.page;
    let lastError='';
    for(let attempt=0;attempt<attempts;attempt++){
      this.checkDeadline(label);
      log(`  ${label}: 第 ${attempt+1}/${attempts} 次尝试`);
      if(await p.locator('#modal[open]').count()){ await p.locator('#mClose').click().catch(()=>{}); await p.waitForTimeout(250); }
      if(preCheck){
        const why=await preCheck();
        if(why){ await this.refreshRound(); await this.waitUsable(); continue; }
      }
      const btn=p.locator(`#view [data-act="${act}"]`);
      if(!await btn.count()){ log(`  ${label}: 动作按钮未出现，等待页面可用`); await this.waitUsable(); continue; }
      if(!(await btn.isEnabled().catch(()=>false))){
        log(`  ${label}: 按钮暂不可用，等待 (第 ${attempt+1} 次)`);
        await p.waitForTimeout(1200); await this.refreshRound(); continue;
      }
      await btn.click({timeout:10_000}).catch(e=>log(`  ${label}: 点击失败 ${String(e.message).slice(0,60)}`));
      if(fill) await fill();
      log(`  ${label}: 已点动作，等待报价就绪`);
      const t0=Date.now();
      while(Date.now()-t0<perTryMs){
        const quote=await readQuoteState(p);
        if(quote.record)throw Error(`${this.label}: previous transaction record is still open; no new quote was created`);
        if(quote.ready){ log(`  ${label}: 报价就绪 ${Date.now()-t0}ms`); return this.submit(); }
        const err=quote.error.trim();
        if(err){
          lastError=err;
          if(!/同步|链视图|ROUND_SYNC_PENDING|READ_VIEW_CHANGED|LIVE_STATE_MISMATCH|REST_HTTP|FETCH|网络|NETWORK/.test(err))throw Error(`${this.label}: ${label} quote ${err.slice(0,140)}`);
          log(`  ${label}: 同步类错误，刷新后重试 → ${err.slice(0,70)}`);
          await p.locator('#mClose').click().catch(()=>{});
          await this.refreshRound(); await this.waitUsable(); break;
        }
        if(/正在补齐|暂不能操作/.test(quote.text)){
          await p.locator('#mClose').click().catch(()=>{});
          await this.refreshRound(); await this.waitUsable(); break;
        }
        if((Date.now()-t0)%3000<260) logv(`  ${label}: 报价中 ${Math.round((Date.now()-t0)/1000)}s`);
        await p.waitForTimeout(250);
      }
      log(`  ${label}: 本次报价未就绪 (${Date.now()-t0}ms)`);
    }
    const t=await p.locator('#modal').innerText().catch(()=>'');
    throw Error(`${this.label}: ${label} quote ${(lastError||t).slice(0,140)}`);
  }
  /** Force the round view to re-read the node. */
  async refreshRound(){
    this.roundCid=null;
    const cid=this.cid||(await this.currentCid());
    if(cid)await this.round(cid).catch(()=>{});
  }
  /** BUY n tickets. Returns {submitted, soldBefore, soldAfter, applied}.
   * `applied` is the only success signal: the on-chain `sold` figure actually advanced.
   * A submitted-but-not-applied buy is a lost race, not a success. */
  async buy(q){
    return this.quoteAction({act:'BUY', label:'buy',
      fill:async()=>{ await this.page.waitForTimeout(300); await this.page.locator('#qty').fill(String(q)); await this.page.locator('#go').click(); }});
  }
  async currentCid(){ return this.cid||this.roundCid||null; }
  /** Wait until the round view offers an action button (the page re-verifies after wallet switches). */
  async waitUsable(maxMs=STEP_MS){
    this.checkDeadline('waitUsable');
    const _t0=Date.now();
    const t0=Date.now();
    while(Date.now()-t0<maxMs){
      if(await this.page.locator('#view .actions button:not([disabled])').count())return true;
      const txt=await this.page.locator('#view').innerText().catch(()=>'');
      if(/正在补齐|暂不能操作|读取中/.test(txt)){
        if(await this.page.locator('#refreshRound').count()) await this.page.locator('#refreshRound').click().catch(()=>{});
      }
      await this.page.waitForTimeout(400);
    }
    return false;
  }
  async createRound(cap,min,minutes=1,onStep=()=>{}){
    const p=this.page;
    onStep('navigate-create');
    await p.locator('.nav [data-go="create"]').click(); await p.waitForTimeout(500);
    await p.locator('#cCap').fill(String(cap)); await p.locator('#cMin').fill(String(min));
    await p.locator('[data-dur="custom"]').click(); await p.waitForTimeout(200);
    await p.locator('#cCustom').fill(String(minutes)); await p.waitForTimeout(200);
    onStep('click-quote');
    await p.locator('#cGo').click();
    const qr=await this.quoteReady();
    onStep('quote-'+(qr?'ready':'timeout'));
    if(!qr){ const t=await p.locator('#modal').innerText().catch(()=>''); throw Error(`${this.label}: create quote ${t.slice(0,140)}`); }
    const r=await this.submit();
    onStep('submitted');
    if(!r.cid)throw Error(`${this.label}: CID not captured from modal`);
    // GENESIS is on chain from here on: track it until the round reaches a terminal state.
    trackRound(r.cid, `${this.label} cap=${cap} min=${min} ${minutes}min`);
    log(`  ⚠ 已登记在途轮次 ${r.cid.slice(0,16)}（中断时用 cleanup.mjs 收尾）`);
    this.roundCid=null;
    return r;
  }
  /** CLOSE: if not yet sold-out, the contract requires DAA >= closeEligibleDaa - 1.
   * If the modal says 还差 N DAA, we wait boundedly and retry; sold-out rounds quote immediately. */
  async closeRound({maxMs=STEP_MS, onWait=()=>{}}={}){
    const p=this.page;
    const startedAt=Date.now();
    let lastWait=null;
    // maxMs bounds ONE quote attempt; the DAA countdown is the contract's own wait and is not a stall.
    for(let attempt=0; attempt<200; attempt++){
      const attemptAt=Date.now();
      this.checkDeadline('close');
      if(Date.now()-attemptAt>=maxMs) throw Error(`${this.label}: close attempt timeout after ${Math.round((Date.now()-attemptAt)/1000)}s${lastWait!=null?`, 还差 ${lastWait} DAA`:''}`);
      if(await p.locator('#modal[open]').count()){ await p.locator('#mClose').click().catch(()=>{}); await p.waitForTimeout(200); }
      const btn=p.locator('#view [data-act="CLOSE"]');
      if(!await btn.count()){
        log(`  close: 封盘按钮未出现，刷新轮次 (第 ${attempt+1} 次)`);
        await this.refreshRound();
        await p.waitForTimeout(1000); continue;
      }
      if(!(await btn.isEnabled().catch(()=>false))){
        log(`  close: 封盘按钮暂不可用，等待 (第 ${attempt+1} 次)`);
        await p.waitForTimeout(1500);
        await this.refreshRound();
        continue;
      }
      await btn.click({timeout:10_000}).catch(e=>log(`  close: 点击失败 ${String(e.message).slice(0,60)}`));
      let q=await readQuoteState(p);
      const q0=Date.now();
      while(!q.ready&&!q.error.trim()&&!q.record&&!/未到封盘时间|还差|还需/.test(q.text)&&Date.now()-q0<STEP_MS){
        await p.waitForTimeout(250); q=await readQuoteState(p);
      }
      if(q.ready){
        const result=await this.submit();
        return {...result, actionMs:Date.now()-startedAt};
      }
      const errText = (q.error || q.text || '');
      const m = errText.match(/(?:还差|还需)\s*约?\s*(\d+)\s*DAA/);
      if(m){
        lastWait=Number(m[1]); onWait(lastWait);
        logv(`  close: 合约时间锁未到，还差约 ${lastWait} DAA`);
        await p.locator('#modal[open] #mClose').click().catch(()=>{});
        // Wait proportional to remaining DAA, max 4s per step (bounded, <=30s)
        await p.waitForTimeout(Math.min(4000, Math.max(1000, lastWait * 90)));
        continue;
      }
      if(q.error.trim()){
        if(/已由其他交易|已被其他|抢先|已封存|被拒绝/.test(q.error))
          throw Error(`${this.label}: close not available — ${q.error.slice(0,100)}`);
        if(!/同步|链视图|ROUND_SYNC_PENDING|READ_VIEW_CHANGED/.test(q.error))
          throw Error(`${this.label}: close quote ${q.error.slice(0,140)}`);
      }
      await p.locator('#modal[open] #mClose').click().catch(()=>{});
      await p.waitForTimeout(1200);
      await this.refreshRound();
    }
    throw Error(`${this.label}: close attempts exhausted`);
  }
  /** Wait until the sealed round is past DRAW_DELAY (100 DAA) and the draw action is offered.
   * Polls the page (it re-reads the node); never guesses from wall-clock time. Returns {waited, lastRemaining}. */
  async waitDrawable({maxMs=STEP_MS,onWait=()=>{},roundCid=null}={}){
    const p=this.page;
    const t0=Date.now();
    let lastRemaining=null;
    for(;;){
      if(Date.now()-t0>=maxMs)return {ok:false,waited:Date.now()-t0,lastRemaining};
      const txt=await p.locator('#view').innerText().catch(()=>'');
      if(/已派奖|空轮|全部购买记录已退款/.test(txt))return {ok:false,waited:Date.now()-t0,terminal:true};
      // "还差 N DAA" is shown by the action hint inside #view (see waitText) AND by the quote modal.
      // Treat either as not-ready, so we never submit a DRAW before DRAW_DELAY.
      const hint=txt.match(/还差\s*(\d+)\s*DAA/);
      const btn=p.locator('#view [data-act="DRAW_AND_PAY"]');
      const present=await btn.count();
      const disabled=present?await btn.isDisabled().catch(()=>false):true;
      if(present&&!hint&&!disabled)return {ok:true,waited:Date.now()-t0,lastRemaining:null};
      if(hint){ lastRemaining=Number(hint[1]); onWait(lastRemaining); }
      else if(!present){ lastRemaining=null; onWait(null); }
      // Refresh the round periodically so the page re-reads the node DAA.
      if(Math.floor((Date.now()-t0)/5000)%4===3&&roundCid){ this.roundCid=null; await this.round(roundCid).catch(()=>{}); }
      await p.waitForTimeout(1000);
    }
  }
  /** DRAW: the contract requires the SEALED input to be >= DRAW_DELAY (100 DAA) old. The authoritative readiness
   * signal is the quote itself (the page may not surface "还差 N DAA" right after a close, and the button may stay
   * enabled). We retry bounded quotes until the node accepts; we never submit a DRAW the node would reject.
   * Uses the same error classification as buy/close/refund. */
  async draw({roundCid=null,onWait=()=>{},maxMs=5*60_000}={}){
    const p=this.page;
    const t0=Date.now();
    let lastRemaining=null;
    // maxMs is the whole draw budget, not one attempt: DRAW_DELAY alone can exceed 30s and
    // each retry costs a refresh. The per-step bound still comes from User.deadline.
    for(let attempt=0;attempt<120;attempt++){
      this.checkDeadline('draw');
      if(Date.now()-t0>=maxMs)throw Error(`${this.label}: draw timeout after ${Math.round((Date.now()-t0)/1000)}s${lastRemaining!=null?`, 还差 ${lastRemaining} DAA`:''}`);
      if(await p.locator('#modal[open]').count()){ await p.locator('#mClose').click().catch(()=>{}); await p.waitForTimeout(200); }
      const btn=p.locator('#view [data-act="DRAW_AND_PAY"]');
      if(!await btn.count()){
        log(`  draw: 开奖按钮未出现，等待视图就绪 (第 ${attempt+1} 次)`);
        // The view may still be "同步中"; wait for the action area instead of immediately reloading.
        let found=false;
        for(let i=0;i<20;i++){ await p.waitForTimeout(500); if(await btn.count()){found=true;break;} }
        if(!found){ log(`  draw: 10s 内仍无按钮，刷新轮次`); await this.refreshRound(); await p.waitForTimeout(800); }
        continue;
      }
      // The button exists but may still be disabled (view syncing, or DRAW_DELAY not reached).
      // A bare click() would throw a 30s TimeoutError and abort the whole scenario.
      // Read the DOM property directly: isEnabled() waits for "stable" and can disagree with
      // a view that re-renders on every poll.
      const drawDisabled = await btn.evaluate(el => !!el.disabled).catch(() => true);
      if(drawDisabled){
        log(`  draw: 开奖按钮 disabled，等待 (第 ${attempt+1} 次)`);
        await p.waitForTimeout(1500);
        continue;
      }
      await btn.click({timeout:10_000}).catch(async e=>{ log(`  draw: 点击失败 ${String(e.message).slice(0,60)}`); });
      // The quote is computed asynchronously; poll until it is ready, errored, or clearly waiting on DRAW_DELAY.
      let q=await readQuoteState(p);
      const q0=Date.now();
      // Poll until the quote reaches a terminal observation: approvable, errored, or a DRAW_DELAY wait hint.
      while(!q.ready&&!q.error.trim()&&!q.record&&!/还差\s*\d+\s*DAA/.test(q.text)&&Date.now()-q0<STEP_MS){
        await p.waitForTimeout(250); q=await readQuoteState(p);
      }
      if(q.ready){ log(`  draw: 开奖报价就绪`); return this.submit(); }
      const m=q.text.match(/还差\s*(\d+)\s*DAA/);
      // DRAW_DELAY not yet reached: keep waiting, never treat it as a failure.
      if(m){ lastRemaining=Number(m[1]); onWait(lastRemaining); logv(`  draw: 封存时间锁未到，还差 ${lastRemaining} DAA`); }
      else if(q.error.trim()){
        if(/已由其他交易|已派奖|轮次已结束|被拒绝/.test(q.error))
          throw Error(`${this.label}: draw not available — ${q.error.slice(0,100)}`);
        if(/还差\s*\d+\s*DAA/.test(q.error)){ const mm=q.error.match(/还差\s*(\d+)/); lastRemaining=Number(mm[1]); onWait(lastRemaining); }
        else if(!/同步|链视图|ROUND_SYNC_PENDING|READ_VIEW_CHANGED|LIVE_STATE_MISMATCH|REST_HTTP|FETCH|网络|NETWORK/.test(q.error))
          throw Error(`${this.label}: draw quote ${q.error.slice(0,140)}`);
      }
      else if(/已由其他交易|已派奖|轮次已结束/.test(q.text))
        throw Error(`${this.label}: draw not available — ${q.text.slice(0,80)}`);
      else { lastRemaining=null; onWait(null); }
      await p.locator('#mClose').click().catch(()=>{});
      await p.waitForTimeout(1500);
      await this.refreshRound();
    }
    throw Error(`${this.label}: draw attempts exhausted${lastRemaining!=null?`, 还差 ${lastRemaining} DAA`:''}`);
  }
  async refund(){
    return this.quoteAction({act:'REFUND', label:'refund', attempts:3});
  }
  /** Current round figures straight from the DOM (the page auto-refreshes them). */
  async figures(){
    const t=await this.page.locator('#view').innerText().catch(()=>'');
    const s=(t.match(/售出\s*\/\s*上限\s*\n?\s*(\d+)\s*\/\s*(\d+)/)||[]);
    const r=(t.match(/(\d+)\/(\d+)\s*笔记录/)||[]);
    const phaseState=await this.page.evaluate(()=>{
      const el=document.querySelector('#view [data-round-phase]');
      return el?{current:el.dataset.current==='true',phase:el.dataset.roundPhase,terminal:el.dataset.terminal}:null;
    });
    const lastPhase=(t.match(/已封存|售票中|退款中|已派奖|空轮|全部购买记录已退款/)||[])[0]??'?';
    const phase=phaseState?phaseState.current?({PAID:'已派奖',EMPTY:'空轮',REFUNDED:'全部购买记录已退款'}[phaseState.terminal]??({'1':'售票中','2':'已封存','5':'退款中'}[phaseState.phase]??'?')):'同步中':lastPhase;
    return {sold:s[1]?Number(s[1]):null,cap:s[2]?Number(s[2]):null,records:r[1]?Number(r[1]):null,phase,current:phaseState?.current??null,lastPhase:phaseState?phaseState.phase:lastPhase};
  }
  async dispose(){ if(this.ctx) await this.ctx.close().catch(()=>{}); }
}

/** Wait until the indexer lists this CID (the explore list is indexer-driven). */
export async function waitIndexed(cid,{tries=60,onWait=()=>{}}={}){
  for(let i=0;i<tries;i++){
    const r=await fetch(IDX+'/v1/rounds?limit=200').then(x=>x.json()).catch(()=>({items:[]}));
    if((r.items||[]).some(x=>x.cid===cid))return true;
    onWait(i+1);
    await new Promise(r=>setTimeout(r,2000));
  }
  return false;
}
/** Authoritative on-chain sold figure from the indexer (falls back to the page when unavailable). */
export async function chainSold(cid){
  try{
    const r=await fetch(`${IDX}/v1/rounds/${cid}`,{signal:AbortSignal.timeout(STEP_MS)}).then(x=>x.json());
    const v=r?.item?.state?.sold;
    return Number.isInteger(v)?v:null;
  }catch{ return null; }
}
export async function launch(){ return chromium.launch(); }


export async function st(cid){
  const r=await fetch(IDX+'/v1/rounds/'+cid).then(x=>x.json()).catch(()=>null);
  const i=r?.item;
  return i ? {phase:i.phase,terminal:i.terminal,value:i.value,indexStatus:i.indexStatus,
    sold:i.state?.sold,pc:i.state?.purchaseCount,cursor:i.state?.cursor,latest:i.latestTxid,accepting:i.accepting} : null;
}
export async function waitState(cid,pred,tries=25){
  let last=null;
  for(let i=0;i<tries;i++){
    last=await st(cid).catch(()=>null);
    if(last&&pred(last))return last;
    await new Promise(r=>setTimeout(r,1200));
  }
  return last;
}
/** Poll until `pred` holds. Each round is one bounded step (<= STEP_MS); `budgetMs` bounds the whole wait. */
export async function waitTerminal(cid,pred,{budgetMs=180_000,onWait=()=>{}}={}){
  const t0=Date.now(); let last=null;
  for(;;){
    last=await waitState(cid,pred,Math.floor(STEP_MS/1200));
    if(last&&pred(last))return last;
    if(Date.now()-t0>=budgetMs)return last;
    onWait(last);
  }
}
export const txOf=r=>typeof r==='string'?r:r?.tx;
