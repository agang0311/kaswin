# Bounded Purchase Directory Spike — Architecture Preflight

**状态**: ISOLATED SPIKE ONLY / NOT PRODUCTION APPROVED  
**范围**: directory persistence, serialization, host recomputation, and VM/resource feasibility.  
**生产修改**: none.

| # | 答案 / 状态 |
|---|---|
| 1 | Identity: directory belongs to one Kaswin round, keyed by existing round_id/funding outpoint. PASS for spike. |
| 2 | Genesis: hypothetical directory is embedded in current round state script; production genesis is reopened. SPIKE ONLY. |
| 3 | Successor ID: hypothetical single Kaswin STATE lineage continues; directory bytes change. KIP-20 production binding not implemented here. SPIKE ONLY. |
| 4 | Current state: one state UTXO whose redeem script contains the bounded directory. PASS as candidate model. |
| 5 | Immutable: round_id, ticket_price, total_tickets, refund parameters, directory order/format. Mutable: sold_tickets, purchase_count, ticket_root, directory length/content. Production schema unresolved. |
| 6 | Mutable fields are measured as candidate state bytes only; no production encoding change. |
| 7 | Spike transitions: synthetic state scan/BUY-like spend, winner lookup scan, host refund planning. Full production transitions not implemented. |
| 8 | Trigger: synthetic permissionless VM input; authorization is not a production decision in this spike. |
| 9 | Topology: synthetic 1:1 state continuation; terminal paths are host-planned only. Production topology unresolved. |
| 10 | Authorized successor: synthetic output state SPK/amount fixture; not production successor validation. |
| 11 | Successor script: measured by P2SH script commitment; full canonical successor proof not implemented. |
| 12 | Successor covenant binding: not implemented in spike; production KIP-20 proof remains pending. |
| 13 | Successor state: directory serialization and host reconstruction are checked; full state transition is pending. |
| 14 | Invariants: record order, cumulative-end monotonicity, end <= MAX_TOTAL_TICKETS, P2PK shape, root recomputation. PASS for host spike. |
| 15 | Value conservation: synthetic transaction fixture only; new bounded refund fee semantics are not implemented here. |
| 16 | Contention: one singleton state UTXO; every BUY contends on it. PASS as identified risk. |
| 17 | Contention surface: one round's all buyers share one state spend. Directory does not reduce state contention. |
| 18 | Partitioning: intentionally not evaluated; this spike tests the requested single-UTXO candidate. |
| 19 | Termination: not implemented; winner/refund cleanup remains pending. |
| 20 | Funds exit: not implemented; this is a resource/data spike only. |
| 21 | Indexer: optional derived provider only; not used by host directory reconstruction. |
| 22 | Provider disappearance: directory candidate is self-contained for purchase data, subject to state UTXO discoverability. |
| 23 | Foreign template: not implemented; production must separately validate payout and ordinary outputs. |
| 24 | Multi-contract flow: not implemented; single STATE candidate only. |
| 25 | L1 Covenant suitability: feasibility is conditional on worst-state resource limits and complete successor/exit proofs; no production approval from this spike alone. |

**Anti-pattern review**: this spike explicitly does not approve a global cross-round state, does not treat covenant_id as business validation, does not use an indexer as authority, and does not claim termination or production security from synthetic VM scanning. Full 8-item anti-pattern review remains required before production coding.
