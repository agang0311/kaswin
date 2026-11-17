// Inventory only public Rolling round records, then count their actually live covenant IDs on the local TN10 node.
// This campaign guard covers the known experiment records; it is not a network-wide index or a global creation allocator.
import fs from 'node:fs';
import path from 'node:path';
import {openLocalCovenants} from './local-covenants.mjs';
const PROFILE='b56bcd9cb654610b238a32bae25c41128ebd2837cc7a91b3ea835f8a102fc4e5';
export async function inspectKnownRounds(root=process.cwd()) {
 const known=new Map(),reserved=new Set();
 const add=(object,source)=>{
  const visit=value=>{
   if(!value||typeof value!=='object')return;
   if(typeof value.cid==='string'&&/^[0-9a-f]{64}$/.test(value.cid)){if(!known.has(value.cid))known.set(value.cid,new Set());known.get(value.cid).add(path.relative(root,source));}
   for(const child of Object.values(value))if(child&&typeof child==='object')visit(child);
  };visit(object);
 };
 const read=file=>{if(!fs.existsSync(file))return null;const object=JSON.parse(fs.readFileSync(file,'utf8'));add(object,file);return object;};
 const dirs=dir=>fs.existsSync(dir)?fs.readdirSync(dir,{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>path.join(dir,e.name)):[];
 for(const dir of dirs(path.join(root,'tests/contracts/artifacts/tn10'))) {
  const state=read(path.join(dir,'state.json'));if(!state||state.profileId!==PROFILE)continue;
  if(typeof state.intent==='string'&&/^\d+-intent\.json$/.test(state.intent)) {
   const intent=read(path.join(dir,state.intent));if(intent?.action==='GENESIS'&&intent.draft?.cid&&['PREPARED','SUBMITTED','UNKNOWN','REJECTED'].includes(intent.status))reserved.add(intent.draft.cid);
  }
 }
 const oldNames=['round-after-genesis.json','state-3-tickets.json','state-after-loser-buy.json','winner-state-for-loser.json','race-1-final.json','race-3-result.json'];
 for(const dir of dirs(path.join(root,'tests/contracts/artifacts/tn10-browser')))for(const name of oldNames)read(path.join(dir,name));
 for(const dir of dirs(path.join(root,'tests/output/rolling-runs'))) {
  for(const name of ['run.json','result.json','round.json','checkpoint.json'])read(path.join(dir,name));
  for(const sub of dirs(dir))if(/^(s[1-6]|race-|three-buy-|close-|buy-close-|cross-node-)/.test(path.basename(sub)))for(const name of ['round.json','checkpoint.json','recovery-round.json'])read(path.join(sub,name));
 }
 const node=await openLocalCovenants(),active=[],reservations=[];
 try {
  for(const [cid,sources] of known) {
   const utxos=await node.query(cid);
   if(utxos.length)active.push({cid,unspentOutputs:utxos.length,sources:[...sources]});
   else if(reserved.has(cid))reservations.push({cid,sources:[...sources]});
  }
  return {schema:'ROLLING_KNOWN_ACTIVE_ROUNDS_1',profileId:PROFILE,at:new Date().toISOString(),knownCids:known.size,active,reservations,slotCount:active.length+reservations.length};
 }finally{node.close();}
}
export async function requireCampaignCapacity(slots=1) {
 const report=await inspectKnownRounds();
 fs.writeFileSync('tests/output/rolling-campaign/active-rounds.json',JSON.stringify(report,null,2)+'\n',{mode:0o600});
 if(report.slotCount+slots>3)throw new Error(`CAMPAIGN_ACTIVE_ROUND_LIMIT ${report.slotCount}+${slots}>3`);
 return report;
}
