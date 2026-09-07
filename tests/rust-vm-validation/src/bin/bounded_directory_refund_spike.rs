//! Kaswin V1 — Bounded Directory Sequential Batch Refund Lifecycle Spike
//!
//! Evaluates permissionless, deterministic, bounded, resumable batch refunding
//! using the in-state bounded purchase directory (36-byte records) without SMT
//! delete proofs, buyer online signatures, or external indexers.

use std::time::Instant;
use kaspa_consensus_core::{
    config::params::TESTNET_PARAMS,
    hashing::sighash::SigHashReusedValuesUnsync,
    mass::{ComputeBudget, MassCalculator, ScriptUnits, transaction_estimated_serialized_size},
    subnets::SubnetworkId,
    tx::{
        ComputeCommit, CovenantBinding, PopulatedTransaction, ScriptPublicKey, Transaction,
        TransactionInput, TransactionOutpoint, TransactionOutput, UtxoEntry,
    },
};
use kaspa_hashes::Hash;
use kaspa_txscript::{
    caches::Cache,
    covenants::CovenantsContext,
    opcodes::codes::*,
    script_builder::ScriptBuilder,
    standard::pay_to_script_hash_script,
    EngineCtx, EngineFlags, TxScriptEngine,
};
use kaspa_txscript_errors::TxScriptError;

// -----------------------------------------------------------------------------
// Protocol Constants & Economic Domain
// -----------------------------------------------------------------------------
pub const COVENANT_ID: Hash = Hash::from_bytes([0x77; 32]);
pub const ZERO_HASH: Hash = Hash::from_bytes([0x00; 32]);
pub const MAX_REFUND_FEE: u64 = 250_000; // 0.0025 KAS max fee per purchase
pub const TICKET_PRICE: u64 = 100_000_000; // 1.0 KAS per ticket
pub const STATE_DEPOSIT: u64 = 50_000_000; // 0.5 KAS creator state deposit

// -----------------------------------------------------------------------------
// Directory Record Format (36 bytes):
// [0..4]:  cumulative_end (u32 LE)
// [4..36]: buyer_pubkey (32 bytes xonly)
// -----------------------------------------------------------------------------
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PurchaseRecord {
    pub cumulative_end: u32,
    pub buyer_pubkey: [u8; 32],
}

impl PurchaseRecord {
    pub fn to_bytes(&self) -> [u8; 36] {
        let mut b = [0u8; 36];
        b[0..4].copy_from_slice(&self.cumulative_end.to_le_bytes());
        b[4..36].copy_from_slice(&self.buyer_pubkey);
        b
    }

    pub fn from_bytes(slice: &[u8]) -> Self {
        assert_eq!(slice.len(), 36);
        let mut end_bytes = [0u8; 4];
        end_bytes.copy_from_slice(&slice[0..4]);
        let cumulative_end = u32::from_le_bytes(end_bytes);
        let mut buyer_pubkey = [0u8; 32];
        buyer_pubkey.copy_from_slice(&slice[4..36]);
        Self { cumulative_end, buyer_pubkey }
    }
}

pub fn directory_bytes(records: &[PurchaseRecord]) -> Vec<u8> {
    let mut b = Vec::with_capacity(records.len() * 36);
    for r in records {
        b.extend_from_slice(&r.to_bytes());
    }
    b
}

pub fn p2pk_spk_bytes(pubkey: &[u8; 32]) -> Vec<u8> {
    let mut v = Vec::with_capacity(34);
    v.push(0x20);
    v.extend_from_slice(pubkey);
    v.push(0xac);
    v
}

// -----------------------------------------------------------------------------
// Covenant Prefix Construction:
//
// Prefix fields pushed onto dstack at execution start (bottom to top):
//   round_id (32B)
//   ticket_price (8B LE)
//   purchase_count (8B LE)
//   cursor (8B LE)
//   creator_refund_spk (34B)
//   directory (P*36B)
// -----------------------------------------------------------------------------
pub fn build_refunding_prefix(
    round_id: &Hash,
    ticket_price: u64,
    purchase_count: u64,
    cursor: u64,
    creator_refund_spk: &[u8],
    directory: &[u8],
) -> Vec<u8> {
    let mut sb = ScriptBuilder::with_flags(EngineFlags { covenants_enabled: true, ..Default::default() });
    sb.add_op(OpTxInputIndex).unwrap();
    sb.add_op(Op0).unwrap();
    sb.add_op(OpEqualVerify).unwrap();
    sb.add_data(&round_id.as_bytes()).unwrap();
    sb.add_data(&ticket_price.to_le_bytes()).unwrap();
    sb.add_data(&purchase_count.to_le_bytes()).unwrap();
    sb.add_data(&cursor.to_le_bytes()).unwrap();
    sb.add_data(creator_refund_spk).unwrap();
    sb.add_data(directory).unwrap();
    sb.drain()
}

