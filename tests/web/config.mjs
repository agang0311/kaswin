/** Config loader for the browser test harness.
 *
 *  Precedence (highest first):
 *    1. environment variables (KASWIN_IDX, KASWIN_NODE, KASWIN_PAGE, KASWIN_STEP_MS, KASWIN_WALLETS)
 *    2. tests/web/config/network.json
 *    3. built-in defaults below
 *
 *  Nothing here touches the network. Loading config never connects, signs or submits.
 */
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(HERE, 'config');

function readJson(name, fallback) {
  const p = path.join(CONFIG_DIR, name);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw Error(`配置文件 ${name} 解析失败: ${e.message}`);
  }
}

const DEFAULTS = {
  network: {
    name: 'testnet-10',
    indexer: 'http://127.0.0.1/indexer/tn10',
    node: 'wss://muon-10.kaspa.blue/kaspa/testnet-10/wrpc/json',
    page: 'http://127.0.0.1/kaswin.html',
    contractPrefix: 'kaswin-v2.0.2',
  },
  timing: { stepMs: 30000, quotePollMs: 250, statePollMs: 1200, heartbeatMs: 5000 },
  round: { defaultMinutes: 1 },
  wallets: { dir: null, roles: { creator: 'tn10-test-only.json', b1: 'tn10-f3-buyer-1.json', b2: 'tn10-f3-buyer-2.json' } },
};

const netFile = readJson('network.json', {});

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

export const NETWORK = Object.freeze({
  name: process.env.KASWIN_NET || netFile.network?.name || DEFAULTS.network.name,
  indexer: process.env.KASWIN_IDX || netFile.network?.indexer || DEFAULTS.network.indexer,
  node: process.env.KASWIN_NODE || netFile.network?.node || DEFAULTS.network.node,
  page: process.env.KASWIN_PAGE || netFile.network?.page || DEFAULTS.network.page,
  contractPrefix: process.env.KASWIN_CONTRACT || netFile.network?.contractPrefix || DEFAULTS.network.contractPrefix,
});

export const TIMING = Object.freeze({
  stepMs: num(process.env.KASWIN_STEP_MS, num(netFile.timing?.stepMs, DEFAULTS.timing.stepMs)),
  quotePollMs: num(netFile.timing?.quotePollMs, DEFAULTS.timing.quotePollMs),
  statePollMs: num(netFile.timing?.statePollMs, DEFAULTS.timing.statePollMs),
  heartbeatMs: num(netFile.timing?.heartbeatMs, DEFAULTS.timing.heartbeatMs),
});

export const ROUND = Object.freeze({
  defaultMinutes: num(netFile.round?.defaultMinutes, DEFAULTS.round.defaultMinutes),
});

/** Resolve the wallet directory once. Throws with the list it tried, never prints key material. */
export function walletDir() {
  const raw = process.env.KASWIN_WALLETS || netFile.wallets?.dir || null;
  // A relative dir in the config means "relative to tests/web/", so "./wallets" is tests/web/wallets.
  const configured = raw ? (path.isAbsolute(raw) ? raw : path.join(HERE, raw)) : null;
  const cands = [
    configured,
    path.join(HERE, 'wallets'),
    path.join(HERE, '..', '..', 'wallets'),
  ].filter(Boolean);
  const roles = netFile.wallets?.roles || DEFAULTS.wallets.roles;
  for (const d of cands) {
    if (fs.existsSync(path.join(d, roles.creator))) return d;
  }
  throw Error(`找不到测试钱包目录，试过: ${cands.join(', ')}`);
}

export function walletRoles() {
  return { ...DEFAULTS.wallets.roles, ...(netFile.wallets?.roles || {}) };
}

export const SCENARIOS = readJson('scenarios.json', { scenarios: {} }).scenarios || {};
export const CLEANUP = readJson('cleanup.json', {});

/** Scenario parameters with defaults, so a missing key never yields undefined math. */
export function scenarioParams(n) {
  const s = SCENARIOS[String(n)] || {};
  return {
    name: s.name || `scenario-${n}`,
    title: s.title || '',
    cap: num(s.cap, 10),
    min: num(s.min, 3),
    minutes: num(s.minutes, ROUND.defaultMinutes),
    buys: num(s.buys, 0),
    buy: s.buy || [],
    buyAlternate: s.buyAlternate || ['b1', 'b2'],
    refundBatches: num(s.refundBatches, 8),
    refundAlternate: s.refundAlternate || ['b1', 'b2'],
    expect: s.expect || {},
    enabled: s.enabled !== false,
    reason: s.reason || '',
  };
}

export function scenarioEnabled(n) {
  const s = SCENARIOS[String(n)];
  return !!s && s.enabled !== false;
}
