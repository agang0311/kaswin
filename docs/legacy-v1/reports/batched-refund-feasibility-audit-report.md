# Kaswin V1 Batched Sequential Refund + Prebroadcast Feasibility Audit (Historical SMT Design)

> **ARCHITECTURAL STATUS NOTICE (2026-09-07)**:
> - **CURRENT PRIMARY V1 CANDIDATE**: **BOUNDED PURCHASE DIRECTORY** in round state UTXO (36-byte records, deterministic sequential cursor progression).
> - **VALID FALLBACK ONLY**: Merkle Tree + Untrusted Providers.
> - **HISTORICAL / SUPERSEDED**: The SMT cursor refunding and `REFUND_CLAIMS` SMT delete models documented herein are retained strictly as isolated cryptographic reference points and historical evaluation records. They are **NOT** the current Kaswin V1 production refund architecture.
> - Any prior statement claiming "V1 adopts Merkle tree + untrusted providers" is **SUPERSEDED**.

---

**日期**: 2026-09-07 UTC  
**证据范围**: pinned `rusty-kaspa` `cfafeb4c093fa37a303f1b9f19c58f986b870ce3`；pinned KIPs `e4ae2332117b5cb68bd6188e065ef885b6d17939`。  
**状态**: 设计审计；未修改 `contracts/*.rs`，未广播 TN10，未合并分支。

## 1. 结论摘要

当前 `REFUND_CLAIMS` spike 只接受为 SMT delete primitive 的隔离证明，不是生产退款架构证据。

新的退款经济规则已取代旧的 exact-principal 规则：

```text
gross_principal_i = ticket_price * count_i
buyer_refund_i    = gross_principal_i - actual_refund_fee_i
0 <= actual_refund_fee_i <= MAX_REFUND_FEE
```

每笔退款交易/批次必须使 covenant 状态余额减少该批次全部 gross principal；每个 purchase 的 fee 只能从该 purchase 自己的退款额中扣除，不能从其他 purchase 或 creator state_deposit 扣除。终局必须完整返回 state_deposit。

`1 KAS = 100,000,000 sompi`。因此 `1,000,000 sompi = 0.01 KAS`；历史 spike 的 `50 * 1,000,000 = 50,000,000 sompi = 0.5 KAS` 算术本身正确。

**当前总判断**：Kaspa pinned mempool 支持“先提交依赖链、逐层变为 ready、可在浏览器关闭后继续”的 **eager prebroadcast + resumable** 模式，但不支持把它描述成永久持久化或自动完成保证。一个 parent/child 依赖层不能出现在同一个 block；因此单条 covenant 依赖链的确认推进上限是每个依赖层至少一个 block。批量 K 只能降低每个 refund record 的交易/状态转换数量，不能提高同一依赖链的单块层数吞吐。

**状态修正**：本报告不再使用“BATCHED REFUND BLOCKED”。批量退款当前状态曾为：

```text
BATCHED REFUND: UNVERIFIED / PROOF PENDING
```

purchase-data architecture gate 现已通过：V1 采用 Merkle tree + untrusted replicable data providers。该模型不要求 trusted indexer、单一 provider 或新的 rusty-kaspa RPC primitive。详见 `docs/merkle-untrusted-provider-architecture-report.md`。

## 2. Phase A：pinned mempool 审计

### 2.1 子交易能否在父交易确认前提交

可以，但分三种情况：

1. **父交易已在本节点普通 mempool**：子交易可提交并进入普通 transaction pool。`populate_mempool_entries` 从 mempool UTXO 视图填充 parent-created output；`TransactionsPool::add_mempool_transaction` 记录 parent set。证据：
   - `mining/src/mempool/populate_entries_and_try_validate.rs:26-41`
   - `mining/src/mempool/model/transactions_pool.rs:120-132`
2. **父交易既不在 consensus/DAG，也不在 mempool**：子交易只有在 RPC 请求允许 orphan 时才会进入 orphan pool；否则返回 `RejectDisallowedOrphan`。证据：
   - `mining/src/mempool/validate_and_insert_transaction.rs:57-70`
   - `rpc/service/src/service.rs:651-676`
3. **父交易已进入 consensus/DAG、但本节点尚未完成对应 mempool 事件处理**：可从 virtual UTXO view 填充并进入普通 mempool。证据：
   - `consensus/src/pipeline/virtual_processor/utxo_validation.rs:416-438`
   - `consensus/src/pipeline/virtual_processor/utxo_validation.rs:449-489`

