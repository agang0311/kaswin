// 由 64 位十六进制私钥推导 TN10 的 P2PK 地址。不联网、不签名、不广播。
//
//   node tests/web/wallets/derive-address.mjs <64位十六进制私钥>
//   node tests/web/wallets/derive-address.mjs --check <钱包文件.json>
//
// 输出地址与公钥；--check 还会核对钱包文件里的 address 是否与私钥匹配。
import fs from 'node:fs';
import {pubkeyToAddress} from '../../../scripts/wallet/address.mjs';
import {xonlyPubkey} from '../../../scripts/wallet/schnorr.mjs';

const hexToBytes = h => Uint8Array.from(h.match(/.{2}/g).map(b => parseInt(b, 16)));
const bytesToHex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');

function derive(privHex) {
  if (!/^[0-9a-f]{64}$/i.test(privHex)) throw Error('私钥必须是 64 位十六进制（不带 0x）');
  const pub = xonlyPubkey(hexToBytes(privHex.toLowerCase()));
  return { pubkey: bytesToHex(pub), address: pubkeyToAddress(bytesToHex(pub), 'kaspatest') };
}

const args = process.argv.slice(2);

if (args[0] === '--check') {
  const file = args[1];
  if (!file) { console.error('用法: --check <钱包文件.json>'); process.exit(2); }
  const w = JSON.parse(fs.readFileSync(file, 'utf8'));
  const d = derive(w.privateKey);
  const ok = d.address === w.address;
  console.log(`文件:     ${file}`);
  console.log(`network:  ${w.network}`);
  console.log(`文件地址: ${w.address}`);
  console.log(`推导地址: ${d.address}`);
  console.log(`公钥:     ${d.pubkey}`);
  console.log(ok ? '✅ address 与 privateKey 匹配' : '❌ address 与 privateKey 不匹配');
  process.exit(ok ? 0 : 1);
}

const priv = args[0];
if (!priv) {
  console.error('用法: node derive-address.mjs <64位十六进制私钥>');
  console.error('      node derive-address.mjs --check <钱包文件.json>');
  process.exit(2);
}
const d = derive(priv);
console.log(`公钥:   ${d.pubkey}`);
console.log(`地址:   ${d.address}`);
console.log('');
console.log('钱包文件格式:');
console.log(JSON.stringify({
  network: 'testnet-10',
  purpose: 'Kaswin TN10 browser test only',
  address: d.address,
  privateKey: priv.toLowerCase(),
}, null, 2));
