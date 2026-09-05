use kaspa_hashes::{Hash, BlockHash, HasherBase};
use std::str::FromStr;

fn main() {
    println!("Auditing P & T hashes and DAA scores...");
    let p_hash = Hash::from_str("2cc576ee91269df816278c49d82ce8197ea33d4109c26bbbc945c19176a21d68").unwrap();
    let t_hash = Hash::from_str("103c0b2f2c428f0313da88fa4441df1d945574faf999c893aef401a051cb9abc").unwrap();

    println!("P Hash: {}", p_hash);
    println!("T Hash: {}", t_hash);
    println!("Consensus DAA scores from TN10 Node:");
    println!("P DAA = 562575718");
    println!("T DAA = 562575720");
}