生产客户端应按 parent-first 顺序提交；child-before-parent 不是不可行，但会依赖 orphan 设置、orphan 限制和 parent 到达后的 promotion。

### 2.2 parent_transactions、chained_transactions、ready_transactions

普通交易池 `TransactionsPool` 保存：

- `all_transactions`: 所有普通 mempool 交易，`transactions_pool.rs:56-60`。
- `parent_transactions`: `child_id -> parent_id set`，`transactions_pool.rs:62-64`。
- `chained_transactions`: `parent_id -> direct child_id set`，`transactions_pool.rs:65-66`。
- `ready_transactions`: 没有 mempool parent 的 frontier，`transactions_pool.rs:68-69`。
- mempool UTXO 及 outpoint ownership 索引，`transactions_pool.rs:76-80`。

插入时：

- 只有 `parents.is_empty()` 才插入 `ready_transactions`；否则只登记 parent/chained 关系，`transactions_pool.rs:120-135`。
- 删除 parent 时，会从 child 的 parent set 删除该 parent；若 child 不再有 mempool parent，就插入 ready frontier，`transactions_pool.rs:143-162`。
- 父交易被 consensus 接受后，`handle_new_block_transactions.rs:27-54` 调用 `get_unorphaned_transactions_after_accepted_transaction`；该函数在 `validate_and_insert_transaction.rs:168-220` 按输出逐层释放 orphan。

因此 child 会被保存在节点内，但在 parent 仍是 mempool ancestor 时不能进入 block template ready frontier。

### 2.3 ancestor/descendant 限制

在 pinned 源码中没有发现显式的“每条依赖链深度”或固定 ancestor/descendant 数量共识限制。存在的是资源和池策略边界：

- 普通 mempool 默认最多 `1,000,000` 笔交易，`mining/src/mempool/config.rs:6-8,111-113`。
- 普通 mempool 默认 estimated bytes 上限 `1,000,000,000`，同上。
- orphan 默认最多 `500` 笔、normalized mass `500,000`，`config.rs:17-18,125-126`。
- descendant 删除/遍历使用 BFS，且源码明确指出深链复杂度可能线性增长，`mempool/model/pool.rs:63-70`。
- mempool 满载时会按可驱逐低优先级交易及其 descendants 处理，`transactions_pool.rs:222-280`。

这不是“无限链”保证；它表示链深度主要受节点内存、mempool policy、feerate、eviction 和运维状态约束。

### 2.4 过期、驱逐、重启

RPC 提交交易使用 `Priority::High`；pinned mempool 文档明确说 high-priority 交易不会按普通 mempool 过期规则删除，并由节点周期性 rebroadcast：

- `mining/src/mempool/mod.rs:34-48`。
- RPC submission 到 flow 的路径：`rpc/service/src/service.rs:651-676`。

P2P 交易为 `Priority::Low`，默认约 24 小时未进 block 后过期：

- `mining/src/mempool/config.rs:10-15,114-124`。
- `mining/src/mempool/model/transactions_pool.rs:325-345`。

即使使用 RPC high priority，也不能得到“只广播一次、跨节点重启永久保存”的证明：mempool 结构是节点内存状态；删除、revalidation、RBF/双花竞争、mempool 满载、节点重启和 reorg 都可能改变其可用性。High priority 只解决 pinned 节点普通过期策略，不能替代链上持久化。

### 2.5 多个 parent->child 依赖层能否进同一 block

不能。pinned consensus 在 block body isolation 中先收集本 block 创建的所有 outpoint，再拒绝本 block 内任何 input 花费这些 outpoint：

- `consensus/src/pipeline/body_processor/body_validation_in_isolation.rs:20-26`
- `consensus/src/pipeline/body_processor/body_validation_in_isolation.rs:136-151`

同一规则是共识级 block rejection，不是矿工 template policy。因此 `tx0 -> tx1 -> tx2` 不能作为同一 block 内的连续链确认；至少需要不同 block 的依赖层。

pinned mempool 测试也验证 selector 只先提供无 parent 的 parent 交易，而不把 child 当作 ready：

- `mining/src/manager_tests.rs:1106-1134`。

### 2.6 confirmation throughput

在 TN10 10 BPS 目标下，单条依赖链的最优理论上界是约一层/区块，即约 10 个 batch layers/秒；这不是网络接受或最终确认保证。实际吞吐还受：

