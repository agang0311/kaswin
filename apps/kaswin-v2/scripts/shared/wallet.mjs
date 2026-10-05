/** KasWare adapter. Pinned source: kasware-wallet 78bb30045edd4d898c4d61c4c75ba1bc37e18748
 *  pageProvider: requestAccounts/getAccounts/getNetwork/getPublicKey/signPskt; events accountsChanged/networkChanged.
 *  background wallet.signPskt: Transaction.deserializeFromSafeJSON(txJsonString) -> sign listed inputs -> serializeToSafeJSON().
 * This page never calls sendKaspa/pushTx and never sees a private key. From the wallet response it takes ONLY the
 * 66-byte signature scripts of the inputs it asked to be signed; each is verified (BIP-340) against the page's own
 * sighash of the page's own transaction. Everything else the wallet returns is compared and otherwise ignored.
 */
import {ensure, KASWARE_NETWORK, NETWORK_ID, unhex, hex, errorText} from './core.mjs';
import {parseJson, jsonText} from './lib/json.mjs';
import {addressToSpk, decodeAddress} from './lib/address.mjs';
import {schnorrSighash} from './lib/sighash.mjs';
import {schnorrVerify} from './lib/schnorr.mjs';
import {spkText} from './nodes.mjs';

export const provider = () => globalThis.kasware ?? null;

export async function waitForProvider(ms = 1500) {
  const t0 = Date.now();
  while (!provider() && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 100));
  return provider();
}

/** Current wallet session (address, x-only key, network). Throws with user-facing text. */
export async function readSession(p = provider(), {request = false} = {}) {
  ensure(p, '未检测到 KasWare 钱包扩展。请在桌面浏览器安装 KasWare，并通过 https 或 localhost 打开本页。');
  ensure(typeof p.signPskt === 'function' && typeof p.getPublicKey === 'function', '当前 KasWare 版本不支持 signPskt / getPublicKey，无法用于合约交易');
  const accounts = request ? await p.requestAccounts() : await p.getAccounts();
  ensure(Array.isArray(accounts) && typeof accounts[0] === 'string' && accounts[0].length > 0, '钱包未授权本页账户');
  const network = await p.getNetwork();
  ensure(network === KASWARE_NETWORK, `钱包当前网络是 ${network || '未知'}，请在 KasWare 中手动切换到 Testnet 10 后重新连接（本页不会自动切换网络）`);
  const address = accounts[0];
  const {version, payload} = decodeAddress(address);
  ensure(version === 0, '仅支持 Schnorr 地址（kaspatest:q…）；ECDSA 账户无法签署本协议的输入');
  const key = hex(payload), pub = String(await p.getPublicKey() ?? '').toLowerCase();
  ensure(pub === key || (/^0[23][0-9a-f]{64}$/.test(pub) && pub.slice(2) === key), '钱包返回的公钥与地址不匹配');
  return Object.freeze({address, key, spk: addressToSpk(address), network: NETWORK_ID});
}

/** SDK 2.0.1 safe JSON (Transaction.serializeToSafeJSON shape), built without the SDK. utxo.address is set for
 * wallet-owned inputs so the wallet can recognise them; the covenant input carries no address. */
export function toSafeJson(draft, session) {
  const t = draft.transaction, auth = new Set(draft.authorizedInputIndices);
  return jsonText({
    id: draft.txid,
    version: t.version,
    inputs: t.inputs.map((i, n) => {
      const u = draft.inputUtxos[n];
      return {transactionId: i.previousOutpoint.transactionId, index: i.previousOutpoint.index, sequence: String(i.sequence), sigOpCount: 0, computeBudget: i.computeBudget ?? 0,
        signatureScript: i.signatureScript,
        utxo: {address: auth.has(n) ? session.address : null, amount: String(u.value), scriptPublicKey: spkText(u.spk), blockDaaScore: String(u.daa), isCoinbase: false, covenantId: u.covenantId ?? null}};
    }),
    outputs: t.outputs.map(o => ({value: String(o.value), scriptPublicKey: spkText(o.scriptPublicKey), covenant: o.covenant ? {authorizingInput: o.covenant.authorizingInput, covenantId: o.covenant.covenantId} : null})),
    subnetworkId: t.subnetworkId, lockTime: String(t.lockTime), gas: String(t.gas), storageMass: String(t.storageMass), payload: t.payload,
  });
}

