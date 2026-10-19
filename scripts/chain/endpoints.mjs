/** Endpoint settings helpers. Defaults are supplied by the selected network, never inferred here. */
import {requireNet} from './network-schema.mjs';
export const RETIRED_HOSTS = new Set(['legacy.kaspa.test:18210', 'legacy.kaspa.test', 'retired.invalid']);
const hostOf = u => { try { return new URL(String(u)).host.toLowerCase(); } catch { return null; } };
export const isRetired = u => {
  const h = hostOf(u);
  return h ? RETIRED_HOSTS.has(h) : false;
};

export function webEndpoints(net) {
  requireNet(net);
  const nodes = net.web?.nodes ?? net.nodes;
  return {node: nodes[0], nodes, indexer: net.web ? net.web.indexer : net.indexer};
}
/** Reconciliation cursors saved under legacy URLs are carried over to the new node. A cursor is only a chain-block
 * hash: it is re-checked on the current node (selected-chain test / ancestor walk) before any search uses it. */
export const LEGACY_NODE_URLS = Object.freeze([]);

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
export function migrateConfig({version = 0, nodes = null, indexer = null} = {}, net) {
  const {node: DEFAULT_NODE, nodes: DEFAULT_NODES} = webEndpoints(net);
  let n = Array.isArray(nodes) && nodes.length && nodes.every(u => typeof u === 'string' && u) ? [...nodes] : null;
  let i = typeof indexer === 'string' && indexer ? indexer : null;
  if (net.web?.legacyConfig && version < 2) {
    if (n && n.some(u => LOCAL_V1.test(u))) n = null;
    if (i && LOCAL_V1.test(i)) i = null;
  }
  if (net.web?.legacyConfig && version < 4) {
    if (n) { n = [...new Set(n.map(u => isRetired(u) ? DEFAULT_NODE : u))]; if (same(n, DEFAULT_NODES)) n = null; }
    if (i && isRetired(i)) i = null;
  }
  return {version: CONFIG_VERSION, nodes: n, indexer: i};
}
