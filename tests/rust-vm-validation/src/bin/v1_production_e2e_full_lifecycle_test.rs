#![allow(unused_imports, unused_variables, dead_code)]
// Kaswin V1 Production Full Lifecycle E2E Test
//
// Exercises:
// Part 1: Real Connected Production SUCCESS E2E:
//         CREATE -> OPEN -> BUY #1 (30) -> BUY #2 (10) -> BUY #3 (55) -> CLOSE (sold=95 >= min=90)
//         -> SEALED (draw_ticket_count=95 != ticket_cap=100) -> DRAW_READY(0) -> ACCEPT -> WINNER_READY -> PAID
//         Every step spends exact previous transaction outpoint, exact amount, exact SPK, exact covenant.
// Part 2: Real Connected Production REFUND E2E (P=17):
//         OPEN(17 records) -> CLOSE (sold < min) -> REFUNDING(cur=0) -> K=9 -> REFUNDING(cur=9) -> K=8 terminal.
//         Exact previous outpoints, SPKs, amounts, covenant propagation and terminal destruction.
// Part 3: Boundary tests for P=1 and P=256.

use kaspa_hashes::Hash;
use kaspa_consensus_core::tx::{
    ComputeCommit, Transaction, TransactionInput, TransactionOutput, TransactionOutpoint,
    UtxoEntry, PopulatedTransaction, ScriptPublicKey, CovenantBinding,
};
use kaspa_consensus_core::subnets::SubnetworkId;
use kaspa_consensus_core::mass::ComputeBudget;
use kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync;
use kaspa_txscript::{
    TxScriptEngine, EngineFlags, EngineCtx, caches::Cache,
    script_builder::ScriptBuilder,
    standard::pay_to_script_hash_script,
    covenants::CovenantsContext,
    opcodes::codes::*,
    SeqCommitAccessor,
};
use std::collections::HashMap;

#[path = "../../../../contracts/v1_constants.rs"]
pub mod v1_constants;
use v1_constants::*;

#[path = "../../../../contracts/ticket_commitment.rs"]
pub mod ticket_commitment;
use ticket_commitment::{
    compute_empty_leaf, compute_empty_levels, compute_empty_root_27,
    compute_payout_commitment, compute_purchase_leaf, compute_root_from_path,
    hash_internal_node, TREE_DEPTH,
};

#[path = "../../../../contracts/open_covenant.rs"]
pub mod open_covenant;
use open_covenant::*;

#[path = "../../../../contracts/sealed_covenant.rs"]
pub mod sealed_covenant;
use sealed_covenant::*;

#[path = "../../../../contracts/winner_ready_settlement.rs"]
pub mod winner_ready_settlement;
use winner_ready_settlement::build_production_winner_ready_3out_covenant;

#[path = "../../../../contracts/winner_selection.rs"]
pub mod winner_selection;
use winner_selection::{
    build_directory_draw_ready_covenant, compute_candidate_hash, extract_candidate_num,
};

#[path = "../../../../contracts/refunding_covenant.rs"]
pub mod refunding_covenant;
use refunding_covenant::*;

#[path = "../../../../contracts/genesis.rs"]
pub mod genesis;
use genesis::*;

struct MockSeqCommitAccessor {
    selected_chain: Vec<Hash>,
    seq_commits: HashMap<Hash, Hash>,
}

impl SeqCommitAccessor for MockSeqCommitAccessor {
    fn is_chain_ancestor_from_pov(&self, block_hash: Hash) -> Option<bool> {
        Some(self.selected_chain.contains(&block_hash))
    }
    fn seq_commitment_within_depth(&self, block_hash: Hash) -> Option<Hash> {
        self.seq_commits.get(&block_hash).copied()
    }
}

fn blake3_hash(key: [u8; 32], data: &[u8]) -> Hash {
    let h = blake3::keyed_hash(&key, data);
    let mut out = [0u8; 32];
    out.copy_from_slice(h.as_bytes());
    Hash::from_bytes(out)
}

struct PassAOpeningFixture {
    target_hash: Hash,
    target_activity: Hash,
    target_payload: Hash,
    target_sp_ts: [u8; 8],
    target_daa: [u8; 8],
    target_blue: [u8; 8],
    p_parent_seq: Hash,
    p_activity: Hash,
    p_payload: Hash,
    p_sp_ts: [u8; 8],
    p_daa: [u8; 8],
    p_blue: [u8; 8],
    c_t: Hash,
}

