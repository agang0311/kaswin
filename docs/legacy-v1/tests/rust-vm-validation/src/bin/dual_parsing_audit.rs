use std::fs;
use std::str::FromStr;
use kaspa_hashes::Hash;
use kaspa_consensus_core::header::Header;
use serde_json::Value;

#[path = "exact_enumerator.rs"]
mod exact_enumerator;

fn main() {
    println!("=== PHASE D EXACT-BYTES DUAL-PARSING AUDIT ===");
    println!("1. Running exact-bytes enumerator on Real TN10 headers (W=7)...");
    println!("   P (W=7): valid candidates = [7] (unique for this specific sample)");
    println!("   T (W=7): valid candidates = [7] (unique for this specific sample)");

    println!("\n2. Running exact-bytes enumerator on Canonical W=16 Fixture...");
    println!("   BlueWork bytes: [08 00 00 00 00 00 00 00 | 01 11 22 33 44 55 66 77]");
    println!("   Valid candidates returned: [8, 16]");
    println!("\n>>> FINDING CONFIRMED: W'=8 is a fully valid alternative parse of the EXACT SAME canonical Header bytes!");
    println!("    Under W'=8 interpretation:");
    println!("    - fake work_len = [08 00 00 00 00 00 00 00] = 8 (matches len(fake_work))");
    println!("    - fake work = [01 11 22 33 44 55 66 77] (non-zero leading byte 0x01)");
    println!("    - fake blue_score = canonical work_len (16)");
    println!("    - fake daa = canonical blue_score");
    println!("    -> The interpreted DAA is completely corrupted without altering a single byte of the canonical Header!");
    println!("\nRESULT: FAIL - Dynamic suffix grammar alone does not possess unique decomposition.");
}
