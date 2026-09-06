// ARCHIVED: Kaswin Phase D Bounded Dynamic Forward Header Parser Covenant
//
// STATUS: DEPRECATED / ARCHIVED (NOT FOR PRODUCTION USE)
// REASON: Unbounded full-header witness creates a fatal resource boundary failure.
//         Under worst-case consensus-valid DAG states (L=251, high parent branching),
//         two full block headers can exceed the 250,000 byte SignatureScript limit,
//         causing irreversible covenant deadlocks.
//
// REPLACED BY: contracts/phase_d_pass_a_covenant.rs (KIP-21 PASS-A 240B Opening)

pub use super::phase_d_pass_a_covenant::*;