- 当前 parent 是否已经被接受；
- miner 是否选择 ready 交易；
- transaction relay 到足够矿工；
- block mass、lane/gas、fee-rate 和 reorg；
- 节点是否保留后继。

`ready_transactions` 是无 mempool ancestor 的 frontier；`SequenceSelector` 按候选顺序逐个尝试并执行 block mass/LPB/gas 约束：

- `mining/src/mempool/model/transactions_pool.rs:210-215`
- `mining/src/mempool/model/frontier/selectors.rs:115-180`

### 2.7 post-Toccata limits and fees

TN10 `TESTNET_PARAMS` 在 pinned `consensus/core/src/config/params.rs:727-764` 使用：

- per-dimension prior block limits：storage/compute/transient 各 `500,000`；
- post-Toccata transient limit：`1,000,000`；
- `max_tx_inputs = 1000`，`max_tx_outputs = 1000`；
- post-Toccata signature script length：`250,000`；
- `mass_per_tx_byte = 1`；`mass_per_script_pub_key_byte = 10`；`mass_per_sig_op = 1000`。

`BlockMassLimits` 与 normalization 定义在 `consensus/core/src/mass/mod.rs:197-258`：

```text
compute limit   = 500,000
transient limit = 1,000,000
storage limit   = 500,000
cofactor(transient) = 500,000 / 1,000,000 = 0.5
cofactor(storage)   = 500,000 / 500,000   = 1.0
reference mass     = 500,000 compute-scale units
```

post-Toccata mempool relay fee 使用：

```text
fee_mass = max(compute_mass, normalized_transient_mass)
minimum relay fee = 100,000 sompi/kg = 100 sompi/gram
storage mass 不额外计入最低 relay fee floor
```

证据：`mining/src/mempool/check_transaction_standard.rs:130-164`；常量在 `mining/src/mempool/config.rs:20-28`。

旧的 pre-Toccata `100,000` standard mass cap 不能用于当前结论。源码仍保留它作为激活过渡窗口兼容代码；post-Toccata block-fit limits 才是本审计的限制基础。

## 3. Phase B：batch K 评估状态

### 3.1 当前可确认的结构事实

`TREE_DEPTH=27` 是 purchase-range leaf 容量（最多 `2^27` 个 purchase leaves），不是单独 ticket 容量。一次 BUY 的 `count > 1` 仍然产生一个 range leaf。

当前 isolated spike 的函数签名和交易结构只支持一个 claim：

- `build_refund_claims_covenant` 没有 K 参数；
- body 只消费一个 `payout_spk/count/start_ticket/purchase_index` 与一组 27 sibling；
- 每次交易只有一个 buyer refund output；
- 文件中的三个 purchase 只是三个连续单 claim，不是 K=3 batch。

因此下面项目当前**没有测量证据**：

- K 个 purchase 的联合 witness bytes；
- K 个 refund output 的 output count/serialized size；
- K 次删除的同交易 script units；
- K 的 exact `ComputeBudget::checked_covering_script_units`；
- K 的 compute/transient/storage mass、relay fee 和 block fit；
- contiguous/multiproof 是否安全及其节省量。

### 3.2 仅作设计候选，不是已批准参数

候选 K 表：

| K | 当前状态 | 说明 |
|---:|---|---|
| 1 | 单 claim spike 可作基线 | 不是 batch architecture 验收；必须按新 fee semantics 重测 |
| 4 | 待 isolated batch prototype | 低风险首个 batch 候选 |
| 8 | 待 isolated batch prototype | 可能是浏览器 prebroadcast 与资源的折中 |
| 16 | 待 prototype | 需要真实 VM/mass 数据，不能外推 |
| 32 | 待 prototype | 需要验证 outputs、witness、script size 和 block fit |
| 64 | 待 prototype | 不能假设可行，尤其要检查 script/witness、compute 与 transient |

不能从 K=1 线性外推 K>1：固定 redeem body、重复 27 sibling、stack limits、输出脚本大小和动态 root reconstruction 都可能改变斜率甚至触发非线性阈值。

## 4. Phase C：zero-indexer recovery

### 4.1 状态是否足够决定下一批

如果生产 `REFUNDING` 状态固定保存 `next_purchase_index`/cursor、remaining root、purchase count 或终止信息，则它足以决定**顺序位置**和下一批的 index range。

