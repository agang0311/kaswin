// Pure parsing: never import the SDK, read a wallet or open a connection here.
export const PROFILE = '7aaf76fe5e2180070290ff984bebaef54e41093e6a77eef24f2b48fb64c159c8';
export const NETWORK = 'f896a3034873be1739fc4359236899fd3d65d2bc94f9780df0d0da3eb1cc4370';
export function parseArgs(args) {
  const modes = new Set(['--dry', '--verify', '--execute']);
  const values = new Set(['scenario', 'round', 'approval', 'step', 'accepting']);
  const out = {}; let mode;
  for (const arg of args) {
    if (modes.has(arg)) { if (mode) throw Error('MODES_ARE_EXCLUSIVE'); mode = arg.slice(2); continue; }
    const m = /^--([a-z]+)=(.+)$/.exec(arg);
    if (!m || !values.has(m[1]) || Object.hasOwn(out, m[1])) throw Error('UNKNOWN_OR_DUPLICATE_ARGUMENT');
    out[m[1]] = m[2];
  }
  out.mode = mode ?? 'dry';
  if (out.scenario && !['empty', 'refund', 'payout'].includes(out.scenario)) throw Error('UNKNOWN_SCENARIO');
  if (out.round && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(out.round)) throw Error('INVALID_ROUND');
  if (out.step && !/^\d{2}-[A-Z_0-9]+$/.test(out.step)) throw Error('INVALID_STEP');
  if (out.accepting && !/^[0-9a-f]{64}$/.test(out.accepting)) throw Error('INVALID_ACCEPTING_HASH');
  if (out.mode === 'dry') {
    if (out.round || out.approval || out.step || out.accepting) throw Error('DRY_TAKES_SCENARIO_ONLY');
    out.scenario ??= 'empty';
  } else if (out.mode === 'verify') {
    if (!out.round || !out.step || out.scenario || out.approval) throw Error('VERIFY_REQUIRES_ROUND_AND_STEP_ONLY');
  } else if (!out.round || !out.scenario || !out.approval || out.step || out.accepting) throw Error('EXECUTE_REQUIRES_SCENARIO_ROUND_APPROVAL');
  return Object.freeze(out);
}
