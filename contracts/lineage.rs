use kaspa_hashes::ZERO_HASH;
use kaspa_txscript::{
    opcodes::codes::*,
    script_builder::{ScriptBuilder, ScriptBuilderResult},
};

/// Appends singleton continuation guard for Kaswin intermediate states (OPEN, SEALED, DRAW_READY):
/// - Reads current C from OpInputCovenantId(0)
/// - Asserts C != ZERO_HASH
/// - OpCovInputCount(C) == 1 (exactly one covenant input with ID C in the tx)
/// - OpAuthOutputCount(0) == 1 (Input 0 authorizes exactly one output)
/// - OpAuthOutputIdx(0, 0) == 0 (authorized output is Output 0)
/// - OpOutputCovenantId(0) == C (Output 0 preserves the exact same covenant ID C)
/// - OpOutputAuthorizingInput(0) == 0 (Output 0's authorizing input is Input 0)
/// - OpCovOutputCount(C) == 1 (exactly one output with ID C in the entire transaction)
pub fn append_kaswin_singleton_continuation_guard(sb: &mut ScriptBuilder) -> ScriptBuilderResult<()> {
    // 1. Read C from OpInputCovenantId(0)
    sb.add_i64(0)?;
    sb.add_op(OpInputCovenantId)?; // Stack: [..., C (32B)]

    // 2. Assert C != ZERO_HASH
    sb.add_op(OpDup)?;
    sb.add_data(&ZERO_HASH.as_bytes())?;
    sb.add_op(OpEqual)?;
    sb.add_op(OpNot)?;
    sb.add_op(OpVerify)?; // Stack: [..., C (32B)]

    // 3. OpCovInputCount(C) == 1
    sb.add_op(OpDup)?;
    sb.add_op(OpCovInputCount)?;
    sb.add_i64(1)?;
    sb.add_op(OpNumEqualVerify)?;

    // 4. OpAuthOutputCount(0) == 1
    sb.add_i64(0)?;
    sb.add_op(OpAuthOutputCount)?;
    sb.add_i64(1)?;
    sb.add_op(OpNumEqualVerify)?;

    // 5. OpAuthOutputIdx(0, 0) == 0
    sb.add_i64(0)?;
    sb.add_i64(0)?;
    sb.add_op(OpAuthOutputIdx)?;
    sb.add_i64(0)?;
    sb.add_op(OpNumEqualVerify)?;

    // 6. OpOutputCovenantId(0) == C
    sb.add_op(OpDup)?; // [..., C, C]
    sb.add_i64(0)?;
    sb.add_op(OpOutputCovenantId)?; // [..., C, C, out_cov_id]
    sb.add_op(OpEqualVerify)?;      // [..., C]

    // 7. OpOutputAuthorizingInput(0) == 0
    sb.add_i64(0)?;
    sb.add_op(OpOutputAuthorizingInput)?;
    sb.add_i64(0)?;
    sb.add_op(OpNumEqualVerify)?;

    // 8. OpCovOutputCount(C) == 1
    sb.add_op(OpCovOutputCount)?; // consumes C!
    sb.add_i64(1)?;
    sb.add_op(OpNumEqualVerify)?;

    Ok(())
}

/// Appends terminal lineage termination guard for WINNER_READY -> PAID:
/// - Reads current C from OpInputCovenantId(0)
/// - Asserts C != ZERO_HASH
/// - OpCovInputCount(C) == 1 (Input 0 is the unique covenant input)
/// - OpAuthOutputCount(0) == 0 (Input 0 authorizes NO covenant output)
/// - OpCovOutputCount(C) == 0 (ZERO outputs with ID C exist in transaction)
/// - OpOutputCovenantId(0) == ZERO_HASH (Output 0 is an ordinary non-covenant output)
/// - OpOutputAuthorizingInput(0) == -1 (Output 0 has no authorizing input)
pub fn append_kaswin_terminal_lineage_guard(sb: &mut ScriptBuilder) -> ScriptBuilderResult<()> {
    // 1. Read C from OpInputCovenantId(0)
    sb.add_i64(0)?;
    sb.add_op(OpInputCovenantId)?; // Stack: [..., C (32B)]

    // 2. Assert C != ZERO_HASH
    sb.add_op(OpDup)?;
    sb.add_data(&ZERO_HASH.as_bytes())?;
    sb.add_op(OpEqual)?;
    sb.add_op(OpNot)?;
    sb.add_op(OpVerify)?; // Stack: [..., C (32B)]

    // 3. OpCovInputCount(C) == 1
    sb.add_op(OpDup)?;
    sb.add_op(OpCovInputCount)?;
    sb.add_i64(1)?;
    sb.add_op(OpNumEqualVerify)?;

    // 4. OpAuthOutputCount(0) == 0 (lineage terminated!)
    sb.add_i64(0)?;
    sb.add_op(OpAuthOutputCount)?;
    sb.add_i64(0)?;
    sb.add_op(OpNumEqualVerify)?;

    // 5. OpCovOutputCount(C) == 0 (no continuation output exists)
    sb.add_op(OpCovOutputCount)?; // consumes C!
    sb.add_i64(0)?;
    sb.add_op(OpNumEqualVerify)?;

    // 6. OpOutputCovenantId(0) == ZERO_HASH (Output 0 has no covenant ID)
    sb.add_i64(0)?;
    sb.add_op(OpOutputCovenantId)?;
    sb.add_data(&ZERO_HASH.as_bytes())?;
    sb.add_op(OpEqualVerify)?;

    // 7. OpOutputAuthorizingInput(0) == -1 (Output 0 has no authorizing input)
    sb.add_i64(0)?;
    sb.add_op(OpOutputAuthorizingInput)?;
    sb.add_i64(-1)?;
    sb.add_op(OpNumEqualVerify)?;

    Ok(())
}
