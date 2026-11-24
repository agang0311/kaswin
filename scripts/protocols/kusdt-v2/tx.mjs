/** Transaction and SilverScript witness builders for Kaswin kUSDT v2.
 * All transactions use tx.version = 1 and encode witnesses per SilverScript 1.0.1 ABI. */
import {
  ascii,
  blake2b256,
  cat,
  check,
  covenantId,
  hex,
  le,
  massOf,
  p2pk,
  p2sh,
  pushBytes,
  pushInt,
  referenceTxId,
  REGISTRATION_SOMPI,
  same,
  targetSeqOf,
  unhex,
} from '../../core.mjs';
import {
  DECISION,
  DRAW_DELAY_DAA,
  EXECUTOR_REWARD,
  FEE_CAP,
  KCC20_OWNER_SCHEME,
  KUSDT_V2_GENESIS_MAGIC,
  KUSDT_V2_VERSION,
  MANAGER_DEPOSIT,
  MAX_BATCH,
  MAX_RECORDS_PER_SHARD,
  MAX_SHARDS,
  MIN_DRAW_TICKETS,
  REROLL_TIMEOUT_DAA,
  SHARD_LEDGER_DEPOSIT,
  SHARD_VAULT_DEPOSIT,
  STAGE,
  WINNER_CARRIER_MIN,
} from './constants.mjs';
import {
  buildKcc20Witness,
  decodeKcc20State,
  decodeManagerDispatchState,
  decodeManagerOpenOrSealedState,
  decodeShardOpenOrFrozenState,
  decodeShardPayoutState,
  decodeShardRefundState,
  encodeManagerDispatchState,
  encodeManagerOpenOrSealedState,
  encodeShardOpenOrFrozenState,
  encodeShardPayoutState,
  encodeShardRefundState,
  kcc20RedeemAndSpk,
} from './codec.mjs';
import {encodeKusdtV2State, redeemForState, scriptPubKeyForState} from './profile.mjs';
import {schnorrSighash} from '../../wallet/sighash.mjs';

const ZERO32 = '00'.repeat(32);
const SUBNETWORK_NATIVE = '00'.repeat(20);
const FUNDING_INPUT_BUDGET = 10;
// Calibrated against real kaspa-txscript 2.1.0 VM across 1..3 KCC-20 inputs (measured minBudget 2..16).
const KCC20_INPUT_BUDGET = 28;
const KCC20_CHANGE_CARRIER = 100_000_000n;
const MAX_KCC20_INPUTS = 3;

const openShardManagerBudget = openedCount => Math.ceil(36 + 0.35 * openedCount);
const buyShardBudget = rc => Math.ceil(22 + 0.16 * rc);
const collectShardBudget = rc => Math.ceil(6 + 0.11 * rc);
const collectManagerBudget = (openedCount, k, totalBatchRc) => Math.ceil(45 + 0.40 * openedCount + 7 * k + 0.11 * totalBatchRc);
const drawManagerBudget = (openedCount, shardRc) => Math.ceil(28 + 0.0125 * openedCount * openedCount + 0.10 * shardRc);
const rerollManagerBudget = openedCount => Math.ceil(42 + 0.30 * openedCount);
const dispatchManagerBudget = (openedCount, k) => Math.ceil(16 + 0.28 * openedCount + 2 * k);
const dispatchShardBudget = rc => Math.ceil(8 + 0.06 * rc);

function normFundingUtxo(u, fallbackSpk) {
  const daa = BigInt(u.utxoDaa ?? u.daa ?? u.daaScore ?? 0n);
  return {
    ...u,
    outpoint: u.outpoint,
    value: BigInt(u.value),
    spk: u.spk ?? fallbackSpk,
    daa,
    utxoDaa: daa,
    covenantId: null,
  };
}

function normCovenantUtxo(u, {defaultValue, redeem, covenantId: cid}) {
  const daa = BigInt(u.utxoDaa ?? u.daa ?? u.daaScore ?? 0n);
  const rawRedeem = typeof redeem === 'string' ? unhex(redeem) : redeem;
  return {
    ...u,
    outpoint: u.outpoint,
    value: BigInt(u.value ?? defaultValue),
    spk: u.spk ?? p2sh(hex(blake2b256(rawRedeem))),
    daa,
    utxoDaa: daa,
    covenantId: u.covenantId ?? cid ?? null,
  };
}

function normKcc20Utxo(u, kusdtCid) {
  const daa = BigInt(u.utxoDaa ?? u.daa ?? u.daaScore ?? 0n);
  const rawRedeem = u.redeem ? (typeof u.redeem === 'string' ? unhex(u.redeem) : u.redeem) : null;
  return {
    ...u,
    outpoint: u.outpoint,
    value: BigInt(u.value ?? SHARD_VAULT_DEPOSIT),
    spk: u.spk ?? (rawRedeem ? p2sh(hex(blake2b256(rawRedeem))) : p2sh(ZERO32)),
    daa,
    utxoDaa: daa,
    covenantId: u.covenantId ?? kusdtCid,
  };
}

function finalizeDraft(transaction, inputUtxos, authorizedInputIndices, fee, rawScriptInputs = []) {
  const utxos = inputUtxos.map(u => ({value: u.value, spk: u.spk}));
  const scriptInputs = rawScriptInputs.map(si => ({
    ...si,
    expectedSighash: hex(schnorrSighash(transaction, utxos, si.inputIndex)),
  }));
  const draft = {transaction, inputUtxos, authorizedInputIndices, fee, ...(scriptInputs.length ? {scriptInputs} : {})};
  const mass = massOf(draft);
  transaction.storageMass = mass.storageMass;
  return {
    draft,
    transaction,
    inputUtxos,
    authorizedInputIndices,
    scriptInputs,
    fee,
    mass,
    txid: referenceTxId(transaction),
  };
}

export function buildWitness(args, frameName, redeemBytes, profile) {
  const frame = profile.frames[frameName];
  check(frame, `KUSDT_V2_FRAME:${frameName}`);
  return hex(
    cat(
      ...args.map(v => (typeof v === 'bigint' ? pushInt(v) : pushBytes(v))),
      pushBytes(unhex(frame.dispatchTag, 4)),
      pushBytes(redeemBytes),
    ),
  );
}

export function makeTx({inputs, outputs, lockTime = 0n, payload = '', storageMass = 0n}) {
  return {
    version: 1,
    inputs,
    outputs,
    lockTime,
    subnetworkId: SUBNETWORK_NATIVE,
    gas: 0n,
    payload,
    storageMass,
  };
}

function u16Le(n) {
  return le(BigInt(n), 2);
}

function u32Le(n) {
  return le(BigInt(n), 4);
}

