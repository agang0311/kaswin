// Real-browser TN10 lifecycle suite. Transactions are built/signed/sent by the page; node RPC is read-only for independent evidence.
// --scenarios=1,2,3,4,5,6 --role=b2 allows disjoint execution alongside CLI lane A. TIMEOUT is reserved for the user's manual test.
import fs from 'node:fs';
import path from 'node:path';
import {RollingPage} from './harness.mjs';
import {acquireWalletLock} from './lock.mjs';
import {saveJson,openEvidenceRpc,stableCursor,roundReady,waitActionQuote,sendQuote,executeAction,finalizedRound,pause} from './evidence.mjs';

const HERE=path.dirname(new URL(import.meta.url).pathname);
const CFG=JSON.parse(fs.readFileSync(path.join(HERE,'config/scenarios.json'),'utf8')).scenarios;
const arg=(k,d)=>process.argv.find(a=>a.startsWith(`--${k}=`))?.slice(k.length+3)??d;
const URL_=arg('url',process.env.KASWIN_TEST_URL??'http://127.0.0.1:8080/');
const NODE=arg('node',process.env.KASWIN_TEST_NODE??'ws://127.0.0.1:18210');
const ROLE=arg('role','creator'),picks=arg('scenarios','1,2,3,4').split(',').map(x=>x.trim());
if(!['creator','b1','b2'].includes(ROLE)||picks.some(x=>!['1','2','3','4','5','6'].includes(x)))throw new Error('ONLY_AUTHORIZED_NON_TIMEOUT_SCENARIOS_1_TO_6');
const buyOverride=arg('buys',null),quantity=Number(arg('quantity','1')),budgetMs=Number(arg('budget','21600'))*1000;
if(!Number.isSafeInteger(quantity)||quantity<1||quantity>65536)throw new Error('QUANTITY');
for(const id of picks){const buys=buyOverride===null?CFG[id].buys:Number(buyOverride);if(!Number.isSafeInteger(buys)||buys<0||buys*quantity>CFG[id].cap)throw new Error('BUY_COUNT_OR_TICKET_CAP');}
const ROOT=path.join(HERE,'../output/rolling-runs');
acquireWalletLock(ROOT,ROLE,`browser scenarios ${picks.join(',')}`);
const resume=arg('resume-run',null);
const stamp=new Date().toISOString().replace(/[:.]/g,'-').replace(/-\d{3}Z$/,'Z'),RUN=resume?path.resolve(resume):path.join(ROOT,`${stamp}-scenarios-${picks.join('-')}`);
if(path.dirname(RUN)!==path.resolve(ROOT))throw new Error('RESUME_PATH');
fs.mkdirSync(RUN,{recursive:true});
const log=(...args)=>{const line=`${new Date().toISOString().slice(11,23)} ${args.join(' ')}`;console.log(line);fs.appendFileSync(path.join(RUN,'run.log'),line+'\n');};
const previous=resume?JSON.parse(fs.readFileSync(path.join(RUN,'run.json'),'utf8')):null;
if(previous&&(previous.role!==ROLE||previous.url!==URL_||previous.node!==NODE))throw new Error('RESUME_SCOPE');
const previousResults=previous?.results.filter(r=>!r.pass&&picks.includes(r.id))??[];
if(previousResults.some(r=>(r.quantity??1)!==quantity))throw new Error('RESUME_QUANTITY');
const results=previous?.results.filter(r=>r.pass||!picks.includes(r.id))??[],started=Date.now();
const record={schema:'KASWIN_ROLLING_RUN_2',startedAt:previous?.startedAt??stamp,url:URL_,node:NODE,role:ROLE,picks:previous?.picks??picks,results,previousAttempts:[...(previous?.previousAttempts??[]),...previousResults]};
const save=()=>saveJson(path.join(RUN,'run.json'),record);
const rpc=await openEvidenceRpc(arg('evidence-node',arg('node',null)??'ws://127.0.0.1:18210'));
try {
  for(const id of picks) {
    const sc=CFG[id],buys=buyOverride===null?sc.buys:Number(buyOverride),dir=path.join(RUN,`s${id}`);
    fs.mkdirSync(dir,{recursive:true});
    const page=new RollingPage({url:URL_,log,profileDir:path.join(RUN,`profile-s${id}`)}),begin=Date.now();
    const result={id,name:sc.name,buys,quantity,pass:false};results.push(result);save();
    log(`=== scenario ${id}: ${sc.title}, buys=${buys}, role=${ROLE} ===`);
    try {
      await page.open();await page.setNode(NODE);await page.connect(ROLE);
      const prevEntry=previousResults.find(r=>r.id===id);
      const cursor=prevEntry?.cursor??await stableCursor(rpc);result.cursor=cursor;
      let round;
      if(resume) {
        if(!await page.p.locator('[data-open]').count()&&await page.p.locator('[data-filter="all"]').count()) {
          await page.p.locator('[data-filter="all"]').first().click().catch(()=>{});
          await pause(600);
        }
        if(prevEntry?.cid&&await page.p.locator(`[data-open="${prevEntry.cid}"]`).count()) {
          await page.p.locator(`[data-open="${prevEntry.cid}"]`).first().click().catch(()=>{});
          await pause(600);
        }
      }
      if(resume&&(await page.p.locator('[data-open]').count()||await page.p.locator('#view [data-act=moreRound]:not([disabled]), #view [data-act=export]').count())) {
        round=await roundReady(page);result.resumedFromBuys=round.buys;
        log(`RESUME scenario ${id}: cid=${round.cid}, already bought=${round.buys}`);
      } else {
        // Longer close time makes scenario 4 prove the sold-out early-close branch, rather than merely closing after the timer.
        await page.fillCreate({price:'1',cap:sc.cap,min:sc.min,minutes:id==='4'?5:sc.minutes});
        await page.clickCreate();if(!await page.waitQuote())throw new Error('GENESIS_QUOTE_TIMEOUT');
        ({round}=await sendQuote(page,'GENESIS',{log}));
      }
      result.cid=round.cid;saveJson(path.join(dir,'checkpoint.json'),round);save();
      for(let n=round.buys+1;n<=buys;n++) {
        const qty=page.p.locator('#qty');if(await qty.count())await qty.fill(String(quantity));
        ({round}=await executeAction(page,'BUY',{log}));
        if(round.buys!==n)throw new Error(`BUY_COUNT_MISMATCH ${round.buys} expected ${n}`);
        saveJson(path.join(dir,'checkpoint.json'),round);
        if(n%16===0||n===buys)log(`scenario ${id}: accepted candidates ${n}/${buys}, frozen=${round.frozen.length}, ${Math.round((Date.now()-begin)/1000)}s`);
      }
      result.bought=round.bought;result.frozenBeforeClose=round.frozen.length;
      if(buys===256&&round.frozen.length!==1)throw new Error('PURCHASE_256_DID_NOT_FREEZE_EXACTLY_ONE_SHARD');
      if(id==='4') {
        result.closedBeforeDeadline=(await rpc.currentDaa())<round.settings.closeEligibleDaa;
        if(!result.closedBeforeDeadline)throw new Error('EARLY_CLOSE_WINDOW_MISSED');
      }
      if(!round.terminal&&!round.receipts.some(r=>r.action==='CLOSE'))({round}=await executeAction(page,'CLOSE',{log,timeout:360000}));
      while(!round.terminal) {
        if(Date.now()-started>budgetMs)throw new Error('SCENARIO_TIME_BUDGET_REACHED');
        const phase=round.manager?await page.state():null;
        let action;
        if(phase?.acts.includes('DRAW'))action='DRAW';
        else action=['PAY_OLD','PAY_SELF','REFUND_OLD','REFUND_SELF'].find(a=>phase?.acts.includes(a));
        if(!action){await pause(500);round=await roundReady(page);continue;}
        ({round}=await executeAction(page,action,{log,timeout:360000}));
        saveJson(path.join(dir,'checkpoint.json'),round);
      }
      const verified=await finalizedRound(page,rpc,{cursor,dir,log});
      result.terminal=verified.round.terminal;result.transactions=verified.evidence.length;result.feeSompi=verified.round.fees.toString();
      result.allAccepted=verified.evidence.every(e=>e.accepted&&BigInt(e.depth)>=100n);
      result.actions=verified.evidence.reduce((counts,e)=>({...counts,[e.action]:(counts[e.action]??0)+1}),{});
      result.pass=result.terminal===sc.expect.terminal&&result.allAccepted&&verified.round.buys===buys&&verified.round.bought===buys*quantity;
      if(!result.pass)throw new Error('SCENARIO_TERMINAL_OR_ACCEPTANCE_MISMATCH');
      await page.shot(dir,'final');
      const browserErrors=page.errors.filter(x=>!/^\[console\] Failed to load resource:.*favicon/.test(x));
      if(browserErrors.length){result.browserErrors=browserErrors;throw new Error(`BROWSER_ERROR ${browserErrors[0]}`);}
      log(`PASSED scenario ${id}: ${result.terminal}, tx=${result.transactions}, fee=${result.feeSompi} sompi`);
    } catch(e) {
      result.pass=false;result.error=String(e.message).slice(0,600);
      await page.shot(dir,'failure').catch(()=>{});
      if(!await page.p?.locator('#modal[open]').count().catch(()=>false)) {
        await page.exportRoundText().then(text=>fs.writeFileSync(path.join(dir,'recovery-round.json'),text,{mode:0o600})).catch(()=>{});
      }
      log(`FAILED scenario ${id}: ${result.error}; preserve profile for recovery, stop suite`);
    } finally {result.ms=Date.now()-begin;save();await page.close_();}
    if(!result.pass||Date.now()-started>budgetMs)break;
  }
} finally {rpc.close();record.totalSeconds=Math.round((Date.now()-started)/1000);save();}
const passed=results.filter(r=>r.pass).length,failed=results.filter(r=>!r.pass).length;
log(`complete: passed=${passed}, failed=${failed}, requested=${record.picks.length}, run=${RUN}`);
process.exitCode=failed||results.length!==record.picks.length?1:0;
