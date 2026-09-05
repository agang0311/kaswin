use kaspa_txscript::deserialize_i64;

fn main() {
    let daa: u64 = 562636838;
    let daa_le_bytes = daa.to_le_bytes(); // [u8; 8]
    println!("DAA: {}", daa);
    println!("LE Bytes: {:02x?}", daa_le_bytes);

    let deserialized = deserialize_i64(&daa_le_bytes, false).unwrap();
    println!("Deserialized i64: {}", deserialized);
    assert_eq!(deserialized as u64, daa);
    println!(">>> OpBin2Num directly converts 8-byte LE to i64 successfully! <<<");
}
