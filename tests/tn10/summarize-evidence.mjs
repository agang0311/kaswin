// Offline only. Writes a deterministic receipt table; --candidate-evidence explicitly
// records the bounded candidate review, never grants public-launch or VM approval.
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {collectEvidence} from '../../contracts/f3.2/tools/tn10-evidence.mjs';
const repo=fileURLToPath(new URL('../../',import.meta.url));
const profile=JSON.parse(await fs.readFile(path.join(repo,'contracts/f3.2/profile.json'))),pins=JSON.parse(await fs.readFile(path.join(repo,'contracts/f3.2/pins.json')));
const evidence=await collectEvidence(repo,profile,pins.networkGenesis);
const lines=['# TN10 历史接受回执摘要（自动生成）','','本地文件核对，不是本次独立节点复验；accepted仅代表checkedAt时观察，不是不可逆最终性。原始回执保持不变。金额sompi，不经过Number。','','| Round | Step | txid | 接受块 | DAA | fee sompi | computeMass | storageMass | checkedAt |','|---|---|---|---|---:|---:|---:|---:|---|',...evidence.records.map(r=>`| ${r.round} | ${r.step} | ${r.txid} | ${r.acceptingBlockHash} | ${r.acceptingDaa} | ${r.feeSompi} | ${r.computeMass} | ${r.storageMass} | ${r.checkedAt} |`)];
await fs.writeFile(path.join(repo,'docs/kaswin-v2/TN10-RECEIPTS.md'),lines.join('\n')+'\n');
if(process.argv.includes('--candidate-evidence'))await fs.writeFile(path.join(repo,'contracts/f3.2/tn10-release-evidence.json'),JSON.stringify({schema:'KASWIN_TN10_ACCEPTANCE_CANDIDATE_1',publicLaunchApproved:false,vmCalibrated:false,unverified:['TIMEOUT_REFUND','REFUND_DIRECTORY_256','REAL_KASWARE_END_TO_END'],review:{scope:'TN10_ACCEPTANCE_CANDIDATE_ONLY',reviewer:'main-assistant',at:new Date().toISOString(),authorization:'Operator requested runner fixes, tradable TN10 candidate, then wallet/indexer acceptance, in that order.'},evidence},null,2)+'\n');
console.log(`Verified ${evidence.records.length} historical receipt/intent pairs; no network or SDK executed.`);
