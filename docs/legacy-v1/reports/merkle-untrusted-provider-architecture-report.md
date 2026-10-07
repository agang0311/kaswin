# Kaswin V1 Merkle Tree + Untrusted Replicable Data Providers (Fallback Architecture)

> **ARCHITECTURAL STATUS NOTICE (2026-09-07)**:
> - **CURRENT PRIMARY V1 CANDIDATE**: **BOUNDED PURCHASE DIRECTORY** in round state UTXO (storing up to 256 36-byte records directly on-chain).
> - **ROLE OF THIS SPECIFICATION**: **VALID FALLBACK ONLY**. This architecture was evaluated when directory feasibility was uncertain; with bounded directory confirmed viable up to N=256, Merkle tree + untrusted providers is demoted to a fallback architecture.
> - Any statement claiming "V1 adopts Merkle tree + untrusted providers" is **SUPERSEDED**.

---

**日期**: 2026-09-07 UTC  
**状态**: Architecture decision gate  ��� **PROPOSED FREEZE**  
**Pinned rusty-kaspa**: `cfafeb4c093fa37a303f1b9f19c58f986b870ce3`  
**Pinned KIPs**: `e4ae2332117b5cb68bd6188e065ef885b6d17939`

## 1. Decision boundary

本报告接受 purchase-data availability audit 的结论，但不把新的 rusty-kaspa RPC primitive 作为 Kaswin V1 依赖。

产品要求修正为：

```text
NO TRUSTED INDEXER
NO SINGLE DATA-PROVIDER DEPENDENCY
```

含义：

- Kaspa native `--utxoindex` 是节点能力，不是 Kaswin application indexer；
- Kaswin provider 只提供 derived discovery/history data，不裁定共识事实；
- 多个 provider、mirror、archive 和本地 cache 可以互换；
- Kaspa.stream / api.kaspa.org 是可选 fallback，不是唯一依赖；
- 唯一权威仍是 Kaspa accepted UTXO、transaction、block/acceptance data 与 Kaswin covenant verification。

本报告不修改 production contracts，不生产化 `REFUND_CLAIMS`，不执行 K batch tuning，不广播 TN10，不改变 randomness/PASS-A、winner selection、range-leaf hash、KIP-20 或 state_deposit。

## 2. Frozen V1 purchase-data model

```text
PURCHASE DATA MODEL = MERKLE TREE + UNTRUSTED REPLICABLE DATA PROVIDERS
```

### 2.1 On-chain authoritative state

Kaswin singleton state UTXO authoritative fields：

```text
round_id
ticket_price
total_tickets
sold_tickets
purchase_count
ticket_root
financial/covenant state
```

State UTXO、其 current ScriptPublicKey、amount、covenant binding、lineage 和 accepted spend 是链上事实。

### 2.2 Provider-derived availability data

Provider 可返回：

```text
round metadata
purchase records in purchase_index order:
  purchase_index
  start_ticket
  count
  payout_spk
  BUY transaction reference
  accepting block reference
Merkle proof/frontier/nodes
current/final ticket_root observation
winner_index -> containing purchase candidate
refund batch ranges
```

Provider 数据不是新的 trust root。客户端必须对每个 snapshot/record/path 执行本地重建和验证，并要求：

```text
computed_ticket_root == on_chain_ticket_root
```

“provider 返回了某地址/某 winner/某 payout”本身永远不能授权资金流向。

## 3. Minimal provider interface

V1 provider 不需要实现通用 explorer、余额索引、排名、搜索或 consensus API。最小接口建议为：

```text
GET /v1/round/{round_id}/snapshot
GET /v1/round/{round_id}/state-candidate
GET /v1/round/{round_id}/purchase/{purchase_index}
GET /v1/round/{round_id}/winner/{winner_index}
GET /v1/round/{round_id}/refund-batch/{first}/{limit}
```

其中 snapshot 是主要接口，其他接口只是分块/按需读取优化。snapshot 应可通过静态 HTTP、文件下载、内容寻址对象存储或普通 mirror 复制。

### 3.1 Snapshot minimum contents

