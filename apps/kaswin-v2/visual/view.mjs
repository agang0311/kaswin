/** Pure presentation of candidate facts; never authorizes an action or releases an input. */
import {S, kas, daaDuration} from '../scripts/shared/core.mjs';
import {recordStatus} from '../scripts/rest.mjs';
export {recordStatus};
export const TX_STATUS = {
  REST_ACCEPTED: {label:'已接受 · REST', tone:'mint', open:false, meaning:'节点已裁剪这段历史（或暂时不可用），无法自行复验；api-tn10.kaspa.org 报告已接受，且它提供的输入、输出金额、脚本和合约绑定与本机批准记录一致。这是外部历史索引证据，不是节点完整复验，也不是不可逆最终性。不会释放输入、不会重发，也不用于后续轮次操作。'},
  SUBMITTING: {label:'提交中', tone:'amber', open:true, meaning:'提交意图已保存，是否生效仍需核对。'},
  SUBMITTED: {label:'已提交', tone:'violet', open:true, meaning:'节点已收到，不等于已被共识接受。'},
  PENDING: {label:'排队中', tone:'violet', open:true, meaning:'节点内存池中存在这笔交易，仍待接受。'},
  RECHECKING: {label:'核验中', tone:'violet', open:true, meaning:'只查询接受结果，不会重新广播。'},
  UNKNOWN: {label:'结果未知', tone:'amber', open:true, meaning:'尚未查明是否生效。输入继续保留占用；只核对、不重发，时间久或内存池查不到都不证明失败。'},
  ACCEPTED: {label:'已接受', tone:'mint', open:false, meaning:'在最近一次核验时，节点选中链接受了这笔交易，且字段与批准内容一致；不代表不可逆最终性。'},
  REJECTED: {label:'被拒绝', tone:'muted', open:false, meaning:'节点明确拒绝了这次提交；不是钱包整体资金未变化的证明。'},
  ARCHIVED: {label:'已归档', tone:'muted', open:false, meaning:'本机不再为这条记录保留输入。归档不证明原交易失败；它可能已经被接受，或被竞争交易取代。'},
};
export const txStatus = s => TX_STATUS[s] ?? {label:String(s),tone:'amber',open:true,meaning:'未知记录状态，请核对。'};
export const needsAttention = r => txStatus(recordStatus(r)).open;
export function roundFacts(d) {
  const s=d?.state,c=s?.config;if(!c)return null;
  return {phase:s.phase,price:BigInt(c.ticketPrice),cap:c.ticketCap,min:c.minTickets,purchaseCap:c.purchaseCap,closeDaa:BigInt(c.closeEligibleDaa),sold:s.sold,count:s.purchaseCount,cursor:s.cursor,pool:BigInt(s.sold)*BigInt(c.ticketPrice),utxoDaa:d.utxoDaa==null?null:BigInt(d.utxoDaa)};
}
export const closeOutcome = f => f.sold===0?'EMPTY':f.sold<f.min?'REFUNDING':'SEALED';
export const CLOSE_OUTCOME={EMPTY:'无人购买：结束并退还创建者押金',REFUNDING:'不足最低票数：转入分批退款',SEALED:'达到最低票数：封存，100 DAA 后可开奖'};
export function plannedActions(d,daa=null){
  const f=roundFacts(d);if(!f||d.terminal)return [];
  const wait=at=>daa===null?null:at>daa?at-daa:0n;
  const timed=(action,until)=>{const w=wait(until);return {action,until,waitDaa:w,available:w===null?null:w===0n};};
  if(f.phase===S.Phase.OPEN){const full=f.sold>=f.cap||f.count>=f.purchaseCap;return [
    {action:'BUY',available:!full,maxQty:Math.max(0,f.cap-f.sold),reason:full?'票数或购买记录已满':null},
    {...timed('CLOSE',f.closeDaa),...(full?{available:true,waitDaa:0n,until:null}:{}),outcome:closeOutcome(f)}];}
  if(f.phase===S.Phase.SEALED)return f.utxoDaa===null?[{action:'DRAW_AND_PAY',available:null},{action:'TIMEOUT_REFUND',available:null}]:[timed('DRAW_AND_PAY',f.utxoDaa+S.DRAW_DELAY),timed('TIMEOUT_REFUND',f.utxoDaa+S.TIMEOUT_DELAY)];
  if(f.phase===S.Phase.REFUNDING)return [{action:'REFUND',available:f.cursor<f.count,size:Math.min(32,f.count-f.cursor),done:f.cursor,total:f.count}];
  return [];
}
export function waitText(until,daa){if(until==null||daa==null)return '需读取节点 DAA';return daa>=until?'现在可核验并操作':'约 '+daaDuration(until-daa)+' 后可操作';}
export function cardStep(row,d,daa=null){
  if(row.terminal)return {text:({PAID:'已派奖 · 奖金见接受交易输出',EMPTY:'无人购买 · 押金已退回',REFUNDED:'退款完成 · 每条扣 0.01 TKAS'})[row.terminal]??'已结束'};
  const f=roundFacts(d),a=plannedActions(d,daa);if(!f)return {text:'详情尚未读取 · 不以 0 代替未知数值'};
  if(f.phase===1)return {text:a[1].available?'任何人可封盘 · '+CLOSE_OUTCOME[a[1].outcome]:'售票中 · 到时仅允许封盘，不自动停售'};
  if(f.phase===2)return {text:a[0].available?'可核验开奖条件 · 执行者赏金 1 TKAS':'已封存 · 需核验开奖等待条件'};
  return {text:`退款进度 ${f.cursor}/${f.count} 条`};
}
export function walletFlow(plan){
  const ins=plan.draft.authorizedInputIndices.map(i=>plan.draft.inputUtxos[i]);
  const spent=ins.reduce((a,u)=>a+u.value,0n),received=plan.outputs.filter(o=>o.mine).reduce((a,o)=>a+o.value,0n);
  return {spent,received,net:received-spent};
}
export function planSummary(p){
  const fee=kas(p.fee),b=p.before;
  if(p.action==='GENESIS')return `锁定 0.2 TKAS 押金，轮次结束后退还创建者；${p.request?.registry?'另付 0.05 TKAS 索引登记费；':''}网络费 ${fee} TKAS。规则创建后不可修改。`;
  if(p.action==='BUY')return `购买 ${p.after.sold-b.sold} 张，票号 #${b.sold+1}–#${p.after.sold}。票款进入合约，另付网络费 ${fee} TKAS。若状态被抢先消费，须重新核对而非重复提交。`;
  if(p.action==='CLOSE')return `${p.terminal==='EMPTY'?CLOSE_OUTCOME.EMPTY:p.after?.phase===5?CLOSE_OUTCOME.REFUNDING:CLOSE_OUTCOME.SEALED}。封盘发起者承担网络费 ${fee} TKAS。`;
  if(p.action==='DRAW_AND_PAY')return `按已验证的 PASS-A 证明计算中奖票 #${p.winner.ticket}。奖金直接支付中奖者，执行者获得 1 TKAS，创建者取回押金。网络费 ${fee} TKAS 从奖池扣除。`;
  if(p.action==='TIMEOUT_REFUND')return `封存已满足 432000 DAA 超时条件，转入退款，但本笔不直接向买家退款。发起者付网络费 ${fee} TKAS；之后需执行退款批次。`;
  if(p.action==='REFUND')return `执行下一批（最多32条）购买记录退款，每条扣0.01 TKAS执行费；执行费池扣除网络费后余款归执行者。${p.sponsored?'需普通资金输入赞助，回款见下方全部输出。':''}这不是额外重复扣票款。`;
  return '';
}
