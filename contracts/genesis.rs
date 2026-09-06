use kaspa_hashes::{Hash, ZERO_HASH};
use kaspa_consensus_core::tx::{Transaction, TransactionOutpoint, TransactionOutput};

#[path = "round_id.rs"]
pub mod round_id;
pub use round_id::compute_canonical_round_id;

#[path = "open_covenant.rs"]
pub mod open_covenant;
use open_covenant::build_initial_open_covenant;

#[path = "ticket_commitment.rs"]
pub mod ticket_commitment;
use ticket_commitment::compute_empty_root_27;

/// Validates whether a transaction is a canonical Kaswin CREATE transaction:
/// - Input 0 exists and serves as the funding outpoint
/// - Transaction version >= 1
/// - round_id is canonically derived: BLAKE2b256(b"KaswinRoundV1" || outpoint.txid || outpoint.index)
/// - Output 0 is the UNIQUE Kaswin genesis output:
///   - value == declared initial_reserve
///   - script_public_key == P2SH(build_initial_open_covenant(derived_round_id, ticket_price, total_tickets, delta_daa))
///   - covenant binding == Some(CovenantBinding { covenant_id: C, authorizing_input: 0 })
///   - C == official recomputed KIP-20 covenant_id(Input0.previous_outpoint, [(0, Output0)])
/// - No second output in the transaction carries a covenant binding from this genesis group
pub fn validate_canonical_kaswin_create(
    tx: &Transaction,
    ticket_price: u64,
    total_tickets: u64,
    delta_daa: u64,
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

    let funding_outpoint = tx.inputs[0].previous_outpoint;
    let derived_round_id = compute_canonical_round_id(&funding_outpoint);

    let expected_redeem = build_initial_open_covenant(
        derived_round_id,
        ticket_price,
        total_tickets,
        delta_daa,
    ).map_err(|_| "Failed to build initial open covenant")?;

    let expected_spk = kaspa_txscript::standard::pay_to_script_hash_script(&expected_redeem);

    let output_0 = &tx.outputs[0];
    if output_0.value != initial_reserve {
        return Err("Output 0 value mismatch with declared initial_reserve");
    }
    if output_0.script_public_key != expected_spk {
        return Err("Output 0 SPK does not match canonical initial OPEN covenant");
    }

    let Some(binding) = output_0.covenant.as_ref() else {
        return Err("Output 0 is missing covenant binding");
    };

    if binding.authorizing_input != 0 {
        return Err("Output 0 authorizing_input must be 0");
    }

    // Official recomputed KIP-20 covenant_id:
    // Genesis outpoint is Input 0's previous_outpoint.
    // Authorized outputs for authorizing_input 0 is [(0, output_0)]:
    let expected_covenant_id = kaspa_consensus_core::hashing::covenant_id::covenant_id(
        funding_outpoint,
        std::iter::once((0u32, output_0)),
    );

    if binding.covenant_id != expected_covenant_id {
        return Err("Output 0 covenant_id does not match official KIP-20 recomputed genesis covenant_id");
    }

    // Verify no second output in tx belongs to this covenant or has authorizing_input 0:
    for (idx, out) in tx.outputs.iter().enumerate().skip(1) {
        if let Some(cov) = out.covenant.as_ref() {
            if cov.covenant_id == expected_covenant_id || cov.authorizing_input == 0 {
                return Err("Multiple outputs in genesis group with same covenant_id or authorizing_input 0");
            }
        }
    }

    Ok(expected_covenant_id)
}