// -----------------------------------------------------------------------------
// Refunding Covenant Body Construction:
// -----------------------------------------------------------------------------
pub fn build_refunding_body(k: usize, static_body_len: usize) -> Vec<u8> {
    let mut sb = ScriptBuilder::with_flags(EngineFlags { covenants_enabled: true, ..Default::default() });

    // Verify initial depth = k + 6:
    sb.add_op(OpDepth).unwrap();
    sb.add_i64((k + 6) as i64).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap();

    // Top item on dstack is directory (depth 0).
    // Park directory on AltStack:
    sb.add_op(OpToAltStack).unwrap(); // AltStack: [directory]

    // Now dstack has 5 parameters:
    // depth 0: creator_refund_spk
    // depth 1: cursor
    // depth 2: purchase_count
    // depth 3: ticket_price
    // depth 4: round_id
    // depth 5..5+k-1: fee witness items!
    // Validate parameter shapes on dstack:
    // creator_refund_spk (depth 0): size == 34
    sb.add_op(Op0).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpSize).unwrap();
    sb.add_op(OpSwap).unwrap(); sb.add_op(OpDrop).unwrap();
    sb.add_i64(34).unwrap(); sb.add_op(OpEqualVerify).unwrap();
    // cursor (depth 1): size == 8
    sb.add_i64(1).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpSize).unwrap();
    sb.add_op(OpSwap).unwrap(); sb.add_op(OpDrop).unwrap();
    sb.add_i64(8).unwrap(); sb.add_op(OpEqualVerify).unwrap();
    // purchase_count (depth 2): size == 8
    sb.add_i64(2).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpSize).unwrap();
    sb.add_op(OpSwap).unwrap(); sb.add_op(OpDrop).unwrap();
    sb.add_i64(8).unwrap(); sb.add_op(OpEqualVerify).unwrap();
    // ticket_price (depth 3): size == 8
    sb.add_i64(3).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpSize).unwrap();
    sb.add_op(OpSwap).unwrap(); sb.add_op(OpDrop).unwrap();
    sb.add_i64(8).unwrap(); sb.add_op(OpEqualVerify).unwrap();
    // round_id (depth 4): size == 32
    sb.add_i64(4).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpSize).unwrap();
    sb.add_op(OpSwap).unwrap(); sb.add_op(OpDrop).unwrap();
    sb.add_i64(32).unwrap(); sb.add_op(OpEqualVerify).unwrap();

    // Check if terminal batch:
    // cursor (depth 1) + k == purchase_count (depth 2)?
    // When (cursor + k) is on stack at depth 0, purchase_count is shifted to depth 3:
    sb.add_i64(1).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpBin2Num).unwrap(); // cursor (num)
    sb.add_i64(k as i64).unwrap(); sb.add_op(OpAdd).unwrap(); // cursor + k
    sb.add_i64(3).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpBin2Num).unwrap(); // purchase_count (num)
    sb.add_op(OpEqual).unwrap(); // boolean is_terminal

    sb.add_op(OpIf).unwrap();
        // =====================================================================
        // TERMINAL BATCH BRANCH (cursor + k == purchase_count)
        // Topology: 1 state input, k + 1 outputs!
        // Outputs 0..k-1: buyer refunds
        // Output k: creator exact state_deposit return
        // Lineage destroyed!
        // =====================================================================
        sb.add_op(OpTxInputCount).unwrap(); sb.add_i64(1).unwrap(); sb.add_op(OpNumEqualVerify).unwrap();
        sb.add_op(OpTxOutputCount).unwrap(); sb.add_i64((k + 1) as i64).unwrap(); sb.add_op(OpNumEqualVerify).unwrap();

        // Singleton termination guard:
        sb.add_op(Op0).unwrap(); sb.add_op(OpInputCovenantId).unwrap();
        sb.add_op(OpDup).unwrap();
        sb.add_data(&ZERO_HASH.as_bytes()).unwrap(); sb.add_op(OpEqual).unwrap(); sb.add_op(OpNot).unwrap(); sb.add_op(OpVerify).unwrap();
        sb.add_op(OpDup).unwrap(); sb.add_op(OpCovInputCount).unwrap(); sb.add_i64(1).unwrap(); sb.add_op(OpNumEqualVerify).unwrap();
        sb.add_op(Op0).unwrap(); sb.add_op(OpAuthOutputCount).unwrap(); sb.add_i64(0).unwrap(); sb.add_op(OpNumEqualVerify).unwrap();
        sb.add_op(OpCovOutputCount).unwrap(); sb.add_i64(0).unwrap(); sb.add_op(OpNumEqualVerify).unwrap();

        // Output k Covenant == None:
        sb.add_i64(k as i64).unwrap(); sb.add_op(OpOutputCovenantId).unwrap();
        sb.add_data(&ZERO_HASH.as_bytes()).unwrap(); sb.add_op(OpEqualVerify).unwrap();
        sb.add_i64(k as i64).unwrap(); sb.add_op(OpOutputAuthorizingInput).unwrap();
        sb.add_i64(-1).unwrap(); sb.add_op(OpEqualVerify).unwrap();

        // Output k SPK == creator_refund_spk (at depth 0):
        sb.add_op(Op0).unwrap(); sb.add_op(OpPick).unwrap(); // creator_refund_spk
        sb.add_data(&[0x00, 0x00]).unwrap(); sb.add_op(OpSwap).unwrap();
        sb.add_op(OpCat).unwrap(); // [0x00, 0x00] || creator_refund_spk
        sb.add_i64(k as i64).unwrap(); sb.add_op(OpTxOutputSpk).unwrap();
        sb.add_op(OpEqualVerify).unwrap();

        // Outputs 0..k-1 Covenant == None:
        for idx in 0..k {
            sb.add_i64(idx as i64).unwrap(); sb.add_op(OpOutputCovenantId).unwrap();
            sb.add_data(&ZERO_HASH.as_bytes()).unwrap(); sb.add_op(OpEqualVerify).unwrap();
            sb.add_i64(idx as i64).unwrap(); sb.add_op(OpOutputAuthorizingInput).unwrap();
            sb.add_i64(-1).unwrap(); sb.add_op(OpEqualVerify).unwrap();
        }

        // Loop over j in 0..k: extract record (cursor + j), verify buyer output:
        // Directory is on AltStack.
        // We accumulate sum_gross on AltStack above directory!
        sb.add_i64(0).unwrap(); sb.add_op(OpToAltStack).unwrap(); // AltStack: [directory, sum_gross]

        for j in 0..k {
            // Pick cursor num (depth 1 on dstack):
            sb.add_i64(1).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpBin2Num).unwrap();
            if j > 0 {
                sb.add_i64(j as i64).unwrap(); sb.add_op(OpAdd).unwrap();
            }
            // Record index rec_idx = cursor + j
            sb.add_op(OpDup).unwrap();
            sb.add_i64(36).unwrap(); sb.add_op(OpMul).unwrap(); // start offset
            sb.add_op(OpDup).unwrap();
            sb.add_i64(36).unwrap(); sb.add_op(OpAdd).unwrap(); // end offset

            // Fetch directory from AltStack without altering [directory, sum_gross]:
            sb.add_op(OpFromAltStack).unwrap(); // sum_gross
            sb.add_op(OpFromAltStack).unwrap(); // directory
            sb.add_op(OpDup).unwrap(); sb.add_op(OpToAltStack).unwrap(); // directory back to AltStack
            sb.add_op(OpSwap).unwrap(); // top is sum_gross
            sb.add_op(OpToAltStack).unwrap(); // sum_gross back to AltStack!
            // dstack: [..., start, end, directory] -> we want [..., directory, start, end]:
            sb.add_op(OpRot).unwrap();
            sb.add_op(OpRot).unwrap();
            sb.add_op(OpSubstr).unwrap(); // 36-byte record blob

            // Extract buyer pubkey (bytes 4..36):
            sb.add_op(OpDup).unwrap();
            sb.add_i64(4).unwrap(); sb.add_i64(36).unwrap(); sb.add_op(OpSubstr).unwrap();
            sb.add_data(&[0x00, 0x00, 0x20]).unwrap(); sb.add_op(OpSwap).unwrap(); sb.add_op(OpCat).unwrap();
            sb.add_data(&[0xac]).unwrap(); sb.add_op(OpCat).unwrap();
            // Output j SPK matches:
            sb.add_i64(j as i64).unwrap(); sb.add_op(OpTxOutputSpk).unwrap();
            sb.add_op(OpEqualVerify).unwrap();

            // Extract end_ticket: bytes 0..4 (u32 LE):
            sb.add_i64(0).unwrap(); sb.add_i64(4).unwrap(); sb.add_op(OpSubstr).unwrap();
            sb.add_op(OpBin2Num).unwrap(); // end_ticket (num)

            // Extract start_ticket:
            sb.add_op(OpSwap).unwrap(); // [..., end_ticket, rec_idx]
            sb.add_op(OpDup).unwrap();
            sb.add_op(Op0).unwrap();
            sb.add_op(OpEqual).unwrap();
            sb.add_op(OpIf).unwrap();
                sb.add_op(OpDrop).unwrap(); // drop rec_idx
                sb.add_i64(0).unwrap();     // start_ticket = 0
            sb.add_op(OpElse).unwrap();
                sb.add_i64(1).unwrap(); sb.add_op(OpSub).unwrap(); // rec_idx - 1
                sb.add_i64(36).unwrap(); sb.add_op(OpMul).unwrap(); // prev_start
                sb.add_op(OpDup).unwrap(); sb.add_i64(4).unwrap(); sb.add_op(OpAdd).unwrap(); // prev_end
                // Fetch directory from AltStack again:
                sb.add_op(OpFromAltStack).unwrap(); // sum_gross
                sb.add_op(OpFromAltStack).unwrap(); // directory
                sb.add_op(OpDup).unwrap(); sb.add_op(OpToAltStack).unwrap(); // directory back
                sb.add_op(OpSwap).unwrap(); // sum_gross
                sb.add_op(OpToAltStack).unwrap(); // sum_gross back
                sb.add_op(OpRot).unwrap();
                sb.add_op(OpRot).unwrap();
                sb.add_op(OpSubstr).unwrap();
                sb.add_op(OpBin2Num).unwrap(); // start_ticket
            sb.add_op(OpEndIf).unwrap();

            // count = end_ticket - start_ticket:
            sb.add_op(OpSub).unwrap();
            sb.add_op(OpDup).unwrap();
            sb.add_i64(1).unwrap(); sb.add_op(OpGreaterThanOrEqual).unwrap(); sb.add_op(OpVerify).unwrap();

            // gross_i = count * ticket_price (ticket_price is at depth 3):
            sb.add_i64(4).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpBin2Num).unwrap();
            sb.add_op(OpMul).unwrap(); // gross_i (num)

            // Add gross_i to sum_gross on AltStack (preserve gross_i for refund_j):
            sb.add_op(OpDup).unwrap();
            sb.add_op(OpFromAltStack).unwrap(); // pops sum_gross
            sb.add_op(OpAdd).unwrap();          // sum_gross + gross_i
            sb.add_op(OpToAltStack).unwrap();   // updated sum_gross back on top!

            // Witness fee_j:
            // Stack depth: [fee_0, ..., fee_{k-1}, round_id, ticket_price, purchase_count, cursor, creator]
            // items above witness: 5 parameters = 5 items.
            let fee_depth = 5 + k - j;
            sb.add_i64(fee_depth as i64).unwrap(); sb.add_op(OpPick).unwrap();
            sb.add_op(OpSize).unwrap(); sb.add_i64(8).unwrap(); sb.add_op(OpNumEqualVerify).unwrap();
            sb.add_op(OpBin2Num).unwrap();

            // 0 <= fee_j <= MAX_REFUND_FEE:
            sb.add_op(OpDup).unwrap(); sb.add_i64(0).unwrap(); sb.add_op(OpGreaterThanOrEqual).unwrap(); sb.add_op(OpVerify).unwrap();
            sb.add_op(OpDup).unwrap(); sb.add_i64(MAX_REFUND_FEE as i64).unwrap(); sb.add_op(OpLessThanOrEqual).unwrap(); sb.add_op(OpVerify).unwrap();

            // refund_j = gross_i - fee_j > 0:
            sb.add_op(OpSub).unwrap();
            sb.add_op(OpDup).unwrap(); sb.add_i64(0).unwrap(); sb.add_op(OpGreaterThan).unwrap(); sb.add_op(OpVerify).unwrap();

            // Output j Amount == refund_j:
            sb.add_i64(j as i64).unwrap(); sb.add_op(OpTxOutputAmount).unwrap();
            sb.add_op(OpEqualVerify).unwrap();
        }

        // Terminal Output k Amount must be exact state_deposit!
        // AltStack has [directory, sum_gross_batch]:
        sb.add_op(OpFromAltStack).unwrap(); // sum_gross_batch (num)
        sb.add_op(Op0).unwrap(); sb.add_op(OpTxInputAmount).unwrap();
        sb.add_op(OpSwap).unwrap(); sb.add_op(OpSub).unwrap(); // Input0 - sum_gross_batch
        sb.add_i64(k as i64).unwrap(); sb.add_op(OpTxOutputAmount).unwrap();
        sb.add_op(OpEqualVerify).unwrap();

    sb.add_op(OpElse).unwrap();
        // =====================================================================
        // NON-TERMINAL BATCH BRANCH (cursor + k < purchase_count)
        // Topology: 1 state input, k + 1 outputs!
        // Output 0: REFUNDING successor state (cursor = cursor + k)
        // Outputs 1..k: buyer refunds
        // Lineage continues 1-to-1: Output 0 covenant == same COVENANT_ID
        // =====================================================================
        sb.add_op(OpTxInputCount).unwrap(); sb.add_i64(1).unwrap(); sb.add_op(OpNumEqualVerify).unwrap();
        sb.add_op(OpTxOutputCount).unwrap(); sb.add_i64((k + 1) as i64).unwrap(); sb.add_op(OpNumEqualVerify).unwrap();

        // Singleton continuation guard:
        sb.add_op(Op0).unwrap(); sb.add_op(OpInputCovenantId).unwrap();
        sb.add_op(OpDup).unwrap();
        sb.add_data(&ZERO_HASH.as_bytes()).unwrap(); sb.add_op(OpEqual).unwrap(); sb.add_op(OpNot).unwrap(); sb.add_op(OpVerify).unwrap();
        sb.add_op(OpDup).unwrap(); sb.add_op(OpCovInputCount).unwrap(); sb.add_i64(1).unwrap(); sb.add_op(OpNumEqualVerify).unwrap();
        sb.add_op(Op0).unwrap(); sb.add_op(OpAuthOutputCount).unwrap(); sb.add_i64(1).unwrap(); sb.add_op(OpNumEqualVerify).unwrap();
        sb.add_op(OpDup).unwrap(); sb.add_op(OpCovOutputCount).unwrap(); sb.add_i64(1).unwrap(); sb.add_op(OpNumEqualVerify).unwrap();

        // Output 0 must have covenant_id == C and authorizing_input == 0:
        // C is on stack from OpDup!
        sb.add_op(Op0).unwrap(); sb.add_op(OpOutputCovenantId).unwrap();
        sb.add_op(OpEqualVerify).unwrap();
        sb.add_op(Op0).unwrap(); sb.add_op(OpOutputAuthorizingInput).unwrap();
        sb.add_op(Op0).unwrap(); sb.add_op(OpEqualVerify).unwrap();

        // Each of Outputs 1..k Covenant == None:
        for idx in 1..=k {
            sb.add_i64(idx as i64).unwrap(); sb.add_op(OpOutputCovenantId).unwrap();
            sb.add_data(&ZERO_HASH.as_bytes()).unwrap(); sb.add_op(OpEqualVerify).unwrap();
            sb.add_i64(idx as i64).unwrap(); sb.add_op(OpOutputAuthorizingInput).unwrap();
            sb.add_i64(-1).unwrap(); sb.add_op(OpEqualVerify).unwrap();
        }

        // Loop over j in 0..k: extract record (cursor + j), verify buyer output at Output (j + 1):
        sb.add_i64(0).unwrap(); sb.add_op(OpToAltStack).unwrap(); // AltStack: [directory, sum_gross]

        for j in 0..k {
            let out_idx = j + 1;

            // Pick cursor num (cursor is at depth 1 on dstack!):
            sb.add_i64(1).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpBin2Num).unwrap();
            if j > 0 {
                sb.add_i64(j as i64).unwrap(); sb.add_op(OpAdd).unwrap();
            }
            // Record index rec_idx = cursor + j
            sb.add_op(OpDup).unwrap();
            sb.add_i64(36).unwrap(); sb.add_op(OpMul).unwrap(); // start offset
            sb.add_op(OpDup).unwrap();
            sb.add_i64(36).unwrap(); sb.add_op(OpAdd).unwrap(); // end offset

            // Directory on AltStack:
            // Fetch directory from AltStack without altering [directory, sum_gross]:
            sb.add_op(OpFromAltStack).unwrap(); // sum_gross
            sb.add_op(OpFromAltStack).unwrap(); // directory
            sb.add_op(OpDup).unwrap(); sb.add_op(OpToAltStack).unwrap(); // directory back to AltStack
            sb.add_op(OpSwap).unwrap(); // top is sum_gross
            sb.add_op(OpToAltStack).unwrap(); // sum_gross back to AltStack!
            sb.add_op(OpRot).unwrap();
            sb.add_op(OpRot).unwrap();
            sb.add_op(OpSubstr).unwrap(); // 36-byte record blob

            // Extract buyer pubkey:
            sb.add_op(OpDup).unwrap();
            sb.add_i64(4).unwrap(); sb.add_i64(36).unwrap(); sb.add_op(OpSubstr).unwrap();
            sb.add_data(&[0x00, 0x00, 0x20]).unwrap(); sb.add_op(OpSwap).unwrap(); sb.add_op(OpCat).unwrap();
            sb.add_data(&[0xac]).unwrap(); sb.add_op(OpCat).unwrap();
            // Output out_idx SPK matches:
            sb.add_i64(out_idx as i64).unwrap(); sb.add_op(OpTxOutputSpk).unwrap();
            sb.add_op(OpEqualVerify).unwrap();

            // Extract end_ticket:
            sb.add_i64(0).unwrap(); sb.add_i64(4).unwrap(); sb.add_op(OpSubstr).unwrap();
            sb.add_op(OpBin2Num).unwrap();

            // Extract start_ticket:
            sb.add_op(OpSwap).unwrap();
            sb.add_op(OpDup).unwrap();
            sb.add_op(Op0).unwrap();
            sb.add_op(OpEqual).unwrap();
            sb.add_op(OpIf).unwrap();
                sb.add_op(OpDrop).unwrap();
                sb.add_i64(0).unwrap();
            sb.add_op(OpElse).unwrap();
                sb.add_i64(1).unwrap(); sb.add_op(OpSub).unwrap();
                sb.add_i64(36).unwrap(); sb.add_op(OpMul).unwrap();
                sb.add_op(OpDup).unwrap(); sb.add_i64(4).unwrap(); sb.add_op(OpAdd).unwrap();
                // Fetch directory from AltStack:
                sb.add_op(OpFromAltStack).unwrap(); // sum_gross
                sb.add_op(OpFromAltStack).unwrap(); // directory
                sb.add_op(OpDup).unwrap(); sb.add_op(OpToAltStack).unwrap(); // directory back
                sb.add_op(OpSwap).unwrap(); // sum_gross
                sb.add_op(OpToAltStack).unwrap(); // sum_gross back
                sb.add_op(OpRot).unwrap();
                sb.add_op(OpRot).unwrap();
                sb.add_op(OpSubstr).unwrap();
                sb.add_op(OpBin2Num).unwrap(); // start_ticket
            sb.add_op(OpEndIf).unwrap();

            // count = end - start:
            sb.add_op(OpSub).unwrap();
            sb.add_op(OpDup).unwrap();
            sb.add_i64(1).unwrap(); sb.add_op(OpGreaterThanOrEqual).unwrap(); sb.add_op(OpVerify).unwrap();

            // gross_i = count * ticket_price (ticket_price is at depth 3):
            sb.add_i64(4).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpBin2Num).unwrap();
            sb.add_op(OpMul).unwrap();

            // Add gross_i to sum_gross on AltStack (preserve gross_i for refund_j):
            sb.add_op(OpDup).unwrap();
            sb.add_op(OpFromAltStack).unwrap(); // pops sum_gross
            sb.add_op(OpAdd).unwrap();          // sum_gross + gross_i
            sb.add_op(OpToAltStack).unwrap();   // updated sum_gross back on top!

            // Witness fee_j:
            // Stack depth: [fee_0, ..., fee_{k-1}, round_id, ticket_price, purchase_count, cursor, creator]
            // items above witness: 5 parameters = 5 items.
            let fee_depth = 5 + k - j;
            sb.add_i64(fee_depth as i64).unwrap(); sb.add_op(OpPick).unwrap();
            sb.add_op(OpSize).unwrap(); sb.add_i64(8).unwrap(); sb.add_op(OpNumEqualVerify).unwrap();
            sb.add_op(OpBin2Num).unwrap();

            // 0 <= fee_j <= MAX_REFUND_FEE:
            sb.add_op(OpDup).unwrap(); sb.add_i64(0).unwrap(); sb.add_op(OpGreaterThanOrEqual).unwrap(); sb.add_op(OpVerify).unwrap();
            sb.add_op(OpDup).unwrap(); sb.add_i64(MAX_REFUND_FEE as i64).unwrap(); sb.add_op(OpLessThanOrEqual).unwrap(); sb.add_op(OpVerify).unwrap();

            // refund_j = gross_i - fee_j > 0:
            sb.add_op(OpSub).unwrap();
            sb.add_op(OpDup).unwrap(); sb.add_i64(0).unwrap(); sb.add_op(OpGreaterThan).unwrap(); sb.add_op(OpVerify).unwrap();

            // Output out_idx Amount == refund_j:
            sb.add_i64(out_idx as i64).unwrap(); sb.add_op(OpTxOutputAmount).unwrap();
            sb.add_op(OpEqualVerify).unwrap();
        }

        // Output 0 Amount must be Input0Amount - sum_gross_batch:
        sb.add_op(OpFromAltStack).unwrap(); // sum_gross_batch (num)
        sb.add_op(Op0).unwrap(); sb.add_op(OpTxInputAmount).unwrap();
        sb.add_op(OpSwap).unwrap(); sb.add_op(OpSub).unwrap();
        sb.add_op(Op0).unwrap(); sb.add_op(OpTxOutputAmount).unwrap();
        sb.add_op(OpEqualVerify).unwrap();

        // Output 0 SPK reconstruction:
        // Slicing body from scriptSig:
        sb.add_op(Op0).unwrap(); sb.add_op(OpTxInputScriptSigLen).unwrap(); // sig_len
        sb.add_op(OpDup).unwrap(); // [sig_len, sig_len]
        sb.add_i64(static_body_len as i64).unwrap(); sb.add_op(OpSub).unwrap(); // start = sig_len - body_len
        sb.add_op(OpSwap).unwrap(); // [start, end]
        sb.add_op(Op0).unwrap(); sb.add_op(OpRot).unwrap(); sb.add_op(OpRot).unwrap();
        sb.add_op(OpTxInputScriptSigSubstr).unwrap(); // extracted static body!
        sb.add_op(OpToAltStack).unwrap(); // stash extracted body

        // Assemble successor prefix:
        // 1. [0xb9, 0x00, 0x88] (TxInputIndex, Op0, EqualVerify)
        sb.add_data(&[0xb9, 0x00, 0x88]).unwrap();
        // 2. round_id (32B): round_id is at depth 5 under prefix_so_far, +1 after pushData = 6
        sb.add_data(&[0x20]).unwrap();
        sb.add_i64(6).unwrap(); sb.add_op(OpPick).unwrap();
        sb.add_op(OpCat).unwrap(); sb.add_op(OpCat).unwrap();

        // 3. ticket_price (8B): ticket_price is at depth 4 under prefix_so_far, +1 after pushData = 5
        sb.add_data(&[0x08]).unwrap();
        sb.add_i64(5).unwrap(); sb.add_op(OpPick).unwrap();
        sb.add_op(OpCat).unwrap(); sb.add_op(OpCat).unwrap();

        // 4. purchase_count (8B): purchase_count is at depth 3 under prefix_so_far, +1 after pushData = 4
        sb.add_data(&[0x08]).unwrap();
        sb.add_i64(4).unwrap(); sb.add_op(OpPick).unwrap();
        sb.add_op(OpCat).unwrap(); sb.add_op(OpCat).unwrap();

        // 5. new_cursor (8B LE): cursor is at depth 2 under prefix_so_far
        sb.add_i64(2).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpBin2Num).unwrap();
        sb.add_i64(k as i64).unwrap(); sb.add_op(OpAdd).unwrap();
        sb.add_i64(8).unwrap(); sb.add_op(OpNum2Bin).unwrap(); // 8-byte LE new_cursor
        sb.add_data(&[0x08]).unwrap(); sb.add_op(OpSwap).unwrap(); sb.add_op(OpCat).unwrap();
        sb.add_op(OpCat).unwrap();

        // 6. creator_refund_spk (34B): creator_refund_spk is at depth 1 under prefix_so_far, +1 after pushData = 2
        sb.add_data(&[0x22]).unwrap();
        sb.add_i64(2).unwrap(); sb.add_op(OpPick).unwrap();
        sb.add_op(OpCat).unwrap(); sb.add_op(OpCat).unwrap();

        // 7. directory (P*36B): on AltStack under static_body!
        // AltStack has [directory, static_body].
        // Pop static_body:
        sb.add_op(OpFromAltStack).unwrap(); // static_body
        sb.add_op(OpFromAltStack).unwrap(); // directory
        sb.add_op(OpSize).unwrap(); // [..., dir, dir_len]
        sb.add_op(OpDup).unwrap();
        sb.add_i64(256).unwrap(); sb.add_op(OpLessThan).unwrap();
        sb.add_op(OpIf).unwrap();
            sb.add_data(&[0x4c]).unwrap(); sb.add_op(OpSwap).unwrap(); sb.add_i64(1).unwrap(); sb.add_op(OpNum2Bin).unwrap(); sb.add_op(OpCat).unwrap();
        sb.add_op(OpElse).unwrap();
            sb.add_data(&[0x4d]).unwrap(); sb.add_op(OpSwap).unwrap(); sb.add_i64(2).unwrap(); sb.add_op(OpNum2Bin).unwrap(); sb.add_op(OpCat).unwrap();
        sb.add_op(OpEndIf).unwrap();
        sb.add_op(OpSwap).unwrap(); sb.add_op(OpCat).unwrap(); // dstack: [prefix_so_far, static_body, dir_push]

        // We want: prefix_so_far || dir_push || static_body:
        sb.add_op(OpRot).unwrap();  // [static_body, dir_push, prefix_so_far]
        sb.add_op(OpSwap).unwrap(); // [static_body, prefix_so_far, dir_push]
        sb.add_op(OpCat).unwrap();  // [static_body, prefix_so_far || dir_push]
        sb.add_op(OpSwap).unwrap(); // [full_prefix, static_body]
        sb.add_op(OpCat).unwrap();  // full expected successor redeem script!

        // Output 0 SPK == P2SH(expected_redeem):
        sb.add_data(b"").unwrap(); sb.add_op(OpBlake2bWithKey).unwrap();
        sb.add_data(&[0x00, 0x00, 0xaa, 0x20]).unwrap(); sb.add_op(OpSwap).unwrap(); sb.add_op(OpCat).unwrap();
        sb.add_data(&[0x87]).unwrap(); sb.add_op(OpCat).unwrap();
        sb.add_op(Op0).unwrap(); sb.add_op(OpTxOutputSpk).unwrap();
        sb.add_op(OpEqualVerify).unwrap();

        // Ensure AltStack has directory so stack cleanup is symmetric:
        sb.add_data(b"").unwrap(); sb.add_op(OpToAltStack).unwrap();

    sb.add_op(OpEndIf).unwrap();

    // Clean execution stack:
    // AltStack cleanup: both branches now have 1 item on AltStack ([directory] or dummy)
    sb.add_op(OpFromAltStack).unwrap(); sb.add_op(OpDrop).unwrap();

    // dstack has 5 parameters + k fee witness items:
    for _ in 0..(k + 5) {
        sb.add_op(OpDrop).unwrap();
    }
    sb.add_op(OpTrue).unwrap();

    sb.drain()
}

