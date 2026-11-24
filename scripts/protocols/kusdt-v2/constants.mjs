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

export const TOKEN_AMOUNT_LIMIT = 1_000_000_000_000_000_000n;
export const PRICE_MIN = 1_000_000n;
export const PRICE_MAX = TOKEN_AMOUNT_LIMIT / 2n; // 500,000,000,000 kUSDT (matches s_refund.sil TOKEN_AMOUNT_LIMIT / 2)
export const EXECUTOR_REWARD = 500_000n;
export const MAX_SHARDS = 256;
export const MAX_RECORDS_PER_SHARD = 256;
export const MAX_ACTIVE_OPEN_SHARDS = 8;
export const MAX_BATCH = 8;
export const MIN_DRAW_TICKETS = 3;
export const DRAW_DELAY_DAA = 100n;
export const REROLL_TIMEOUT_DAA = 432_000n;
export const DAA_LIMIT = 500_000_000_000n;
export const CLOSE_DAA_MAX = DAA_LIMIT - REROLL_TIMEOUT_DAA; // 499,999,568,000 (matches m_open.sil)
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
  s_refund: 'adf4eb35939f240a77de7f7ac0700b9116dca627452056523b8c63e2fd63cf16',
  s_frozen: 'dce727e1cb4a6d9ddc421d65d87af54becaff2234861ea3d356894e5d7456c62',
  s_open: '3d5ce67b7a302d18a63a824e16056b27ec549350db9a50c7f7d00587416a256f',
  m_dispatch: '529a66a41b1a277e57162d9dadaf3ffe49538b83cfff9adcd874286ed6ba3fba',
  m_sealed: '3e07af22007701e0c41d42f5a6bef38eb999c5079d5c3673f9617e04dc1b770c',
  m_open: '39a29f4e215a2d264aa1dad63ec61b41633c7ff3822fe8e8c6d888b32d2e5445',
});

export function kusdtAsset(kusdtCid = MAINNET_KUSDT_CID) {
  return Object.freeze({
    kind: 'KCC20',
    symbol: 'kUSDT',
    decimals: 6,
    tokenCovenantId: kusdtCid,
  });
}
