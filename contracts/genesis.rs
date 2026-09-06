// Kaswin KIP-20 Genesis & Create Transaction Validation
//
// Protocol Version: Kaswin V1 (Toccata Consensus Rules)
// Economic Model: State Deposit & Principal Segregation
//
// State Deposit Semantics:
// - Provided by creator (initial genesis output 0 amount)
// - Does not earn tickets and does NOT belong to the prize pool
// - NEVER paid to the winner
// - Automatically returned to creator_refund_spk on normal winner settlement,
//   unsold refund, and full-sale timeout refund
// - Transaction fees must NOT be deducted from state_deposit

use kaspa_hashes::Hash;
use kaspa_consensus_core::tx::{Transaction, TransactionOutpoint, TransactionOutput, CovenantBinding};
use kaspa_consensus_core::constants::{MAX_SOMPI, TX_VERSION_TOCCATA};
use kaspa_txscript::LOCK_TIME_THRESHOLD;

#[path = "v1_constants.rs"]
pub mod v1_constants;
use v1_constants::DELTA_DAA_V1;

#[path = "round_id.rs"]
pub mod round_id;
pub use round_id::compute_canonical_round_id;

#[path = "open_covenant.rs"]
pub mod open_covenant;
use open_covenant::build_initial_open_covenant;

#[path = "ticket_commitment.rs"]
pub mod ticket_commitment;
use ticket_commitment::is_canonical_payout_spk;

/// Validates admission parameters for creating a new Kaswin V1 round:
/// 1. 1 <= total_tickets <= 100_000_000
/// 2. ticket_price >= 1 sompi
/// 3. state_deposit >= 1 sompi
/// 4. 0 < refund_lock_daa < LOCK_TIME_THRESHOLD
/// 5. ticket_principal = ticket_price.checked_mul(total_tickets)
/// 6. max_pool = state_deposit.checked_add(ticket_principal)
/// 7. max_pool <= MAX_SOMPI
/// 8. is_canonical_payout_spk(creator_refund_spk)
pub fn validate_kaswin_create_parameters(
    ticket_price: u64,
    total_tickets: u64,
    refund_lock_daa: u64,
    creator_refund_spk: &[u8],
    state_deposit: u64,
) -> Result<u64, &'static str> {
    if total_tickets < 1 || total_tickets > 100_000_000 {
        return Err("total_tickets must be between 1 and 100_000_000");
    }
    if ticket_price < 1 {
        return Err("ticket_price must be >= 1 sompi (zero-value ticket invalid)");
    }
    if state_deposit < 1 {
        return Err("state_deposit must be >= 1 sompi (zero-value genesis output invalid)");
    }
    if refund_lock_daa == 0 || refund_lock_daa >= LOCK_TIME_THRESHOLD {
        return Err("refund_lock_daa must be > 0 and < LOCK_TIME_THRESHOLD (500_000_000_000)");
    }
    if !is_canonical_payout_spk(creator_refund_spk) {
        return Err("creator_refund_spk must be canonical class A/B/C SPK");
    }

    let ticket_principal = ticket_price
        .checked_mul(total_tickets)
        .ok_or("ticket_price * total_tickets checked_mul overflow")?;

    let max_pool = state_deposit
        .checked_add(ticket_principal)
        .ok_or("state_deposit + ticket_principal checked_add overflow")?;

    if max_pool > MAX_SOMPI {
        return Err("max_pool exceeds consensus MAX_SOMPI limit");
    }

    Ok(max_pool)
}

