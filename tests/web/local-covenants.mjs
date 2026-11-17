// Read-only adapter for this experiment node's local getUtxosByCovenantId patch (not a general RPC/submit client).
import {parseJson,jsonText} from '../../scripts/chain/json.mjs';
import {utxoFromRpc} from '../../scripts/chain/nodes.mjs';
export async function openLocalCovenants() {
 const ws=new WebSocket('ws://127.0.0.1:18210'),pending=new Map();let next=0;
 ws.addEventListener('message',event=>{
  const msg=parseJson(String(event.data)),p=pending.get(msg.id);if(!p)return;
  clearTimeout(p.timer);pending.delete(msg.id);msg.error?p.reject(new Error(jsonText(msg.error))):p.resolve(msg.params);
 });
 const fail=()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('LOCAL_COVENANT_CONNECTION_CLOSED'));}pending.clear();};
 ws.addEventListener('close',fail);ws.addEventListener('error',fail);
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{ws.close();reject(new Error('LOCAL_COVENANT_CONNECT_TIMEOUT'));},10000);ws.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});ws.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('LOCAL_COVENANT_CONNECT_ERROR'));},{once:true});});
 const call=(method,params={})=>new Promise((resolve,reject)=>{
  const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(new Error('LOCAL_COVENANT_RPC_TIMEOUT'));},10000);
  pending.set(id,{resolve,reject,timer});ws.send(`{"id":${id},"method":${JSON.stringify(method)},"params":${jsonText(params)}}`);
 });
 try {
  const info=await call('getServerInfo');if(info.networkId!=='testnet-10'||info.isSynced!==true)throw new Error('LOCAL_COVENANT_NODE_SCOPE');
  return {info,close:()=>ws.close(),query:async cid=>{
   if(!/^[0-9a-f]{64}$/.test(cid))throw new Error('COVENANT_ID');
   const r=await call('getUtxosByCovenantId',{covenantId:cid}),entries=r.entries??r.utxos;
   if(!Array.isArray(entries)||entries.length>1024)throw new Error('COVENANT_RESPONSE');
   const parsed=entries.map(utxoFromRpc);if(parsed.some(u=>u.covenantId!==cid))throw new Error('COVENANT_RESPONSE_ID');return parsed;
  }};
 }catch(e){ws.close();throw e;}
}
