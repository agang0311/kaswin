/// Canonical constants strictly frozen for Kaswin Protocol V1.
///
/// Under Kaspa Testnet-10 Toccata consensus (10 BPS nominal block rate):
/// - DELTA_DAA_V1: Target DAA delay from round sealing to PoW entropy block (nominal 10 seconds).
/// - FULL_SALE_RECOVERY_DELAY_DAA_V1: Application policy grace period for permissionless draw claims
///   (432,000 DAA score units = 10 * 43,200 seconds = nominal 12 hours).

pub const DELTA_DAA_V1: u64 = 100;
pub const FULL_SALE_RECOVERY_DELAY_DAA_V1: u64 = 432_000;

// -----------------------------------------------------------------------------
// V1 Production Candidate Constants
// -----------------------------------------------------------------------------

/// Maximum total tickets allowed per Kaswin V1 round (ticket_cap <= 100,000)
pub const MAX_TICKET_CAP_V1: u64 = 100_000;

/// Maximum number of individual purchase range records allowed per round (directory capacity <= 256)
pub const MAX_PURCHASE_COUNT_V1: usize = 256;

/// Maximum price per ticket allowed at CREATE (10,000 KAS = 10^12 sompi)
pub const MAX_TICKET_PRICE_V1: u64 = 1_000_000_000_000;

/// Maximum allowable refund fee deductible per individual purchase (0.015 KAS = 1,500,000 sompi)
pub const MAX_REFUND_FEE_V1: u64 = 1_500_000;

/// Guaranteed minimum buyer refund payout per purchase record (0.0001 KAS = 10,000 sompi)
pub const MIN_REFUND_PAYOUT_V1: u64 = 10_000;

/// User-frozen minimum denomination: 1 KAS. With count >= 1, every
/// purchase can cover bounded refund fees without creating dust-sized refunds.
pub const MIN_TICKET_PRICE_V1: u64 = 100_000_000;

/// Creator capital floor (0.2 KAS), returned intact at every terminal path.
/// Final CREATE funding/change topology must separately pass MassCalculator admission.
/// Bounds the initial plurality-2 state output's storage contribution to 200,000.
pub const MIN_STATE_DEPOSIT_V1: u64 = 20_000_000;

/// Maximum batch size for sequential refunds (K_MAX = 16)
pub const REFUND_K_MAX_V1: usize = 16;

/// Fixed finalizer reward paid to permissionless caller on WINNER_READY -> PAID terminal settlement (1 KAS = 100M sompi)
pub const FINALIZER_REWARD_V1: u64 = 100_000_000;

/// Maximum allowable implicit miner fee deducted on terminal draw settlement (0.5 KAS = 50M sompi)
pub const MAX_FINALIZE_FEE_V1: u64 = 50_000_000;

/// Guaranteed minimum net winner payout on terminal draw settlement (1 KAS = 100M sompi)
pub const MIN_WINNER_PAYOUT_V1: u64 = 100_000_000;

/// SMT Depth for ticket commitment (2^27 purchase range leaves)
pub const TREE_DEPTH_V1: usize = 27;

/// Domain R for 56-bit winner rejection sampling (2^56)
pub const DOMAIN_R_56_V1: i64 = 1i64 << 56;