```text
schema_version
network_id / network suffix
round_id
funding_outpoint
state-candidate:
  state_outpoint
  state_output_index
  state_transaction_id
  state_script_public_key
  state_amount
  state_covenant_id
  observed acceptance/block reference
immutable round parameters
purchase_count
sold_tickets
purchase records ordered by purchase_index
record fields:
  purchase_index
  start_ticket
  count
  payout_spk
  BUY txid / output or accepted-block reference
optional Merkle frontier/nodes/proofs
optional observed current/final ticket_root
```

Provider 可以分片、压缩或增量发布 snapshot，但必须能产生一个可验证的完整 round snapshot。客户端不应要求数千个单 purchase API 请求才可恢复。

### 3.2 Client verification pipeline

客户端处理 provider 数据的固定顺序：

1. 验证 network、round_id、funding_outpoint 格式；
2. 从 native node 获取/确认当前 Kaswin state candidate；
3. 验证 state ScriptPublicKey、amount、covenant binding、lineage 与当前交易状态；
4. 检查 snapshot 的 immutable parameters 与 current state 一致；
5. 检查 purchase_index 严格连续且 `0 <= start_ticket`、`count > 0`；
6. 对每条 record 重算 canonical range leaf；
7. 从 records/frontier/proofs 重算 ticket_root；
8. 要求重算 root 等于链上 current `ticket_root`；
9. 仅在第 8 步通过后，把 payout、winner membership 或 refund batch 作为 transaction witness 候选；
10. 最终仍由 Kaspa consensus/covenant 执行 transaction。

缺失、重复、乱序、超范围、错误 SPK、错误 BUY reference 或 root mismatch 都是本地 availability/validation failure，不得降级为接受 provider 数据。

## 4. Provider dishonesty analysis

恶意 provider 可以：

- 返回空 snapshot；
- 延迟或遗漏 purchase；
- 返回错误 purchase_index/start/count/payout；
- 返回错误 sibling/frontier；
- 返回旧 state candidate；
- 返回互相矛盾的多个版本；
- 对同一请求实施 rate limit 或拒绝服务。

恶意 provider 不能仅凭返回数据：

- 改变 on-chain purchase_count；
- 改变 on-chain ticket_root；
- 改变 winner_index；
- 改变 payout_spk；
- 让错误 range leaf 通过 root verification；
- 让 refund 扣除错误 purchase；
- 让退款支付到未经 purchase commitment 验证的地址；
- 让 prize 支付给错误 purchase；
- double-spend 已消费状态；
- 增发或侵蚀 state_deposit；
- 伪造 current singleton lineage。

攻击结果最多是：

```text
availability failure / local verification failure / delayed recovery
```

这满足 provider 仅承担 availability，不承担 correctness。

## 5. Current-state discovery audit

### 5.1 Round URL/bookmark identifier

建议 round URL 至少包含：

```text
network suffix
funding_outpoint.txid
funding_outpoint.index
round_id
```

`round_id` 可由 funding outpoint 按固定 Kaswin domain 重新计算；它是 discovery key，不是“当前状态”的权威声明。

只含当前 state txid 不足以长期恢复，因为状态会随每次 BUY/refund/draw spend 而变化。只含 round_id 也不足以直接查询 Kaspa UTXO，因为 pinned native RPC 没有通用 outpoint lookup。

### 5.2 Provider state candidate

fresh browser 可以从任意 provider 获取：

```text
candidate current state outpoint
candidate state transaction/output
candidate state SPK and amount
candidate covenant id
candidate accepted/block reference
```

这些只是候选发现结果。客户端必须重新向 native node 验证 current UTXO 是否仍 live、SPK/amount/covenant 是否一致，以及该 state 是否属于 round lineage。

### 5.3 Native `--utxoindex` role

pinned RPC 的 `get_utxos_by_addresses`：

- 在 `rpc/core/src/api/rpc.rs:359-370` 声明；
- 明确要求节点以 `--utxoindex` 启动；
- service 在 `rpc/service/src/service.rs:785-792` 未启用时返回 `NoUtxoIndex`；
- 返回 outpoint、amount、SPK、block DAA、coinbase 标志和 covenant id，类型见 `rpc/core/src/model/address.rs:7-21` 与 `model/tx.rs:25-66`。