/** Ask the wallet to sign the authorized inputs; returns {signatures: Map(index -> sigScriptHex)} after full verification. */
export async function signWithWallet(draft, session, {p = provider(), onWaiting, timeoutMs = 90000} = {}) {
  const current = await readSession(p);
  ensure(current.address === session.address && current.key === session.key, '钱包账户已变化，计划作废，请重新报价');
  if (!draft.authorizedInputIndices.length) return new Map();
  const request = toSafeJson(draft, session);
  onWaiting?.('等待 KasWare 签名（手机端若未自动弹窗，请查看后台标签页或菜单底部的 KasWare）…');
  let response;
  try {
    const signPromise = p.signPskt({txJsonString: request, options: {signInputs: draft.authorizedInputIndices.map(index => ({index, sighashType: 1}))}});
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('等待钱包签名超时（90秒）。手机端若未自动弹出签名窗口，请查看浏览器标签列表中的 KasWare 页面，或在浏览器菜单最底部点击 KasWare 扩展图标完成核准')), timeoutMs);
    });
    try { response = await Promise.race([signPromise, timeoutPromise]); }
    finally { clearTimeout(timer); }
  }
  catch (e) { throw new Error(`钱包未签名：${errorText(e)}`); }
  ensure(typeof response === 'string' && response.length < 8 * 1024 * 1024, '钱包返回格式错误（应为交易 JSON 字符串）');
  const back = parseJson(response), sent = parseJson(request);
  ensure(Array.isArray(back?.inputs) && back.inputs.length === sent.inputs.length && Array.isArray(back.outputs) && back.outputs.length === sent.outputs.length, '钱包返回的交易输入/输出数量被改变');
  // Fields committed by the v1 sighash must be unchanged; otherwise the returned signatures could not belong to our
  // transaction. Non-committed fields (compute budgets, storage mass) are never taken from the wallet: the page submits
  // ITS OWN transaction with only the verified 66-byte signature scripts inserted.
  const auth = new Set(draft.authorizedInputIndices);
  const committed = j => jsonText({version: Number(j.version), lockTime: String(j.lockTime), gas: String(j.gas), subnetworkId: String(j.subnetworkId).toLowerCase(), payload: String(j.payload ?? '').toLowerCase(),
    inputs: j.inputs.map((i, n) => ({t: String(i.transactionId).toLowerCase(), i: Number(i.index), s: String(i.sequence), sig: auth.has(n) ? '' : String(i.signatureScript ?? '').toLowerCase()})),
    outputs: j.outputs.map(o => ({v: String(o.value), spk: String(o.scriptPublicKey).toLowerCase(), c: o.covenant ? [Number(o.covenant.authorizingInput), String(o.covenant.covenantId).toLowerCase()] : null}))});
  ensure(committed(back) === committed(sent), '钱包修改了交易内容（金额/收款脚本/输入/锁定时间等），已拒绝');
  const echo = j => jsonText(j.inputs.map(i => [Number(i.computeBudget ?? 0), Number(i.sigOpCount ?? 0)]).concat([String(j.storageMass ?? '')]));
  const echoDiffers = echo(back) !== echo(sent);
  const sigs = new Map();
  for (const idx of draft.authorizedInputIndices) {
    const s = String(back.inputs[idx].signatureScript ?? '').toLowerCase();
    ensure(/^41[0-9a-f]{128}01$/.test(s), `钱包没有为输入 ${idx} 返回标准 Schnorr 签名`);
    const msg = schnorrSighash(draft.transaction, draft.inputUtxos, idx);
    ensure(await schnorrVerify(unhex(session.key, 32), msg, unhex(s.slice(2, 130), 64)), `输入 ${idx} 的签名验证失败（与本页计算的签名哈希不符），已拒绝`);
    sigs.set(idx, s);
  }
  const after = await readSession(p);
  ensure(after.address === session.address && after.key === session.key, '签名期间钱包账户发生变化，计划作废');
  sigs.echoDiffers = echoDiffers;
  return sigs;
}

/** Subscribe to wallet account/network changes. Returns an unsubscribe function. */
export function watchWallet(onChange, p = provider()) {
  if (!p?.on) return () => {};
  const a = () => onChange('accounts'), n = () => onChange('network');
  p.on('accountsChanged', a); p.on('networkChanged', n);
  return () => { p.removeListener?.('accountsChanged', a); p.removeListener?.('networkChanged', n); };
}
