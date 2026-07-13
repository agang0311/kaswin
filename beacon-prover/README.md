# Kaspa raffle drand prover

This standalone application produces a RISC Zero succinct receipt proving that a fixed League of Entropy quicknet BLS signature is valid for a specific round. The guest image embeds the quicknet public key. Its journal is exactly:

```text
round as little-endian u64 || SHA-256(drand signature)
```

The raffle covenant fixes a future round when ticket sales close, computes the expected journal digest, and verifies the receipt with Toccata `OpZkPrecompile`. A prover can submit the unique valid result or remain silent; it cannot choose another winner. Silence is handled by the existing timeout refund path.

Builds require the RISC Zero 3.0.5 toolchain on Linux. Generate a proof with:

```bash
cargo run --release -p kaspa-raffle-beacon-prover --features risc0-zkvm/prove -- \
  123 \
  b75c69d0b72a5d906e854e808ba7e2accb1542ac355ae486d591aa9d43765482e26cd02df835d3546d23c4b13e0dfc92 \
  proof.json
```

The proof provider does not hold a signing key and is not trusted by the contract.

The HTTP service proves at most one round at a time. Repeated requests for that round return `202`; a different round returns `429` until the worker is free. Public deployments should put the service behind HTTPS and apply request rate limits at the reverse proxy.
