// Synthetic model only. No SDK, signing, wallet, network, evidence or acceptance files.
import {fileURLToPath} from 'node:url';
import {loadV2Bundle} from '../../contracts/f3.2/tools/linking.mjs';
import * as S from '../../packages/f3.2-core/lib/state.js';
import {buildAction, buildOpenGenesis} from '../../packages/f3.2-core/lib/builders.js';
import {referenceTxId} from '../../packages/f3.2-core/lib/transaction.js';
import {p2pk, p2sh} from '../../packages/f3.2-core/lib/covenant-id.js';
import {hex} from '../../packages/f3.2-core/lib/bytes.js';
import {blake2b256} from '../../packages/f3.2-core/lib/hashes.js';
import {convergeFee} from '../../apps/kaswin-v2/scripts/shared/mass.mjs';
import {PROFILE} from './cli.mjs';
export async function run({scenario}) {
  const {profile} = await loadV2Bundle(fileURLToPath(new URL('../../contracts/f3.2/', import.meta.url)));
  if (profile.id !== PROFILE) throw Error('PROFILE_DRIFT');
  const key = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
  const pool = new Map(), k = o => `${o.transactionId}:${o.index}`;
  pool.set('initial', {outpoint: {transactionId: '11'.repeat(32), index: 0}, value: 10000000000n, spk: p2pk(key), daa: 1n, covenantId: null});
  let score = 1000n, ledger, tip, origin, cid, utxoDaa;
  const take = () => {const f = [...pool.values()].find(f => f.value >= 100000000n); if (!f) throw Error('SYNTHETIC_FUNDS_EXHAUSTED'); return f;};
  function apply(d) {
    const id = referenceTxId(d.transaction);
    for (const f of d.inputUtxos.filter((_, i) => d.authorizedInputIndices.includes(i))) {
      const entry = [...pool.entries()].find(([, x]) => k(x.outpoint) === k(f.outpoint));
      if (!entry) throw Error('SIMULATED_DOUBLE_SPEND'); pool.delete(entry[0]);
    }
    score += 5n;
    d.transaction.outputs.forEach((o, index) => {if (!o.covenant && o.scriptPublicKey.script === p2pk(key).script) {
      const f = {outpoint: {transactionId: id, index}, value: o.value, spk: o.scriptPublicKey, daa: score, covenantId: null}; pool.set(k(f.outpoint), f);
    }});
    console.log(JSON.stringify({mode: 'SIMULATED_OFFLINE_ONLY', action: d.action, syntheticTxid: id, quotedFeeSompi: d.fee.toString(), acceptance: 'NOT_OBSERVED', vm: 'NOT_RUN'}));
    tip = {transactionId: id, index: 0}; utxoDaa = score;
    if (d.transition) ledger = d.transition.next;
  }
  const config = {ticketPrice: 100000000n, ticketCap: 10, purchaseCap: 256, minTickets: 3, closeEligibleDaa: 1100n};
  const g = convergeFee(fee => buildOpenGenesis(profile, key, config, [take()], fee), 1).draft;
  origin = g.origin; cid = g.transaction.outputs[0].covenant.covenantId; apply(g); ledger = S.newOpen(key, config);
  const snapshot = () => ({ledger: S.encodeLedger(ledger), tip, origin, covenantId: cid, value: S.valueOf(ledger), utxoDaa, currentDaa: score,
    scriptPublicKey: p2sh(hex(blake2b256(S.scriptOf(ledger, profile))))});
  function action(name, quantity) {
    const x = snapshot(), funds = [take()]; // sponsor REFUND too; explicit virtual funds, never reused spent inputs
    const d = convergeFee(fee => buildAction(x, profile, {action: name, actorKey: key, ...(quantity ? {quantity} : {})}, fee, funds), 1).draft;
    apply(d);
  }
  if (scenario !== 'empty') {action('BUY', scenario === 'payout' ? 2 : 1); action('BUY', 1);}
  score = config.closeEligibleDaa; action('CLOSE');
  if (scenario === 'refund') action('REFUND');
  console.log(scenario === 'payout' ? 'SIMULATION stops at SEALED: live PASS-A and payout NOT verified.' : 'SIMULATED terminal only; not a network lifecycle or resource validation.');
}
