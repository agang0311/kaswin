use kaspa_consensus_core::constants::{MAX_SOMPI, TX_VERSION_TOCCATA};
use kaspa_consensus_core::subnets::SubnetworkId;
use kaspa_consensus_core::tx::{
    ComputeCommit, CovenantBinding, PopulatedTransaction, ScriptPublicKey, Transaction,
    TransactionInput, TransactionOutpoint, TransactionOutput, UtxoEntry,
};
use kaspa_hashes::Hash;
use kaspa_txscript::covenants::CovenantsContext;
use kaspa_txscript::opcodes::codes::*;

#[path = "../../../../contracts/v1_constants.rs"]
pub mod v1_constants;
use v1_constants::DELTA_DAA_V1;

#[path = "../../../../contracts/ticket_commitment.rs"]
pub mod ticket_commitment;
use ticket_commitment::is_canonical_payout_spk;

#[path = "../../../../contracts/genesis.rs"]
pub mod genesis;
use genesis::{
    build_canonical_kaswin_genesis_output, validate_canonical_kaswin_create,
    validate_kaswin_create_parameters,
};

fn main() {
    println!("===============================================================");
    println!("KASWIN CANONICAL CREATE PARAMETER ADMISSION TEST (P1 - P5)");
    println!("===============================================================");

    let funding_outpoint = TransactionOutpoint::new(Hash::from_u64_word(12345), 0);
    let delta_daa = DELTA_DAA_V1; // 100
    let refund_lock_daa = 1_500_000u64;

    // Canonical Class A creator SPK (PubKey 36B)
    let mut creator_refund_spk = vec![0x00, 0x00, OpData32 as u8];
    creator_refund_spk.extend(vec![0x77; 32]);
    creator_refund_spk.push(OpCheckSig as u8);
    assert!(is_canonical_payout_spk(&creator_refund_spk));

    // -------------------------------------------------------------
    // P1: ticket_price = 0 -> FAIL
    // -------------------------------------------------------------
    println!("\n[Test P1] ticket_price = 0 (Must FAIL)");
    let res_p1 = validate_kaswin_create_parameters(
        0, // ticket_price = 0
        100,
        refund_lock_daa,
        &creator_refund_spk,
        50_000_000,
    );
    assert!(res_p1.is_err());
    println!("  -> PASS: ticket_price = 0 rejected with: {:?}", res_p1.err().unwrap());

    let res_p1_build = build_canonical_kaswin_genesis_output(
        funding_outpoint,
        0,
        100,
        delta_daa,
        refund_lock_daa,
        creator_refund_spk.clone(),
        50_000_000,
    );
    assert!(res_p1_build.is_err());
    println!("  -> PASS: build_canonical_kaswin_genesis_output rejected ticket_price = 0");

    // -------------------------------------------------------------
    // P2: state_deposit = 0 -> FAIL
    // -------------------------------------------------------------
    println!("\n[Test P2] state_deposit = 0 (Must FAIL)");
    let res_p2 = validate_kaswin_create_parameters(
        10_000_000,
        100,
        refund_lock_daa,
        &creator_refund_spk,
        0, // state_deposit = 0
    );
    assert!(res_p2.is_err());
    println!("  -> PASS: state_deposit = 0 rejected with: {:?}", res_p2.err().unwrap());

    let res_p2_build = build_canonical_kaswin_genesis_output(
        funding_outpoint,
        10_000_000,
        100,
        delta_daa,
        refund_lock_daa,
        creator_refund_spk.clone(),
        0,
    );
    assert!(res_p2_build.is_err());
    println!("  -> PASS: build_canonical_kaswin_genesis_output rejected state_deposit = 0");

    // -------------------------------------------------------------
    // P3: ticket_price * total_tickets checked_mul overflow -> FAIL
    // -------------------------------------------------------------
    println!("\n[Test P3] ticket_price * total_tickets checked_mul overflow (Must FAIL)");
    let res_p3 = validate_kaswin_create_parameters(
        u64::MAX / 10,
        100, // overflow u64
        refund_lock_daa,
        &creator_refund_spk,
        50_000_000,
    );
    assert!(res_p3.is_err());
    println!("  -> PASS: checked_mul overflow rejected with: {:?}", res_p3.err().unwrap());

    // -------------------------------------------------------------
    // P4: state_deposit + principal > MAX_SOMPI -> FAIL
    // -------------------------------------------------------------
    println!("\n[Test P4] state_deposit + principal > MAX_SOMPI (Must FAIL)");
    let res_p4 = validate_kaswin_create_parameters(
        1,
        1,
        refund_lock_daa,
        &creator_refund_spk,
        MAX_SOMPI, // MAX_SOMPI + 1 > MAX_SOMPI
    );
    assert!(res_p4.is_err());
    println!("  -> PASS: state_deposit + principal > MAX_SOMPI rejected with: {:?}", res_p4.err().unwrap());

    // -------------------------------------------------------------
    // P5: state_deposit + principal == MAX_SOMPI -> PASS
    // -------------------------------------------------------------
    println!("\n[Test P5] state_deposit + principal == MAX_SOMPI (Must PASS)");
    let res_p5 = validate_kaswin_create_parameters(
        1,
        100, // principal = 100
        refund_lock_daa,
        &creator_refund_spk,
        MAX_SOMPI - 100, // total = MAX_SOMPI
    );
    assert_eq!(res_p5, Ok(MAX_SOMPI));
    println!("  -> PASS: state_deposit + principal == MAX_SOMPI accepted with max_pool = {} sompi", res_p5.unwrap());

    // =============================================================
    // CREATE VALIDATOR NEGATIVE MATRIX (C1 - C9)
    // =============================================================
    println!("\n===============================================================");
    println!("KASWIN CANONICAL CREATE TRANSACTION MATRIX (C1 - C9)");
    println!("===============================================================");

    let ticket_price = 10_000_000u64;
    let total_tickets = 100u64;
    let state_deposit = 50_000_000u64;

    let (genesis_output_0, expected_covenant_id) = build_canonical_kaswin_genesis_output(
        funding_outpoint,
        ticket_price,
        total_tickets,
        DELTA_DAA_V1,
        refund_lock_daa,
        creator_refund_spk.clone(),
        state_deposit,
    ).unwrap();

    let valid_base_tx = Transaction::new(
        TX_VERSION_TOCCATA,
        vec![TransactionInput::new_with_mass(
            funding_outpoint,
            vec![0x33; 66],
            0,
            ComputeCommit::ComputeBudget(0.into()),
        )],
        vec![genesis_output_0.clone()],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );

    // C1: Canonical V1 CREATE transaction -> PASS
    println!("\n[Test C1] Canonical V1 CREATE transaction (Must PASS)");
    let res_c1 = validate_canonical_kaswin_create(
        &valid_base_tx,
        ticket_price,
        total_tickets,
        DELTA_DAA_V1,
        refund_lock_daa,
        &creator_refund_spk,
        state_deposit,
    );
    assert_eq!(res_c1, Ok(expected_covenant_id));
    println!("  -> PASS: Canonical V1 recognized with covenant_id = {}", res_c1.unwrap());

    // C2: delta != 100 -> FAIL
    println!("\n[Test C2] delta != 100 (Must FAIL)");
    let res_c2 = validate_canonical_kaswin_create(
        &valid_base_tx,
        ticket_price,
        total_tickets,
        101, // wrong delta
        refund_lock_daa,
        &creator_refund_spk,
        state_deposit,
    );
    assert!(res_c2.is_err());
    println!("  -> PASS: delta != 100 rejected with: {:?}", res_c2.err().unwrap());

    // C3: version 0 -> FAIL
    println!("\n[Test C3] CREATE version 0 (Must FAIL)");
    let mut tx_c3 = valid_base_tx.clone();
    tx_c3.version = 0;
    let res_c3 = validate_canonical_kaswin_create(
        &tx_c3,
        ticket_price,
        total_tickets,
        DELTA_DAA_V1,
        refund_lock_daa,
        &creator_refund_spk,
        state_deposit,
    );
    assert!(res_c3.is_err());
    println!("  -> PASS: Tx version 0 rejected with: {:?}", res_c3.err().unwrap());

    // C4: version 2 -> FAIL
    println!("\n[Test C4] CREATE version 2 (Must FAIL)");
    let mut tx_c4 = valid_base_tx.clone();
    tx_c4.version = 2;
    let res_c4 = validate_canonical_kaswin_create(
        &tx_c4,
        ticket_price,
        total_tickets,
        DELTA_DAA_V1,
        refund_lock_daa,
        &creator_refund_spk,
        state_deposit,
    );
    assert!(res_c4.is_err());
    println!("  -> PASS: Tx version 2 rejected with: {:?}", res_c4.err().unwrap());

    // C5: Output 0 wrong SPK -> FAIL
    println!("\n[Test C5] Output 0 wrong SPK (Must FAIL)");
    let mut tx_c5 = valid_base_tx.clone();
    tx_c5.outputs[0].script_public_key = ScriptPublicKey::from_vec(0, vec![0x51]);
    let res_c5 = validate_canonical_kaswin_create(
        &tx_c5,
        ticket_price,
        total_tickets,
        DELTA_DAA_V1,
        refund_lock_daa,
        &creator_refund_spk,
        state_deposit,
    );
    assert!(res_c5.is_err());
    println!("  -> PASS: Wrong Output 0 SPK rejected with: {:?}", res_c5.err().unwrap());

    // C6: Output 0 wrong covenant ID -> FAIL
    println!("\n[Test C6] Output 0 wrong covenant ID (Must FAIL)");
    let mut tx_c6 = valid_base_tx.clone();
    tx_c6.outputs[0].covenant = Some(CovenantBinding {
        covenant_id: Hash::from_u64_word(0xbadc0de),
        authorizing_input: 0,
    });
    let res_c6 = validate_canonical_kaswin_create(
        &tx_c6,
        ticket_price,
        total_tickets,
        DELTA_DAA_V1,
        refund_lock_daa,
        &creator_refund_spk,
        state_deposit,
    );
    assert!(res_c6.is_err());
    println!("  -> PASS: Wrong covenant ID on Output 0 rejected with: {:?}", res_c6.err().unwrap());

    // C7: Output 1 same covenant C -> FAIL
    println!("\n[Test C7] Output 1 reuses same covenant C (Must FAIL)");
    let mut tx_c7 = valid_base_tx.clone();
    tx_c7.outputs.push(TransactionOutput {
        value: 1_000_000,
        script_public_key: ScriptPublicKey::from_vec(0, creator_refund_spk[2..].to_vec()),
        covenant: Some(CovenantBinding {
            covenant_id: expected_covenant_id,
            authorizing_input: 0,
        }),
    });
    let res_c7 = validate_canonical_kaswin_create(
        &tx_c7,
        ticket_price,
        total_tickets,
        DELTA_DAA_V1,
        refund_lock_daa,
        &creator_refund_spk,
        state_deposit,
    );
    assert!(res_c7.is_err());
    println!("  -> PASS: Duplicate covenant C on Output 1 rejected with: {:?}", res_c7.err().unwrap());

    // C8 (CREATE-G1): Output 1 distinct valid genesis D with authorizing_input = 0 -> FAIL
    println!("\n[Test C8 / CREATE-G1] Output 1 distinct valid genesis D with authorizing_input=0 (Must FAIL in Kaswin)");
    let mut temp_out1 = TransactionOutput {
        value: 1_000_000,
        script_public_key: ScriptPublicKey::from_vec(0, creator_refund_spk[2..].to_vec()),
        covenant: None,
    };
    let official_d = kaspa_consensus_core::hashing::covenant_id::covenant_id(
        funding_outpoint,
        std::iter::once((1u32, &temp_out1)),
    );
    temp_out1.covenant = Some(CovenantBinding {
        covenant_id: official_d,
        authorizing_input: 0,
    });

    let mut tx_c8 = valid_base_tx.clone();
    tx_c8.outputs.push(temp_out1);

    // 1. Proove that consensus CovenantsContext considers this valid:
    let pop_c8 = PopulatedTransaction::new(&tx_c8, vec![
        UtxoEntry::new(100_000_000, ScriptPublicKey::from_vec(0, creator_refund_spk[2..].to_vec()), 1_000_000, false, None),
    ]);
    let cov_ctx_res = CovenantsContext::from_tx(&pop_c8);
    assert!(cov_ctx_res.is_ok(), "Consensus CovenantsContext MUST accept multiple valid genesis groups from Input 0!");
    println!("  -> Verified: Consensus CovenantsContext::from_tx() == Ok (D is consensus-valid genesis)");

    // 2. Prove that Kaswin validator strictly rejects it:
    let res_c8 = validate_canonical_kaswin_create(
        &tx_c8,
        ticket_price,
        total_tickets,
        DELTA_DAA_V1,
        refund_lock_daa,
        &creator_refund_spk,
        state_deposit,
    );
    assert_eq!(
        res_c8,
        Err("Non-zero output must not be authorized by Input 0 in CREATE transaction")
    );
    println!("  -> PASS: Kaswin validator strictly BLOCKED multi-genesis authorization on Output 1!");

    // C9: Ordinary non-covenant change output -> PASS
    println!("\n[Test C9] Ordinary non-covenant change output (Must PASS)");
    let mut tx_c9 = valid_base_tx.clone();
    tx_c9.outputs.push(TransactionOutput {
        value: 49_900_000, // change back to creator wallet
        script_public_key: ScriptPublicKey::from_vec(0, creator_refund_spk[2..].to_vec()),
        covenant: None,    // ordinary wallet change
    });
    let res_c9 = validate_canonical_kaswin_create(
        &tx_c9,
        ticket_price,
        total_tickets,
        DELTA_DAA_V1,
        refund_lock_daa,
        &creator_refund_spk,
        state_deposit,
    );
    assert_eq!(res_c9, Ok(expected_covenant_id));
    println!("  -> PASS: Valid CREATE with ordinary non-covenant change output accepted!");

    println!("\n===============================================================");
    println!("ALL 5 ADMISSION (P1-P5) AND 9 CREATE MATRIX (C1-C9) TESTS PASSED 100%!");
    println!("===============================================================");
}
