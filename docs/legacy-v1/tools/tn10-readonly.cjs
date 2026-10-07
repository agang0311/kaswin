// Official v2.0.1 API checked against the pinned SDK declaration file.
// Public-address-only TN10 probe: no wallet file, secret, signing or submit APIs.
const fs = require('node:fs');
const path = require('node:path');
const sdk = require('/root/kaspa/references/kaspa-wasm32-sdk/nodejs/kaspa');
const root = path.resolve(__dirname, '..');
const publicWallet = JSON.parse(fs.readFileSync(path.join(root, 'research/tn10/wallet-public.json'), 'utf8'));
if (publicWallet.network !== 'testnet-10' || !publicWallet.address.startsWith('kaspatest:')) throw Error('Invalid public wallet');
const stringify = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
const deadline = setTimeout(() => { console.error('TN10 read-only probe timeout'); process.exit(1); }, 45000);
(async () => {
  const resolver = new sdk.Resolver();
  let rpc;
  try {
    // Optional resolver response fetched via system HTTPS transport when WASM HTTP stalls.
    const url = process.env.KASWIN_TN10_RPC_URL || await resolver.getUrl(sdk.Encoding.Borsh, 'testnet-10');
    const u = new URL(url);
    if (!['ws:', 'wss:'].includes(u.protocol) || u.username || u.password) throw Error('Invalid resolver endpoint');
    console.log('Resolved endpoint:', url);
    rpc = new sdk.RpcClient({ url, encoding: sdk.Encoding.Borsh, networkId: 'testnet-10' });
    await rpc.connect({ blockAsyncConnect: true, strategy: 'fallback', timeoutDuration: 10000 });
    const info = await rpc.getServerInfo();
    console.log('Server info:', stringify(info));
    if (String(info.networkId) !== 'testnet-10' || info.isSynced !== true || info.hasUtxoIndex !== true) throw Error('TN10/sync/UTXO gate failed');
    const response = await rpc.getUtxosByAddresses({ addresses: [publicWallet.address] });
    const seen = new Set(); let balance = 0n;
    for (const e of response.entries) {
      const key = `${e.outpoint.transactionId}:${e.outpoint.index}`;
      if (seen.has(key)) throw Error('Duplicate UTXO');
      seen.add(key);
      const amount = e.amount;
      if (typeof amount !== 'bigint' || amount < 0n) throw Error('Unexpected amount type');
      balance += amount;
    }
    const record = { observedAt: new Date().toISOString(), source: 'single resolver-discovered RPC; not independent consensus proof', endpoint: url, serverInfo: info, address: publicWallet.address, balanceSompi: balance, utxos: response.entries };
    const name = `rpc-balance-${Date.now()}.json`;
    fs.writeFileSync(path.join(root, 'research/tn10', name), stringify(record), { flag: 'wx' });
    console.log('Balance sompi:', balance.toString(), 'UTXOs:', seen.size, 'Evidence:', name);
  } finally {
    if (rpc) { await rpc.disconnect(); rpc.free(); }
    resolver.free(); clearTimeout(deadline);
  }
})().catch(e => { clearTimeout(deadline); console.error('Read-only probe failed:', e.message || String(e)); process.exitCode = 1; });