Kaswin V1 将 `--utxoindex` 视为**推荐的 native node capability**，不是 Kaswin indexer，也不是协议 authority。它用于把 provider 找到的 state SPK/address 解析为当前 live UTXO candidate。

如果用户连接的普通节点没有 `--utxoindex`，客户端不能假定能从 round_id 自动枚举 current state；应显示“当前状态不可由此节点确认”，再尝试另一个 native node/provider。不能把 provider candidate 当作已确认 state。

### 5.4 Current state bytes

provider 需要提供 state transaction/output bytes 或可重建的完整 state candidate，因为：

- current P2SH/SPK 可能随 mutable state 改变；
- provider 不应只返回一个人类可读状态标签；
- client 必须解析并核对 round_id、parameters、sold/purchase count、root、amount、covenant lineage；
- P2SH hash 不能反推出 redeem script；
- state bytes 可由 provider/archival source 提供，但其合法性由 current UTXO、SPK commitment、covenant rules 和 accepted chain 决定。

可重算部分：

- round_id from funding outpoint；
- canonical purchase leaf；
- SMT root/proofs；
- expected state SPK from known state schema；
- expected refund batch ranges；
- winner containing record after verified purchase list。

不可从 root 单独重算部分：

- purchase record 原文；
- payout_spk；
- start/count；
- Merkle sibling paths；
- current state outpoint。

## 6. Fresh-browser recovery result

场景：旧 BUY bodies 已被 pruning；无 browser cache；无 Kaswin indexer；Kaspa.stream 不可用；连接 ordinary pruned TN10 node。

### 6.1 Current state discovery

- 若 provider A/B/C 或本地 snapshot 可提供 candidate，且 native node 启用 `--utxoindex` 能确认 current UTXO：**PASS**。
- 若没有 provider/cache，且 node 没有 `--utxoindex`：**FAIL（discovery unavailable）**，不能信任 provider 以外的猜测。
- provider 找到 state 不会使 provider 成为 authority；native UTXO/covenant validation 仍是 authority。

### 6.2 Open round BUY

**REQUIRES PROVIDER / VERIFIED SNAPSHOT / LOCAL TREE STATE**。

当前 Merkle-root-only BUY transition 需要 27 个 sibling hashes 才能验证空 slot 并计算 append successor root。仅有 current state UTXO、ticket_root、sold_tickets 和 purchase_count，fresh browser 无法从 root 推导这些 siblings。

provider snapshot、verified local tree state 或本地缓存必须提供 purchase history/frontier/path material。provider 数据只能作为 witness candidate；客户端仍需本地重建并要求 computed root 等于链上 ticket_root。

### 6.3 Sold-out winner lookup and payout/finalize

**REQUIRES OPTIONAL EXTERNAL DATA PROVIDER**。

current root 不能恢复 winner 所在 range leaf。客户端需要 verified purchase snapshot/records/proofs；可以来自任一 provider、archive、mirror 或本地 export。数据经本地 root verification 后才能构造 payout transaction；provider 不能更改 payout。

如果所有 provider/cache 都消失，链上 state 仍正确，但 winner lookup witness 不可得，表现为 availability failure，不是 provider correctness failure。

### 6.4 Unsold refund batch and resume

**REQUIRES OPTIONAL EXTERNAL DATA PROVIDER**。

current REFUNDING state 可确定 deterministic cursor/next range（由未来生产设计冻结）；但不能从 root 恢复 records/proofs。fresh browser 需要 verified snapshot 或对应 batch records/proofs。

已确认 batch 的 current state 可由 native UTXO discovery 找到；后续 batch transaction 仍必须从 verified provider/cache/history 数据构造。provider 不同意时，客户端保留能通过 root verification 的 dataset，拒绝不一致版本。

## 7. Redundancy and disagreement policy

provider set：