function addKasFundingAndChange({fundingUtxos, neededSompi, changeAddressSpk, baseInputs, baseInputUtxos = [], baseOutputs, fee, maxInputs = 16}) {
  const inputs = [...baseInputs];
  const inputUtxos = [...baseInputUtxos];
  const authorizedInputIndices = [];
  const outputs = [...baseOutputs];
  let funded = 0n;
  for (const u of fundingUtxos) {
    if (funded >= neededSompi + fee) break;
    if (inputs.length >= maxInputs) break;
    check(!u.covenantId, 'KUSDT_V2_FUNDING_COVENANT_UTXO');
    const idx = inputs.length;
    inputs.push({
      previousOutpoint: u.outpoint,
      signatureScript: '',
      sequence: 0n,
      computeBudget: FUNDING_INPUT_BUDGET,
    });
    inputUtxos.push(normFundingUtxo(u, changeAddressSpk));
    authorizedInputIndices.push(idx);
    funded += BigInt(u.value);
  }
  check(funded >= neededSompi + fee, 'KUSDT_V2_INSUFFICIENT_KAS');
  const change = funded - neededSompi - fee;
  if (change > 0n) {
    check(changeAddressSpk, 'KUSDT_V2_CHANGE_SPK');
    outputs.push({value: change, scriptPublicKey: changeAddressSpk, covenant: null});
  }
  return {inputs, inputUtxos, authorizedInputIndices, outputs};
}

export function encodeKusdtV2GenesisPayload(mgrState, profile) {
  check(mgrState.stage === STAGE.M_OPEN && mgrState.openedCount === 0 && mgrState.cursor === 0 && mgrState.totalTickets === 0, 'KUSDT_V2_GENESIS_STATE');
  return hex(cat(ascii(KUSDT_V2_GENESIS_MAGIC), unhex(profile.id, 32), encodeManagerOpenOrSealedState(mgrState)));
}

export function decodeKusdtV2GenesisPayload(payloadHex, profile) {
  const raw = unhex(payloadHex);
  const magic = ascii(KUSDT_V2_GENESIS_MAGIC);
  check(raw.length === magic.length + 32 + 60, 'KUSDT_V2_GENESIS_PAYLOAD_LEN');
  check(same(raw.slice(0, magic.length), magic), 'KUSDT_V2_GENESIS_MAGIC');
  const pid = hex(raw.slice(magic.length, magic.length + 32));
  check(pid === profile.id, 'KUSDT_V2_GENESIS_PROFILE');
  const state = decodeManagerOpenOrSealedState(raw.slice(magic.length + 32));
  check(state.stage === STAGE.M_OPEN && state.openedCount === 0 && state.cursor === 0 && state.totalTickets === 0 && state.decision === DECISION.UNDECIDED && state.reserved === 0, 'KUSDT_V2_GENESIS_STATE');
  return state;
}

function checkRegistrySpkLocal(spk) {
  check(spk && Number.isInteger(spk.version) && spk.version >= 0 && spk.version <= 65535, 'REGISTRY_VERSION');
  check(typeof spk.script === 'string' && spk.script.length > 0 && spk.script.length <= 2_000_000, 'REGISTRY_SCRIPT');
  unhex(spk.script);
  return {version: spk.version, script: spk.script.toLowerCase()};
}

export function buildCreateRoundTx({creatorPk, price, closeDaa, fundingUtxos, changeSpk, registrySpk = null, fee = 10_000n, profile}) {
  check(fee > 0n && fee <= FEE_CAP, 'KUSDT_V2_FEE_CAP');
  check(fundingUtxos.length >= 1, 'KUSDT_V2_NO_FUNDING');
  const mgrState = {
    stage: STAGE.M_OPEN,
    version: KUSDT_V2_VERSION,
    creatorPk,
    price: BigInt(price),
    closeDaa: BigInt(closeDaa),
    openedCount: 0,
    cursor: 0,
    totalTickets: 0,
    decision: DECISION.UNDECIDED,
    reserved: 0,
    entries: [],
  };
  const managerRedeem = redeemForState(mgrState, profile);
  const mgrSpk = p2sh(hex(blake2b256(managerRedeem)));
  const baseOutputs = [{value: MANAGER_DEPOSIT, scriptPublicKey: mgrSpk, covenant: null}];
  let registration = 0n;
  if (registrySpk) {
    registration = REGISTRATION_SOMPI;
    baseOutputs.push({value: registration, scriptPublicKey: checkRegistrySpkLocal(registrySpk), covenant: null});
  }
  const {inputs, inputUtxos, authorizedInputIndices, outputs} = addKasFundingAndChange({
    fundingUtxos,
    neededSompi: MANAGER_DEPOSIT + registration,
    changeAddressSpk: changeSpk,
    baseInputs: [],
    baseInputUtxos: [],
    baseOutputs,
    fee,
  });
  // Genesis manager covenantId is bound to authorizingInput 0
  const cid = covenantId(inputs[0].previousOutpoint, [{index: 0, value: MANAGER_DEPOSIT, spk: mgrSpk}]);
  outputs[0] = {value: MANAGER_DEPOSIT, scriptPublicKey: mgrSpk, covenant: {covenantId: cid, authorizingInput: 0}};
  const payload = encodeKusdtV2GenesisPayload(mgrState, profile);
  const transaction = makeTx({inputs, outputs, payload});
  return {...finalizeDraft(transaction, inputUtxos, authorizedInputIndices, fee), cid, managerState: mgrState, managerRedeem};
}

