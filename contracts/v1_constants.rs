/// Canonical constants strictly frozen for Kaswin Protocol V1.
///
/// Under Kaspa Testnet-10 Toccata consensus (10 BPS nominal block rate):
/// - DELTA_DAA_V1: Target DAA delay from round sealing to PoW entropy block (nominal 10 seconds).
/// - FULL_SALE_RECOVERY_DELAY_DAA_V1: Application policy grace period for permissionless draw claims
///   (432,000 DAA score units = 10 * 43,200 seconds = nominal 12 hours).

pub const DELTA_DAA_V1: u64 = 100;
pub const FULL_SALE_RECOVERY_DELAY_DAA_V1: u64 = 432_000;
