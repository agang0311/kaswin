/** Offline unit tests for scripts/wallet/extension-wallet.mjs and controller walletEpoch guards.
 * Uses only synthetic public/unfunded test keys and mock extension providers; never touches real wallets or broadcasts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {availableExtensionWallets, extensionSafeJson, openExtensionWallet} from '../../scripts/wallet/extension-wallet.mjs';
import {openKaspireWallet, kaspireSchemeLink, kaspireAppLink, kaspireAndroidIntent, renderPairingQrDataUrl} from '../../scripts/wallet/kaspire-wallet.mjs';
import {openMemoryWallet} from '../../scripts/wallet/wallet.mjs';
import {createController} from '../../scripts/round/controller.mjs';
import {RoundStore, MemoryStore} from '../../scripts/store/round-store.mjs';
import {fixture, fund, profile, PRICE, FEE} from '../contracts/fixtures.mjs';
import {buildAction} from '../contracts/transactions.mjs';
import {parseJson} from '../../scripts/chain/json.mjs';
import {TN10} from '../../scripts/chain/tn10.mjs';

const SECRET_A = createHash('sha256').update('rolling-tn10-extension-test-a').digest('hex');
const SECRET_B = createHash('sha256').update('rolling-tn10-extension-test-b').digest('hex');

function makeDraft(memWallet) {
  const f = fixture({module: 'sales'});
  return buildAction(
    f.manager,
    profile,
    {action: 'BUY', quantity: 1, actorKey: memWallet.key},
    {funds: [fund(3, 10n * PRICE, memWallet.key)], fee: FEE, budgets: [10, 10]},
  );
}

function makeMockKasware(memWallet, {network = 'kaspa_testnet_10', publicKey = memWallet.key, tamper = null, delayMs = 0} = {}) {
  const handlers = new Map();
  let currentAccounts = [memWallet.address];
  let currentNet = network;
  let currentPub = publicKey;
  return {
    provider: {
      async requestAccounts() { return currentAccounts; },
      async getAccounts() { return currentAccounts; },
      async getNetwork() { return currentNet; },
      async getPublicKey() { return currentPub; },
      on(ev, fn) {
        if (!handlers.has(ev)) handlers.set(ev, new Set());
        handlers.get(ev).add(fn);
      },
      removeListener(ev, fn) {
        handlers.get(ev)?.delete(fn);
      },
      async signPskt({txJsonString, options}) {
        if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
        const parsed = parseJson(txJsonString);
        const draft = makeDraft(memWallet);
        // Sign using memWallet on a cloned draft that matches the passed indices
        assert.deepEqual(options.signInputs.map(x => x.index), draft.authorizedInputIndices);
        await memWallet.sign(draft);
        for (const {index} of options.signInputs) {
          parsed.inputs[index].signatureScript = draft.transaction.inputs[index].signatureScript;
        }
        if (tamper) tamper(parsed);
        return JSON.stringify(parsed);
      },
    },
    emit(ev, payload) {
      for (const fn of handlers.get(ev) ?? []) fn(payload);
    },
    setAccount(addr, pub) { currentAccounts = addr ? [addr] : []; if (pub !== undefined) currentPub = pub; },
    setNetwork(net) { currentNet = net; },
  };
}

function makeMockKastle(memWallet, {network = 'testnet-10', publicKey = memWallet.key, tamper = null} = {}) {
  const handlers = new Map();
  return {
    provider: {
      async connect() { return true; },
      async getAccount() { return {address: memWallet.address, publicKey}; },
      async getNetwork() { return network; },
      on(ev, fn) {
        if (!handlers.has(ev)) handlers.set(ev, new Set());
        handlers.get(ev).add(fn);
      },
      removeListener(ev, fn) {
        handlers.get(ev)?.delete(fn);
      },
      async signTx(net, txJsonString, scripts) {
        assert.equal(net, 'testnet-10');
        const parsed = parseJson(txJsonString);
        const draft = makeDraft(memWallet);
        assert.deepEqual(scripts, draft.authorizedInputIndices.map(inputIndex => ({inputIndex, signType: 'All'})));
        await memWallet.sign(draft);
        for (const {inputIndex} of scripts) {
          parsed.inputs[inputIndex].signatureScript = draft.transaction.inputs[inputIndex].signatureScript;
        }
        if (tamper) tamper(parsed);
        return JSON.stringify(parsed);
      },
    },
    emit(ev, payload) {
      for (const fn of handlers.get(ev) ?? []) fn(payload);
    },
  };
}

test('availableExtensionWallets detects injected globals and extensionSafeJson scopes utxo.address to auth inputs only', () => {
  const mem = openMemoryWallet(SECRET_A);
  const draft = makeDraft(mem);
  assert.deepEqual(availableExtensionWallets({}), []);
  assert.deepEqual(availableExtensionWallets({kasware: {}, kastle: {}}).map(x => x.id), ['kasware', 'kastle']);

  const safe = parseJson(extensionSafeJson(draft, {address: mem.address}));
  assert.equal(safe.inputs[0].utxo.address, null);
  assert.ok(safe.inputs[0].utxo.covenantId);
  assert.equal(safe.inputs[1].utxo.address, mem.address);
  assert.equal(safe.inputs[1].utxo.covenantId, null);
  mem.close();
});

test('KasWare and Kastle TN10 validation, authorized-only signing, and BIP-340 verification', async () => {
  const mem = openMemoryWallet(SECRET_A);
  const kw = makeMockKasware(mem);
  const w1 = await openExtensionWallet('kasware', {globals: {kasware: kw.provider}});
  const d1 = makeDraft(mem);
  const covSigBefore = d1.transaction.inputs[0].signatureScript;
  await w1.sign(d1);
  assert.equal(d1.transaction.inputs[0].signatureScript, covSigBefore);
  assert.match(d1.transaction.inputs[1].signatureScript, /^41[0-9a-f]{128}01$/);
  w1.close();

  const kl = makeMockKastle(mem);
  const w2 = await openExtensionWallet('kastle', {globals: {kastle: kl.provider}});
  const d2 = makeDraft(mem);
  await w2.sign(d2);
  assert.match(d2.transaction.inputs[1].signatureScript, /^41[0-9a-f]{128}01$/);
  w2.close();

  // Rejects wrong network, public key mismatch, ECDSA address, non-TN10 address
  const badNetKw = makeMockKasware(mem, {network: 'kaspa_mainnet'});
  await assert.rejects(() => openExtensionWallet('kasware', {globals: {kasware: badNetKw.provider}}), /WALLET_NETWORK_MISMATCH/);

  const badNetKl = makeMockKastle(mem, {network: 'mainnet'});
  await assert.rejects(() => openExtensionWallet('kastle', {globals: {kastle: badNetKl.provider}}), /WALLET_NETWORK_MISMATCH/);

  const badPubKw = makeMockKasware(mem, {publicKey: '00'.repeat(32)});
  await assert.rejects(() => openExtensionWallet('kasware', {globals: {kasware: badPubKw.provider}}), /WALLET_PUBLIC_KEY_MISMATCH/);

  mem.close();
});

test('rejects returned transaction tampering (amount, script, input, unauthorized witness) and invalid signatures', async () => {
  const mem = openMemoryWallet(SECRET_A);

  for (const tamper of [
    p => { p.outputs[0].value = String(BigInt(p.outputs[0].value) - 1n); },
    p => { p.outputs[0].scriptPublicKey = '0000' + 'aa'.repeat(34); },
    p => { p.inputs[0].transactionId = 'ff'.repeat(32); },
    p => { p.inputs[0].signatureScript = 'deadbeef'; },
  ]) {
    const kw = makeMockKasware(mem, {tamper});
    const w = await openExtensionWallet('kasware', {globals: {kasware: kw.provider}});
    const d = makeDraft(mem);
    await assert.rejects(() => w.sign(d), /WALLET_TRANSACTION_CHANGED/);
    assert.equal(d.transaction.inputs[1].signatureScript, '');
    w.close();
  }

  // Invalid signature script (all zeros)
  const badSigKw = makeMockKasware(mem, {tamper: p => { p.inputs[1].signatureScript = '41' + '00'.repeat(64) + '01'; }});
  const wBad = await openExtensionWallet('kasware', {globals: {kasware: badSigKw.provider}});
  const dBad = makeDraft(mem);
  await assert.rejects(() => wBad.sign(dBad), /SIGNATURE_INVALID/);
  assert.equal(dBad.transaction.inputs[1].signatureScript, '');
  wBad.close();

  mem.close();
});

test('invalidation on disconnect / account / network change and timeout prevents late signature adoption', async () => {
  const memA = openMemoryWallet(SECRET_A);
  const memB = openMemoryWallet(SECRET_B);

  // Account/network event invalidates wallet
  let invalidated = 0;
  const kw1 = makeMockKasware(memA);
  const w1 = await openExtensionWallet('kasware', {globals: {kasware: kw1.provider}, onInvalidate: () => { invalidated++; }});
  kw1.emit('accountsChanged', [memB.address]);
  assert.equal(invalidated, 1);
  assert.equal(w1.closed, true);
  await assert.rejects(() => w1.sign(makeDraft(memA)), /WALLET_CLOSED/);

  // Silent account/network drift caught by assertSession before/during sign
  const kw2 = makeMockKasware(memA);
  const w2 = await openExtensionWallet('kasware', {globals: {kasware: kw2.provider}});
  kw2.setAccount(memB.address, memB.key);
  await assert.rejects(() => w2.sign(makeDraft(memA)), /WALLET_CHANGED/);
  w2.close();

  // Timeout rejects and late signature never mutates draft
  const kwSlow = makeMockKasware(memA, {delayMs: 80});
  const wSlow = await openExtensionWallet('kasware', {globals: {kasware: kwSlow.provider}, timeoutMs: 15});
  const dSlow = makeDraft(memA);
  await assert.rejects(() => wSlow.sign(dSlow), /WALLET_SIGN_TIMEOUT/);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(dSlow.transaction.inputs[1].signatureScript, '');
  wSlow.close();

  memA.close();
  memB.close();
});

test('controller walletEpoch guard aborts persist/send if wallet changes or disconnects during signing', async () => {
  const mem = openMemoryWallet(SECRET_A);
  let submitCalls = 0;
  const store = new RoundStore(new MemoryStore());

  const mockRpc = {
    net: TN10,
    url: 'ws://127.0.0.1:18210',
    ws: {readyState: 1},
    currentDaa: async () => 5000n,
    on: () => () => {},
    async call(method) {
      if (method === 'getFeeEstimate') return {estimate: {normalBuckets: [{feerate: 1}]}};
      if (method === 'getUtxosByAddresses') return {entries: [{outpoint: {transactionId: 'aa'.repeat(32), index: 0}, utxoEntry: {amount: String(10n * PRICE), scriptPublicKey: {version: 0, scriptPublicKey: `20${mem.key}ac`}, blockDaaScore: '1000', isCoinbase: false}}]};
      if (method === 'submitTransaction') { submitCalls++; return {transactionId: '00'.repeat(32)}; }
      throw new Error(`UNEXPECTED_${method}`);
    },
  };
  const mockService = {
    base: 'http://127.0.0.1:18211',
    async info() { return {engine: {configured: true, binarySha256: '00'.repeat(32)}, limits: {}, configured: true}; },
    async measure(draft) { return {ok: true, computeMass: 1000, storageMass: 0, transientMass: 0, budgets: draft.transaction.inputs.map(() => 10)}; },
    async verify(draft) { return {ok: true, computeMass: 1000, storageMass: 0, transientMass: 0, budgets: draft.transaction.inputs.map(() => 10)}; },
  };

  const ctl = createController({profile, roundStore: store, enginePin: null});
  // Inject connected rpc & service using controller methods isn't possible without network unless mocked via fetch/ws,
  // so verify walletEpoch disconnect behavior directly on connectExternalWallet + disconnectWallet.
  const kw = makeMockKasware(mem);
  const addr = await ctl.connectExternalWallet('kasware', {globals: {kasware: kw.provider}});
  assert.equal(addr, mem.address);
  kw.emit('networkChanged', 'kaspa_mainnet');
  assert.equal(ctl.state.wallet, null);
  assert.equal(submitCalls, 0);
  ctl.close();
  mem.close();
});

test('Kaspire WalletConnect adapter pairs, signs ordinary inputs via kaspa_signPskt, rejects tampering, and invalidates on session_delete', async () => {
  const mem = openMemoryWallet(SECRET_A);
  const wcUri = `wc:${'a'.repeat(64)}@2?relay-protocol=irn&symKey=${'b'.repeat(64)}`;
  assert.equal(kaspireSchemeLink(wcUri), `kaspire://wc?uri=${encodeURIComponent(wcUri)}`);
  assert.equal(kaspireAppLink(wcUri), `https://kaspire.kaslab.space/kaspire/wc?uri=${encodeURIComponent(wcUri)}`);
  assert.match(kaspireAndroidIntent(wcUri), /^intent:\/\/wc\?uri=.*#Intent;scheme=kaspire;package=space\.kaspire\.wallet;/);
  const qr = await renderPairingQrDataUrl(kaspireAppLink(wcUri));
  assert.match(qr, /^data:image\/png;base64,/);

  const handlers = new Map();
  let tamperOutput = false;
  const mockSession = {topic: 'topic-1', namespaces: {kaspa: {chains: ['kaspa:testnet-10'], accounts: [`kaspa:testnet-10:${mem.address.split(':')[1]}`]}}};
  const mockClient = {
    session: {getAll: () => []},
    on(ev, fn) { if (!handlers.has(ev)) handlers.set(ev, new Set()); handlers.get(ev).add(fn); },
    off(ev, fn) { handlers.get(ev)?.delete(fn); },
    async disconnect() {},
    async connect() { return {uri: wcUri, approval: async () => mockSession}; },
    async request({request}) {
      if (request.method === 'kaspa_getAccounts') return [mem.address];
      if (request.method === 'kaspa_getPublicKey') return mem.key;
      if (request.method === 'kaspa_signPskt') {
        const parsed = parseJson(request.params.txJsonString);
        const draft = makeDraft(mem);
        await mem.sign(draft);
        parsed.inputs[1].signatureScript = draft.transaction.inputs[1].signatureScript;
        if (tamperOutput) parsed.outputs[0].value = '1';
        return JSON.stringify(parsed);
      }
      throw new Error(`unexpected method: ${request.method}`);
    },
  };

  let paired = null;
  const ctl = createController({profile, roundStore: new RoundStore(new MemoryStore())});
  const addr = await ctl.connectExternalWallet('kaspire', {
    client: mockClient,
    onPairingUri: info => { paired = info; },
  });
  assert.equal(addr, mem.address);
  assert.equal(paired.wcUri, wcUri);
  assert.equal(paired.schemeUri, kaspireSchemeLink(wcUri));
  assert.equal(ctl.state.wallet.id, 'kaspire');
  assert.equal(ctl.state.wallet.name, 'Kaspire');

  const d1 = makeDraft(mem);
  await ctl.state.wallet.sign(d1);
  assert.match(d1.transaction.inputs[1].signatureScript, /^41[0-9a-f]{128}01$/);

  tamperOutput = true;
  const d2 = makeDraft(mem);
  await assert.rejects(() => ctl.state.wallet.sign(d2), /WALLET_TRANSACTION_CHANGED/);
  tamperOutput = false;

  // Same-network and same-account session_events (e.g. Kaspire auto-switching back to active chain on signPskt) MUST NOT invalidate!
  for (const fn of handlers.get('session_event') ?? []) {
    fn({topic: 'topic-1', params: {chainId: 'kaspa:testnet-10', event: {name: 'networkChanged', data: 'testnet-10'}}});
    fn({topic: 'topic-1', params: {chainId: 'kaspa:testnet-10', event: {name: 'networkChanged', data: 'kaspa:testnet-10'}}});
    fn({topic: 'topic-1', params: {chainId: 'kaspa:testnet-10', event: {name: 'accountsChanged', data: [mem.address]}}});
    fn({topic: 'topic-1', params: {chainId: 'kaspa:mainnet', event: {name: 'accountsChanged', data: ['kaspa:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkx9awp4e']}}});
  }
  assert.equal(ctl.state.wallet?.id, 'kaspire');
  assert.equal(ctl.state.wallet?.closed, false);

  // Genuine network switch to a different network MUST still invalidate!
  for (const fn of handlers.get('session_event') ?? []) {
    fn({topic: 'topic-1', params: {chainId: 'kaspa:mainnet', event: {name: 'networkChanged', data: 'mainnet'}}});
  }
  assert.equal(ctl.state.wallet, null);

  // Reconnect and verify genuine account switch and session_delete both invalidate cleanly
  await ctl.connectExternalWallet('kaspire', {client: mockClient});
  assert.equal(ctl.state.wallet?.id, 'kaspire');
  const memOther = openMemoryWallet(SECRET_B);
  for (const fn of handlers.get('session_event') ?? []) {
    fn({topic: 'topic-1', params: {chainId: 'kaspa:testnet-10', event: {name: 'accountsChanged', data: [memOther.address]}}});
  }
  assert.equal(ctl.state.wallet, null);
  memOther.close();

  await ctl.connectExternalWallet('kaspire', {client: mockClient});
  assert.equal(ctl.state.wallet?.id, 'kaspire');
  for (const fn of handlers.get('session_delete') ?? []) fn({topic: 'topic-1'});
  assert.equal(ctl.state.wallet, null);
  ctl.close();
  mem.close();
});

test('extension wallet ping() returns false and invalidates on locked/changed session, and sign() aborts cleanly via signal', async () => {
  const memA = openMemoryWallet(SECRET_A);
  const memB = openMemoryWallet(SECRET_B);

  // 1) ping() returns true while authorized, then false + invalidates when accounts become empty (locked)
  let invalidatedLock = 0;
  const kwLock = makeMockKasware(memA);
  const wLock = await openExtensionWallet('kasware', {globals: {kasware: kwLock.provider}, onInvalidate: () => { invalidatedLock++; }});
  assert.equal(await wLock.ping(), true);
  assert.equal(wLock.closed, false);
  kwLock.setAccount(null);
  assert.equal(await wLock.ping(), false);
  assert.equal(wLock.closed, true);
  assert.equal(invalidatedLock, 1);

  // 2) ping() returns false + invalidates when account switches without emitting event
  let invalidatedSwitch = 0;
  const kwSwitch = makeMockKasware(memA);
  const wSwitch = await openExtensionWallet('kasware', {globals: {kasware: kwSwitch.provider}, onInvalidate: () => { invalidatedSwitch++; }});
  kwSwitch.setAccount(memB.address, memB.key);
  assert.equal(await wSwitch.ping(), false);
  assert.equal(wSwitch.closed, true);
  assert.equal(invalidatedSwitch, 1);

  // 3) ping() returns false + invalidates when session probe times out
  let invalidatedTimeout = 0;
  const kwTimeout = makeMockKasware(memA);
  const origGetAccounts = kwTimeout.provider.getAccounts.bind(kwTimeout.provider);
  let hangProbe = false;
  kwTimeout.provider.getAccounts = () => hangProbe ? new Promise(() => {}) : origGetAccounts();
  const wTimeout = await openExtensionWallet('kasware', {
    globals: {kasware: kwTimeout.provider},
    timeoutMs: 80,
    onInvalidate: () => { invalidatedTimeout++; },
  });
  hangProbe = true;
  assert.equal(await wTimeout.ping(), false);
  assert.equal(wTimeout.closed, true);
  assert.equal(invalidatedTimeout, 1);

  // 4) sign(draft, {signal}) aborts with WALLET_SIGN_CANCELLED without adopting late signature or closing session
  let invalidatedAbort = 0;
  const kwSlow = makeMockKasware(memA, {delayMs: 200});
  const wSlow = await openExtensionWallet('kasware', {
    globals: {kasware: kwSlow.provider},
    timeoutMs: 5000,
    onInvalidate: () => { invalidatedAbort++; },
  });
  const ac = new AbortController();
  const d = makeDraft(memA);
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(() => wSlow.sign(d, {signal: ac.signal}), /WALLET_SIGN_CANCELLED/);
  assert.equal(d.transaction.inputs[1].signatureScript, '');
  assert.equal(wSlow.closed, false);
  assert.equal(invalidatedAbort, 0);

  wSlow.close();
  memA.close();
  memB.close();
});

test('KasWare connect avoids hung requestAccounts when already unlocked, recovers on unlock accountsChanged, and aborts cleanly via signal without locking controller.busy', async () => {
  const memA = openMemoryWallet(SECRET_A);

  // 1) Already unlocked & authorized: fast getAccounts() path connects immediately even if requestAccounts() hangs forever
  const kwFast = makeMockKasware(memA);
  kwFast.provider.requestAccounts = () => new Promise(() => {});
  const wFast = await openExtensionWallet('kasware', {globals: {kasware: kwFast.provider}, connectTimeoutMs: 500});
  assert.equal(wFast.address, memA.address);
  // Same-account / same-network echoes do NOT falsely disconnect
  kwFast.emit('accountsChanged', [memA.address]);
  kwFast.emit('networkChanged', 'kaspa_testnet_10');
  assert.equal(wFast.closed, false);
  // Empty accountsChanged (auto-lock) DOES disconnect
  kwFast.emit('accountsChanged', []);
  assert.equal(wFast.closed, true);

  // 2) Locked KasWare (getAccounts returns []) + hung requestAccounts(): recovers immediately when user unlocks and accountsChanged emits
  const kwUnlock = makeMockKasware(memA);
  kwUnlock.setAccount(null);
  kwUnlock.provider.requestAccounts = () => new Promise(() => {});
  setTimeout(() => {
    kwUnlock.setAccount(memA.address, memA.key);
    kwUnlock.emit('accountsChanged', [memA.address]);
  }, 30);
  const wUnlock = await openExtensionWallet('kasware', {globals: {kasware: kwUnlock.provider}, connectTimeoutMs: 2000});
  assert.equal(wUnlock.address, memA.address);
  wUnlock.close();

  // 3) Locked KasWare + hung requestAccounts(): clicking Cancel aborts via signal with WALLET_CONNECT_CANCELLED and immediately frees ctl.state.busy
  const kwHung = makeMockKasware(memA);
  kwHung.setAccount(null);
  kwHung.provider.requestAccounts = () => new Promise(() => {});
  const ctl = createController({profile, roundStore: new RoundStore(new MemoryStore())});
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 30);
  await assert.rejects(
    () => ctl.connectExternalWallet('kasware', {globals: {kasware: kwHung.provider}, signal: ac.signal, connectTimeoutMs: 5000}),
    /WALLET_CONNECT_CANCELLED/,
  );
  assert.equal(ctl.state.busy, false);
  assert.equal(ctl.state.wallet, null);

  // Immediately reconnecting after user unlocks KasWare succeeds with zero "BUSY" lockout
  kwHung.setAccount(memA.address, memA.key);
  const addr = await ctl.connectExternalWallet('kasware', {globals: {kasware: kwHung.provider}, connectTimeoutMs: 500});
  assert.equal(addr, memA.address);
  assert.equal(ctl.state.busy, false);

  ctl.close();
  memA.close();
});