export function buildOpenShardTx({
  managerUtxo,
  managerCid,
  buyerPk,
  qty,
  buyerKasUtxos,
  buyerKcc20Utxos,
  kcc20Suffix,
  changeSpk,
  fee = 25_000n,
  profile,
}) {
  check(fee > 0n && fee <= FEE_CAP, 'KUSDT_V2_FEE_CAP');
  check(Number.isInteger(qty) && qty >= 1, 'KUSDT_V2_QTY');
  check(buyerKasUtxos.length >= 1, 'KUSDT_V2_NO_FUNDING');
  const mgrRedeem = typeof managerUtxo.redeem === 'string' ? unhex(managerUtxo.redeem) : managerUtxo.redeem;
  const oldMgr = decodeManagerOpenOrSealedState(unhexOrSliceState(mgrRedeem, profile.frames.m_open.tail));
  check(oldMgr.stage === STAGE.M_OPEN && oldMgr.cursor === 0 && oldMgr.openedCount < MAX_SHARDS, 'KUSDT_V2_M_OPEN_STATE');

  const authKas = buyerKasUtxos[0];
  check(!authKas.covenantId, 'KUSDT_V2_AUTH_KAS_COVENANT');
  check(BigInt(authKas.value) >= 1n, 'KUSDT_V2_AUTH_KAS_EMPTY');

  const shardState = {
    stage: STAGE.S_OPEN,
    version: KUSDT_V2_VERSION,
    managerCid,
    firstBuyerPk: buyerPk,
    price: oldMgr.price,
    records: [{cumTickets: qty, buyerPk}],
  };
  const shardSpk = scriptPubKeyForState(shardState, profile);
  const shardCid = covenantId(authKas.outpoint, [{index: 1, value: SHARD_LEDGER_DEPOSIT, spk: shardSpk}]);

  const newMgr = {
    ...oldMgr,
    openedCount: oldMgr.openedCount + 1,
    entries: [...oldMgr.entries, {shardCid, ledgerHash: ZERO32, cumTickets: 0}],
  };
  const newMgrSpk = scriptPubKeyForState(newMgr, profile);

  const cost = BigInt(qty) * oldMgr.price;
  let kcc20In = 0n;
  const selectedKcc20 = [];
  for (const ku of buyerKcc20Utxos) {
    check(ku.covenantId === profile.kusdtCid, 'KUSDT_V2_WRONG_TOKEN');
    if (selectedKcc20.length >= MAX_KCC20_INPUTS) break;
    const amt = BigInt(ku.amount);
    const kuRedeem = ku.redeem
      ? (typeof ku.redeem === 'string' ? unhex(ku.redeem) : ku.redeem)
      : kcc20RedeemAndSpk({amount: amt, owner: buyerPk, ownerScheme: KCC20_OWNER_SCHEME.P2PK_SCHNORR}, kcc20Suffix).redeem;
    kcc20In += amt;
    selectedKcc20.push({...ku, amount: amt, redeem: kuRedeem});
    if (kcc20In >= cost) break;
  }
  check(kcc20In >= cost, 'KUSDT_V2_INSUFFICIENT_KUSDT');

  const vaultState = {amount: cost, owner: shardCid, ownerScheme: KCC20_OWNER_SCHEME.OWNER_COVENANT_ID, borrowScheme: 0, borrowGuard: ZERO32, extensionCommitment: ZERO32};
  const vaultKcc20 = kcc20RedeemAndSpk(vaultState, kcc20Suffix);
  const nextKcc20States = [vaultState];
  const outputs = [
    {value: MANAGER_DEPOSIT, scriptPublicKey: newMgrSpk, covenant: {covenantId: managerCid, authorizingInput: 0}},
    {value: SHARD_LEDGER_DEPOSIT, scriptPublicKey: shardSpk, covenant: {covenantId: shardCid, authorizingInput: 1}},
    {value: SHARD_VAULT_DEPOSIT, scriptPublicKey: vaultKcc20.scriptPubKey, covenant: {covenantId: profile.kusdtCid, authorizingInput: 2}},
  ];
  let kcc20ChangeCarrier = 0n;
  let kcc20ChangeSpk = null;
  if (kcc20In > cost) {
    const chgState = {amount: kcc20In - cost, owner: buyerPk, ownerScheme: KCC20_OWNER_SCHEME.P2PK_SCHNORR, borrowScheme: 0, borrowGuard: ZERO32, extensionCommitment: ZERO32};
    const chg = kcc20RedeemAndSpk(chgState, kcc20Suffix);
    nextKcc20States.push(chgState);
    const inCarrier = selectedKcc20.reduce((s, u) => s + BigInt(u.value ?? SHARD_VAULT_DEPOSIT), 0n);
    kcc20ChangeCarrier = inCarrier >= 300_000_000n ? 300_000_000n : (inCarrier >= 200_000_000n ? 200_000_000n : KCC20_CHANGE_CARRIER);
    kcc20ChangeSpk = chg.scriptPubKey.script;
    outputs.push({value: kcc20ChangeCarrier, scriptPublicKey: chg.scriptPubKey, covenant: {covenantId: profile.kusdtCid, authorizingInput: 2}});
  }

  const kcc20Inputs = [];
  const kcc20InputUtxos = [];
  const scriptInputs = [];
  for (let j = 0; j < selectedKcc20.length; j++) {
    const ku = selectedKcc20[j];
    const inputIndex = 2 + j;
    const builtW = ku.signatureScript
      ? {scriptHex: ku.signatureScript, sigOffset: null}
      : buildKcc20Witness({nextStates: nextKcc20States, redeemBytes: ku.redeem, leader: j === 0, ownerScheme: KCC20_OWNER_SCHEME.P2PK_SCHNORR});
    kcc20Inputs.push({
      previousOutpoint: ku.outpoint,
      signatureScript: builtW.scriptHex,
      sequence: 0n,
      computeBudget: ku.computeBudget ?? KCC20_INPUT_BUDGET,
    });
    kcc20InputUtxos.push(normKcc20Utxo(ku, profile.kusdtCid));
    if (builtW.sigOffset != null) {
      scriptInputs.push({
        inputIndex,
        prebuiltSignatureScript: builtW.scriptHex,
        signatureOffsets: [builtW.sigOffset],
        ownerKey: buyerPk,
        signType: 1,
      });
    }
  }

  const baseInputs = [
    {
      previousOutpoint: managerUtxo.outpoint,
      signatureScript: '',
      sequence: 0n,
      computeBudget: openShardManagerBudget(oldMgr.openedCount),
    },
    {
      previousOutpoint: authKas.outpoint,
      signatureScript: '',
      sequence: 0n,
      computeBudget: FUNDING_INPUT_BUDGET,
    },
    ...kcc20Inputs,
  ];
  const inputUtxos = [
    normCovenantUtxo(managerUtxo, {defaultValue: MANAGER_DEPOSIT, redeem: mgrRedeem, covenantId: managerCid}),
    normFundingUtxo(authKas, changeSpk),
    ...kcc20InputUtxos,
  ];
  const authorizedInputIndices = [1];
  const kcc20InKas = kcc20InputUtxos.reduce((s, u) => s + u.value, 0n);
  const neededFromExtraKas = SHARD_LEDGER_DEPOSIT + SHARD_VAULT_DEPOSIT + kcc20ChangeCarrier - kcc20InKas;
  const inputs = [...baseInputs];
  let kasIn = BigInt(authKas.value);
  for (const u of buyerKasUtxos.slice(1)) {
    if (kasIn >= neededFromExtraKas + fee) break;
    if (inputs.length >= 8) break;
    check(!u.covenantId, 'KUSDT_V2_FUNDING_COVENANT_UTXO');
    authorizedInputIndices.push(inputs.length);
    inputs.push({previousOutpoint: u.outpoint, signatureScript: '', sequence: 0n, computeBudget: FUNDING_INPUT_BUDGET});
    inputUtxos.push(normFundingUtxo(u, changeSpk));
    kasIn += BigInt(u.value);
  }
  check(kasIn >= neededFromExtraKas + fee, 'KUSDT_V2_INSUFFICIENT_KAS');
  const kasChange = kasIn - neededFromExtraKas - fee;
  if (kasChange > 0n) outputs.push({value: kasChange, scriptPublicKey: changeSpk, covenant: null});

  const data = cat(u32Le(qty), unhex(buyerPk, 32));
  inputs[0].signatureScript = buildWitness(
    [1n, BigInt(profile.frames.m_open.tail.length), profile.frames.s_open.tail, kcc20Suffix, data],
    'm_open',
    mgrRedeem,
    profile,
  );
  const transaction = makeTx({inputs, outputs});
  return {...finalizeDraft(transaction, inputUtxos, authorizedInputIndices, fee, scriptInputs), shardCid, shardState, managerState: newMgr, kcc20ChangeSpk};
}

