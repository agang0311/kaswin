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

/** Splice a 65-byte Schnorr signature (64B sig || 0x01 SIGHASH_ALL) into zero-filled 65B slots of a prebuilt script witness. */
export function spliceScriptSignature(prebuiltHex,offsets,sig65Hex) {
  check(typeof prebuiltHex==='string'&&prebuiltHex.length>0&&prebuiltHex.length%2===0&&/^[0-9a-f]+$/.test(prebuiltHex),'SCRIPT_WITNESS_HEX');
  check(typeof sig65Hex==='string'&&/^[0-9a-f]{128}01$/.test(sig65Hex),'SIGNATURE_INVALID');
  check(Array.isArray(offsets)&&offsets.length>=1,'SCRIPT_WITNESS_OFFSETS');
  const zeroSlot='00'.repeat(65);
  let out=prebuiltHex;
  for(const off of offsets) {
    check(Number.isInteger(off)&&off>=0&&(off+65)*2<=prebuiltHex.length,'SCRIPT_WITNESS_OFFSET_BOUNDS');
    const start=off*2,end=(off+65)*2;
    check(prebuiltHex.slice(start,end)===zeroSlot,'SCRIPT_WITNESS_SLOT_NONZERO');
    out=out.slice(0,start)+sig65Hex+out.slice(end);
  }
  return out;
}

/** Verify EVERY script-input signature (e.g. KCC-20 P2SH witness) and ensure no bytes outside signatureOffsets changed. */
export async function verifyScriptSignatures(draft) {
  const scriptInputs=draft?.scriptInputs;
  if(!Array.isArray(scriptInputs)||!scriptInputs.length)return;
  const utxos=draft.inputUtxos.map(u=>({value:u.value,spk:u.spk}));
  const zeroSlot='00'.repeat(65);
  for(const si of scriptInputs) {
    const idx=si?.inputIndex;
    check(Number.isInteger(idx)&&idx>=0&&idx<draft.transaction.inputs.length,'SCRIPT_SIGNATURE_CONTEXT');
    check(!!draft.inputUtxos[idx]?.covenantId,'SCRIPT_SIGNATURE_CONTEXT');
    check(typeof si.ownerKey==='string'&&/^[0-9a-f]{64}$/.test(si.ownerKey),'SCRIPT_SIGNATURE_CONTEXT');
    check(typeof si.prebuiltSignatureScript==='string'&&si.prebuiltSignatureScript.length>0,'SCRIPT_SIGNATURE_CONTEXT');
    check(Array.isArray(si.signatureOffsets)&&si.signatureOffsets.length>=1,'SCRIPT_SIGNATURE_CONTEXT');
    const hash=schnorrSighash(draft.transaction,utxos,idx),expectedHex=hex(hash);
    if(si.expectedSighash)check(si.expectedSighash===expectedHex,'SCRIPT_SIGHASH_MISMATCH');
    const signed=String(draft.transaction.inputs[idx].signatureScript??'').toLowerCase();
    check(signed.length===si.prebuiltSignatureScript.length,'SCRIPT_SIGNATURE_LENGTH');
    let masked=signed;
    for(const off of si.signatureOffsets) {
      check(Number.isInteger(off)&&off>=0&&(off+65)*2<=signed.length,'SCRIPT_WITNESS_OFFSET_BOUNDS');
      const start=off*2,end=(off+65)*2;
      const sig65=signed.slice(start,end);
      check(/^[0-9a-f]{128}01$/.test(sig65),'SIGNATURE_INVALID');
      check(await schnorrVerify(unhex(si.ownerKey),hash,unhex(sig65.slice(0,128))),'SIGNATURE_INVALID');
      masked=masked.slice(0,start)+zeroSlot+masked.slice(end);
    }
    check(masked===si.prebuiltSignatureScript,'SCRIPT_WITNESS_MODIFIED');
  }
}

