/** Shared operation kernel. No endpoints, wallet loader, UI, filesystem or test scenarios.
 * Adapters own authority and explicit storage policy. Hooks validate local approval/signatures and action proofs;
 * they do not impose extra before/after-sign live UTXO RPCs. */
import {buildAction, buildOpenGenesis} from '../core/lib/builders.js';
import {referenceTxId} from '../core/lib/transaction.js';
import {convergeFee} from '../chain/mass.mjs';
import {buildSplit} from './funding.mjs';
import {requireRuntimeProfile, requireRuntimeVersion} from '../contract/runtime.mjs';

export class OperationEngine {
  static builder({profile, ownerKey, config, registrySpk = null, snapshot = null, operation = null,
    funds = [], computeBudget, split = null}) {
    if (split) { requireRuntimeVersion(); return fee => { requireRuntimeVersion(); return buildSplit(split.source, ownerKey, split.values, fee); }; }
    requireRuntimeProfile(profile);
    return fee => {
      requireRuntimeProfile(profile);
      return !snapshot ? buildOpenGenesis(profile, ownerKey, config, funds, fee, registrySpk)
        : buildAction(snapshot, profile, operation, fee, funds, computeBudget);
    };
  }
  static quote(spec, feerate, options) { return convergeFee(this.builder(spec), feerate, options); }
  /** Every adapter declares required (experiment journal) or optional (browser session) persistence.
   * Optional means the adapter keeps a session record when its durable backend is unavailable; authority and exact
   * signed-record checks are always required. Missing hooks/policy never silently authorize a send. */
  static async prepare({check, beforeSign, sign, afterSign, makeRecord, persistence, context}) {
    for (const f of [check, beforeSign, sign, afterSign, makeRecord, persistence?.persist])
      if (typeof f !== 'function') throw Error('OPERATION_ADAPTER_REQUIRED');
    if (!['required', 'optional'].includes(persistence.durability)) throw Error('PERSISTENCE_POLICY_REQUIRED');
    await check(); await beforeSign(); await check();
    const signed = await sign();
    await check(); await afterSign(signed); await check();
    const record = await makeRecord(signed);
    if (referenceTxId(record.signed) !== record.draft.txid) throw Error('RECORD_TXID_MISMATCH');
    await check();
    const stored = await persistence.persist(context, record);
    return {record, stored, durability: persistence.durability};
  }
}
