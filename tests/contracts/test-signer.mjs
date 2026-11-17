/** TN10-only signer for the three pre-existing dedicated test wallets. Keys never leave this closure. */
import {readFile,lstat} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {schnorrSign,schnorrVerify,xonlyPubkey} from '../../scripts/wallet/schnorr.mjs';
import {schnorrSighash} from '../../scripts/wallet/sighash.mjs';
import {pubkeyToAddress,spkToAddress} from '../../scripts/wallet/address.mjs';
import {p2pk} from '../../scripts/core/lib/covenant-id.js';
import {hex,unhex,check} from './state.mjs';
const WALLETS={
 creator:['tn10-test-only.json','kaspatest:qrg05u38z50weug9f8lcws7p07fzzvfsx9ap82f0akk4gxcs0ew86qd384xyt'],
 buyer1:['tn10-f3-buyer-1.json','kaspatest:qqhgp2pqztujn0mljt35xgmtz9edparth9f67upv3s5rxmdm4lkc2jqp65s3w'],
 buyer2:['tn10-f3-buyer-2.json','kaspatest:qzf372g3n7lfyscmemmkclu2487m6xctjc3uhslmc55dcdxrr556v963skl4p'],
};
export const publicWallets=()=>Object.entries(WALLETS).map(([role,[,address]])=>({role,address}));
export function decodeTestWallet(text) {try{return JSON.parse(text);}catch {throw new Error('TEST_WALLET_READ_FAILED');}}
export async function openTestSigner(role,networkId) {
 check(networkId==='testnet-10'&&Object.hasOwn(WALLETS,role),'TEST_SIGNER_SCOPE');
 const [name,address]=WALLETS[role],path=new URL(`../web/wallets/${name}`,import.meta.url);
 const stat=await lstat(path);check(stat.isFile()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0,'TEST_WALLET_PERMISSIONS');
 let doc;try {doc=decodeTestWallet(await readFile(path,'utf8'));}catch {throw new Error('TEST_WALLET_READ_FAILED');}
 check(doc.network==='testnet-10'&&doc.address===address,'TEST_WALLET_IDENTITY');
 const secret=unhex(doc.privateKey,32);delete doc.privateKey;
 const key=hex(xonlyPubkey(secret));check(pubkeyToAddress(key,'kaspatest')===address,'TEST_WALLET_ADDRESS');
 let closed=false;
 return {address,key,spk:p2pk(key),close(){secret.fill(0);closed=true;},async sign(draft){
   check(!closed,'SIGNER_CLOSED');
   check(draft.fee>0n&&draft.fee<=50000000n,'SIGNER_FEE_SCOPE');
   const allowed=new Set(publicWallets().map(w=>w.address));
   for(const o of draft.transaction.outputs) if(!o.covenant)check(allowed.has(spkToAddress(o.scriptPublicKey,'kaspatest')),'SIGNER_RECIPIENT_SCOPE');
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