// -----------------------------------------------------------------------------
// Fixed-Point Body Length Convergence Table:
// -----------------------------------------------------------------------------
pub fn compute_converged_body(k: usize) -> Vec<u8> {
    let mut guess = 100;
    for _ in 0..16 {
        let b = build_refunding_body(k, guess);
        if b.len() == guess {
            return b;
        }
        guess = b.len();
    }
    build_refunding_body(k, guess)
}

// -----------------------------------------------------------------------------
// VM Test Helper
// -----------------------------------------------------------------------------
fn run_vm(tx: &Transaction, input0_redeem: &[u8], input0_amount: u64, budget: Option<ComputeBudget>) -> Result<(), TxScriptError> {
    let mut tx_exec = tx.clone();
    if let Some(b) = budget {
        tx_exec.inputs[0].compute_commit = ComputeCommit::ComputeBudget(b);
    }
    let pop = PopulatedTransaction::new(&tx_exec, vec![
        UtxoEntry::new(input0_amount, pay_to_script_hash_script(input0_redeem), 1_000_000, false, Some(COVENANT_ID)),
    ]);
    let cov = CovenantsContext::from_tx(&pop).map_err(|e| TxScriptError::CovenantsError(e))?;
    let cache = Cache::new(1000);
    let reused = SigHashReusedValuesUnsync::new();
    let ectx = EngineCtx::new(&cache).with_reused(&reused).with_covenants_ctx(&cov);
    let allowed_units = tx_exec.inputs[0].compute_commit.allowed_script_units();
    let mut opcode_log = Vec::new();
    let mut vm = TxScriptEngine::from_transaction_input_with_script_units_limit(
        &pop, &pop.tx.inputs[0], 0, &pop.entries[0], ectx,
        EngineFlags { covenants_enabled: true, ..Default::default() },
        allowed_units,
    ).with_opcode_execution_log_buffer(&mut opcode_log);
    let res = vm.execute();
    drop(vm);
    if let Err(ref e) = res {
        eprintln!("VM Execution failed: {:?}", e);
        let trace = String::from_utf8_lossy(&opcode_log);
        let lines: Vec<&str> = trace.lines().collect();
        eprintln!("VM opcode log lines={} tail:", lines.len());
        for line in lines.iter().rev().take(40).rev() { eprintln!("  {line}"); }
    }
    res
}