export function buildBuyTx({
  shardUtxo,
  shardCid,
  vaultUtxo,
  buyerPk,
  qty,
  buyerKasUtxos,
  buyerKcc20Utxos,
  kcc20Suffix,
  changeSpk,
  fee = 20_000n,
  profile,
}) {
  check(fee > 0n && fee <= FEE_CAP, 'KUSDT_V2_FEE_CAP');
  check(Number.isInteger(qty) && qty >= 1, 'KUSDT_V2_QTY');
  const shardRedeem = typeof shardUtxo.redeem === 'string' ? unhex(shardUtxo.redeem) : shardUtxo.redeem;
  const oldShard = decodeShardOpenOrFrozenState(unhexOrSliceState(shardRedeem, profile.frames.s_open.tail));
  check(oldShard.stage === STAGE.S_OPEN && oldShard.records.length < MAX_RECORDS_PER_SHARD, 'KUSDT_V2_S_OPEN_STATE');

  const oldTickets = oldShard.records[oldShard.records.length - 1].cumTickets;
  const newTickets = oldTickets + qty;
  const newShard = {
    ...oldShard,
    records: [...oldShard.records, {cumTickets: newTickets, buyerPk}],
  };
  const newShardSpk = scriptPubKeyForState(newShard, profile);

  const oldAmt = BigInt(oldTickets) * oldShard.price;
  const cost = BigInt(qty) * oldShard.price;
  const newAmt = oldAmt + cost;

  let kcc20In = 0n;
  const selectedKcc20 = [];
  for (const ku of buyerKcc20Utxos) {
    check(ku.covenantId === profile.kusdtCid, 'KUSDT_V2_WRONG_TOKEN');
    if (selectedKcc20.length >= MAX_KCC20_INPUTS - 1) break;
    const amt = BigInt(ku.amount);
    const kuRedeem = ku.redeem
      ? (typeof ku.redeem === 'string' ? unhex(ku.redeem) : ku.redeem)
      : kcc20RedeemAndSpk({amount: amt, owner: buyerPk, ownerScheme: KCC20_OWNER_SCHEME.P2PK_SCHNORR}, kcc20Suffix).redeem;
    kcc20In += amt;
    selectedKcc20.push({...ku, amount: amt, redeem: kuRedeem});
    if (kcc20In >= cost) break;
  }
  check(kcc20In >= cost, 'KUSDT_V2_INSUFFICIENT_KUSDT');

  const newVaultState = {amount: newAmt, owner: shardCid, ownerScheme: KCC20_OWNER_SCHEME.OWNER_COVENANT_ID, borrowScheme: 0, borrowGuard: ZERO32, extensionCommitment: ZERO32};
  const newVault = kcc20RedeemAndSpk(newVaultState, kcc20Suffix);
  const nextKcc20States = [newVaultState];
  const outputs = [
    {value: SHARD_LEDGER_DEPOSIT, scriptPublicKey: newShardSpk, covenant: {covenantId: shardCid, authorizingInput: 0}},
    {value: SHARD_VAULT_DEPOSIT, scriptPublicKey: newVault.scriptPubKey, covenant: {covenantId: profile.kusdtCid, authorizingInput: 1}},
  ];
  let kcc20ChangeCarrier = 0n;
  let kcc20ChangeSpk = null;
  if (kcc20In > cost) {
    const chgState = {amount: kcc20In - cost, owner: buyerPk, ownerScheme: KCC20_OWNER_SCHEME.P2PK_SCHNORR, borrowScheme: 0, borrowGuard: ZERO32, extensionCommitment: ZERO32};
    const chg = kcc20RedeemAndSpk(chgState, kcc20Suffix);
    nextKcc20States.push(chgState);
    const inCarrier = selectedKcc20.reduce((s, u) => s + BigInt(u.value ?? SHARD_VAULT_DEPOSIT), 0n);
    kcc20ChangeCarrier = inCarrier >= 300_000_000n ? 300_000_000n : (inCarrier >= 200_000_000n ? 200_000_000n : KCC20_CHANGE_CARRIER);
    kcc20ChangeSpk = chg.scriptPubKey.script;
    outputs.push({value: kcc20ChangeCarrier, scriptPublicKey: chg.scriptPubKey, covenant: {covenantId: profile.kusdtCid, authorizingInput: 1}});
  }

  const vaultRedeem = vaultUtxo.redeem
    ? (typeof vaultUtxo.redeem === 'string' ? unhex(vaultUtxo.redeem) : vaultUtxo.redeem)
    : kcc20RedeemAndSpk({amount: oldAmt, owner: shardCid, ownerScheme: KCC20_OWNER_SCHEME.OWNER_COVENANT_ID}, kcc20Suffix).redeem;
  const vaultSig = vaultUtxo.signatureScript || buildKcc20Witness({
    nextStates: nextKcc20States,
    redeemBytes: vaultRedeem,
    leader: true,
    ownerScheme: KCC20_OWNER_SCHEME.OWNER_COVENANT_ID,
  }).scriptHex;

  const kcc20Inputs = [];
  const kcc20InputUtxos = [];
  const scriptInputs = [];
  for (let j = 0; j < selectedKcc20.length; j++) {
    const ku = selectedKcc20[j];
    const inputIndex = 2 + j;
    const builtW = ku.signatureScript
      ? {scriptHex: ku.signatureScript, sigOffset: null}
      : buildKcc20Witness({nextStates: nextKcc20States, redeemBytes: ku.redeem, leader: false, ownerScheme: KCC20_OWNER_SCHEME.P2PK_SCHNORR});
    kcc20Inputs.push({previousOutpoint: ku.outpoint, signatureScript: builtW.scriptHex, sequence: 0n, computeBudget: ku.computeBudget ?? KCC20_INPUT_BUDGET});
    kcc20InputUtxos.push(normKcc20Utxo(ku, profile.kusdtCid));
    if (builtW.sigOffset != null) {
      scriptInputs.push({
        inputIndex,
        prebuiltSignatureScript: builtW.scriptHex,
        signatureOffsets: [builtW.sigOffset],
        ownerKey: buyerPk,
        signType: 1,
      });
    }
  }

  const kcc20InKas = kcc20InputUtxos.reduce((s, u) => s + u.value, 0n);
  const baseInputs = [
    {previousOutpoint: shardUtxo.outpoint, signatureScript: '', sequence: 0n, computeBudget: buyShardBudget(oldShard.records.length)},
    {previousOutpoint: vaultUtxo.outpoint, signatureScript: vaultSig, sequence: 0n, computeBudget: vaultUtxo.computeBudget ?? KCC20_INPUT_BUDGET},
    ...kcc20Inputs,
  ];
  const baseInputUtxos = [
    normCovenantUtxo(shardUtxo, {defaultValue: SHARD_LEDGER_DEPOSIT, redeem: shardRedeem, covenantId: shardCid}),
    normKcc20Utxo({...vaultUtxo, redeem: vaultRedeem}, profile.kusdtCid),
    ...kcc20InputUtxos,
  ];
  const {inputs, inputUtxos, authorizedInputIndices, outputs: finalOutputs} = addKasFundingAndChange({
    fundingUtxos: buyerKasUtxos,
    neededSompi: kcc20ChangeCarrier - kcc20InKas,
    changeAddressSpk: changeSpk,
    baseInputs,
    baseInputUtxos,
    baseOutputs: outputs,
    fee,
    maxInputs: 8,
  });
  inputs[0].signatureScript = buildWitness(
    [1n, BigInt(qty), unhex(buyerPk, 32), BigInt(profile.frames.s_open.tail.length), new Uint8Array(), kcc20Suffix],
    's_open',
    shardRedeem,
    profile,
  );
  const transaction = makeTx({inputs, outputs: finalOutputs});
  return {...finalizeDraft(transaction, inputUtxos, authorizedInputIndices, fee, scriptInputs), shardState: newShard, kcc20ChangeSpk};
}

