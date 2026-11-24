/** Frozen protocol constants for Kaswin kUSDT v2 (256 parallel shards).
 * Values match docs/KUSDT-PARALLEL-SHARDS-SPEC.md and contracts/kusdt-v2/artifacts/template-pins.json. */
export const KUSDT_V2_PROTOCOL_ID = 'kusdt-v2';
export const KUSDT_V2_VERSION = 0x01;
export const KUSDT_V2_GENESIS_MAGIC = 'KASWIN_KUSDT_V2_GENESIS';

export const MAINNET_KUSDT_CID = '50b3477e7368d0c5bfbd64483b4607350ec411377972f33e40b2d4b6d1513fd3';
export const KCC20_EXT_TEMPLATE_HASH = '734850b0af0aeef49f009167bf9ddd238fd8c5cdbe214234f97181ac6f5cc498';
export const KCC20_PREFIX_HEX = '6b209703112ee6e3555107cd168858992b77d3b74f655205b2b463b1f9ec2ec73cf7';
export const KCC20_SUFFIX_LEN = 3885;

export const MANAGER_DEPOSIT = 400_000_000n;
export const SHARD_LEDGER_DEPOSIT = 200_000_000n;
export const SHARD_VAULT_DEPOSIT = 200_000_000n;
export const SHARD_TOTAL_DEPOSIT = SHARD_LEDGER_DEPOSIT + SHARD_VAULT_DEPOSIT;
export const WINNER_CARRIER_MIN = 150_000_000n;

export const PRICE_MIN = 1_000_000n;
export const EXECUTOR_REWARD = 500_000n;
export const MAX_SHARDS = 256;
export const MAX_RECORDS_PER_SHARD = 256;
export const MAX_ACTIVE_OPEN_SHARDS = 8;
export const MAX_BATCH = 8;
export const MIN_DRAW_TICKETS = 3;
export const DRAW_DELAY_DAA = 100n;
export const REROLL_TIMEOUT_DAA = 432_000n;
export const FEE_CAP = 50_000_000n;

export const STAGE = Object.freeze({
  M_OPEN: 0x01,
  M_SEALED: 0x02,
  M_DISPATCH: 0x03,
  S_OPEN: 0x11,
  S_FROZEN: 0x12,
  S_PAYOUT: 0x13,
  S_REFUND: 0x14,
});

export const DECISION = Object.freeze({
  UNDECIDED: 0x00,
  PAYOUT: 0x01,
  REFUND: 0x02,
});

export const KCC20_OWNER_SCHEME = Object.freeze({
  P2PK_SCHNORR: 0x00,
  OWNER_COVENANT_ID: 0x04,
});

export const KUSDT_V2_TEMPLATE_ORDER = Object.freeze([
  's_payout',
  's_refund',
  's_frozen',
  's_open',
  'm_dispatch',
  'm_sealed',
  'm_open',
]);

export const FROZEN_MAINNET_TEMPLATE_HASHES = Object.freeze({
  s_payout: 'd9c495e42d7730616441e05335ab8e30a742e7004e67f467ad4498111452e950',
  s_refund: '63f0f28aee985e1b3393c3722de1cbf1c4bec8eb565de75ee5125165c9a79983',
  s_frozen: '5f6a591bd11fc5d4f873ab17aa94cc5b41e688ff7b9bae34e157dd5f86dfc76a',
  s_open: '30213f2234df0b1f67794ef5b8fd6e91f144a3d745ffa282d679218ac52165fc',
  m_dispatch: 'c19b021080e31fd1408bd7aa7455cf11cfd4324d1cae0d94dd8ce6139db00050',
  m_sealed: 'e987429ff1ee8d5905fe6dc7c7a01ea5747f7e036d26d2a2e37e35c6d031f20f',
  m_open: '559e67acf808e5d48283421e01ac7dc3134d91109f09ac1257324fa85feb8f2a',
});

export function kusdtAsset(kusdtCid = MAINNET_KUSDT_CID) {
  return Object.freeze({
    kind: 'KCC20',
    symbol: 'kUSDT',
    decimals: 6,
    tokenCovenantId: kusdtCid,
  });
}