但它不包含该批的完整 purchase record、payout SPK 或 27 sibling path。root 是 commitment，不是原文数据存储。因此 state 足以决定“要找谁”，不足以单独构造 witness。

### 4.2 fresh browser 需要的数据

fresh browser 至少需要：

- current REFUNDING UTXO 的完整 transaction/output state；
- cursor/next index 与 current root；
- 对应 purchase records：purchase index、start、count、committed payout SPK；
- current root 到这些 leaves 的 27-level sibling proofs；
- 确认这些 records 属于本轮并且未被更早 batch 消费；
- 已确认父 transaction id，才能确定当前 spend outpoint。

### 4.3 native TN10 RPC 是否足够

在“节点仍保留所需历史 block/transaction 数据，并允许客户端扫描历史”的条件下，pinned RPC 能提供构造所需原始交易材料：

- `get_block` 可选择包含 transactions 和 verbose data，`rpc/service/src/service.rs:492-500`；
- block transaction converter 可返回完整 `signature_script`，`rpc/service/src/converter/consensus.rs:383-392`；
- `get_virtual_chain_from_block` / v2 可从 chain path 获取 added blocks 与 acceptance data，`rpc/service/src/service.rs:724-774,1345-1375`；
- `get_mempool_entry` 只覆盖当前 mempool，不是历史存档，`rpc/service/src/service.rs:596-623`。

但是 RPC 没有一个共识级“按 Kaswin round_id 直接返回所有 purchase records + SMT proofs”的 native primitive。客户端必须从 CREATE/BUY 历史重建 purchase log 和 sparse tree，或依赖额外历史服务。节点 pruning/历史不可用、扫描范围过大、RPC 不返回完整历史或不同节点视图都会影响可操作性。

结论：native RPC 在有历史数据时**足以作为读取通道**，但不是独立的永久数据可用性保证；“无 indexer”不能等同于“无历史扫描/无 portable receipt”。

### 4.4 原始 BUY witness 能否作为 canonical data log

可以作为 canonical data source，前提是协议明确：

1. 每个 accepted BUY 的 witness/transaction 是 purchase record 的唯一原文来源；
2. record 由 transaction acceptance、输入 round lineage、purchase index 和 committed leaf 验证；
3. fresh client 能取得该 accepted transaction 的完整 signature script；
4. 运行时能重新计算 leaf/root/path，并处理 reorg 后的 accepted history。

这要求保留可读取的完整 BUY 历史。链上 root 本身不承诺原始 witness 永久可取。

### 4.5 最小 portable receipt 建议

在未证明 node-history 可用性前，最小可移植恢复材料应至少包含：

```text
round_id
current_refunding_outpoint
next_purchase_index / batch cursor
purchase records: (purchase_index, start_ticket, count, payout_spk)
27 sibling hashes per required sequential leaf, or a safely audited multiproof
current root and expected successor roots
parent/child txids for already-preconstructed chain suffix
```

它是可移植客户端恢复包，不是新的信任根；每个字段仍须由 covenant commitments 和 accepted transaction history 验证。若产品要求“所有浏览器都可关闭且永不保留 receipt”，则需要额外的链上数据可用性 primitive，目前 pinned sources 未提供该 Kaswin-specific primitive。

## 5. Phase D：prebroadcast chain

### 5.1 可由源代码支持的部分

`tx0 -> tx1 -> tx2` 的 child txid 在广播 tx0 前可以计算，前提是 tx1/tx2 的签名、witness、outputs 和 covenant validation 不依赖 parent 被接受后的动态 DAA/acceptance context。transaction id 是 transaction content 的确定函数；parent outpoint 只需使用预先已知 txid。

提交到同一个 RPC 节点时：

1. tx0 为 high-priority RPC transaction，进入 ready frontier；
2. tx1 若 tx0 已在 mempool，则进入普通 transaction pool，但因有 mempool parent 不进入 ready；
3. tx2 同理依赖 tx1；
4. tx0 从 mempool 被接受/移除后，tx1 parent set 清空并进入 ready；
5. tx1 被接受/移除后，tx2 进入 ready。

这些 promotion 关系由 `transactions_pool.rs:120-162` 和 accepted/unorphan flow `validate_and_insert_transaction.rs:168-220` 支持。

### 5.2 不能由源代码支持的部分

以下命题不能宣称为保证：

- 所有节点永久保存 tx1/tx2；
- 节点重启后自动恢复整个未确认链；
- P2P 转发的后继仍保持 high priority；
- 每个 ready batch 必然被矿工选择；
- 一次 RPC prebroadcast 后无需任何未来 retry/检查即可完成全链。

