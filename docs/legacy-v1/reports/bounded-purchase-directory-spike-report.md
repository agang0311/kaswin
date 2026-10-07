# Bounded Purchase Directory Spike Report

**Status**: isolated host/resource spike; not production code, not canonical encoding, not a covenant security proof.  
**Production contracts modified**: no.  
**Candidate MAX_TOTAL_TICKETS**: 1,000,000 (not frozen).  
**Candidate records**: u32 cumulative_end + 32-byte x-only P2PK = 36 bytes; comparison u64 variant = 40 bytes.

## Results

The executable is:

```text
tests/rust-vm-validation/src/bin/bounded_purchase_directory_spike.rs
```

It constructs worst-case directories at `purchase_count = MAX_PURCHASE_COUNT`, validates monotonic cumulative ends and P2PK shape, serializes/deserializes both variants, recomputes the existing frozen range-leaf Merkle root, performs first/middle/last winner directory lookups, constructs candidate state bytes and candidate synthetic transaction fixtures, and measures pinned `MassCalculator` output.

The VM number below is deliberately labelled **synthetic VM**: it executes a trivial covenant-enabled script with the directory supplied as a witness element. It does not scan/validate the directory in production bytecode and must not be read as a production covenant benchmark. The synthetic script consumed 37 SU / `ComputeBudget(0)` for every size; this demonstrates only the harness path, not directory validation cost.

| max purchases | encoding | directory | candidate state payload | candidate redeem | sigscript | tx est. | compute | transient | normalized transient | storage | relay floor |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 64 | u32 | 2,304 B | 2,400 B | 2,398 B | 2,435 B | 2,743 B | 3,583 | 10,972 | 5,486 | 990,100 | 548,600 |
| 64 | u64 | 2,560 B | 2,656 B | 2,654 B | 2,691 B | 2,999 B | 3,839 | 11,996 | 5,998 | 990,100 | 599,800 |
| 128 | u32 | 4,608 B | 4,704 B | 4,702 B | 4,739 B | 5,047 B | 5,887 | 20,188 | 10,094 | 990,100 | 1,009,400 |
| 128 | u64 | 5,120 B | 5,216 B | 5,214 B | 5,251 B | 5,559 B | 6,399 | 22,236 | 11,118 | 990,100 | 1,111,800 |
| 256 | u32 | 9,216 B | 9,312 B | 9,310 B | 9,347 B | 9,655 B | 10,495 | 38,620 | 19,310 | 990,100 | 1,931,000 |
| 256 | u64 | 10,240 B | 10,336 B | 10,334 B | 10,371 B | 10,679 B | 11,519 | 42,716 | 21,358 | 990,100 | 2,135,800 |
| 512 | u32 | 18,432 B | 18,528 B | 18,526 B | 18,563 B | 18,871 B | 19,711 | 75,484 | 37,742 | 990,100 | 3,774,200 |
| 512 | u64 | 20,480 B | 20,576 B | 20,574 B | 20,611 B | 20,919 B | 21,759 | 83,676 | 41,838 | 990,100 | 4,183,800 |
| 1024 | u32 | 36,864 B | 36,960 B | 36,958 B | 36,995 B | 37,303 B | 38,143 | 149,212 | 74,606 | 990,100 | 7,460,600 |
| 1024 | u64 | 40,960 B | 41,056 B | 41,054 B | 41,091 B | 41,399 B | 42,239 | 165,596 | 82,798 | 990,100 | 8,279,800 |
| 2048 | u32 | 73,728 B | 73,824 B | 73,824 B | 73,863 B | 74,171 B | 75,011 | 296,684 | 148,342 | 990,100 | 14,834,200 |
| 2048 | u64 | 81,920 B | 82,016 B | 82,016 B | 82,055 B | 82,363 B | 83,203 | 329,452 | 164,726 | 990,100 | 16,472,600 |

Relay floor uses pinned post-Toccata `100,000 sompi/kg` and `max(compute_mass, normalized_transient_mass)`. Storage mass is reported separately and is not included in that relay floor.

Synthetic host operations passed for every candidate and encoding:

- deserialize(serialized directory) byte/record round-trip;
- cumulative-end monotonicity and final end exactly 1,000,000;
- canonical P2PK reconstruction shape;
- full directory range-leaf root recomputation;
- winner lookup for first, middle and last ticket (`[0, middle, last]` record positions);
- candidate state/redeem construction.

Observed host timing was small and remained approximately linear in P: directory construction/redeem generation was about 8–9 ms at 64 and about 174–179 ms at 2048 on this machine; Merkle root generation is O(P·27). Synthetic VM harness time was about 0.10–0.14 ms at 64 and 1.89–2.09 ms at 2048, but is not a production scan measurement.

## Interpretation

The candidate is not comfortably feasible at 2048. Even before adding real directory validation, u32 reaches approximately 74 KB of candidate state/redeem bytes, approximately 297 KB transient mass, approximately 148 KB normalized transient mass, and a 14.8M sompi relay floor. u64 is larger. The candidate state transaction fixture also reports storage mass 990,100, exceeding the 500,000 TN10 storage block dimension; this must be treated as a hard warning requiring a correctly modelled production state amount/script before any approval.

The 36-byte/u32 form is strictly better than the 40-byte/u64 form for this candidate. u32 can represent the candidate 1,000,000-ticket bound with no arithmetic ambiguity, but future expansion beyond `u32::MAX` would require an explicit protocol encoding change; this spike does not freeze that choice.

This spike does not establish that a bounded directory can replace the Merkle provider architecture. It only establishes host reconstruction and preliminary resource slopes. A real directory covenant must still prove successor reconstruction, immutable directory preservation, append-only semantics, winner scan/proof behavior, bounded per-purchase fees, KIP-20 bindings, and terminal payout/refund paths.