// -----------------------------------------------------------------------------
// Transaction Builder for Batch Refund Step
// -----------------------------------------------------------------------------
pub fn build_refund_batch_tx(
    round_id: &Hash,
    ticket_price: u64,
    purchase_count: u64,
    cursor: u64,
    k: usize,
    records: &[PurchaseRecord],
    current_state_amount: u64,
    fees: &[u64],
    creator_refund_spk: &[u8],
    body: &[u8],
    budget: ComputeBudget,
) -> (Transaction, Vec<u8>) {
    let dir = directory_bytes(records);
    let current_prefix = build_refunding_prefix(
        round_id, ticket_price, purchase_count, cursor, creator_refund_spk, &dir,
    );
    let mut current_redeem = current_prefix;
    current_redeem.extend_from_slice(body);

    let is_terminal = cursor + (k as u64) == purchase_count;

    // Build witness scriptSig: [fee_0, ..., fee_{k-1}, current_redeem]
    let mut sb_sig = ScriptBuilder::with_flags(EngineFlags { covenants_enabled: true, ..Default::default() });
    for f in fees {
        sb_sig.add_data(&f.to_le_bytes()).unwrap();
    }
    sb_sig.add_data(&current_redeem).unwrap();
    let sig_script = sb_sig.drain();

    let mut outputs = Vec::new();
    let mut sum_gross = 0u64;

    if !is_terminal {
        // Compute buyer refunds
        for j in 0..k {
            let rec_idx = (cursor as usize) + j;
            let end_ticket = records[rec_idx].cumulative_end as u64;
            let start_ticket = if rec_idx == 0 { 0 } else { records[rec_idx - 1].cumulative_end as u64 };
            let count = end_ticket - start_ticket;
            let gross = count * ticket_price;
            sum_gross += gross;
            let refund_val = gross - fees[j];
            let buyer_spk = p2pk_spk_bytes(&records[rec_idx].buyer_pubkey);
            outputs.push(TransactionOutput {
                value: refund_val,
                script_public_key: ScriptPublicKey::from_vec(0, buyer_spk),
                covenant: None,
            });
        }

        // Successor state output:
        let successor_val = current_state_amount - sum_gross;
        let next_prefix = build_refunding_prefix(
            round_id, ticket_price, purchase_count, cursor + (k as u64), creator_refund_spk, &dir,
        );
        let mut next_redeem = next_prefix;
        next_redeem.extend_from_slice(body);
        let next_spk = pay_to_script_hash_script(&next_redeem);

        // Prepend Output 0 as successor:
        outputs.insert(0, TransactionOutput {
            value: successor_val,
            script_public_key: next_spk,
            covenant: Some(CovenantBinding { covenant_id: COVENANT_ID, authorizing_input: 0 }),
        });
    } else {
        // Terminal:
        // Outputs 0..k-1: buyer refunds
        for j in 0..k {
            let rec_idx = (cursor as usize) + j;
            let end_ticket = records[rec_idx].cumulative_end as u64;
            let start_ticket = if rec_idx == 0 { 0 } else { records[rec_idx - 1].cumulative_end as u64 };
            let count = end_ticket - start_ticket;
            let gross = count * ticket_price;
            sum_gross += gross;
            let refund_val = gross - fees[j];
            let buyer_spk = p2pk_spk_bytes(&records[rec_idx].buyer_pubkey);
            outputs.push(TransactionOutput {
                value: refund_val,
                script_public_key: ScriptPublicKey::from_vec(0, buyer_spk),
                covenant: None,
            });
        }

        // Output k: creator state_deposit
        let creator_val = current_state_amount - sum_gross;
        outputs.push(TransactionOutput {
            value: creator_val,
            script_public_key: ScriptPublicKey::from_vec(0, creator_refund_spk.to_vec()),
            covenant: None,
        });
    }

    let tx = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::from_bytes([0x12; 32]), 0),
            sig_script,
            0,
            ComputeCommit::ComputeBudget(budget),
        )],
        outputs,
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );

    (tx, current_redeem)
}

