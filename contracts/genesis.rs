use kaspa_hashes::Hash;
use kaspa_consensus_core::tx::{Transaction, TransactionOutpoint, TransactionOutput, CovenantBinding};

#[path = "round_id.rs"]
pub mod round_id;
pub use round_id::compute_canonical_round_id;

#[path = "open_covenant.rs"]
pub mod open_covenant;
use open_covenant::build_initial_open_covenant;

#[path = "ticket_commitment.rs"]
pub mod ticket_commitment;
use ticket_commitment::is_canonical_payout_spk;

/// Deterministically builds the canonical Kaswin Genesis Output 0 and KIP-20 Covenant ID:
/// 1. Derives round_id from funding_outpoint.
/// 2. Builds canonical initial OPEN covenant including refund_lock_daa and reserve_payout_spk.
/// 3. Computes official KIP-20 covenant_id(funding_outpoint, [(0, temp_output)]).
/// 4. Sets CovenantBinding { covenant_id: C, authorizing_input: 0 }.
/// 5. Returns (canonical_output_0, covenant_id).
pub fn build_canonical_kaswin_genesis_output(
    funding_outpoint: TransactionOutpoint,
    ticket_price: u64,
    total_tickets: u64,
    delta_daa: u64,
    refund_lock_daa: u64,
    reserve_payout_spk: Vec<u8>,
    initial_reserve: u64,
) -> (TransactionOutput, Hash) {
    assert!(is_canonical_payout_spk(&reserve_payout_spk));
    let derived_round_id = compute_canonical_round_id(&funding_outpoint);

    let initial_open_redeem = build_initial_open_covenant(
        derived_round_id,
        ticket_price,
        total_tickets,
        delta_daa,
        refund_lock_daa,
        reserve_payout_spk,
    ).expect("valid initial open covenant");
    let initial_open_spk = kaspa_txscript::standard::pay_to_script_hash_script(&initial_open_redeem);

    let mut output_0 = TransactionOutput {
        value: initial_reserve,
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

    (output_0, official_covenant_id)
}

/// Validates whether a transaction is a canonical Kaswin CREATE transaction.
pub fn validate_canonical_kaswin_create(
    tx: &Transaction,
    ticket_price: u64,
    total_tickets: u64,
    delta_daa: u64,
    refund_lock_daa: u64,
    reserve_payout_spk: &[u8],
    initial_reserve: u64,
) -> Result<Hash, &'static str> {
    if tx.version < 1 {
        return Err("Transaction version must be >= 1 for covenants");
    }
    if tx.inputs.is_empty() {
        return Err("Missing input 0");
    }
    if tx.outputs.is_empty() {
        return Err("Missing output 0");
    }
    if !is_canonical_payout_spk(reserve_payout_spk) {
        return Err("reserve_payout_spk must be canonical");
    }

    let funding_outpoint = tx.inputs[0].previous_outpoint;
    let (expected_output_0, expected_covenant_id) = build_canonical_kaswin_genesis_output(
        funding_outpoint,
        ticket_price,
        total_tickets,
        delta_daa,
        refund_lock_daa,
        reserve_payout_spk.to_vec(),
        initial_reserve,
    );

    let output_0 = &tx.outputs[0];
    if output_0.value != initial_reserve {
        return Err("Output 0 value mismatch with declared initial_reserve");
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
        return Err("Output 0 covenant_id does not match official KIP-20 recomputed genesis covenant_id");
    }

    for out in tx.outputs.iter().skip(1) {
        if let Some(cov) = out.covenant.as_ref() {
            if cov.covenant_id == expected_covenant_id || cov.authorizing_input == 0 {
                return Err("Multiple outputs in genesis group with same covenant_id or authorizing_input 0");
            }
        }
    }

    Ok(expected_covenant_id)
}