/// Deterministically builds the canonical Kaswin Genesis Output 0 and KIP-20 Covenant ID:
/// 1. Validates create parameters via validate_kaswin_create_parameters.
/// 2. Enforces canonical V1 delta_daa == DELTA_DAA_V1 (100).
/// 3. Derives round_id from funding_outpoint.
/// 4. Builds canonical initial OPEN covenant including refund_lock_daa and creator_refund_spk.
/// 5. Computes official KIP-20 covenant_id(funding_outpoint, [(0, temp_output)]).
/// 6. Sets CovenantBinding { covenant_id: C, authorizing_input: 0 }.
/// 7. Returns (canonical_output_0, covenant_id).
pub fn build_canonical_kaswin_genesis_output(
    funding_outpoint: TransactionOutpoint,
    ticket_price: u64,
    total_tickets: u64,
    delta_daa: u64,
    refund_lock_daa: u64,
    creator_refund_spk: Vec<u8>,
    state_deposit: u64,
) -> Result<(TransactionOutput, Hash), &'static str> {
    if delta_daa != DELTA_DAA_V1 {
        return Err("delta_daa must be exactly DELTA_DAA_V1 (100) for canonical Kaswin V1");
    }

    validate_kaswin_create_parameters(
        ticket_price,
        total_tickets,
        refund_lock_daa,
        &creator_refund_spk,
        state_deposit,
    )?;

    let derived_round_id = compute_canonical_round_id(&funding_outpoint);

    let initial_open_redeem = build_initial_open_covenant(
        derived_round_id,
        ticket_price,
        total_tickets,
        DELTA_DAA_V1,
        refund_lock_daa,
        creator_refund_spk,
    ).map_err(|_| "failed to build initial open covenant")?;
    let initial_open_spk = kaspa_txscript::standard::pay_to_script_hash_script(&initial_open_redeem);

    let mut output_0 = TransactionOutput {
        value: state_deposit,
        script_public_key: initial_open_spk,
        covenant: None,
    };

    let official_covenant_id = kaspa_consensus_core::hashing::covenant_id::covenant_id(
        funding_outpoint,
        std::iter::once((0u32, &output_0)),
    );

    output_0.covenant = Some(CovenantBinding {
        covenant_id: official_covenant_id,
        authorizing_input: 0,
    });

    Ok((output_0, official_covenant_id))
}

/// Validates whether a transaction is a canonical Kaswin CREATE transaction.
pub fn validate_canonical_kaswin_create(
    tx: &Transaction,
    ticket_price: u64,
    total_tickets: u64,
    delta_daa: u64,
    refund_lock_daa: u64,
    creator_refund_spk: &[u8],
    state_deposit: u64,
) -> Result<Hash, &'static str> {
    if delta_daa != DELTA_DAA_V1 {
        return Err("delta_daa must be exactly DELTA_DAA_V1 (100) for canonical Kaswin V1");
    }
    if tx.version != TX_VERSION_TOCCATA {
        return Err("Transaction version must be exactly TX_VERSION_TOCCATA (1)");
    }
    if tx.inputs.is_empty() {
        return Err("Missing input 0");
    }
    if tx.outputs.is_empty() {
        return Err("Missing output 0");
    }

    validate_kaswin_create_parameters(
        ticket_price,
        total_tickets,
        refund_lock_daa,
        creator_refund_spk,
        state_deposit,
    )?;

    let funding_outpoint = tx.inputs[0].previous_outpoint;
    let (expected_output_0, expected_covenant_id) = build_canonical_kaswin_genesis_output(
        funding_outpoint,
        ticket_price,
        total_tickets,
        delta_daa,
        refund_lock_daa,
        creator_refund_spk.to_vec(),
        state_deposit,
    )?;

    let output_0 = &tx.outputs[0];
    if output_0.value != state_deposit {
        return Err("Output 0 value mismatch with declared state_deposit");
    }
    if output_0.script_public_key != expected_output_0.script_public_key {
        return Err("Output 0 SPK does not match canonical initial OPEN covenant");
    }

    let Some(binding) = output_0.covenant.as_ref() else {
        return Err("Output 0 is missing covenant binding");
    };

    if binding.authorizing_input != 0 {
        return Err("Output 0 authorizing_input must be 0");
    }

    if binding.covenant_id != expected_covenant_id {
        return Err("Output 0 covenant_id mismatch with canonical derivation");
    }

    // Genesis Isolation: All non-zero outputs (outputs[1..]) must NOT reuse covenant C,
    // and must NOT be authorized by Input 0 (no multi-genesis authorization from input 0).
    // Ordinary wallet change outputs (covenant == None) are explicitly permitted.
    for output in tx.outputs.iter().skip(1) {
        if let Some(cov) = output.covenant.as_ref() {
            if cov.covenant_id == expected_covenant_id {
                return Err("Non-zero output reuses covenant ID C in CREATE transaction");
            }
            if cov.authorizing_input == 0 {
                return Err("Non-zero output must not be authorized by Input 0 in CREATE transaction");
            }
        }
    }

    Ok(expected_covenant_id)
}