// -----------------------------------------------------------------------------
// MAIN ENTRY POINT
// -----------------------------------------------------------------------------
fn main() {
    println!("==================================================================");
    println!("KASWIN V1 BOUNDED DIRECTORY SEQUENTIAL REFUND SPIKE");
    println!("==================================================================");

    let round_id = Hash::from_bytes([0x52; 32]);
    let purchase_count = 256u64;
    let final_sold = 7_420u64;
    let creator_refund_spk = p2pk_spk_bytes(&[0x77; 32]);

    // Build realistic purchase directory with 256 records summing to 7,420 tickets:
    let mut records = Vec::with_capacity(256);
    let mut cur = 0u32;
    for i in 0..256 {
        let count = if i < 255 {
            (7_420 / 256) as u32
        } else {
            7_420 - cur
        };
        cur += count;
        records.push(PurchaseRecord {
            cumulative_end: cur,
            buyer_pubkey: [(i & 0xff) as u8; 32],
        });
    }
    assert_eq!(records[255].cumulative_end, 7_420);
    println!("Generated {} directory records, final_sold = {}", records.len(), records.last().unwrap().cumulative_end);

    let initial_gross = final_sold * TICKET_PRICE;
    let initial_state_amount = STATE_DEPOSIT + initial_gross;
    println!("Initial State Amount: {} sompi (Deposit: {} + Gross: {})", initial_state_amount, STATE_DEPOSIT, initial_gross);

    let mass_calc = MassCalculator::new_with_consensus_params(&TESTNET_PARAMS);
    let cofactors = TESTNET_PARAMS.block_mass_cofactors().after();

    // -------------------------------------------------------------------------
    // TEST EACH CANDIDATE BATCH K: [1, 4, 8, 16, 32, 64]
    // -------------------------------------------------------------------------
    let k_candidates = [1usize, 4, 8, 16, 32, 64];

    println!("\n=== EVALUATING BATCH K CANDIDATES [1, 4, 8, 16, 32, 64] ===");
    println!("  K  | Step Type | Redeem   | SigScript | TxBytes | Outputs | ScriptUnits | Budget | Compute | Transient | Storage | Relay Floor   | SumFee");
    println!("-----+-----------+----------+-----------+---------+---------+-------------+--------+---------+-----------+---------+---------------+---------");

    for &k in &k_candidates {
        let body = compute_converged_body(k);
        let budget = ComputeBudget(150); // generous initial commit

        // 1. Test Middle / Generic Step (cursor = 0)
        let fees = vec![50_000u64; k];
        let (tx_mid, redeem_mid) = build_refund_batch_tx(
            &round_id, TICKET_PRICE, purchase_count, 0, k, &records, initial_state_amount, &fees, &creator_refund_spk, &body, budget,
        );
        let res_mid = run_vm(&tx_mid, &redeem_mid, initial_state_amount, None);
        assert_eq!(res_mid, Ok(()), "K={} non-terminal execution failed", k);

        let pop_mid = PopulatedTransaction::new(&tx_mid, vec![
            UtxoEntry::new(initial_state_amount, pay_to_script_hash_script(&redeem_mid), 1_000_000, false, Some(COVENANT_ID)),
        ]);
        let non_mid = mass_calc.calc_non_contextual_masses(&tx_mid);
        let ctx_mid = mass_calc.calc_contextual_masses(&pop_mid).unwrap();
        let norm_mid = non_mid.normalized_transient(&cofactors);
        let fee_mass_mid = non_mid.compute_mass.max(norm_mid);
        let relay_mid = (fee_mass_mid * 100_000 / 1000).max(100_000);
        let tx_size_mid = transaction_estimated_serialized_size(&tx_mid);

        let cov_mid = CovenantsContext::from_tx(&pop_mid).unwrap();
        let cache_mid = Cache::new(1000);
        let reused_mid = SigHashReusedValuesUnsync::new();
        let ectx_mid = EngineCtx::new(&cache_mid).with_reused(&reused_mid).with_covenants_ctx(&cov_mid);
        let mut vm_mid = TxScriptEngine::from_transaction_input_with_script_units_limit(
            &pop_mid, &pop_mid.tx.inputs[0], 0, &pop_mid.entries[0], ectx_mid,
            EngineFlags { covenants_enabled: true, ..Default::default() },
            tx_mid.inputs[0].compute_commit.allowed_script_units(),
        );
        assert_eq!(vm_mid.execute(), Ok(()));
        let su_mid = vm_mid.used_script_units();
        let bmin_mid = ComputeBudget::checked_covering_script_units(su_mid).unwrap();

        // Check B_min-1 failure:
        if bmin_mid.0 > 0 {
            let res_under = run_vm(&tx_mid, &redeem_mid, initial_state_amount, Some(ComputeBudget(bmin_mid.0 - 1)));
            assert!(matches!(res_under, Err(TxScriptError::ExceededCommittedScriptUnits { .. })));
        }

        println!(" {:>3} | Non-Term  | {:>6} B | {:>7} B | {:>5} B | {:>7} | {:>9} SU | Budget({:>2}) | {:>7} | {:>9} | {:>7} | {:>7} sompi | {:>7} sompi",
            k, redeem_mid.len(), tx_mid.inputs[0].signature_script.len(), tx_size_mid, tx_mid.outputs.len(),
            su_mid.0, bmin_mid.0, non_mid.compute_mass, non_mid.transient_mass, ctx_mid.storage_mass, relay_mid, k as u64 * 50_000
        );

        // 2. Test Terminal Step (cursor = purchase_count - k)
        let term_cursor = purchase_count - (k as u64);
        let term_fees = vec![50_000u64; k];
        let sold_before_term = records[term_cursor as usize - 1].cumulative_end as u64;
        let term_state_amount = STATE_DEPOSIT + (final_sold - sold_before_term) * TICKET_PRICE;

        let (tx_term, redeem_term) = build_refund_batch_tx(
            &round_id, TICKET_PRICE, purchase_count, term_cursor, k, &records, term_state_amount, &term_fees, &creator_refund_spk, &body, budget,
        );
        let res_term = run_vm(&tx_term, &redeem_term, term_state_amount, None);
        assert_eq!(res_term, Ok(()), "K={} terminal execution failed", k);

        let pop_term = PopulatedTransaction::new(&tx_term, vec![
            UtxoEntry::new(term_state_amount, pay_to_script_hash_script(&redeem_term), 1_000_000, false, Some(COVENANT_ID)),
        ]);
        let non_term = mass_calc.calc_non_contextual_masses(&tx_term);
        let ctx_term = mass_calc.calc_contextual_masses(&pop_term).unwrap();
        let norm_term = non_term.normalized_transient(&cofactors);
        let fee_mass_term = non_term.compute_mass.max(norm_term);
        let relay_term = (fee_mass_term * 100_000 / 1000).max(100_000);
        let tx_size_term = transaction_estimated_serialized_size(&tx_term);

        let cov_term = CovenantsContext::from_tx(&pop_term).unwrap();
        let cache_term = Cache::new(1000);
        let reused_term = SigHashReusedValuesUnsync::new();
        let ectx_term = EngineCtx::new(&cache_term).with_reused(&reused_term).with_covenants_ctx(&cov_term);
        let mut vm_term = TxScriptEngine::from_transaction_input_with_script_units_limit(
            &pop_term, &pop_term.tx.inputs[0], 0, &pop_term.entries[0], ectx_term,
            EngineFlags { covenants_enabled: true, ..Default::default() },
            tx_term.inputs[0].compute_commit.allowed_script_units(),
        );
        assert_eq!(vm_term.execute(), Ok(()));
        let su_term = vm_term.used_script_units();
        let bmin_term = ComputeBudget::checked_covering_script_units(su_term).unwrap();

        println!(" {:>3} | TERMINAL  | {:>6} B | {:>7} B | {:>5} B | {:>7} | {:>9} SU | Budget({:>2}) | {:>7} | {:>9} | {:>7} | {:>7} sompi | {:>7} sompi",
            k, redeem_term.len(), tx_term.inputs[0].signature_script.len(), tx_size_term, tx_term.outputs.len(),
            su_term.0, bmin_term.0, non_term.compute_mass, non_term.transient_mass, ctx_term.storage_mass, relay_term, k as u64 * 50_000
        );

        // Terminal creator output amount check:
        assert_eq!(tx_term.outputs.last().unwrap().value, STATE_DEPOSIT, "Creator state deposit must be exact!");
    }

    // -------------------------------------------------------------------------
    // RELAY FLOOR ANALYSIS FOR K=1:
    // -------------------------------------------------------------------------
    println!("\n=== CRUCIAL AUDIT: K=1 RELAY FLOOR VS SINGLE PURCHASE FEE ===");
    let body_1 = compute_converged_body(1);
    let (tx_1, redeem_1) = build_refund_batch_tx(
        &round_id, TICKET_PRICE, purchase_count, 0, 1, &records, initial_state_amount, &[MAX_REFUND_FEE], &creator_refund_spk, &body_1, ComputeBudget(10),
    );
    let pop_1 = PopulatedTransaction::new(&tx_1, vec![
        UtxoEntry::new(initial_state_amount, pay_to_script_hash_script(&redeem_1), 1_000_000, false, Some(COVENANT_ID)),
    ]);
    let non_1 = mass_calc.calc_non_contextual_masses(&tx_1);
    let norm_1 = non_1.normalized_transient(&cofactors);
    let fee_mass_1 = non_1.compute_mass.max(norm_1);
    let relay_floor_1 = (fee_mass_1 * 100_000 / 1000).max(100_000);
    println!("K=1 Transaction Details:");
    println!("  Tx Size:            {} bytes", transaction_estimated_serialized_size(&tx_1));
    println!("  Transient Mass:     {} grams (norm: {})", non_1.transient_mass, norm_1);
    println!("  Compute Mass:       {} grams", non_1.compute_mass);
    println!("  Relay Floor:        {} sompi ({:.5} KAS)", relay_floor_1, relay_floor_1 as f64 / 1e8);
    println!("  MAX_REFUND_FEE:     {} sompi ({:.5} KAS)", MAX_REFUND_FEE, MAX_REFUND_FEE as f64 / 1e8);
    if MAX_REFUND_FEE < relay_floor_1 {
        println!("  -> FINDING: MAX_REFUND_FEE ({} sompi) < relay_floor_1 ({} sompi)!", MAX_REFUND_FEE, relay_floor_1);
        println!("     Therefore, K=1 single-refund is consensus-valid but CANNOT be relayed by standard mempool alone without external funding!");
    } else {
        println!("  -> FINDING: MAX_REFUND_FEE >= relay_floor_1 (relayable).");
    }

    // -------------------------------------------------------------------------
    // FULL END-TO-END PIPELINE SIMULATION (P=256, K=16, 16 BATCHES)
    // -------------------------------------------------------------------------
    println!("\n=== FULL END-TO-END PIPELINE SIMULATION (P=256, K=16, 16 BATCHES) ===");
    let k_sim = 16usize;
    let body_sim = compute_converged_body(k_sim);
    let mut sim_cursor = 0u64;
    let mut sim_state_amount = initial_state_amount;
    let mut total_refunded_to_buyers = 0u64;
    let mut total_fees_paid = 0u64;

    let num_batches = (purchase_count as usize) / k_sim;
    for b in 0..num_batches {
        let is_last = b == num_batches - 1;
        let fees = vec![30_000u64; k_sim]; // 0.0003 KAS fee per purchase
        let (tx, redeem) = build_refund_batch_tx(
            &round_id, TICKET_PRICE, purchase_count, sim_cursor, k_sim, &records, sim_state_amount, &fees, &creator_refund_spk, &body_sim, ComputeBudget(45),
        );
        let res = run_vm(&tx, &redeem, sim_state_amount, None);
        assert_eq!(res, Ok(()), "Batch {} (cursor={}) failed VM execution", b, sim_cursor);

        // Sum buyer payouts:
        let buyer_out_start = if !is_last { 1 } else { 0 };
        let buyer_out_end = if !is_last { 1 + k_sim } else { k_sim };
        for o in buyer_out_start..buyer_out_end {
            total_refunded_to_buyers += tx.outputs[o].value;
        }
        for &f in &fees {
            total_fees_paid += f;
        }

        if !is_last {
            sim_state_amount = tx.outputs[0].value;
            sim_cursor += k_sim as u64;
        } else {
            let creator_refund_val = tx.outputs[k_sim].value;
            assert_eq!(creator_refund_val, STATE_DEPOSIT, "Terminal creator output must equal exact state deposit!");
            sim_cursor += k_sim as u64;
        }
    }

    assert_eq!(sim_cursor, 256);
    println!("Completed all 16 batches (256/256 purchases refunded)!");
    println!("  Total buyer refunds received: {} sompi", total_refunded_to_buyers);
    println!("  Total network fees paid:      {} sompi", total_fees_paid);
    println!("  Sum buyer + fees:             {} sompi", total_refunded_to_buyers + total_fees_paid);
    println!("  Expected gross pool:          {} sompi", initial_gross);
    assert_eq!(total_refunded_to_buyers + total_fees_paid, initial_gross, "Gross pool conservation strictly verified!");
    println!("  -> PASS: 100% principal accounted for, state deposit returned intact!");

    // -------------------------------------------------------------------------
    // NEGATIVE ADVERSARIAL MATRIX (24 MANDATORY CASES)
    // -------------------------------------------------------------------------
    println!("\n=== RUNNING 24-CASE NEGATIVE ADVERSARIAL MATRIX (K=4) ===");
    let k_neg = 4usize;
    let body_neg = compute_converged_body(k_neg);
    let fees_neg = vec![20_000u64; k_neg];
    let (tx_base, redeem_base) = build_refund_batch_tx(
        &round_id, TICKET_PRICE, purchase_count, 0, k_neg, &records, initial_state_amount, &fees_neg, &creator_refund_spk, &body_neg, ComputeBudget(20),
    );

    let assert_neg = |num: usize, name: &str, tx: &Transaction, redeem: &[u8], amount: u64| {
        let res = run_vm(tx, redeem, amount, None);
        assert!(res.is_err(), "Negative test #{} ({}) unexpectedly PASSED!", num, name);
        println!("  #{:<2}: {:<48} -> FAIL (OK)", num, name);
    };

    // #1: cursor skip purchase (successor cursor advanced by K+1 instead of K)
    {
        let mut tx = tx_base.clone();
        let next_prefix = build_refunding_prefix(&round_id, TICKET_PRICE, purchase_count, (k_neg + 1) as u64, &creator_refund_spk, &directory_bytes(&records));
        let mut next_redeem = next_prefix; next_redeem.extend_from_slice(&body_neg);
        tx.outputs[0].script_public_key = pay_to_script_hash_script(&next_redeem);
        assert_neg(1, "cursor skip a purchase (c + k + 1)", &tx, &redeem_base, initial_state_amount);
    }

    // #2: cursor does not advance (successor cursor unchanged)
    {
        let mut tx = tx_base.clone();
        let next_prefix = build_refunding_prefix(&round_id, TICKET_PRICE, purchase_count, 0, &creator_refund_spk, &directory_bytes(&records));
        let mut next_redeem = next_prefix; next_redeem.extend_from_slice(&body_neg);
        tx.outputs[0].script_public_key = pay_to_script_hash_script(&next_redeem);
        assert_neg(2, "cursor does not advance (c + 0)", &tx, &redeem_base, initial_state_amount);
    }

    // #3: cursor advances K+1 in SPK
    {
        let mut tx = tx_base.clone();
        let next_prefix = build_refunding_prefix(&round_id, TICKET_PRICE, purchase_count, 5, &creator_refund_spk, &directory_bytes(&records));
        let mut next_redeem = next_prefix; next_redeem.extend_from_slice(&body_neg);
        tx.outputs[0].script_public_key = pay_to_script_hash_script(&next_redeem);
        assert_neg(3, "cursor advances K+1", &tx, &redeem_base, initial_state_amount);
    }

    // #4: repeat refund of old record
    {
        let prefix_old = build_refunding_prefix(&round_id, TICKET_PRICE, purchase_count, 4, &creator_refund_spk, &directory_bytes(&records));
        let mut redeem_old = prefix_old; redeem_old.extend_from_slice(&body_neg);
        let (tx, _) = build_refund_batch_tx(&round_id, TICKET_PRICE, purchase_count, 4, k_neg, &records, initial_state_amount - 1_000_000, &fees_neg, &creator_refund_spk, &body_neg, ComputeBudget(20));
        assert_neg(4, "repeat refund old record", &tx, &redeem_base, initial_state_amount);
    }

    // #5: payout SPK tampering (buyer 0 SPK replaced with attacker SPK)
    {
        let mut tx = tx_base.clone();
        tx.outputs[1].script_public_key = ScriptPublicKey::from_vec(0, p2pk_spk_bytes(&[0x66; 32]));
        assert_neg(5, "payout SPK tampered to attacker", &tx, &redeem_base, initial_state_amount);
    }

    // #6: payout pubkey from other record (buyer 0 SPK swapped with buyer 1 SPK)
    {
        let mut tx = tx_base.clone();
        tx.outputs[1].script_public_key = tx_base.outputs[2].script_public_key.clone();
        assert_neg(6, "payout pubkey swapped with other record", &tx, &redeem_base, initial_state_amount);
    }

    // #7: gross_i underpaid by 1 sompi (buyer 0 receives refund - 1)
    {
        let mut tx = tx_base.clone();
        tx.outputs[1].value -= 1;
        assert_neg(7, "buyer refund underpaid by 1 sompi", &tx, &redeem_base, initial_state_amount);
    }

    // #8: gross_i overpaid by 1 sompi (buyer 0 receives refund + 1)
    {
        let mut tx = tx_base.clone();
        tx.outputs[1].value += 1;
        assert_neg(8, "buyer refund overpaid by 1 sompi", &tx, &redeem_base, initial_state_amount);
    }

    // #9: fee_i negative (illegal sign-magnitude)
    {
        let mut tx = tx_base.clone();
        let mut sb = ScriptBuilder::with_flags(EngineFlags { covenants_enabled: true, ..Default::default() });
        sb.add_data(&(-20_000i64).to_le_bytes()).unwrap();
        for f in &fees_neg[1..] { sb.add_data(&f.to_le_bytes()).unwrap(); }
        sb.add_data(&redeem_base).unwrap();
        tx.inputs[0].signature_script = sb.drain();
        assert_neg(9, "fee_i negative", &tx, &redeem_base, initial_state_amount);
    }

    // #10: fee_i > MAX_REFUND_FEE
    {
        let fees_excessive = vec![MAX_REFUND_FEE + 1; k_neg];
        let (tx, redeem) = build_refund_batch_tx(&round_id, TICKET_PRICE, purchase_count, 0, k_neg, &records, initial_state_amount, &fees_excessive, &creator_refund_spk, &body_neg, ComputeBudget(20));
        assert_neg(10, "fee_i > MAX_REFUND_FEE", &tx, &redeem, initial_state_amount);
    }

    // #11: refund_i <= 0 (fee equals gross)
    {
        let count_0 = records[0].cumulative_end as u64;
        let gross_0 = count_0 * TICKET_PRICE;
        let mut fees_huge = fees_neg.clone();
        fees_huge[0] = gross_0;
        let (tx, redeem) = build_refund_batch_tx(&round_id, TICKET_PRICE, purchase_count, 0, k_neg, &records, initial_state_amount, &fees_huge, &creator_refund_spk, &body_neg, ComputeBudget(20));
        assert_neg(11, "refund_i <= 0 (zero refund)", &tx, &redeem, initial_state_amount);
    }

    // #12: successor amount - 1 sompi
    {
        let mut tx = tx_base.clone();
        tx.outputs[0].value -= 1;
        assert_neg(12, "successor amount - 1 sompi", &tx, &redeem_base, initial_state_amount);
    }

    // #13: successor amount + 1 sompi
    {
        let mut tx = tx_base.clone();
        tx.outputs[0].value += 1;
        assert_neg(13, "successor amount + 1 sompi", &tx, &redeem_base, initial_state_amount);
    }

    // #14: directory tampering in successor
    {
        let mut tampered_recs = records.clone();
        tampered_recs[10].cumulative_end += 1;
        let next_prefix = build_refunding_prefix(&round_id, TICKET_PRICE, purchase_count, k_neg as u64, &creator_refund_spk, &directory_bytes(&tampered_recs));
        let mut next_redeem = next_prefix; next_redeem.extend_from_slice(&body_neg);
        let mut tx = tx_base.clone();
        tx.outputs[0].script_public_key = pay_to_script_hash_script(&next_redeem);
        assert_neg(14, "directory tampered in successor", &tx, &redeem_base, initial_state_amount);
    }

    // #15: purchase_count tampered in successor
    {
        let next_prefix = build_refunding_prefix(&round_id, TICKET_PRICE, purchase_count + 1, k_neg as u64, &creator_refund_spk, &directory_bytes(&records));
        let mut next_redeem = next_prefix; next_redeem.extend_from_slice(&body_neg);
        let mut tx = tx_base.clone();
        tx.outputs[0].script_public_key = pay_to_script_hash_script(&next_redeem);
        assert_neg(15, "purchase_count tampered in successor", &tx, &redeem_base, initial_state_amount);
    }

    // #16: ticket_price tampered in successor
    {
        let next_prefix = build_refunding_prefix(&round_id, TICKET_PRICE + 1, purchase_count, k_neg as u64, &creator_refund_spk, &directory_bytes(&records));
        let mut next_redeem = next_prefix; next_redeem.extend_from_slice(&body_neg);
        let mut tx = tx_base.clone();
        tx.outputs[0].script_public_key = pay_to_script_hash_script(&next_redeem);
        assert_neg(16, "ticket_price tampered in successor", &tx, &redeem_base, initial_state_amount);
    }

    // #17: hidden extra payout output added
    {
        let mut tx = tx_base.clone();
        tx.outputs.push(TransactionOutput {
            value: 10_000,
            script_public_key: ScriptPublicKey::from_vec(0, p2pk_spk_bytes(&[0x99; 32])),
            covenant: None,
        });
        assert_neg(17, "hidden extra payout output added", &tx, &redeem_base, initial_state_amount);
    }

    // #18: missing one buyer output (output count = k instead of k+1)
    {
        let mut tx = tx_base.clone();
        tx.outputs.pop();
        assert_neg(18, "missing one buyer output", &tx, &redeem_base, initial_state_amount);
    }

    // #19: wrong KIP-20 continuation (authorizing_input != 0)
    {
        let mut tx = tx_base.clone();
        tx.outputs[0].covenant = Some(CovenantBinding { covenant_id: COVENANT_ID, authorizing_input: 1 });
        assert_neg(19, "wrong KIP-20 authorizing input", &tx, &redeem_base, initial_state_amount);
    }

    // #20: duplicate state continuation (Output 1 also has covenant)
    {
        let mut tx = tx_base.clone();
        tx.outputs[1].covenant = Some(CovenantBinding { covenant_id: COVENANT_ID, authorizing_input: 0 });
        assert_neg(20, "duplicate state continuation on Output 1", &tx, &redeem_base, initial_state_amount);
    }

    // #21: terminal creator deposit - 1 sompi
    {
        let term_cursor = purchase_count - (k_neg as u64);
        let sold_before_term = records[term_cursor as usize - 1].cumulative_end as u64;
        let term_state_amount = STATE_DEPOSIT + (final_sold - sold_before_term) * TICKET_PRICE;
        let (mut tx, redeem) = build_refund_batch_tx(&round_id, TICKET_PRICE, purchase_count, term_cursor, k_neg, &records, term_state_amount, &fees_neg, &creator_refund_spk, &body_neg, ComputeBudget(20));
        let last_idx = tx.outputs.len() - 1;
        tx.outputs[last_idx].value -= 1;
        assert_neg(21, "terminal creator deposit - 1 sompi", &tx, &redeem, term_state_amount);
    }

    // #22: terminal creator deposit + 1 sompi
    {
        let term_cursor = purchase_count - (k_neg as u64);
        let sold_before_term = records[term_cursor as usize - 1].cumulative_end as u64;
        let term_state_amount = STATE_DEPOSIT + (final_sold - sold_before_term) * TICKET_PRICE;
        let (mut tx, redeem) = build_refund_batch_tx(&round_id, TICKET_PRICE, purchase_count, term_cursor, k_neg, &records, term_state_amount, &fees_neg, &creator_refund_spk, &body_neg, ComputeBudget(20));
        let last_idx = tx.outputs.len() - 1;
        tx.outputs[last_idx].value += 1;
        assert_neg(22, "terminal creator deposit + 1 sompi", &tx, &redeem, term_state_amount);
    }

    // #23: terminal continuation not destroyed (creator output has covenant)
    {
        let term_cursor = purchase_count - (k_neg as u64);
        let sold_before_term = records[term_cursor as usize - 1].cumulative_end as u64;
        let term_state_amount = STATE_DEPOSIT + (final_sold - sold_before_term) * TICKET_PRICE;
        let (mut tx, redeem) = build_refund_batch_tx(&round_id, TICKET_PRICE, purchase_count, term_cursor, k_neg, &records, term_state_amount, &fees_neg, &creator_refund_spk, &body_neg, ComputeBudget(20));
        let last_idx = tx.outputs.len() - 1;
        tx.outputs[last_idx].covenant = Some(CovenantBinding { covenant_id: COVENANT_ID, authorizing_input: 0 });
        assert_neg(23, "terminal continuation not destroyed", &tx, &redeem, term_state_amount);
    }

    // #24: draw-capable successor produced from refund path (Output 0 SPK is SEALED)
    {
        let mut tx = tx_base.clone();
        tx.outputs[0].script_public_key = ScriptPublicKey::from_vec(0, p2pk_spk_bytes(&[0x11; 32]));
        assert_neg(24, "draw-capable successor produced from refund", &tx, &redeem_base, initial_state_amount);
    }

    println!("\n==================================================================");
    println!("ALL 24 NEGATIVE ADVERSARIAL CASES STRICTLY REJECTED!");
    println!("==================================================================");

    println!("\n==================================================================");
    println!("BOUNDED DIRECTORY REFUND PASS");
    println!("==================================================================");
}
