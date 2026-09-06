use kaspa_consensus_core::constants::MAX_SOMPI;
use kaspa_consensus_core::tx::TransactionOutpoint;
use kaspa_hashes::Hash;
use kaspa_txscript::opcodes::codes::*;

#[path = "../../../../contracts/ticket_commitment.rs"]
pub mod ticket_commitment;
use ticket_commitment::is_canonical_payout_spk;

#[path = "../../../../contracts/genesis.rs"]
pub mod genesis;
use genesis::{build_canonical_kaswin_genesis_output, validate_kaswin_create_parameters};

fn main() {
    println!("===============================================================");
    println!("KASWIN CANONICAL CREATE PARAMETER ADMISSION TEST (P1 - P5)");
    println!("===============================================================");

    // Canonical Class A reserve SPK (PubKey 36B)
    let mut reserve_payout_spk = vec![0x00, 0x00, OpData32 as u8];
    reserve_payout_spk.extend(vec![0x77; 32]);
    reserve_payout_spk.push(OpCheckSig as u8);
    assert!(is_canonical_payout_spk(&reserve_payout_spk));

    let refund_lock_daa = 1_500_000u64;
    let funding_outpoint = TransactionOutpoint::new(Hash::from_u64_word(112233), 0);
    let delta_daa = 100u64;

    // -------------------------------------------------------------
    // P1: ticket_price = 0 -> FAIL
    // -------------------------------------------------------------
    println!("\n[Test P1] ticket_price = 0 (Must FAIL)");
    let res_p1 = validate_kaswin_create_parameters(
        0, // ticket_price = 0
        100,
        refund_lock_daa,
        &reserve_payout_spk,
        50_000_000,
    );
    assert!(res_p1.is_err());
    println!("  -> PASS: ticket_price = 0 rejected with: {:?}", res_p1.err().unwrap());

    // Also check build_canonical_kaswin_genesis_output fails
    let res_p1_build = build_canonical_kaswin_genesis_output(
        funding_outpoint,
        0,
        100,
        delta_daa,
        refund_lock_daa,
        reserve_payout_spk.clone(),
        50_000_000,
    );
    assert!(res_p1_build.is_err());
    println!("  -> PASS: build_canonical_kaswin_genesis_output rejected ticket_price = 0");

    // -------------------------------------------------------------
    // P2: initial_reserve = 0 -> FAIL
    // -------------------------------------------------------------
    println!("\n[Test P2] initial_reserve = 0 (Must FAIL)");
    let res_p2 = validate_kaswin_create_parameters(
        10_000_000,
        100,
        refund_lock_daa,
        &reserve_payout_spk,
        0, // initial_reserve = 0
    );
    assert!(res_p2.is_err());
    println!("  -> PASS: initial_reserve = 0 rejected with: {:?}", res_p2.err().unwrap());

    let res_p2_build = build_canonical_kaswin_genesis_output(
        funding_outpoint,
        10_000_000,
        100,
        delta_daa,
        refund_lock_daa,
        reserve_payout_spk.clone(),
        0,
    );
    assert!(res_p2_build.is_err());
    println!("  -> PASS: build_canonical_kaswin_genesis_output rejected initial_reserve = 0");

    // -------------------------------------------------------------
    // P3: ticket_price * total_tickets checked_mul overflow -> FAIL
    // -------------------------------------------------------------
    println!("\n[Test P3] ticket_price * total_tickets checked_mul overflow (Must FAIL)");
    let res_p3 = validate_kaswin_create_parameters(
        u64::MAX / 10,
        100, // overflow u64
        refund_lock_daa,
        &reserve_payout_spk,
        50_000_000,
    );
    assert!(res_p3.is_err());
    println!("  -> PASS: checked_mul overflow rejected with: {:?}", res_p3.err().unwrap());

    // -------------------------------------------------------------
    // P4: initial_reserve + principal > MAX_SOMPI -> FAIL
    // -------------------------------------------------------------
    println!("\n[Test P4] initial_reserve + principal > MAX_SOMPI (Must FAIL)");
    let res_p4 = validate_kaswin_create_parameters(
        1,
        1,
        refund_lock_daa,
        &reserve_payout_spk,
        MAX_SOMPI, // MAX_SOMPI + 1 > MAX_SOMPI
    );
    assert!(res_p4.is_err());
    println!("  -> PASS: initial_reserve + principal > MAX_SOMPI rejected with: {:?}", res_p4.err().unwrap());

    // -------------------------------------------------------------
    // P5: initial_reserve + principal == MAX_SOMPI -> PASS
    // -------------------------------------------------------------
    println!("\n[Test P5] initial_reserve + principal == MAX_SOMPI (Must PASS)");
    let res_p5 = validate_kaswin_create_parameters(
        1,
        100, // principal = 100
        refund_lock_daa,
        &reserve_payout_spk,
        MAX_SOMPI - 100, // total = MAX_SOMPI
    );
    assert_eq!(res_p5, Ok(MAX_SOMPI));
    println!("  -> PASS: initial_reserve + principal == MAX_SOMPI accepted with max_pool = {} sompi", res_p5.unwrap());

    println!("\n===============================================================");
    println!("ALL 5 PARAMETER ADMISSION TESTS (P1 - P5) PASSED 100%!");
    println!("===============================================================");
}
