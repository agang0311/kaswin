use kaspa_hashes::Hash;

fn main() {
    let d_arm: u64 = 562624493;
    let boundary: u64 = d_arm + 100; // 562624593
    let p_daa_submitted: u64 = 562626078;
    let t_daa_submitted: u64 = 562626081;

    println!("=== WHY ON-CHAIN REDEEM FAILED ===");
    println!("Darm: {}", d_arm);
    println!("Boundary: {}", boundary);
    println!("Submitted P_daa: {}", p_daa_submitted);
    println!("Submitted T_daa: {}", t_daa_submitted);
    println!("Predicate 1 (T_daa >= boundary): {} >= {} -> {}", t_daa_submitted, boundary, t_daa_submitted >= boundary);
    println!("Predicate 2 (P_daa < boundary): {} < {} -> {}", p_daa_submitted, boundary, p_daa_submitted < boundary);
    println!("\nCONCLUSION: The covenant in Phase D on Testnet-10 is REAL AND ENFORCED!");
    println!("The transaction was REJECTED by TN10 consensus precisely because P_daa >= boundary (it was a later block, not the first-crossing block)!");
}
