/** Reauthenticate recorded TN10 experiment transactions against the node, then build a separate archive.
 * Read-only on chain. The receipt file supplies a location hint, never acceptance authority.
 * Usage: node tests/contracts/tn10-replay.mjs [--node=<ws/wss url>] [--run=<dir>] [--out-dir=<dir>]
 */
import {readdir,readFile,mkdir,open,unlink} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {TN10} from '../../scripts/chain/tn10.mjs';
import {loadDeploymentProfile} from '../../scripts/contract/bundle.mjs';
import {FileArchive} from '../../scripts/indexer/archive.mjs';
import {RollingNodeAdapter} from '../../scripts/indexer/node-adapter.mjs';
import {RollingIndexer} from '../../scripts/indexer/indexer.mjs';
import {durable,connectTN10} from './tn10-run.mjs';
const here=dirname(fileURLToPath(import.meta.url)),runs=join(here,'artifacts/tn10'),root=join(here,'artifacts/tn10-index');
export async function replay({runDirectory=null,outputDirectory=null,nodeUrl=null}={}) {
 const destination=outputDirectory?resolve(outputDirectory):root,selected=runDirectory?resolve(runDirectory):null;
 if(selected&&dirname(selected)!==runs)throw new Error('REPLAY_RUN_SCOPE');
 if(destination!==root&&dirname(destination)!==root)throw new Error('REPLAY_OUTPUT_SCOPE');
 await mkdir(destination,{recursive:true,mode:0o700});const lock=await open(join(destination,'writer.lock'),'wx',0o600);await lock.writeFile(String(process.pid));
 let rpc,node;
 try {
  const profile=await loadDeploymentProfile(),archive=new FileArchive(join(destination,'archive'));
  rpc=await connectTN10(nodeUrl);
  // AcceptanceEvidence expects NodeLink's {rpc,data} event envelope; JsonRpc emits raw chain data.
  const link={net:TN10,nodes:[rpc],connect:async()=>[rpc],call:rpc.call.bind(rpc),currentDaa:rpc.currentDaa,
   on:(kind,fn)=>rpc.on(kind,kind==='chain'?data=>fn({rpc,data}):fn)};
  node=new RollingNodeAdapter({link,profile,archive});
  const indexer=new RollingIndexer({archive,profile,networkGenesis:TN10.genesis,nodeAdapter:node}),rows=[];
  for(const d of await readdir(runs,{withFileTypes:true}))if(d.isDirectory()&&(!selected||join(runs,d.name)===selected)) {
   let state;try{state=JSON.parse(await readFile(join(runs,d.name,'state.json'),'utf8'));}catch(e){if(e.code==='ENOENT')continue;throw e;}
   if(!state.cid||!state.receipts.length)continue;
   let view=await archive.getRound(TN10.genesis,profile.id,state.cid);
   for(const receipt of state.receipts) {
    view=await indexer.ingest(receipt.txid,{acceptingBlockHash:receipt.acceptingBlock},view?.revision??'0');
    console.log(JSON.stringify({scenario:state.scenario,txid:receipt.txid,revalidated:true,revision:view.revision}));
   }
   const snapshot={scenario:state.scenario,round:view,receipts:state.receipts,verifiedAt:new Date().toISOString()};
   await durable(join(destination,`${state.cid}.json`),snapshot);rows.push(snapshot);
  }
  if(selected&&rows.length!==1)throw new Error('REPLAY_SELECTED_RUN_MISSING');
  const summary={network:TN10.networkId,genesis:TN10.genesis,profileId:profile.id,status:'NODE_REVALIDATED_SNAPSHOT_NOT_FINALITY',verifiedAt:new Date().toISOString(),rounds:rows};
  await durable(join(destination,'summary.json'),summary);return summary;
 }finally{node?.dispose();rpc?.close();await lock.close();await unlink(join(destination,'writer.lock'));}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const arg=name=>process.argv.find(s=>s.startsWith(`--${name}=`))?.slice(name.length+3);
 replay({runDirectory:arg('run')??null,outputDirectory:arg('out-dir')??null,nodeUrl:arg('node')??null}).then(s=>console.log(JSON.stringify({rounds:s.rounds.length,status:s.status}))).catch(e=>{console.error(e.code??e.safeCode??e.message);process.exitCode=1;});
}