1. Kaswin lightweight provider；
2. Kaspa.stream / api.kaspa.org（可用时）；
3. third-party/community mirrors；
4. local verified snapshot/receipt export。

不要求 provider 之间先达成一致。客户端规则：

- 任一 provider 可作为候选来源；
- 完整 snapshot 在本地验证；
- 多份 snapshot 可交叉比对；
- root mismatch、state mismatch、record gap、invalid proof 直接拒绝；
- provider disagreement 不进入协议决策；
- 成功验证的 snapshot 可静态缓存和镜像；
- provider 不需要在线参与每次 transaction confirmation。

Kaspa.stream 的 rate limits 只影响该 provider 的可用性，不影响协议正确性；必须保留其他 provider、archive 和 portable snapshot fallback。

## 8. Rebuildability

Kaswin provider 是 append-only derived view，可从 archival/history data 重建：

1. 从 funding outpoint/round_id 定位 round；
2. 读取 accepted virtual-chain/block acceptance data；
3. 读取 BUY transactions 的完整 inputs/signature scripts/outputs；
4. 验证 each BUY against prior Kaswin state and lineage；
5. 重算 purchase range records；
6. 重算 ticket_root at every accepted state；
7. 保存 accepting block/transaction references；
8. 导出 snapshot/chunks/frontier。

因此 provider 丢失不会改变 consensus state；新 provider 可以从 archival/history source 重建同一 derived dataset。若所有历史数据源都消失，则无法恢复原文 witness，这是已明确接受的 availability risk，而不是允许 provider 裁决资金的理由。

## 9. Replication and operational simplicity

该 provider 不需要：

- 私钥；
- keeper authority；
- transaction signing；
- consensus fork choice；
- winner selection authority；
- custom Kaspa node RPC；
- mutable central database schema；
- per-request consensus decision。

实现只需：

- chain/history reader；
- Kaswin transaction parser；
- range-leaf/SMT verifier；
- snapshot builder；
- static manifest/file/HTTP publisher。

不同实现可以独立从相同 accepted chain data 生成 snapshot。客户端只接受通过 on-chain root 和 current state verification 的结果。

## 10. Architecture gate

| Gate | Result | Reason |
|---|---|---|
| Provider dataset locally verifiable | **PASS** | records/proofs rebuild root and compare with on-chain ticket_root |
| Provider cannot redirect funds | **PASS** | provider output is never authorization; covenant/native state validates destination and amount |
| Current state remains chain-authoritative | **PASS** | provider supplies candidate only; native UTXO/SPK/amount/covenant and lineage are rechecked |
| Kaspa.stream optional | **PASS** | fallback member only; disagreement/rate-limit is survivable with other providers/cache |
| Provider rebuildable | **PASS** | append-only derived view rebuildable from archival/history data |
| Snapshot replicable | **PASS** | static complete snapshot/manifest can be mirrored and locally cached |
| Multiple implementations feasible | **PASS** | no signing authority or custom node primitive; parser + verifier + publisher suffice |
| No trusted indexer / no single provider | **PASS with explicit availability condition** | at least one provider/cache/history source is required to obtain witness data; none is trusted for correctness |

## 11. Residual accepted limitation

“无 trusted indexer”不等于“无 availability dependency”。V1 明确接受：

```text
正确性不依赖任何 provider；
构造需要历史原文的交易，需要至少一个可用 provider、archive 或 verified local snapshot。
```

如果所有 provider、archive、mirror 和 local snapshot 都消失：

- current on-chain state 仍是唯一真相；
- provider 不能伪造赢家或退款；
- 但客户端可能无法得到 purchase witness，因而无法主动构造 payout/refund transaction；
- 这是 data availability failure，不能宣传为无条件可操作。

## 12. Final architecture verdict

**PURCHASE DATA MODEL = MERKLE TREE + UNTRUSTED REPLICABLE DATA PROVIDERS**

**唯一下一动作**：实现隔离的 batched refund VM/resource spike，使用已冻结的 Merkle purchase model 和新的 bounded per-purchase fee semantics；不得修改 production contracts、广播 TN10、合并分支或改变 randomness。