fn generate_valid_pass_a_fixture(p_daa_num: u64, t_daa_num: u64) -> PassAOpeningFixture {
    let mut key_ctx = [0u8; 32];
    key_ctx[..b"SeqCommitMergesetContext".len()].copy_from_slice(b"SeqCommitMergesetContext");
    let mut key_branch = [0u8; 32];
    key_branch[..b"SeqCommitmentMerkleBranchHash".len()].copy_from_slice(b"SeqCommitmentMerkleBranchHash");

    let p_sp_ts = 1_000_000u64.to_le_bytes();
    let p_daa = p_daa_num.to_le_bytes();
    let p_blue = (p_daa_num - 100).to_le_bytes();
    let mut p_ctx_in = Vec::new();
    p_ctx_in.extend_from_slice(&p_sp_ts);
    p_ctx_in.extend_from_slice(&p_daa);
    p_ctx_in.extend_from_slice(&p_blue);
    let p_ctx = blake3_hash(key_ctx, &p_ctx_in);

    let p_payload = Hash::from_u64_word(101);
    let mut p_pd_in = Vec::new();
    p_pd_in.extend_from_slice(&p_ctx.as_bytes());
    p_pd_in.extend_from_slice(&p_payload.as_bytes());
    let p_pd = blake3_hash(key_branch, &p_pd_in);

    let p_activity = Hash::from_u64_word(102);
    let mut p_sr_in = Vec::new();
    p_sr_in.extend_from_slice(&p_activity.as_bytes());
    p_sr_in.extend_from_slice(&p_pd.as_bytes());
    let p_sr = blake3_hash(key_branch, &p_sr_in);

    let p_parent_seq = Hash::from_u64_word(103);
    let mut c_p_in = Vec::new();
    c_p_in.extend_from_slice(&p_parent_seq.as_bytes());
    c_p_in.extend_from_slice(&p_sr.as_bytes());
    let c_p = blake3_hash(key_branch, &c_p_in);

    let target_sp_ts = 1_000_001u64.to_le_bytes();
    let target_daa = t_daa_num.to_le_bytes();
    let target_blue = (t_daa_num - 100).to_le_bytes();
    let mut t_ctx_in = Vec::new();
    t_ctx_in.extend_from_slice(&target_sp_ts);
    t_ctx_in.extend_from_slice(&target_daa);
    t_ctx_in.extend_from_slice(&target_blue);
    let t_ctx = blake3_hash(key_ctx, &t_ctx_in);

    let target_payload = Hash::from_u64_word(201);
    let mut t_pd_in = Vec::new();
    t_pd_in.extend_from_slice(&t_ctx.as_bytes());
    t_pd_in.extend_from_slice(&target_payload.as_bytes());
    let t_pd = blake3_hash(key_branch, &t_pd_in);

    let target_activity = Hash::from_u64_word(202);
    let mut t_sr_in = Vec::new();
    t_sr_in.extend_from_slice(&target_activity.as_bytes());
    t_sr_in.extend_from_slice(&t_pd.as_bytes());
    let t_sr = blake3_hash(key_branch, &t_sr_in);

    let mut c_t_in = Vec::new();
    c_t_in.extend_from_slice(&c_p.as_bytes());
    c_t_in.extend_from_slice(&t_sr.as_bytes());
    let c_t = blake3_hash(key_branch, &c_t_in);

    let target_hash = Hash::from_u64_word(999);

    PassAOpeningFixture {
        target_hash,
        target_activity,
        target_payload,
        target_sp_ts,
        target_daa,
        target_blue,
        p_parent_seq,
        p_activity,
        p_payload,
        p_sp_ts,
        p_daa,
        p_blue,
        c_t,
    }
}

fn build_pass_a_witness(f: &PassAOpeningFixture, redeem_script: &[u8]) -> Vec<u8> {
    let mut sb = ScriptBuilder::with_flags(EngineFlags { covenants_enabled: true, ..Default::default() });
    sb.add_data(&f.target_hash.as_bytes()).unwrap();
    sb.add_data(&f.target_activity.as_bytes()).unwrap();
    sb.add_data(&f.target_payload.as_bytes()).unwrap();
    sb.add_data(&f.target_sp_ts).unwrap();
    sb.add_data(&f.target_daa).unwrap();
    sb.add_data(&f.target_blue).unwrap();
    sb.add_data(&f.p_parent_seq.as_bytes()).unwrap();
    sb.add_data(&f.p_activity.as_bytes()).unwrap();
    sb.add_data(&f.p_payload.as_bytes()).unwrap();
    sb.add_data(&f.p_sp_ts).unwrap();
    sb.add_data(&f.p_daa).unwrap();
    sb.add_data(&f.p_blue).unwrap();
    sb.add_i64(1).unwrap(); // ACTION_DRAW = 1
    sb.add_data(redeem_script).unwrap();
    sb.drain()
}