export function buildEmptyCloseTx({managerUtxo, managerCid = null, fundingUtxos, changeSpk, fee = 10_000n, profile}) {
  check(fee > 0n && fee <= FEE_CAP, 'KUSDT_V2_FEE_CAP');
  const mgrRedeem = typeof managerUtxo.redeem === 'string' ? unhex(managerUtxo.redeem) : managerUtxo.redeem;
  const oldMgr = decodeManagerOpenOrSealedState(unhexOrSliceState(mgrRedeem, profile.frames.m_open.tail));
  check(oldMgr.stage === STAGE.M_OPEN && oldMgr.openedCount === 0, 'KUSDT_V2_NOT_EMPTY');

  const {inputs, inputUtxos, authorizedInputIndices, outputs} = addKasFundingAndChange({
    fundingUtxos,
    neededSompi: 0n,
    changeAddressSpk: changeSpk,
    baseInputs: [{previousOutpoint: managerUtxo.outpoint, signatureScript: '', sequence: 0n, computeBudget: 10}],
    baseInputUtxos: [normCovenantUtxo(managerUtxo, {defaultValue: MANAGER_DEPOSIT, redeem: mgrRedeem, covenantId: managerCid})],
    baseOutputs: [{value: MANAGER_DEPOSIT, scriptPublicKey: p2pk(oldMgr.creatorPk), covenant: null}],
    fee,
  });
  inputs[0].signatureScript = buildWitness(
    [2n, 0n, new Uint8Array(), new Uint8Array(), new Uint8Array()],
    'm_open',
    mgrRedeem,
    profile,
  );
  const transaction = makeTx({inputs, outputs, lockTime: oldMgr.closeDaa});
  return finalizeDraft(transaction, inputUtxos, authorizedInputIndices, fee);
}

export function buildCollectBatchTx({managerUtxo, managerCid, shardUtxos, fundingUtxos, changeSpk, fee = 40_000n, profile}) {
  check(fee > 0n && fee <= FEE_CAP, 'KUSDT_V2_FEE_CAP');
  const k = shardUtxos.length;
  check(k >= 1 && k <= MAX_BATCH, 'KUSDT_V2_BATCH_SIZE');
  const mgrRedeem = typeof managerUtxo.redeem === 'string' ? unhex(managerUtxo.redeem) : managerUtxo.redeem;
  const oldMgr = decodeManagerOpenOrSealedState(unhexOrSliceState(mgrRedeem, profile.frames.m_open.tail));
  check(oldMgr.stage === STAGE.M_OPEN && oldMgr.cursor + k <= oldMgr.openedCount, 'KUSDT_V2_COLLECT_RANGE');

  const entries = oldMgr.entries.map(e => ({...e}));
  let totalTickets = oldMgr.totalTickets;
  let totalBatchRc = 0;
  const baseInputs = [{previousOutpoint: managerUtxo.outpoint, signatureScript: '', sequence: 0n, computeBudget: 0}];
  const baseInputUtxos = [normCovenantUtxo(managerUtxo, {defaultValue: MANAGER_DEPOSIT, redeem: mgrRedeem, covenantId: managerCid})];
  const shardOutputs = [];
  const redeemLens = [];
  const nextShardStates = [];

  for (let i = 0; i < k; i++) {
    const sUtxo = shardUtxos[i];
    const sRedeem = typeof sUtxo.redeem === 'string' ? unhex(sUtxo.redeem) : sUtxo.redeem;
    const sState = decodeShardOpenOrFrozenState(unhexOrSliceState(sRedeem, profile.frames.s_open.tail));
    totalBatchRc += sState.records.length;
    const frozen = {...sState, stage: STAGE.S_FROZEN};
    const frozenBytes = encodeKusdtV2State(frozen);
    const shardTickets = sState.records[sState.records.length - 1].cumTickets;
    totalTickets += shardTickets;
    const idx = oldMgr.cursor + i;
    entries[idx] = {
      shardCid: entries[idx].shardCid,
      ledgerHash: hex(blake2b256(frozenBytes)),
      cumTickets: totalTickets,
    };
    nextShardStates.push(frozen);
    redeemLens.push(u32Le(sRedeem.length));
    baseInputs.push({
      previousOutpoint: sUtxo.outpoint,
      signatureScript: buildWitness(
        [2n, 0n, unhex(ZERO32, 32), 0n, profile.frames.s_frozen.tail, new Uint8Array()],
        's_open',
        sRedeem,
        profile,
      ),
      sequence: 0n,
      computeBudget: collectShardBudget(sState.records.length),
    });
    baseInputUtxos.push(normCovenantUtxo(sUtxo, {defaultValue: SHARD_LEDGER_DEPOSIT, redeem: sRedeem, covenantId: entries[idx].shardCid}));
    shardOutputs.push({
      value: SHARD_LEDGER_DEPOSIT,
      scriptPublicKey: scriptPubKeyForState(frozen, profile),
      covenant: {covenantId: entries[idx].shardCid, authorizingInput: i + 1},
    });
  }
  baseInputs[0].computeBudget = collectManagerBudget(oldMgr.openedCount, k, totalBatchRc);

  const nextCursor = oldMgr.cursor + k;
  const done = nextCursor === oldMgr.openedCount;
  let nextMgrState;
  let extraBytes = new Uint8Array();
  let ownTailBytes = BigInt(profile.frames.m_open.tail.length);

  if (!done) {
    nextMgrState = {...oldMgr, cursor: nextCursor, totalTickets, entries};
  } else if (totalTickets < MIN_DRAW_TICKETS) {
    ownTailBytes = 0n;
    extraBytes = profile.frames.m_dispatch.tail;
    nextMgrState = {
      stage: STAGE.M_DISPATCH,
      version: KUSDT_V2_VERSION,
      creatorPk: oldMgr.creatorPk,
      price: oldMgr.price,
      closeDaa: oldMgr.closeDaa,
      openedCount: oldMgr.openedCount,
      cursor: 0,
      totalTickets,
      decision: DECISION.REFUND,
      reserved: 0,
      winnerPk: ZERO32,
      shardCids: entries.map(e => e.shardCid),
    };
  } else {
    ownTailBytes = 0n;
    extraBytes = profile.frames.m_sealed.tail;
    nextMgrState = {
      ...oldMgr,
      stage: STAGE.M_SEALED,
      cursor: 0,
      totalTickets,
      entries,
    };
  }

  const mgrOut = {
    value: MANAGER_DEPOSIT,
    scriptPublicKey: scriptPubKeyForState(nextMgrState, profile),
    covenant: {covenantId: managerCid, authorizingInput: 0},
  };
  const {inputs, inputUtxos, authorizedInputIndices, outputs} = addKasFundingAndChange({
    fundingUtxos,
    neededSompi: 0n,
    changeAddressSpk: changeSpk,
    baseInputs,
    baseInputUtxos,
    baseOutputs: [mgrOut, ...shardOutputs],
    fee,
  });
  const data = cat(u16Le(k), u32Le(profile.frames.s_open.tail.length), ...redeemLens);
  inputs[0].signatureScript = buildWitness(
    [3n, ownTailBytes, profile.frames.s_frozen.tail, extraBytes, data],
    'm_open',
    mgrRedeem,
    profile,
  );
  const transaction = makeTx({inputs, outputs, lockTime: oldMgr.closeDaa});
  return {...finalizeDraft(transaction, inputUtxos, authorizedInputIndices, fee), managerState: nextMgrState, shardStates: nextShardStates};
}

