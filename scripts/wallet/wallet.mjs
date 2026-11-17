/** In-memory TN10 wallet. A private key exists ONLY inside the closure returned by openMemoryWallet:
 * never persisted, uploaded, logged or reflected in an error message. close() zeroes the byte array.
 * (JS strings are immutable: the caller must drop its own copy and clear the DOM input immediately.)
 * Public-address recipients (permissionless actions) carry no signing capability at all. */
import {schnorrSign,schnorrVerify,xonlyPubkey} from './schnorr.mjs';
import {schnorrSighash} from './sighash.mjs';
import {pubkeyToAddress,decodeAddress} from './address.mjs';
import {p2pk} from '../core/lib/covenant-id.js';
import {check,hex,unhex,FEE_CAP} from '../core.mjs';
const PREFIX='kaspatest';
const aux=()=>{const b=new Uint8Array(32);globalThis.crypto.getRandomValues(b);return b;};
export const isSignature=s=>/^41[0-9a-f]{128}01$/.test(s);

/** Parse a 32-byte hex key; errors never contain the input. */
function parseKey(text) {
  const t=typeof text==='string'?text.trim().replace(/^0x/i,''):'';
  check(/^[0-9a-fA-F]{64}$/.test(t),'KEY_FORMAT');
  return unhex(t.toLowerCase(),32);
}
export function openMemoryWallet(privateKeyText) {
  const secret=parseKey(privateKeyText);
  let key,address;
  try {key=hex(xonlyPubkey(secret));address=pubkeyToAddress(key,PREFIX);}
  catch {secret.fill(0);throw Object.assign(new Error('KEY_INVALID'),{code:'KEY_INVALID'});}
  let closed=false;const spk=p2pk(key);
  return Object.freeze({
    kind:'key',canSign:true,address,key,spk,
    get closed(){return closed;},
    close(){secret.fill(0);closed=true;},
    /** SIGHASH_ALL for every authorized (ordinary P2PK) input, each verified locally before it is accepted. */
    async sign(draft) {
      check(!closed,'WALLET_CLOSED');
      check(typeof draft.fee==='bigint'&&draft.fee>0n&&draft.fee<=FEE_CAP,'SIGNER_FEE_SCOPE');
      check(draft.inputUtxos.reduce((n,u)=>n+u.value,0n)-draft.transaction.outputs.reduce((n,o)=>n+o.value,0n)===draft.fee,'SIGNER_CONSERVATION');
      const utxos=draft.inputUtxos.map(u=>({value:u.value,spk:u.spk}));
      for(const i of draft.authorizedInputIndices) {
        check(draft.inputUtxos[i].spk.script===spk.script&&draft.inputUtxos[i].spk.version===0&&!draft.inputUtxos[i].covenantId,'SIGNER_INPUT_SCOPE');
        check(draft.transaction.inputs[i].signatureScript==='','SIGNER_ALREADY_SIGNED');
      }
      for(const i of draft.authorizedInputIndices) {
        const hash=schnorrSighash(draft.transaction,utxos,i),sig=schnorrSign(secret,hash,aux());
        check(await schnorrVerify(unhex(key),hash,sig),'LOCAL_SIGNATURE_CHECK');
        draft.transaction.inputs[i].signatureScript='41'+hex(sig)+'01';
      }
    },
  });
}
/** Public-address-only identity for permissionless actions (executor reward recipient). No key, cannot sign. */
export function publicRecipient(address) {
  const {version,payload}=decodeAddress(String(address).trim(),PREFIX);
  check(version===0,'RECIPIENT_P2PK_REQUIRED');
  const key=hex(payload);
  return Object.freeze({kind:'public',canSign:false,address:pubkeyToAddress(key,PREFIX),key,spk:p2pk(key),closed:false,close(){},
    async sign(draft){check(draft.authorizedInputIndices.length===0,'PERMISSIONLESS_SIGNATURE_SCOPE');}});
}
/** Verify EVERY ordinary-input signature of a signed draft (SIGHASH_ALL, owner key read from the spent P2PK script). */
export async function verifyOrdinarySignatures(draft) {
  const utxos=draft.inputUtxos.map(u=>({value:u.value,spk:u.spk}));
  for(const i of draft.authorizedInputIndices) {
    const s=draft.transaction.inputs[i].signatureScript,m=/^20([0-9a-f]{64})ac$/.exec(draft.inputUtxos[i].spk.script);
    check(isSignature(s)&&m&&draft.inputUtxos[i].spk.version===0&&!draft.inputUtxos[i].covenantId,'SIGNATURE_CONTEXT');
    check(await schnorrVerify(unhex(m[1]),schnorrSighash(draft.transaction,utxos,i),unhex(s.slice(2,130))),'SIGNATURE_INVALID');
  }
}