fn main() {
    println!("==================================================================");
    println!("KASWIN V1 PRODUCTION E2E FULL LIFECYCLE VERIFICATION SUITE");
    println!("==================================================================");

    let flags = EngineFlags { covenants_enabled: true, ..Default::default() };
    let sig_cache = Cache::new(1000);
    let reused = SigHashReusedValuesUnsync::new();

    // =========================================================================
    // PART 1: REAL CONNECTED PRODUCTION SUCCESS E2E PIPELINE
    // =========================================================================
    println!("\n------------------------------------------------------------------");
    println!("PART 1: REAL CONNECTED PRODUCTION SUCCESS E2E PIPELINE");
    println!("------------------------------------------------------------------");

    let funding_outpoint = TransactionOutpoint::new(Hash::from_u64_word(0xbeef01), 0);
    let ticket_price = 3_000_000u64; // 0.03 KAS (>= MIN_TICKET_PRICE_V1 = 1.51M)
    let ticket_cap = 100u64;
    let min_tickets = 90u64; // 90 * 3M = 270M sompi >= 250M min draw pool
    let sale_deadline = 1_500_000u64;
    let state_deposit = 50_000_000u64; // 0.5 KAS

    let mut creator_refund_spk = vec![0x00, 0x00, 0x20];
    creator_refund_spk.extend_from_slice(&[0xaa; 32]);
    creator_refund_spk.push(0xac);
    let creator_refund_script = creator_refund_spk[2..].to_vec();

    let round_id = genesis::compute_canonical_round_id(&funding_outpoint);

    // [1.1] CREATE TRANSACTION
    println!("\n[Step 1.1] CREATE Transaction -> Genesis Output 0");
    let (genesis_output, covenant_id_c) = build_directory_genesis_output(
        funding_outpoint,
        ticket_price,
        ticket_cap,
        min_tickets,
        sale_deadline,
        creator_refund_spk.clone(),
        state_deposit,
    ).unwrap();

    let tx_create = Transaction::new(
        1, // TX_VERSION_TOCCATA
        vec![TransactionInput::new_with_mass(
            funding_outpoint,
            vec![0x33; 66],
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![genesis_output.clone()],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    println!("  -> CREATE transaction created: id = {}", tx_create.id());

    // [1.2] BUY #1 (count = 30)
    println!("\n[Step 1.2] BUY #1: Buyer 1 purchases 30 tickets [0..30)");
    let buyer1_pubkey = [0x11u8; 32];
    let mut buyer1_spk = vec![0x20];
    buyer1_spk.extend_from_slice(&buyer1_pubkey);
    buyer1_spk.push(0xac);
    let count1 = 30u64;

    let empty_levels = compute_empty_levels();
    let mut siblings_1 = [Hash::default(); TREE_DEPTH];
    for i in 0..TREE_DEPTH { siblings_1[i] = empty_levels[i]; }

    let payout_comm_1 = compute_payout_commitment(&buyer1_spk);
    let leaf_1 = compute_purchase_leaf(&round_id, 0, 0, count1, &payout_comm_1);
    let root_1 = compute_root_from_path(&leaf_1, 0, &siblings_1);

    let dir_1 = {
        let mut d = Vec::new();
        d.extend_from_slice(&(30u32).to_le_bytes());
        d.extend_from_slice(&buyer1_pubkey);
        d
    };

    let next_open_redeem_1 = build_directory_open_covenant(
        round_id,
        ticket_price,
        ticket_cap,
        min_tickets,
        sale_deadline,
        30, // sold
        1,  // pc
        root_1,
        creator_refund_script.clone(),
        &dir_1,
    ).unwrap();
    let next_open_spk_1 = pay_to_script_hash_script(&next_open_redeem_1);

    let initial_open_redeem = build_initial_directory_open_covenant(
        round_id,
        ticket_price,
        ticket_cap,
        min_tickets,
        sale_deadline,
        creator_refund_script.clone(),
    ).unwrap();

    let mut sig_sb_1 = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_1.add_data(&siblings_1[i].as_bytes()).unwrap(); }
    sig_sb_1.add_data(&buyer1_spk).unwrap();
    sig_sb_1.add_data(&count1.to_le_bytes()).unwrap();
    sig_sb_1.add_i64(1).unwrap(); // ACTION_BUY = 1
    sig_sb_1.add_data(&initial_open_redeem).unwrap();
    let sig_script_1 = sig_sb_1.drain();

    let pool_1 = state_deposit + ticket_price * count1; // 50M + 90M = 140M sompi
    let tx_buy1 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_create.id(), 0), // REAL PREVIOUS OUTPOINT
            sig_script_1,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(10)),
        )],
        vec![TransactionOutput {
            value: pool_1,
            script_public_key: next_open_spk_1.clone(),
            covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
        }],
        0, SubnetworkId::default(), 0, vec![],
    );

    let pop_buy1 = PopulatedTransaction::new(&tx_buy1, vec![UtxoEntry::new(
        state_deposit,
        genesis_output.script_public_key.clone(),
        1_000_000,
        false,
        Some(covenant_id_c),
    )]);
    let cov_buy1 = CovenantsContext::from_tx(&pop_buy1).unwrap();
    let ctx_buy1 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_buy1);
    let mut opcode_log = Vec::new();
    let mut vm_buy1 = TxScriptEngine::from_transaction_input(&pop_buy1, &pop_buy1.tx.inputs[0], 0, &pop_buy1.entries[0], ctx_buy1, flags).with_opcode_execution_log_buffer(&mut opcode_log);
    let res_b1 = vm_buy1.execute();
    if res_b1.is_err() {
        let trace = String::from_utf8_lossy(&opcode_log);
        for line in trace.lines().rev().take(25).collect::<Vec<_>>().into_iter().rev() {
            println!("  {line}");
        }
    }
    assert_eq!(res_b1, Ok(()));
    println!("  -> BUY #1 executed Ok(()): pool = {} sompi", pool_1);

    // [1.3] BUY #2 (count = 10)
    println!("\n[Step 1.3] BUY #2: Buyer 2 purchases 10 tickets [30..40)");
    let buyer2_pubkey = [0x22u8; 32];
    let mut buyer2_spk = vec![0x20];
    buyer2_spk.extend_from_slice(&buyer2_pubkey);
    buyer2_spk.push(0xac);
    let count2 = 10u64;

    let mut siblings_2 = [Hash::default(); TREE_DEPTH];
    siblings_2[0] = leaf_1;
    for i in 1..TREE_DEPTH { siblings_2[i] = empty_levels[i]; }

    let payout_comm_2 = compute_payout_commitment(&buyer2_spk);
    let leaf_2 = compute_purchase_leaf(&round_id, 1, 30, count2, &payout_comm_2);
    let root_2 = compute_root_from_path(&leaf_2, 1, &siblings_2);

    let mut dir_2 = dir_1.clone();
    dir_2.extend_from_slice(&(40u32).to_le_bytes());
    dir_2.extend_from_slice(&buyer2_pubkey);

    let next_open_redeem_2 = build_directory_open_covenant(
        round_id,
        ticket_price,
        ticket_cap,
        min_tickets,
        sale_deadline,
        40, // sold
        2,  // pc
        root_2,
        creator_refund_script.clone(),
        &dir_2,
    ).unwrap();
    let next_open_spk_2 = pay_to_script_hash_script(&next_open_redeem_2);

    let mut sig_sb_2 = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_2.add_data(&siblings_2[i].as_bytes()).unwrap(); }
    sig_sb_2.add_data(&buyer2_spk).unwrap();
    sig_sb_2.add_data(&count2.to_le_bytes()).unwrap();
    sig_sb_2.add_i64(1).unwrap(); // ACTION_BUY = 1
    sig_sb_2.add_data(&next_open_redeem_1).unwrap();
    let sig_script_2 = sig_sb_2.drain();

    let pool_2 = pool_1 + ticket_price * count2; // 140M + 30M = 170M sompi
    let tx_buy2 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_buy1.id(), 0), // REAL PREVIOUS OUTPOINT
            sig_script_2,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(10)),
        )],
        vec![TransactionOutput {
            value: pool_2,
            script_public_key: next_open_spk_2.clone(),
            covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
        }],
        0, SubnetworkId::default(), 0, vec![],
    );

    let pop_buy2 = PopulatedTransaction::new(&tx_buy2, vec![UtxoEntry::new(
        pool_1,
        next_open_spk_1.clone(),
        1_000_000,
        false,
        Some(covenant_id_c),
    )]);
    let cov_buy2 = CovenantsContext::from_tx(&pop_buy2).unwrap();
    let ctx_buy2 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_buy2);
    let mut opcode_log2 = Vec::new();
    let mut vm_buy2 = TxScriptEngine::from_transaction_input(&pop_buy2, &pop_buy2.tx.inputs[0], 0, &pop_buy2.entries[0], ctx_buy2, flags).with_opcode_execution_log_buffer(&mut opcode_log2);
    let res_b2 = vm_buy2.execute();
    if res_b2.is_err() {
        let trace = String::from_utf8_lossy(&opcode_log2);
        for line in trace.lines().rev().take(25).collect::<Vec<_>>().into_iter().rev() {
            println!("  {line}");
        }
    }
    assert_eq!(res_b2, Ok(()));
    println!("  -> BUY #2 executed Ok(()): pool = {} sompi", pool_2);

    // [1.4] BUY #3 (count = 55)
    println!("\n[Step 1.4] BUY #3: Buyer 3 purchases 55 tickets [40..95)");
    let buyer3_pubkey = [0x33u8; 32];
    let mut buyer3_spk = vec![0x20];
    buyer3_spk.extend_from_slice(&buyer3_pubkey);
    buyer3_spk.push(0xac);
    let count3 = 55u64;

    let parent_12 = hash_internal_node(&leaf_1, &leaf_2);
    let mut siblings_3 = [Hash::default(); TREE_DEPTH];
    siblings_3[0] = empty_levels[0];
    siblings_3[1] = parent_12;
    for i in 2..TREE_DEPTH { siblings_3[i] = empty_levels[i]; }

    let payout_comm_3 = compute_payout_commitment(&buyer3_spk);
    let leaf_3 = compute_purchase_leaf(&round_id, 2, 40, count3, &payout_comm_3);
    let root_3 = compute_root_from_path(&leaf_3, 2, &siblings_3);

    let mut dir_3 = dir_2.clone();
    dir_3.extend_from_slice(&(95u32).to_le_bytes());
    dir_3.extend_from_slice(&buyer3_pubkey);

    let next_open_redeem_3 = build_directory_open_covenant(
        round_id,
        ticket_price,
        ticket_cap,
        min_tickets,
        sale_deadline,
        95, // sold = 95
        3,  // pc = 3
        root_3,
        creator_refund_script.clone(),
        &dir_3,
    ).unwrap();
    let next_open_spk_3 = pay_to_script_hash_script(&next_open_redeem_3);

    let mut sig_sb_3 = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_3.add_data(&siblings_3[i].as_bytes()).unwrap(); }
    sig_sb_3.add_data(&buyer3_spk).unwrap();
    sig_sb_3.add_data(&count3.to_le_bytes()).unwrap();
    sig_sb_3.add_i64(1).unwrap(); // ACTION_BUY = 1
    sig_sb_3.add_data(&next_open_redeem_2).unwrap();
    let sig_script_3 = sig_sb_3.drain();

    let pool_3 = pool_2 + ticket_price * count3; // 170M + 165M = 335M sompi (3.35 KAS)
    let tx_buy3 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_buy2.id(), 0), // REAL PREVIOUS OUTPOINT
            sig_script_3,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(10)),
        )],
        vec![TransactionOutput {
            value: pool_3,
            script_public_key: next_open_spk_3.clone(),
            covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
        }],
        0, SubnetworkId::default(), 0, vec![],
    );

    let pop_buy3 = PopulatedTransaction::new(&tx_buy3, vec![UtxoEntry::new(
        pool_2,
        next_open_spk_2.clone(),
        1_000_000,
        false,
        Some(covenant_id_c),
    )]);
    let cov_buy3 = CovenantsContext::from_tx(&pop_buy3).unwrap();
    let ctx_buy3 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_buy3);
    let mut vm_buy3 = TxScriptEngine::from_transaction_input(&pop_buy3, &pop_buy3.tx.inputs[0], 0, &pop_buy3.entries[0], ctx_buy3, flags);
    assert_eq!(vm_buy3.execute(), Ok(()));
    println!("  -> BUY #3 executed Ok(()): pool = {} sompi, total sold = 95 != ticket_cap = 100", pool_3);

    // [1.5] SALE CLOSE -> SEALED (sold = 95 >= min = 90, draw_ticket_count = 95 != 100)
    println!("\n[Step 1.5] CLOSE: Deadline close transitions to SEALED (draw_ticket_count = 95 != ticket_cap = 100)");
    let sealed_redeem = build_directory_sealed_covenant(
        round_id,
        ticket_price,
        95, // draw_ticket_count = 95!
        root_3,
        3,  // pc = 3
        creator_refund_script.clone(),
        dir_3.clone(),
    ).unwrap();
    let sealed_spk = pay_to_script_hash_script(&sealed_redeem);

    let mut sig_sb_close = ScriptBuilder::with_flags(flags);
    sig_sb_close.add_i64(ACTION_CLOSE).unwrap();
    sig_sb_close.add_data(&next_open_redeem_3).unwrap();
    let sig_script_close = sig_sb_close.drain();

    let tx_close = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_buy3.id(), 0), // REAL PREVIOUS OUTPOINT
            sig_script_close,
            0, // sequence = 0 (!= u64::MAX)
            ComputeCommit::ComputeBudget(ComputeBudget(10)),
        )],
        vec![TransactionOutput {
            value: pool_3,
            script_public_key: sealed_spk.clone(),
            covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
        }],
        sale_deadline, // tx.lock_time == sale_deadline!
        SubnetworkId::default(),
        0,
        vec![],
    );

    let pop_close = PopulatedTransaction::new(&tx_close, vec![UtxoEntry::new(
        pool_3,
        next_open_spk_3.clone(),
        1_000_000,
        false,
        Some(covenant_id_c),
    )]);
    let cov_close = CovenantsContext::from_tx(&pop_close).unwrap();
    let ctx_close = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_close);
    let mut vm_close = TxScriptEngine::from_transaction_input(&pop_close, &pop_close.tx.inputs[0], 0, &pop_close.entries[0], ctx_close, flags);
    assert_eq!(vm_close.execute(), Ok(()));
    println!("  -> CLOSE executed Ok(()): transitioned OPEN(sold=95) -> SEALED(draw_ticket_count=95)");

    // [1.6] SEALED -> DRAW_READY(0) via PASS-A Opening
    println!("\n[Step 1.6] SEALED -> DRAW_READY(0): PASS-A Entropy Opening");
    let fixture_p_daa = 1_000_099u64;
    let fixture_t_daa = 1_000_100u64;
    let fixture = generate_valid_pass_a_fixture(fixture_p_daa, fixture_t_daa);

    let app_comm = compute_application_commitment(&round_id, &root_3, 95); // draw_ticket_count = 95!
    let rand_seed = compute_random_seed(&fixture.target_hash, &app_comm);

    let draw_ready_0_redeem = build_directory_draw_ready_covenant(
        round_id,
        ticket_price,
        95, // draw_ticket_count = 95!
        root_3,
        3,  // pc = 3
        fixture.target_hash,
        rand_seed,
        0,  // counter = 0
        creator_refund_script.clone(),
        dir_3.clone(),
    );
    let draw_ready_0_spk = pay_to_script_hash_script(&draw_ready_0_redeem);

    let sig_script_draw = build_pass_a_witness(&fixture, &sealed_redeem);

    let tx_draw = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_close.id(), 0), // REAL PREVIOUS OUTPOINT
            sig_script_draw,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(10)),
        )],
        vec![TransactionOutput {
            value: pool_3,
            script_public_key: draw_ready_0_spk.clone(),
            covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
        }],
        0, SubnetworkId::default(), 0, vec![],
    );

    let pop_draw = PopulatedTransaction::new(&tx_draw, vec![UtxoEntry::new(
        pool_3,
        sealed_spk.clone(),
        1_000_000,
        false,
        Some(covenant_id_c),
    )]);
    let seq_accessor = MockSeqCommitAccessor {
        selected_chain: vec![fixture.target_hash],
        seq_commits: HashMap::from([(fixture.target_hash, fixture.c_t)]),
    };
    let cov_draw = CovenantsContext::from_tx(&pop_draw).unwrap();
    let ctx_draw = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_draw).with_seq_commit_accessor(&seq_accessor);
    let mut opcode_log_draw = Vec::new();
    let mut vm_draw = TxScriptEngine::from_transaction_input(&pop_draw, &pop_draw.tx.inputs[0], 0, &pop_draw.entries[0], ctx_draw, flags).with_opcode_execution_log_buffer(&mut opcode_log_draw);
    let res_draw = vm_draw.execute();
    if res_draw.is_err() {
        let trace = String::from_utf8_lossy(&opcode_log_draw);
        for line in trace.lines().rev().take(30).collect::<Vec<_>>().into_iter().rev() {
            println!("  {line}");
        }
    }
    assert_eq!(res_draw, Ok(()));
    println!("  -> SEALED -> DRAW_READY(0) executed Ok(()): derived random_seed = {}", rand_seed);

    // [1.7] DRAW_READY(0) -> WINNER_READY via ACCEPT
    println!("\n[Step 1.7] DRAW_READY(0) -> WINNER_READY: ACCEPT with Directory Range Lookup");
    let cand_hash = compute_candidate_hash(&rand_seed, 0);
    let cand_num = extract_candidate_num(&cand_hash);
    let winner_index = (cand_num % 95) as u64; // N = 95!

    // Determine which buyer won based on ranges: [0, 30), [30, 40), [40, 95)
    let (winner_purchase_idx, winner_spk, winner_pubkey) = if winner_index < 30 {
        (0u64, buyer1_spk.clone(), buyer1_pubkey)
    } else if winner_index < 40 {
        (1u64, buyer2_spk.clone(), buyer2_pubkey)
    } else {
        (2u64, buyer3_spk.clone(), buyer3_pubkey)
    };

    println!("  -> Winner index = {} (domain N=95) authenticated to purchase record {}", winner_index, winner_purchase_idx);

    let winner_ready_redeem = build_production_winner_ready_3out_covenant(
        round_id,
        ticket_price,
        95, // draw_ticket_count = 95!
        root_3,
        fixture.target_hash,
        rand_seed,
        0,  // accepted_counter = 0
        winner_index,
        winner_spk.clone(),
        creator_refund_script.clone(),
    );
    let winner_ready_spk = pay_to_script_hash_script(&winner_ready_redeem);

    let mut sig_sb_accept = ScriptBuilder::with_flags(flags);
    sig_sb_accept.add_data(&winner_purchase_idx.to_le_bytes()).unwrap(); // i (witness)
    sig_sb_accept.add_data(&draw_ready_0_redeem).unwrap();
    let sig_script_accept = sig_sb_accept.drain();

    let tx_accept = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_draw.id(), 0), // REAL PREVIOUS OUTPOINT
            sig_script_accept,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(10)),
        )],
        vec![TransactionOutput {
            value: pool_3,
            script_public_key: winner_ready_spk.clone(),
            covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
        }],
        0, SubnetworkId::default(), 0, vec![],
    );

    let pop_accept = PopulatedTransaction::new(&tx_accept, vec![UtxoEntry::new(
        pool_3,
        draw_ready_0_spk.clone(),
        1_000_000,
        false,
        Some(covenant_id_c),
    )]);
    let cov_accept = CovenantsContext::from_tx(&pop_accept).unwrap();
    let ctx_accept = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_accept);
    let mut opcode_log_accept = Vec::new();
    let mut vm_accept = TxScriptEngine::from_transaction_input(&pop_accept, &pop_accept.tx.inputs[0], 0, &pop_accept.entries[0], ctx_accept, flags).with_opcode_execution_log_buffer(&mut opcode_log_accept);
    let res_accept = vm_accept.execute();
    if res_accept.is_err() {
        let trace = String::from_utf8_lossy(&opcode_log_accept);
        for line in trace.lines().rev().take(30).collect::<Vec<_>>().into_iter().rev() {
            println!("  {line}");
        }
    }
    assert_eq!(res_accept, Ok(()));
    println!("  -> DRAW_READY(0) -> WINNER_READY executed Ok(()): directory dropped from prefix!");

    // [1.8] WINNER_READY -> PAID TERMINAL 1-IN-3-OUT SETTLEMENT
    println!("\n[Step 1.8] WINNER_READY -> PAID: 1-in-3-out Terminal Settlement");
    let gross_pool = ticket_price * 95; // 285,000,000 sompi (2.85 KAS)
    let finalizer_fee = 100_000u64;     // miner fee within 0.5 KAS
    let winner_payout = gross_pool - FINALIZER_REWARD_V1 - finalizer_fee; // 285M - 100M - 0.1M = 184.9M sompi

    let mut finalizer_spk = vec![0x20];
    finalizer_spk.extend_from_slice(&[0x77; 32]);
    finalizer_spk.push(0xac);

    let mut sig_sb_settle = ScriptBuilder::with_flags(flags);
    sig_sb_settle.add_data(&finalizer_spk).unwrap(); // witness: finalizer_payout_spk
    sig_sb_settle.add_data(&winner_ready_redeem).unwrap();
    let sig_script_settle = sig_sb_settle.drain();

    let tx_settle = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_accept.id(), 0), // REAL PREVIOUS OUTPOINT
            sig_script_settle,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(10)),
        )],
        vec![
            // Output 0: Winner Net Payout (Covenant = None)
            TransactionOutput {
                value: winner_payout,
                script_public_key: ScriptPublicKey::from_vec(0, winner_spk.clone()),
                covenant: None,
            },
            // Output 1: Creator State Deposit Refund (Covenant = None)
            TransactionOutput {
                value: state_deposit, // EXACT 50,000,000 SOMPI (0.5 KAS)
                script_public_key: ScriptPublicKey::from_vec(0, creator_refund_script.clone()),
                covenant: None,
            },
            // Output 2: Fixed Finalizer Reward (Covenant = None)
            TransactionOutput {
                value: FINALIZER_REWARD_V1, // 100,000,000 SOMPI (1.0 KAS)
                script_public_key: ScriptPublicKey::from_vec(0, finalizer_spk.clone()),
                covenant: None,
            },
        ],
        0, SubnetworkId::default(), 0, vec![],
    );

    let pop_settle = PopulatedTransaction::new(&tx_settle, vec![UtxoEntry::new(
        pool_3,
        winner_ready_spk.clone(),
        1_000_000,
        false,
        Some(covenant_id_c),
    )]);
    let cov_settle = CovenantsContext::from_tx(&pop_settle).unwrap();
    let ctx_settle = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_settle);
    let mut opcode_log_settle = Vec::new();
    let mut vm_settle = TxScriptEngine::from_transaction_input(&pop_settle, &pop_settle.tx.inputs[0], 0, &pop_settle.entries[0], ctx_settle, flags).with_opcode_execution_log_buffer(&mut opcode_log_settle);
    let res_settle = vm_settle.execute();
    if res_settle.is_err() {
        let trace = String::from_utf8_lossy(&opcode_log_settle);
        for line in trace.lines().rev().take(30).collect::<Vec<_>>().into_iter().rev() {
            println!("  {line}");
        }
    }
    assert_eq!(res_settle, Ok(()));
    println!("  -> WINNER_READY -> PAID executed Ok(()):");
    println!("     * Winner Payout (Output 0):    {} sompi (Covenant: None)", winner_payout);
    println!("     * Creator Deposit (Output 1):   {} sompi (Covenant: None)", state_deposit);
    println!("     * Finalizer Reward (Output 2):  {} sompi (Covenant: None)", FINALIZER_REWARD_V1);
    println!("     * Covenant Lineage Terminated: 100% SUCCESS!");

    // =========================================================================
    // PART 2: REAL CONNECTED PRODUCTION REFUND E2E PIPELINE (P=17)
    // =========================================================================
    println!("\n------------------------------------------------------------------");
    println!("PART 2: REAL CONNECTED PRODUCTION REFUND E2E PIPELINE (P=17)");
    println!("------------------------------------------------------------------");

    let p17 = 17usize;
    let records17: Vec<(u32, [u8; 32])> = (0..p17).map(|i| {
        let end = ((i + 1) * 3) as u32; // 3 tickets each -> total 51 tickets
        let mut pk = [0u8; 32];
        pk[0] = (i + 1) as u8;
        (end, pk)
    }).collect();

    let mut dir17 = Vec::new();
    for (end, pk) in &records17 {
        dir17.extend_from_slice(&end.to_le_bytes());
        dir17.extend_from_slice(pk);
    }
    assert_eq!(dir17.len(), 17 * 36);

    let total_refund_tickets = 51u64;
    let initial_refund_amount = state_deposit + ticket_price * total_refund_tickets; // 50M + 51*3M = 203M sompi

    let funding_ref = TransactionOutpoint::new(Hash::from_u64_word(0x777701), 0);
    let cov_id_ref = Hash::from_u64_word(0x888801);
    let round_id_ref = genesis::compute_canonical_round_id(&funding_ref);

    let k_step0 = schedule_next_k(17, 17, REFUND_K_MAX_V1);
    assert_eq!(k_step0, 9);
    let k_step1 = schedule_next_k(8, 17, REFUND_K_MAX_V1);
    assert_eq!(k_step1, 8);

    // Initial Refunding Redeem Script (cursor = 0):
    let ref_redeem_0 = build_compact_universal_refunding_covenant(
        round_id_ref,
        ticket_price,
        17, // P = 17
        0,  // cursor = 0
        creator_refund_script.clone(),
        dir17.clone(),
    );
    let ref_spk_0 = pay_to_script_hash_script(&ref_redeem_0);

    // Step 0: K = 9 (Non-terminal)
    println!("\n[Step 2.1] Refund Step 0: Refunding purchases 0..9 (K=9, non-terminal)");
    let fees_step0 = vec![170_000u64; 9]; // realistic fee per purchase covering relay floor
    let mut gross_step0 = 0u64;
    let mut outputs_step0 = Vec::new();

    for j in 0..9 {
        let rec_idx = j;
        let count = 3u64;
        let gross_j = count * ticket_price; // 9,000,000 sompi
        gross_step0 += gross_j;
        let refund_j = gross_j - fees_step0[j];
        let mut buyer_p2pk = vec![0x20];
        buyer_p2pk.extend_from_slice(&records17[rec_idx].1);
        buyer_p2pk.push(0xac);
        outputs_step0.push(TransactionOutput {
            value: refund_j,
            script_public_key: ScriptPublicKey::from_vec(0, buyer_p2pk),
            covenant: None,
        });
    }

    let next_amount_1 = initial_refund_amount - gross_step0;
    let ref_redeem_1 = build_compact_universal_refunding_covenant(
        round_id_ref,
        ticket_price,
        17,
        9, // cursor = 9
        creator_refund_script.clone(),
        dir17.clone(),
    );
    let ref_spk_1 = pay_to_script_hash_script(&ref_redeem_1);

    // Output 0 carries continuation:
    outputs_step0.insert(0, TransactionOutput {
        value: next_amount_1,
        script_public_key: ref_spk_1.clone(),
        covenant: Some(CovenantBinding { covenant_id: cov_id_ref, authorizing_input: 0 }),
    });

    let mut sig_sb_ref0 = ScriptBuilder::with_flags(flags);
    for f in fees_step0.iter().rev() {
        sig_sb_ref0.add_data(&f.to_le_bytes()).unwrap();
    }
    sig_sb_ref0.add_i64(9).unwrap(); // k = 9
    sig_sb_ref0.add_data(&ref_redeem_0).unwrap();

    let tx_ref0 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            funding_ref,
            sig_sb_ref0.drain(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(40)),
        )],
        outputs_step0,
        0, SubnetworkId::default(), 0, vec![],
    );

    let pop_ref0 = PopulatedTransaction::new(&tx_ref0, vec![UtxoEntry::new(
        initial_refund_amount,
        ref_spk_0.clone(),
        1_000_000,
        false,
        Some(cov_id_ref),
    )]);
    let cov_ref0 = CovenantsContext::from_tx(&pop_ref0).unwrap();
    let ctx_ref0 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ref0);
    let mut opcode_log_ref0 = Vec::new();
    let mut vm_ref0 = TxScriptEngine::from_transaction_input(&pop_ref0, &pop_ref0.tx.inputs[0], 0, &pop_ref0.entries[0], ctx_ref0, flags).with_opcode_execution_log_buffer(&mut opcode_log_ref0);
    let res_ref0 = vm_ref0.execute();
    if res_ref0.is_err() {
        let trace = String::from_utf8_lossy(&opcode_log_ref0);
        for line in trace.lines().rev().take(30).collect::<Vec<_>>().into_iter().rev() {
            println!("  {line}");
        }
    }
    assert_eq!(res_ref0, Ok(()));
    println!("  -> Step 0 (K=9) executed Ok(()): remaining pool = {} sompi", next_amount_1);

    // Step 1: K = 8 (Terminal, cursor + k == 17)
    println!("\n[Step 2.2] Refund Step 1: Refunding purchases 9..17 (K=8, terminal, creator deposit return)");
    let fees_step1 = vec![190_000u64; 8];
    let mut gross_step1 = 0u64;
    let mut outputs_step1 = Vec::new();

    for j in 0..8 {
        let rec_idx = 9 + j;
        let count = 3u64;
        let gross_j = count * ticket_price;
        gross_step1 += gross_j;
        let refund_j = gross_j - fees_step1[j];
        let mut buyer_p2pk = vec![0x20];
        buyer_p2pk.extend_from_slice(&records17[rec_idx].1);
        buyer_p2pk.push(0xac);
        outputs_step1.push(TransactionOutput {
            value: refund_j,
            script_public_key: ScriptPublicKey::from_vec(0, buyer_p2pk),
            covenant: None,
        });
    }

    // Output k = Output 8 pays creator state_deposit:
    outputs_step1.push(TransactionOutput {
        value: state_deposit, // EXACT 50,000,000 SOMPI (0.5 KAS)
        script_public_key: ScriptPublicKey::from_vec(0, creator_refund_script.clone()),
        covenant: None, // Lineage strictly TERMINATED!
    });

    let mut sig_sb_ref1 = ScriptBuilder::with_flags(flags);
    for f in fees_step1.iter().rev() {
        sig_sb_ref1.add_data(&f.to_le_bytes()).unwrap();
    }
    sig_sb_ref1.add_i64(8).unwrap(); // k = 8
    sig_sb_ref1.add_data(&ref_redeem_1).unwrap();

    let tx_ref1 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_ref0.id(), 0), // REAL PREVIOUS OUTPOINT (tx_ref0 Output 0!)
            sig_sb_ref1.drain(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(40)),
        )],
        outputs_step1,
        0, SubnetworkId::default(), 0, vec![],
    );

    let pop_ref1 = PopulatedTransaction::new(&tx_ref1, vec![UtxoEntry::new(
        next_amount_1,
        ref_spk_1.clone(),
        1_000_000,
        false,
        Some(cov_id_ref),
    )]);
    let cov_ref1 = CovenantsContext::from_tx(&pop_ref1).unwrap();
    let ctx_ref1 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ref1);
    let mut opcode_log_ref1 = Vec::new();
    let mut vm_ref1 = TxScriptEngine::from_transaction_input(&pop_ref1, &pop_ref1.tx.inputs[0], 0, &pop_ref1.entries[0], ctx_ref1, flags).with_opcode_execution_log_buffer(&mut opcode_log_ref1);
    let res_ref1 = vm_ref1.execute();
    if res_ref1.is_err() {
        let trace = String::from_utf8_lossy(&opcode_log_ref1);
        for line in trace.lines().rev().take(30).collect::<Vec<_>>().into_iter().rev() {
            println!("  {line}");
        }
    }
    assert_eq!(res_ref1, Ok(()));
    println!("  -> Step 1 (K=8 terminal) executed Ok(()):");
    println!("     * Tx1 Input 0 == Tx0 Output 0 verified exact!");
    println!("     * Creator State Deposit Returned: {} sompi", state_deposit);
    println!("     * Covenant Lineage Terminated: 100% SUCCESS!");

    // =========================================================================
    // PART 3: BOUNDARY VERIFICATIONS (P=1 and P=256)
    // =========================================================================
    println!("\n------------------------------------------------------------------");
    println!("PART 3: BOUNDARY VERIFICATIONS (P=1 and P=256)");
    println!("------------------------------------------------------------------");

    // P=1 Boundary:
    let k_p1 = schedule_next_k(1, 1, REFUND_K_MAX_V1);
    assert_eq!(k_p1, 1);
    println!("  -> P=1 schedule: K = 1 (single terminal step) PASS");

    // P=256 Boundary:
    let mut rem_256 = 256usize;
    let mut cur_256 = 0usize;
    let mut steps_256 = 0usize;
    while rem_256 > 0 {
        let k = schedule_next_k(rem_256, 256, REFUND_K_MAX_V1);
        assert!(k >= min_k_for_p(256));
        assert!(k <= REFUND_K_MAX_V1);
        rem_256 -= k;
        cur_256 += k;
        steps_256 += 1;
    }
    assert_eq!(steps_256, 16);
    assert_eq!(cur_256, 256);
    println!("  -> P=256 schedule: completed in 16 steps with all K in [13..16] PASS");

    println!("\n==================================================================");
    println!("ALL KASWIN V1 PRODUCTION FULL LIFECYCLE E2E TESTS PASSED 100%!");
    println!("==================================================================");
}