export function buildDrawTx({managerUtxo, managerCid, passAProof, shardIndex, recordIndex, frozenShardState, fundingUtxos, changeSpk, fee = 25_000n, profile}) {
  check(fee > 0n && fee <= FEE_CAP, 'KUSDT_V2_FEE_CAP');
  const mgrRedeem = typeof managerUtxo.redeem === 'string' ? unhex(managerUtxo.redeem) : managerUtxo.redeem;
  const oldMgr = decodeManagerOpenOrSealedState(unhexOrSliceState(mgrRedeem, profile.frames.m_sealed.tail));
  check(oldMgr.stage === STAGE.M_SEALED, 'KUSDT_V2_NOT_SEALED');
  targetSeqOf(passAProof);
  const winnerPk = frozenShardState.records[recordIndex].buyerPk;
  const nextMgr = {
    stage: STAGE.M_DISPATCH,
    version: KUSDT_V2_VERSION,
    creatorPk: oldMgr.creatorPk,
    price: oldMgr.price,
    closeDaa: oldMgr.closeDaa,
    openedCount: oldMgr.openedCount,
    cursor: 0,
    totalTickets: oldMgr.totalTickets,
    decision: DECISION.PAYOUT,
    reserved: 0,
    winnerPk,
    shardCids: oldMgr.entries.map(e => e.shardCid),
  };
  const {inputs, inputUtxos, authorizedInputIndices, outputs} = addKasFundingAndChange({
    fundingUtxos,
    neededSompi: 0n,
    changeAddressSpk: changeSpk,
    baseInputs: [{previousOutpoint: managerUtxo.outpoint, signatureScript: '', sequence: DRAW_DELAY_DAA, computeBudget: drawManagerBudget(oldMgr.openedCount, frozenShardState.records.length)}],
    baseInputUtxos: [normCovenantUtxo(managerUtxo, {defaultValue: MANAGER_DEPOSIT, redeem: mgrRedeem, covenantId: managerCid})],
    baseOutputs: [{value: MANAGER_DEPOSIT, scriptPublicKey: scriptPubKeyForState(nextMgr, profile), covenant: {covenantId: managerCid, authorizingInput: 0}}],
    fee,
  });
  const frozenBytes = encodeKusdtV2State(frozenShardState);
  const data = cat(passAProof, u16Le(shardIndex), u16Le(recordIndex), frozenBytes);
  inputs[0].signatureScript = buildWitness([1n, 0n, profile.frames.m_dispatch.tail, data], 'm_sealed', mgrRedeem, profile);
  const transaction = makeTx({inputs, outputs});
  return {...finalizeDraft(transaction, inputUtxos, authorizedInputIndices, fee), managerState: nextMgr, winnerPk};
}

export function buildRerollTx({managerUtxo, managerCid, fundingUtxos, changeSpk, fee = 10_000n, profile}) {
  check(fee > 0n && fee <= FEE_CAP, 'KUSDT_V2_FEE_CAP');
  const mgrRedeem = typeof managerUtxo.redeem === 'string' ? unhex(managerUtxo.redeem) : managerUtxo.redeem;
  const oldMgr = decodeManagerOpenOrSealedState(unhexOrSliceState(mgrRedeem, profile.frames.m_sealed.tail));
  check(oldMgr.stage === STAGE.M_SEALED, 'KUSDT_V2_NOT_SEALED');
  const {inputs, inputUtxos, authorizedInputIndices, outputs} = addKasFundingAndChange({
    fundingUtxos,
    neededSompi: 0n,
    changeAddressSpk: changeSpk,
    baseInputs: [{previousOutpoint: managerUtxo.outpoint, signatureScript: '', sequence: REROLL_TIMEOUT_DAA, computeBudget: rerollManagerBudget(oldMgr.openedCount)}],
    baseInputUtxos: [normCovenantUtxo(managerUtxo, {defaultValue: MANAGER_DEPOSIT, redeem: mgrRedeem, covenantId: managerCid})],
    baseOutputs: [{value: MANAGER_DEPOSIT, scriptPublicKey: scriptPubKeyForState(oldMgr, profile), covenant: {covenantId: managerCid, authorizingInput: 0}}],
    fee,
  });
  inputs[0].signatureScript = buildWitness(
    [2n, BigInt(profile.frames.m_sealed.tail.length), new Uint8Array(), new Uint8Array()],
    'm_sealed',
    mgrRedeem,
    profile,
  );
  const transaction = makeTx({inputs, outputs});
  return {...finalizeDraft(transaction, inputUtxos, authorizedInputIndices, fee), managerState: oldMgr};
}

