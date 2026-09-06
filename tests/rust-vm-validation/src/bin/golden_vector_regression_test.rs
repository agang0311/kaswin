use kaspa_hashes::Hash;
use kaspa_consensus_core::tx::TransactionOutpoint;
use faster_hex::hex_string;

#[path = "../../../../contracts/v1_constants.rs"]
pub mod v1_constants;
use v1_constants::{DELTA_DAA_V1, FULL_SALE_RECOVERY_DELAY_DAA_V1};

#[path = "../../../../contracts/genesis.rs"]
pub mod genesis;
use genesis::build_canonical_kaswin_genesis_output;

#[path = "../../../../contracts/open_covenant.rs"]
pub mod open_covenant;

fn main() {
    println!("==================================================================");
    println!("KASWIN V1 CANONICAL GOLDEN VECTOR REGRESSION TEST");
    println!("==================================================================");

    // Canonical Testnet-10 Golden Vector Input Parameters:
    let funding_outpoint = TransactionOutpoint::new(Hash::from_u64_word(0xabc123), 0);
    let state_deposit = 50_000_000u64;  // 0.5 KAS
    let ticket_price  = 100_000_000u64; // 1.0 KAS
    let total_tickets = 100u64;
    let refund_lock_daa = 1_500_000u64;

    let mut creator_refund_spk = vec![0x00, 0x00, 0x20];
    creator_refund_spk.extend(vec![0xcc; 32]);
    creator_refund_spk.push(0xac);

    // Implicit Protocol V1 Constants:
    assert_eq!(DELTA_DAA_V1, 100);
    assert_eq!(FULL_SALE_RECOVERY_DELAY_DAA_V1, 432_000);

    // Canonical Derivations:
    let round_id = genesis::compute_canonical_round_id(&funding_outpoint);
    let (genesis_out, covenant_id_c) = build_canonical_kaswin_genesis_output(
        funding_outpoint,
        ticket_price,
        total_tickets,
        DELTA_DAA_V1,
        refund_lock_daa,
        creator_refund_spk.clone(),
        state_deposit,
    ).unwrap();

    let initial_open_redeem = open_covenant::build_initial_open_covenant(
        round_id,
        ticket_price,
        total_tickets,
        DELTA_DAA_V1,
        refund_lock_daa,
        creator_refund_spk,
    ).unwrap();

    let mut state = blake2b_simd::Params::new().hash_length(32).to_state();
    state.update(&initial_open_redeem);
    let redeem_hash = state.finalize();
    let redeem_hash_hex = hex_string(redeem_hash.as_bytes());
    let genesis_spk_hex = hex_string(genesis_out.script_public_key.script());
    let cov_id_hex = covenant_id_c.to_string();
    let round_id_hex = round_id.to_string();

    println!("Computed Artifacts:");
    println!("  round_id:                    {}", round_id_hex);
    println!("  initial_open_redeem_len:     {} bytes", initial_open_redeem.len());
    println!("  initial_open_redeem_blake2b: {}", redeem_hash_hex);
    println!("  genesis_output_0_spk:        {}", genesis_spk_hex);
    println!("  covenant_id_c:               {}", cov_id_hex);

    // Strict Golden Assertions:
    assert_eq!(
        round_id_hex,
        "1bd3a9f6a597c8eaffd40c6d40faf221bdbe0d486bd80852a7f227efeb2db4f2",
        "Canonical Round ID mismatch"
    );
    assert_eq!(
        initial_open_redeem.len(),
        9823,
        "Canonical Initial OPEN Redeem Script byte length mismatch"
    );
    assert_eq!(
        redeem_hash_hex,
        "e3e4b421615fbc47f40f37952772f33b59e7fc0fc147c4bd2b7f4f430c261a75",
        "Canonical Initial OPEN Redeem BLAKE2b-256 hash mismatch"
    );
    assert_eq!(
        genesis_spk_hex,
        "aa20e3e4b421615fbc47f40f37952772f33b59e7fc0fc147c4bd2b7f4f430c261a7587",
        "Canonical Genesis Output 0 ScriptPublicKey hex mismatch"
    );
    assert_eq!(
        cov_id_hex,
        "18e062983330a6e32371d97595f184e3e477ccd21dbe20bd91f636e6cd1e0f51",
        "Canonical KIP-20 Covenant ID C mismatch"
    );

    println!("\n  -> PASS: All Golden Vector invariants strictly verified 100% byte-for-byte!");
    println!("==================================================================");
}