因此产品文案必须使用：

```text
eager prebroadcast + resumable
```

而不是“broadcast once and close forever guaranteed”。

### 5.3 同一 block 与重启/eviction/reorg

- 同一 block 放置 parent 与 child：共识 `check_no_chained_transactions` 拒绝。
- 未确认 chain 的 high-priority 版本：pinned 普通过期扫描不会删除；但节点重启、mempool eviction、revalidation、RBF/双花竞争和 parent invalidation 仍可能破坏链。
- parent confirmed 后：同一节点内的 child 会由 parent removal/accepted processing 进入 ready；这支持“原浏览器关闭后节点继续持有”的有限命题。
- reorg：已确认状态按共识回滚/重算；预构造后继必须重新检查 parent outpoint、current UTXO、lineage 和脚本上下文。该行为未被本项目 batch VM/mempool integration test 验证。

## 6. Phase E：A/B 比较

| 维度 | A. any-order delete-root | B. deterministic batched sequential |
|---|---|---|
| no-indexer | 需要按任意 claim 更新 root；恢复者仍要找 record/path | cursor 明确下一批；仍需历史 record/path |
| preconstruct future tx | arbitrary order 会改变后继 root，难预构造 | 顺序固定，child txid 可在前置 witness 固定时预构造 |
| proof update | 每次任意 leaf delete 都改变 root/path | 顺序批次也需每步 successor root；可设计成连续批次 |
| transaction count | 每个 purchase 一笔时 O(P) | O(ceil(P/K)) 状态转换，但每批 outputs/witness 增大 |
| fee burden | 每笔都有固定 transaction overhead | 固定 overhead 分摊到 K 个 purchase；每个 purchase fee 仍从自身 gross principal 扣除 |
| browser closure | 依赖每次新 claim；没有预构造 suffix | eager prebroadcast 更强；仍只有 resumable、非永久自动保证 |
| resumability | 需要发现任意剩余 leaves | cursor/next range 使恢复定位简单 |
| covenant complexity | 单 leaf body 较小，任意 order | batch stack/output/root/fee bookkeeping 更复杂 |
| mass/compute | 单 claim 资源较易测 | K 不能线性外推，必须真实 VM/mass 测量 |
| auditability | 任意顺序的历史解释更复杂 | 固定顺序、cursor 和批次边界更易审计 |
| data availability | 两者都不能从 root 恢复原文 | B 更适合固定顺序 receipt，但仍不能消除原文可用性问题 |

**判断**：B 在预构造、恢复定位、历史审计和 fee overhead 方面有明确结构优势；但这不是已完成的可行性证明。B 的决定性缺口是 batch witness/data availability 与真实 K 资源边界，而不是 pinned mempool 是否允许依赖交易。

## 7. 当前冻结/重新开放边界

保持冻结：

- randomness / PASS-A；
- first-crossing target semantics；
- `DELTA_DAA_V1 = 100`；
- winner rejection sampling；
- range-leaf hash formulas；
- KIP-20 primitives；
- state_deposit principle。

保持重新开放：

- refund architecture；
- refund fee semantics；
- OPEN/REFUNDING canonical bytes；
- CREATE final golden vector/covenant id。

未修改生产 contracts，未重新引入 FULL-SALE refund、reseal/reroll 或 creator-funded O(P) refund fee。

## 8. 最小必要下一步

新增一个完全隔离的 `refund_claims_batch_spike.rs`，只实现 Phase B/D 原型：固定顺序 K-batch、per-purchase fee bounded semantics、K=1/4/8/16/32/64 资源测量，以及同节点 3-layer prebroadcast/mempool promotion/restart-or-eviction 证据。不得修改 production `contracts/*.rs`。

## 9. 最终状态

**BATCHED REFUND BLOCKED / EXACT BLOCKER**

精确 blocker：当前没有经过 TxScriptEngine、官方 `ComputeBudget::checked_covering_script_units`、pinned post-Toccata mass 计算和 dependent-chain integration test 的批量实现，因此不能选择任何 K、不能证明完整 chain prebroadcast 的资源可行性，也不能把 B 生产化。

**唯一下一动作**：实现并运行隔离的 `refund_claims_batch_spike.rs`，完成 K=1/4/8/16/32/64 与 `tx0 -> tx1 -> tx2` 的 VM/mempool 证据。