export function buildDispatchBatchTx({managerUtxo, managerCid, frozenShardUtxos, fundingUtxos, changeSpk, fee = 40_000n, profile}) {
  check(fee > 0n && fee <= FEE_CAP, 'KUSDT_V2_FEE_CAP');
  const k = frozenShardUtxos.length;
  check(k >= 1 && k <= MAX_BATCH, 'KUSDT_V2_BATCH_SIZE');
  const mgrRedeem = typeof managerUtxo.redeem === 'string' ? unhex(managerUtxo.redeem) : managerUtxo.redeem;
  const oldMgr = decodeManagerDispatchState(unhexOrSliceState(mgrRedeem, profile.frames.m_dispatch.tail));
  check(oldMgr.stage === STAGE.M_DISPATCH && oldMgr.cursor + k <= oldMgr.openedCount, 'KUSDT_V2_DISPATCH_RANGE');

  const isPayout = oldMgr.decision === DECISION.PAYOUT;
  const nextTail = isPayout ? profile.frames.s_payout.tail : profile.frames.s_refund.tail;
  const baseInputs = [{previousOutpoint: managerUtxo.outpoint, signatureScript: '', sequence: 0n, computeBudget: dispatchManagerBudget(oldMgr.openedCount, k)}];
  const baseInputUtxos = [normCovenantUtxo(managerUtxo, {defaultValue: MANAGER_DEPOSIT, redeem: mgrRedeem, covenantId: managerCid})];
  const shardOutputs = [];
  const metaParts = [];
  const nextShardStates = [];

  for (let i = 0; i < k; i++) {
    const sUtxo = frozenShardUtxos[i];
    const sRedeem = typeof sUtxo.redeem === 'string' ? unhex(sUtxo.redeem) : sUtxo.redeem;
    const frozen = decodeShardOpenOrFrozenState(unhexOrSliceState(sRedeem, profile.frames.s_frozen.tail));
    const shardCid = oldMgr.shardCids[oldMgr.cursor + i];
    const shardTickets = frozen.records[frozen.records.length - 1].cumTickets;
    let nextShard;
    if (isPayout) {
      const vaultAmount = BigInt(shardTickets) * oldMgr.price;
      nextShard = {
        stage: STAGE.S_PAYOUT,
        version: KUSDT_V2_VERSION,
        firstBuyerPk: frozen.firstBuyerPk,
        winnerPk: oldMgr.winnerPk,
        vaultAmount,
        managerCid,
        shardTickets,
      };
      metaParts.push(unhex(frozen.firstBuyerPk, 32), le(vaultAmount, 8), u32Le(shardTickets));
    } else {
      nextShard = {
        stage: STAGE.S_REFUND,
        version: KUSDT_V2_VERSION,
        firstBuyerPk: frozen.firstBuyerPk,
        price: frozen.price,
        recordCount: frozen.records.length,
        claimedMask: 0,
        records: frozen.records,
      };
      const stBytes = encodeShardRefundState(nextShard);
      metaParts.push(u16Le(stBytes.length), stBytes);
    }
    nextShardStates.push(nextShard);
    baseInputs.push({
      previousOutpoint: sUtxo.outpoint,
      signatureScript: buildWitness(
        [BigInt(oldMgr.decision), unhex(oldMgr.winnerPk, 32), nextTail],
        's_frozen',
        sRedeem,
        profile,
      ),
      sequence: 0n,
      computeBudget: dispatchShardBudget(frozen.records.length),
    });
    baseInputUtxos.push(normCovenantUtxo(sUtxo, {defaultValue: SHARD_LEDGER_DEPOSIT, redeem: sRedeem, covenantId: shardCid}));
    shardOutputs.push({
      value: SHARD_LEDGER_DEPOSIT,
      scriptPublicKey: scriptPubKeyForState(nextShard, profile),
      covenant: {covenantId: shardCid, authorizingInput: i + 1},
    });
  }

  const nextCursor = oldMgr.cursor + k;
  const done = nextCursor === oldMgr.openedCount;
  let mgrOut;
  let nextMgrState = null;
  let ownTailBytes = 0n;
  if (done) {
    mgrOut = {value: MANAGER_DEPOSIT, scriptPublicKey: p2pk(oldMgr.creatorPk), covenant: null};
  } else {
    ownTailBytes = BigInt(profile.frames.m_dispatch.tail.length);
    nextMgrState = {...oldMgr, cursor: nextCursor};
    mgrOut = {
      value: MANAGER_DEPOSIT,
      scriptPublicKey: scriptPubKeyForState(nextMgrState, profile),
      covenant: {covenantId: managerCid, authorizingInput: 0},
    };
  }

  const {inputs, inputUtxos, authorizedInputIndices, outputs} = addKasFundingAndChange({
    fundingUtxos,
    neededSompi: 0n,
    changeAddressSpk: changeSpk,
    baseInputs,
    baseInputUtxos,
    baseOutputs: [mgrOut, ...shardOutputs],
    fee,
  });
  inputs[0].signatureScript = buildWitness(
    [BigInt(k), ownTailBytes, nextTail, cat(...metaParts)],
    'm_dispatch',
    mgrRedeem,
    profile,
  );
  const transaction = makeTx({inputs, outputs});
  return {...finalizeDraft(transaction, inputUtxos, authorizedInputIndices, fee), managerState: nextMgrState, shardStates: nextShardStates};
}

export function buildPayoutTx({shardUtxo, shardCid = null, vaultUtxo, executorPk = null, fundingUtxos, kcc20Suffix, changeSpk, fee = 15_000n, profile}) {
  check(fee > 0n && fee <= FEE_CAP, 'KUSDT_V2_FEE_CAP');
  const shardRedeem = typeof shardUtxo.redeem === 'string' ? unhex(shardUtxo.redeem) : shardUtxo.redeem;
  const st = decodeShardPayoutState(unhexOrSliceState(shardRedeem, profile.frames.s_payout.tail));
  const isExecutor = !!executorPk;
  if (isExecutor) check(st.vaultAmount > EXECUTOR_REWARD, 'KUSDT_V2_VAULT_TOO_SMALL_FOR_EXECUTOR');

  const winnerAmt = isExecutor ? st.vaultAmount - EXECUTOR_REWARD : st.vaultAmount;
  const winnerState = {amount: winnerAmt, owner: st.winnerPk, ownerScheme: KCC20_OWNER_SCHEME.P2PK_SCHNORR, borrowScheme: 0, borrowGuard: ZERO32, extensionCommitment: ZERO32};
  const winnerKcc20 = kcc20RedeemAndSpk(winnerState, kcc20Suffix);
  const nextKcc20States = [winnerState];
  const outputs = [
    {value: SHARD_LEDGER_DEPOSIT + SHARD_VAULT_DEPOSIT, scriptPublicKey: p2pk(st.firstBuyerPk), covenant: null},
    {value: WINNER_CARRIER_MIN, scriptPublicKey: winnerKcc20.scriptPubKey, covenant: {covenantId: profile.kusdtCid, authorizingInput: 1}},
  ];
  let neededKas = WINNER_CARRIER_MIN;
  if (isExecutor) {
    const execState = {amount: EXECUTOR_REWARD, owner: executorPk, ownerScheme: KCC20_OWNER_SCHEME.P2PK_SCHNORR, borrowScheme: 0, borrowGuard: ZERO32, extensionCommitment: ZERO32};
    const execKcc20 = kcc20RedeemAndSpk(execState, kcc20Suffix);
    nextKcc20States.push(execState);
    outputs.push({value: WINNER_CARRIER_MIN, scriptPublicKey: execKcc20.scriptPubKey, covenant: {covenantId: profile.kusdtCid, authorizingInput: 1}});
    neededKas += WINNER_CARRIER_MIN;
  }

  const effShardCid = shardCid ?? shardUtxo.covenantId ?? ZERO32;
  const vaultRedeem = vaultUtxo.redeem
    ? (typeof vaultUtxo.redeem === 'string' ? unhex(vaultUtxo.redeem) : vaultUtxo.redeem)
    : kcc20RedeemAndSpk({amount: st.vaultAmount, owner: effShardCid, ownerScheme: KCC20_OWNER_SCHEME.OWNER_COVENANT_ID}, kcc20Suffix).redeem;
  const vaultSig = vaultUtxo.signatureScript || buildKcc20Witness({
    nextStates: nextKcc20States,
    redeemBytes: vaultRedeem,
    leader: true,
    ownerScheme: KCC20_OWNER_SCHEME.OWNER_COVENANT_ID,
  }).scriptHex;

  const baseInputs = [
    {
      previousOutpoint: shardUtxo.outpoint,
      signatureScript: buildWitness([isExecutor ? 1n : 2n, kcc20Suffix], 's_payout', shardRedeem, profile),
      sequence: 0n,
      computeBudget: 16,
    },
    {previousOutpoint: vaultUtxo.outpoint, signatureScript: vaultSig, sequence: 0n, computeBudget: vaultUtxo.computeBudget ?? KCC20_INPUT_BUDGET},
  ];
  const baseInputUtxos = [
    normCovenantUtxo(shardUtxo, {defaultValue: SHARD_LEDGER_DEPOSIT, redeem: shardRedeem, covenantId: effShardCid}),
    normKcc20Utxo({...vaultUtxo, redeem: vaultRedeem}, profile.kusdtCid),
  ];
  const {inputs, inputUtxos, authorizedInputIndices, outputs: finalOutputs} = addKasFundingAndChange({
    fundingUtxos,
    neededSompi: neededKas,
    changeAddressSpk: changeSpk,
    baseInputs,
    baseInputUtxos,
    baseOutputs: outputs,
    fee,
  });
  const transaction = makeTx({inputs, outputs: finalOutputs});
  return finalizeDraft(transaction, inputUtxos, authorizedInputIndices, fee);
}

