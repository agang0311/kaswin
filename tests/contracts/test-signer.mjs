/** TN10-only signer for the three pre-existing dedicated test wallets. Keys never leave this closure. */
import {readFile,lstat} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {schnorrSign,schnorrVerify,xonlyPubkey} from '../../scripts/wallet/schnorr.mjs';
import {schnorrSighash} from '../../scripts/wallet/sighash.mjs';
import {pubkeyToAddress,spkToAddress} from '../../scripts/wallet/address.mjs';
import {p2pk} from '../../scripts/core/lib/covenant-id.js';
import {REGISTRATION_SOMPI} from '../../scripts/core/lib/registry.js';
import {TN10} from '../../scripts/chain/tn10.mjs';
import {hex,unhex,check} from './state.mjs';
const SECP256K1_N=0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const POOL_DOMAIN=Buffer.from('KASWIN_TN10_BUYER_POOL_V1','ascii');
const WALLETS={
 creator:['tn10-test-only.json','kaspatest:qrg05u38z50weug9f8lcws7p07fzzvfsx9ap82f0akk4gxcs0ew86qd384xyt'],
 buyer1:['tn10-f3-buyer-1.json','kaspatest:qqhgp2pqztujn0mljt35xgmtz9edparth9f67upv3s5rxmdm4lkc2jqp65s3w'],
 buyer2:['tn10-f3-buyer-2.json','kaspatest:qzf372g3n7lfyscmemmkclu2487m6xctjc3uhslmc55dcdxrr556v963skl4p'],
};
export const publicWallets=()=>Object.entries(WALLETS).map(([role,[,address]])=>({role,address}));
export function decodeTestWallet(text) {try{return JSON.parse(text);}catch {throw new Error('TEST_WALLET_READ_FAILED');}}
async function loadWalletSecret(role,networkId) {
 check(networkId==='testnet-10'&&Object.hasOwn(WALLETS,role),'TEST_SIGNER_SCOPE');
 const [name,address]=WALLETS[role],path=new URL(`../web/wallets/${name}`,import.meta.url);
 const stat=await lstat(path);check(stat.isFile()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0,'TEST_WALLET_PERMISSIONS');
 let doc;try {doc=decodeTestWallet(await readFile(path,'utf8'));}catch {throw new Error('TEST_WALLET_READ_FAILED');}
 check(doc.network==='testnet-10'&&doc.address===address,'TEST_WALLET_IDENTITY');
 const secret=unhex(doc.privateKey,32);delete doc.privateKey;
 const key=hex(xonlyPubkey(secret));check(pubkeyToAddress(key,'kaspatest')===address,'TEST_WALLET_ADDRESS');
 return {address,key,secret};
}
function deriveSecret(baseSecret,index) {
 check(baseSecret instanceof Uint8Array&&baseSecret.length===32,'DERIVE_BASE_SECRET');
 check(Number.isSafeInteger(index)&&index>=0&&index<65536,'DERIVE_INDEX');
 const idx=Buffer.alloc(4);idx.writeUInt32BE(index,0);
 const ctr=Buffer.alloc(4);
 for(let c=0;c<256;c++) {
  ctr.writeUInt32BE(c,0);
  const h=createHash('sha256').update(baseSecret).update(POOL_DOMAIN).update(idx).update(ctr).digest();
  const n=BigInt('0x'+h.toString('hex'));
  if(n>=1n&&n<SECP256K1_N)return new Uint8Array(h);
 }
 throw new Error('DERIVE_SECRET_EXHAUSTED');
}
export function createDerivedBuyerPoolFromSecret(baseSecret,baseAddress,count,{prefix='kaspatest'}={}) {
 check(Number.isSafeInteger(count)&&count>=1&&count<=256,'BUYER_POOL_SIZE');
 check(typeof baseAddress==='string'&&baseAddress.startsWith(`${prefix}:`),'DERIVED_SWEEP_BASE_ADDRESS');
 const secrets=[],entries=[];
 for(let i=0;i<count;i++) {
  const sec=deriveSecret(baseSecret,i),key=hex(xonlyPubkey(sec)),address=pubkeyToAddress(key,prefix);
  secrets.push(sec);entries.push(Object.freeze({index:i,key,address,spk:p2pk(key)}));
 }
 let closed=false;
 return {
  baseAddress,
  entries:Object.freeze(entries),
  close(){if(closed)return;closed=true;for(const s of secrets)s.fill(0);},
  async signSweep(index,draft) {
   check(!closed,'SIGNER_CLOSED');
   check(Number.isSafeInteger(index)&&index>=0&&index<entries.length,'DERIVE_INDEX');
   check(draft.fee>0n&&draft.fee<=50000000n,'SIGNER_FEE_SCOPE');
   for(const o of draft.transaction.outputs) {
    check(!o.covenant&&spkToAddress(o.scriptPublicKey,prefix)===baseAddress,'DERIVED_SWEEP_RECIPIENT_SCOPE');
   }
   check(draft.inputUtxos.reduce((n,u)=>n+u.value,0n)-draft.transaction.outputs.reduce((n,o)=>n+o.value,0n)===draft.fee,'SIGNER_CONSERVATION');
   const entry=entries[index],sec=secrets[index],utxos=draft.inputUtxos.map(u=>({value:u.value,spk:u.spk}));
   for(const i of draft.authorizedInputIndices) {
    check(draft.inputUtxos[i].spk.script===entry.spk.script&&!draft.inputUtxos[i].covenantId,'SIGNER_INPUT_SCOPE');
    const hash=schnorrSighash(draft.transaction,utxos,i),sig=schnorrSign(sec,hash,randomBytes(32));
    check(await schnorrVerify(unhex(entry.key),hash,sig),'LOCAL_SIGNATURE_CHECK');
    draft.transaction.inputs[i].signatureScript='41'+hex(sig)+'01';
   }
  },
 };
}
export async function openDerivedBuyerPool(baseRole,count,networkId) {
 const {address,secret}=await loadWalletSecret(baseRole,networkId);
 try {
  const pool=createDerivedBuyerPoolFromSecret(secret,address,count,{prefix:'kaspatest'});
  return {baseRole,...pool};
 }finally{secret.fill(0);}
}
export async function openTestSigner(role,networkId) {
 const {address,key,secret}=await loadWalletSecret(role,networkId);
 let closed=false;
 return {address,key,spk:p2pk(key),close(){secret.fill(0);closed=true;},async sign(draft){
   check(!closed,'SIGNER_CLOSED');
   check(draft.fee>0n&&draft.fee<=50000000n,'SIGNER_FEE_SCOPE');
   const allowed=new Set(publicWallets().map(w=>w.address));
   for(const o of draft.transaction.outputs) if(!o.covenant) {
    const outAddr=spkToAddress(o.scriptPublicKey,'kaspatest');
    check(allowed.has(outAddr)||(outAddr===TN10.registry.address&&o.value===REGISTRATION_SOMPI),'SIGNER_RECIPIENT_SCOPE');
   }
   check(draft.inputUtxos.reduce((n,u)=>n+u.value,0n)-draft.transaction.outputs.reduce((n,o)=>n+o.value,0n)===draft.fee,'SIGNER_CONSERVATION');
   const utxos=draft.inputUtxos.map(u=>({value:u.value,spk:u.spk}));
   for(const i of draft.authorizedInputIndices) {
     check(draft.inputUtxos[i].spk.script===p2pk(key).script&&!draft.inputUtxos[i].covenantId,'SIGNER_INPUT_SCOPE');
     const hash=schnorrSighash(draft.transaction,utxos,i),sig=schnorrSign(secret,hash,randomBytes(32));
     check(await schnorrVerify(unhex(key),hash,sig),'LOCAL_SIGNATURE_CHECK');
     draft.transaction.inputs[i].signatureScript='41'+hex(sig)+'01';
   }
 }};
}
