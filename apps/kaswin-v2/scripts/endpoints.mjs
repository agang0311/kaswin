/** V2 endpoint defaults and one-time migration of saved browser settings. Pure: no DOM, no network.
 * Default node wss://tn10.kaspay.top/wrpc and indexer https://tn10.kaspay.top/indexer.
 * Retired endpoints are removed from defaults and from saved settings. */
const RETIRED_DOMAIN = ['cd311', 'cn'].join('.');
export const RETIRED_HOST = RETIRED_DOMAIN + ':888';
const hostOf = u => { try { return new URL(String(u)).host.toLowerCase(); } catch { return null; } };
export const isRetired = u => {
  const h = hostOf(u);
  return h ? (h === RETIRED_DOMAIN || h.endsWith('.' + RETIRED_DOMAIN) || h.startsWith(RETIRED_DOMAIN + ':')) : false;
};

export const DEFAULT_NODE = 'wss://tn10.kaspay.top/wrpc';
export const DEFAULT_INDEXER = 'https://tn10.kaspay.top/indexer';
/** Explicit V2 list (not derived from the shared Opus constant, so Opus changes cannot silently alter V2 defaults).
 * Public TN10 JSON wRPC nodes are ordered fallbacks, used only if the ones before them are unreachable or unsynced. */
export const DEFAULT_NODES = Object.freeze([
  DEFAULT_NODE,
  'wss://vector-10.kaspa.green/kaspa/testnet-10/wrpc/json',
  'wss://muon-10.kaspa.blue/kaspa/testnet-10/wrpc/json',
  'wss://quark-10.kaspa.red/kaspa/testnet-10/wrpc/json',
  'wss://electron-10.kaspa.stream/kaspa/testnet-10/wrpc/json',
]);
/** Reconciliation cursors saved under the retired URL are carried over to the new node. A cursor is only a chain-block
 * hash: it is re-checked on the current node (selected-chain test / ancestor walk) before any search uses it. */
export const LEGACY_NODE_URLS = Object.freeze([`wss://${RETIRED_HOST}/wrpc`]);

/** Advisory only: never rewrites a transport or prevents saving a valid URL. Browser policy is independent of syntax. */
export function connectionNotices({nodes = [], indexer, pageUrl = globalThis.location?.href} = {}) {
  const urls = [...nodes, ...(indexer ? [indexer] : [])].map(u => new URL(u));
  const plain = urls.filter(u => ['ws:', 'http:'].includes(u.protocol));
  const loopback = u => /^(localhost|.*\.localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(u.hostname);
  const page = pageUrl ? new URL(pageUrl) : null, notices = [];
  if (page?.protocol === 'https:' && plain.some(u => !loopback(u))) {
    notices.push('本页通过 HTTPS 打开，浏览器通常会拦截到 ws:// 节点或 http:// 索引器的明文连接（混合内容）。可以保存，但连接可能失败。无需给节点办证书：可在可信设备上用本地 HTTP 打开此 HTML；或使用可信的 HTTPS/WSS 代理。页面不能绕过浏览器限制，也不会自动改写协议。');
  }
  if (urls.some(loopback)) {
    notices.push('127.0.0.1、localhost、[::1] 指打开浏览器的这台设备，不是托管网页的服务器。手机访问电脑上的服务时，应填写电脑的局域网 IP。HTTPS 访问回环地址的例外及本地网络授权因浏览器而异，保存成功不等于连接成功。');
  }
  if (plain.length) notices.push('ws:// 与 http:// 无需 TLS 证书，但不加密，传输可被篡改；请仅在可信设备或网络使用。局域网 HTTP 网页本身也可能被篡改，不能只靠交易检查消除风险。');
  return notices;
}

export const CONFIG_VERSION = 4;
const LOCAL_V1 = /\/\/(127\.0\.0\.1|localhost|192\.168\.1\.201)(:|\/|$)/;
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Saved {nodes, indexer} -> migrated values; null means "use the current defaults". */
export function migrateConfig({version = 0, nodes = null, indexer = null} = {}) {
  let n = Array.isArray(nodes) && nodes.length && nodes.every(u => typeof u === 'string' && u) ? [...nodes] : null;
  let i = typeof indexer === 'string' && indexer ? indexer : null;
  if (version < 2) { // 2026-10-01 lists that forced 127.0.0.1 / 192.168.1.201 first (unreachable for remote visitors)
    if (n && n.some(u => LOCAL_V1.test(u))) n = null;
    if (i && LOCAL_V1.test(i)) i = null;
  }
  if (version < 4) { // retire old endpoints; replace in place so a custom list keeps its other entries
    if (n) { n = [...new Set(n.map(u => isRetired(u) ? DEFAULT_NODE : u))]; if (same(n, DEFAULT_NODES)) n = null; }
    if (i && isRetired(i)) i = null;
  }
  return {version: CONFIG_VERSION, nodes: n, indexer: i};
}