/** Parse a 32-byte hex key; errors never contain the input. */
function parseKey(text) {
  const t=typeof text==='string'?text.trim().replace(/^0x/i,''):'';
  check(/^[0-9a-fA-F]{64}$/.test(t),'KEY_FORMAT');
  return unhex(t.toLowerCase(),32);
}
export function openMemoryWallet(privateKeyText,{prefix=PREFIX}={}) {
  const secret=parseKey(privateKeyText);
  let key,address;
  try {key=hex(xonlyPubkey(secret));address=pubkeyToAddress(key,prefix);}
  catch {secret.fill(0);throw Object.assign(new Error('KEY_INVALID'),{code:'KEY_INVALID'});}
  let closed=false;const spk=p2pk(key);
  return Object.freeze({
    kind:'key',canSign:true,address,key,spk,
    capabilities:Object.freeze({supportsCovenantTxV1:true,selectiveSigning:true}),
    get closed(){return closed;},
    close(){secret.fill(0);closed=true;},
    /** SIGHASH_ALL for every authorized (ordinary P2PK) input and script input, each verified locally before it is accepted. */
    async sign(draft) {
      check(!closed,'WALLET_CLOSED');
      const scriptInputs=Array.isArray(draft.scriptInputs)?draft.scriptInputs:[];
      if(!draft.authorizedInputIndices.length&&!scriptInputs.length)return;
      check(typeof draft.fee==='bigint'&&draft.fee>0n&&draft.fee<=FEE_CAP,'SIGNER_FEE_SCOPE');
      check(draft.inputUtxos.reduce((n,u)=>n+u.value,0n)-draft.transaction.outputs.reduce((n,o)=>n+o.value,0n)===draft.fee,'SIGNER_CONSERVATION');
      const utxos=draft.inputUtxos.map(u=>({value:u.value,spk:u.spk}));
      for(const i of draft.authorizedInputIndices) {
        check(draft.inputUtxos[i].spk.script===spk.script&&draft.inputUtxos[i].spk.version===0&&!draft.inputUtxos[i].covenantId,'SIGNER_INPUT_SCOPE');
        check(draft.transaction.inputs[i].signatureScript==='','SIGNER_ALREADY_SIGNED');
      }
      for(const si of scriptInputs) {
        const i=si.inputIndex;
        check(Number.isInteger(i)&&i>=0&&i<draft.transaction.inputs.length,'SIGNER_INPUT_SCOPE');
        check(!!draft.inputUtxos[i]?.covenantId&&si.ownerKey===key,'SIGNER_INPUT_SCOPE');
        check(draft.transaction.inputs[i].signatureScript===si.prebuiltSignatureScript,'SIGNER_ALREADY_SIGNED');
      }
      for(const i of draft.authorizedInputIndices) {
        const hash=schnorrSighash(draft.transaction,utxos,i),sig=schnorrSign(secret,hash,aux());
        check(await schnorrVerify(unhex(key),hash,sig),'LOCAL_SIGNATURE_CHECK');
        draft.transaction.inputs[i].signatureScript='41'+hex(sig)+'01';
      }
      for(const si of scriptInputs) {
        const i=si.inputIndex,hash=schnorrSighash(draft.transaction,utxos,i);
        if(si.expectedSighash)check(hex(hash)===si.expectedSighash,'SCRIPT_SIGHASH_MISMATCH');
        const sig=schnorrSign(secret,hash,aux());
        check(await schnorrVerify(unhex(key),hash,sig),'LOCAL_SIGNATURE_CHECK');
        draft.transaction.inputs[i].signatureScript=spliceScriptSignature(si.prebuiltSignatureScript,si.signatureOffsets,hex(sig)+'01');
      }
    },
  });
}
/** Public-address-only identity for permissionless actions (executor reward recipient). No key, cannot sign. */
export function publicRecipient(address,{prefix=PREFIX}={}) {
  const {version,payload}=decodeAddress(String(address).trim(),prefix);
  check(version===0,'RECIPIENT_P2PK_REQUIRED');
  const key=hex(payload);
  return Object.freeze({kind:'public',canSign:false,address:pubkeyToAddress(key,prefix),key,spk:p2pk(key),
    capabilities:Object.freeze({supportsCovenantTxV1:false,selectiveSigning:false}),closed:false,close(){},
    async sign(draft){check(draft.authorizedInputIndices.length===0,'PERMISSIONLESS_SIGNATURE_SCOPE');}});
}
/** Verify EVERY ordinary-input and script-input signature of a signed draft (SIGHASH_ALL). */
export async function verifyOrdinarySignatures(draft) {
  const utxos=draft.inputUtxos.map(u=>({value:u.value,spk:u.spk}));
  for(const i of draft.authorizedInputIndices) {
    const s=draft.transaction.inputs[i].signatureScript,m=/^20([0-9a-f]{64})ac$/.exec(draft.inputUtxos[i].spk.script);
    check(isSignature(s)&&m&&draft.inputUtxos[i].spk.version===0&&!draft.inputUtxos[i].covenantId,'SIGNATURE_CONTEXT');
    check(await schnorrVerify(unhex(m[1]),schnorrSighash(draft.transaction,utxos,i),unhex(s.slice(2,130))),'SIGNATURE_INVALID');
  }
  await verifyScriptSignatures(draft);
}
