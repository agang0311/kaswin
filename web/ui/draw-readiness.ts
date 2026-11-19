/** Display-only countdown. Wall-clock estimates never unlock an action or increment observed chain scores. */
import {DRAW_DELAY,TIMEOUT_DELAY} from '../../scripts/core.mjs';
import type {Ctx,Detail} from '../app/types.ts';
interface Readiness {ready: boolean; label: string; button: string; detail: string; percent: number|null}
const estimatedSeconds=(remaining: bigint,observedAt: number|undefined,now: number): bigint=>{
  const elapsed=observedAt?BigInt(Math.max(0,Math.floor((now-observedAt)/1000))):0n;
  const seconds=(remaining+9n)/10n;
  return seconds>elapsed?seconds-elapsed:0n;
};
export function drawReadiness(D: Detail,x: Ctx,now=Date.now()): Readiness {
  const manager=D.r.manager,daa=x.daa;
  const checking={ready:false,label:'正在核验开奖条件…',button:'等待节点核验',detail:'正在向节点定位开奖目标块并核对确认进度。',percent:null};
  if(!manager||daa===null)return checking;
  const current=daa>manager.utxoDaa?daa:manager.utxoDaa,boundary=manager.utxoDaa+DRAW_DELAY;
  if(current>=manager.utxoDaa+TIMEOUT_DELAY-1000n)return {ready:false,label:'开奖窗口已关闭',button:'等待超时退款',detail:'已接近或达到超时窗口；达到退款条件后可转入退款。',percent:null};
  if(current<boundary){
    const remaining=boundary-current,seconds=estimatedSeconds(remaining,x.daaObservedAt,now);
    return {ready:false,label:'开奖倒计时 · 封存等待',button:'等待封存时间',
      detail:seconds>0n?`第一阶段：还差 ${remaining} DAA，预计约 ${seconds} 秒；随后等待目标块 100 blue score 确认。`:'预计等待时间已到，正在等待节点确认封存满 100 DAA…',
      percent:Number((DRAW_DELAY-remaining)*100n/DRAW_DELAY)};
  }
  const p=x.drawProgress;
  if(!p||p.phase==='CHECKING')return {...checking,label:'开奖倒计时 · 定位目标块'};
  if(p.phase==='UNAVAILABLE'||now-p.observedAt>15000)return {...checking,label:'开奖进度暂不可用',detail:'保留轮次记录，等待节点重新核验开奖条件。'};
  const count=p.confirmations??0n,required=p.requiredConfirmations;
  if(p.phase==='READY'&&required>0n&&count>=required)return {ready:true,label:'开奖条件已就绪',button:'核验并开奖',detail:`封存 100 DAA 已满足；目标块已累计 ${count}/${required} blue score 确认。`,percent:100};
  if(required<=0n)return checking;
  const remaining=required>count?required-count:0n,seconds=estimatedSeconds(remaining,p.observedAt,now);
  return {ready:false,label:'开奖倒计时 · 目标块确认',button:'等待目标块确认',
    detail:seconds>0n?`第二阶段：目标块确认 ${count}/${required} blue score，预计约 ${seconds} 秒。`:`第二阶段：目标块确认 ${count}/${required} blue score，正在等待节点更新。`,
    percent:Number((count>required?required:count)*100n/required)};
}