export function buildClaimRefundTx({shardUtxo, shardCid, vaultUtxo, recIdx, fundingUtxos, kcc20Suffix, changeSpk, fee = 15_000n, profile}) {
  check(fee > 0n && fee <= FEE_CAP, 'KUSDT_V2_FEE_CAP');
  const shardRedeem = typeof shardUtxo.redeem === 'string' ? unhex(shardUtxo.redeem) : shardUtxo.redeem;
  const st = decodeShardRefundState(unhexOrSliceState(shardRedeem, profile.frames.s_refund.tail));
  check(recIdx >= 0 && recIdx < st.recordCount, 'KUSDT_V2_REC_IDX');
  check((st.claimedMask & (1 << recIdx)) === 0, 'KUSDT_V2_ALREADY_CLAIMED');

  const prevCum = recIdx === 0 ? 0 : st.records[recIdx - 1].cumTickets;
  const qty = st.records[recIdx].cumTickets - prevCum;
  const refundAmt = BigInt(qty) * st.price;
  const buyerPk = st.records[recIdx].buyerPk;
  const nextMask = st.claimedMask | (1 << recIdx);
  const fullMask = st.recordCount === 1 ? 1 : 3;
  const isLast = nextMask === fullMask;

  const buyerState = {amount: refundAmt, owner: buyerPk, ownerScheme: KCC20_OWNER_SCHEME.P2PK_SCHNORR, borrowScheme: 0, borrowGuard: ZERO32, extensionCommitment: ZERO32};
  const buyerKcc20 = kcc20RedeemAndSpk(buyerState, kcc20Suffix);
  const outputs = [];
  const nextKcc20States = [];
  let nextShardState = null;
  let ownTailBytes = 0n;
  let neededKas = WINNER_CARRIER_MIN;
  let curVaultAmt = refundAmt;

  if (isLast) {
    nextKcc20States.push(buyerState);
    outputs.push({value: SHARD_LEDGER_DEPOSIT + SHARD_VAULT_DEPOSIT, scriptPublicKey: p2pk(st.firstBuyerPk), covenant: null});
    outputs.push({value: WINNER_CARRIER_MIN, scriptPublicKey: buyerKcc20.scriptPubKey, covenant: {covenantId: profile.kusdtCid, authorizingInput: 1}});
  } else {
    ownTailBytes = BigInt(profile.frames.s_refund.tail.length);
    nextShardState = {...st, claimedMask: nextMask};
    const otherIdx = recIdx === 0 ? 1 : 0;
    const otherPrev = otherIdx === 0 ? 0 : st.records[0].cumTickets;
    const remAmt = BigInt(st.records[otherIdx].cumTickets - otherPrev) * st.price;
    curVaultAmt = refundAmt + remAmt;
    const nextVaultState = {amount: remAmt, owner: shardCid, ownerScheme: KCC20_OWNER_SCHEME.OWNER_COVENANT_ID, borrowScheme: 0, borrowGuard: ZERO32, extensionCommitment: ZERO32};
    const nextVault = kcc20RedeemAndSpk(nextVaultState, kcc20Suffix);
    nextKcc20States.push(nextVaultState, buyerState);
    outputs.push(
      {value: SHARD_LEDGER_DEPOSIT, scriptPublicKey: scriptPubKeyForState(nextShardState, profile), covenant: {covenantId: shardCid, authorizingInput: 0}},
      {value: SHARD_VAULT_DEPOSIT, scriptPublicKey: nextVault.scriptPubKey, covenant: {covenantId: profile.kusdtCid, authorizingInput: 1}},
      {value: WINNER_CARRIER_MIN, scriptPublicKey: buyerKcc20.scriptPubKey, covenant: {covenantId: profile.kusdtCid, authorizingInput: 1}},
    );
  }

  const vaultRedeem = vaultUtxo.redeem
    ? (typeof vaultUtxo.redeem === 'string' ? unhex(vaultUtxo.redeem) : vaultUtxo.redeem)
    : kcc20RedeemAndSpk({amount: curVaultAmt, owner: shardCid, ownerScheme: KCC20_OWNER_SCHEME.OWNER_COVENANT_ID}, kcc20Suffix).redeem;
  const vaultSig = vaultUtxo.signatureScript || buildKcc20Witness({
    nextStates: nextKcc20States,
    redeemBytes: vaultRedeem,
    leader: true,
    ownerScheme: KCC20_OWNER_SCHEME.OWNER_COVENANT_ID,
  }).scriptHex;

  const baseInputs = [
    {
      previousOutpoint: shardUtxo.outpoint,
      signatureScript: buildWitness([BigInt(recIdx), ownTailBytes, kcc20Suffix], 's_refund', shardRedeem, profile),
      sequence: 0n,
      computeBudget: 28,
    },
    {previousOutpoint: vaultUtxo.outpoint, signatureScript: vaultSig, sequence: 0n, computeBudget: vaultUtxo.computeBudget ?? KCC20_INPUT_BUDGET},
  ];
  const baseInputUtxos = [
    normCovenantUtxo(shardUtxo, {defaultValue: SHARD_LEDGER_DEPOSIT, redeem: shardRedeem, covenantId: shardCid}),
    normKcc20Utxo({...vaultUtxo, redeem: vaultRedeem}, profile.kusdtCid),
  ];
  const {inputs, inputUtxos, authorizedInputIndices, outputs: finalOutputs} = addKasFundingAndChange({
    fundingUtxos,
    neededSompi: neededKas,
    changeAddressSpk: changeSpk,
    baseInputs,
    baseInputUtxos,
    baseOutputs: outputs,
    fee,
  });
  const transaction = makeTx({inputs, outputs: finalOutputs});
  return {...finalizeDraft(transaction, inputUtxos, authorizedInputIndices, fee), shardState: nextShardState};
}

function unhexOrSliceState(redeem, tail) {
  // redeem = 0x6b || pushBytes(state) || tail
  check(redeem[0] === 0x6b, 'KUSDT_V2_REDEEM_PREFIX');
  const op = redeem[1];
  let off = 2;
  let len = 0;
  if (op <= 75) {
    len = op;
  } else if (op === 0x4c) {
    len = redeem[2];
    off = 3;
  } else if (op === 0x4d) {
    len = redeem[2] | (redeem[3] << 8);
    off = 4;
  } else if (op === 0x4e) {
    len = redeem[2] | (redeem[3] << 8) | (redeem[4] << 16) | (redeem[5] << 24);
    off = 6;
  } else {
    throw new Error('KUSDT_V2_PUSH_OP');
  }
  check(off + len + tail.length === redeem.length, 'KUSDT_V2_REDEEM_LEN');
  return redeem.slice(off, off + len);
}
