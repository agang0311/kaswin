# Kaswin V1 Purchase Data Availability Architecture Audit

**日期**: 2026-09-07 UTC  
**范围**: purchase-data persistence/discoverability；未实现退款或生产 covenant。  
**Pinned rusty-kaspa**: `cfafeb4c093fa37a303f1b9f19c58f986b870ce3`  
**Pinned KIPs**: `e4ae2332117b5cb68bd6188e065ef885b6d17939`

## 0. 状态与边界

本审计接受以下已确认事实：

- mempool 支持 parent/child 依赖链；child 有 mempool parent 时不在 `ready_transactions`；
- 同 block parent->child 被共识 `check_no_chained_transactions` 拒绝；
- eager prebroadcast 只能改善 liveness，不能承诺节点重启、eviction、reorg 后自动完成；
- 产品措辞为 `eager prebroadcast + resumable`；
- 普通 kaspad 节点会在 pruning 后删除旧 block body；archival 节点不代表普通节点行为；
- `ticket_root` 是 commitment，不能恢复 purchase record 或 Merkle siblings；
- Kaspa.stream / api.kaspa.org 只能作为可选、不可信历史数据源，不能成为唯一协议 liveness 依赖。

当前退款状态为：

```text
BATCHED REFUND: UNVERIFIED / PROOF PENDING
```

当前更深层的 V1 阻塞为：

```text
CURRENT MERKLE-ROOT-ONLY PURCHASE MODEL
+ ZERO REQUIRED INDEXER
= DATA AVAILABILITY BLOCKED
```

本报告不修改 `contracts/*.rs`，不广播 TN10，不改变 randomness、PASS-A、winner rejection sampling、range-leaf hash、KIP-20 或 state_deposit 原则。

## 1. 两个必须分离的要求

### A. Data persistence

在旧 BUY block body 被普通节点 pruning 后，构造退款、派奖或赢家证明所需的 purchase data 仍必须存在于某个可验证的持久载体中。

“历史上曾出现在交易 witness 中”不是 persistence；“某个第三方 archive 仍有副本”也不是协议级 persistence。

### B. Data discoverability

fresh browser 仅知道 round/current Kaswin state，连接普通 pruned TN10 node，并且没有浏览器缓存、Kaswin indexer 或 Kaspa.stream 时，必须能够定位并读取所需数据。

“数据存在于某些 UTXO”不等于 discoverable。必须同时有：

1. 可枚举的 discovery namespace；
2. native RPC 能在普通节点配置下查询该 namespace；
3. RPC 返回足以重建数据的 UTXO/SPK/metadata；
4. 不依赖一个永久运行的中心化服务。

## 2. Pinned native RPC 能力边界

### 2.1 按地址查询 UTXO 不是普通节点默认能力

pinned RPC API 明确说明 `get_utxos_by_addresses` 仅在节点以 `--utxoindex` 启动时可用：

- `rpc/core/src/api/rpc.rs:359-370`
- `rpc/service/src/service.rs:785-792`

没有 UTXO index 时，服务返回 `NoUtxoIndex`。因此它不能被描述为所有普通 TN10 节点都具备的无 indexer discovery primitive。

返回项包含：

- outpoint；
- amount；
- ScriptPublicKey；
- block DAA score；
- coinbase 标志；
- covenant id。

对应类型：

- `rpc/core/src/model/address.rs:7-21`
- `rpc/core/src/model/tx.rs:25-66`

### 2.2 没有通用按 outpoint 查询 current UTXO entry 的 native RPC

pinned RPC API 中没有 `get_utxo_by_outpoint(txid,index)` 形式的通用方法。存在的 `get_utxo_return_address` 是按 transaction id 和 accepting DAA 计算 return address 的专用方法，不是 current UTXO 内容读取接口：

- `rpc/core/src/api/rpc.rs:455-465`
- `rpc/core/src/model/message.rs:2792-2849`

因此，若 chunk head 只在 state 中保存一个 outpoint，fresh browser 不能仅凭该 outpoint 通过普通 native RPC 拉取 chunk UTXO 的 SPK/data。

### 2.3 `get_block` 不能解决 pruning 后的 persistence

`get_block` 可选择返回 transactions，并且 transaction input 可包含完整 `signature_script`：

- `rpc/service/src/service.rs:492-500`
- `rpc/service/src/converter/consensus.rs:383-392`

但这只适用于节点仍有该 block body。pruning 后不能把 `get_block` 当作历史数据保证。

### 2.4 `get_mempool_entry` 不是历史存储

`get_mempool_entry` 和 `get_mempool_entries` 只覆盖当前 mempool：

- `rpc/service/src/service.rs:596-623`

它不能恢复数周或数月前已确认且已被 pruning 的 BUY。

## 3. A：Merkle root + untrusted indexer

### 3.1 结构

```text
Kaswin state:
  ticket_root
  sold_tickets
  purchase_count

External historical provider:
  purchase_index
  start_ticket
  count
  payout_spk
  Merkle siblings
```

provider 可以是 Kaspa.stream、api.kaspa.org、archive node 或 Kaswin indexer，但不应成为 consensus judge。

### 3.2 Persistence

**FAIL（协议级）**。Merkle root 只保留 commitment；BUY witness 可能随普通节点 pruning 消失。只有至少一个外部历史 provider 继续保存完整 BUY data 时，实际操作才可能继续。

### 3.3 Discoverability

**REQUIRES OPTIONAL EXTERNAL DATA PROVIDER**。current state 没有 purchase data 或 provider locator。fresh browser 不能从 root 反推出 records/proofs。

### 3.4 Trust and verification

- Provider 不需要被信任为资金/赢家裁判：所有 records、payout SPK、siblings 都可由 ticket_root、range-leaf hash、SMT path 和 covenant rules 验证。
- Provider 仍必须可用；“不可信”不等于“无需服务”。
- 多 provider 可交叉比对，rate limit 可能使 O(P) 扫描不适合浏览器。
- 如果所有 provider 都消失，root 仍可验证为 commitment，但无法构造需要原文 witness 的 refund/finalize/payout transaction；资金路径会变成数据可用性阻塞。

### 3.5 结论

A 是一个可工作的 **INDEXER-AVAILABLE** 架构，不是 INDEXERLESS 架构。它可以作为可选加速路径，但不满足本次“至少一个外部 provider 都不能成为必需品”的产品要求。

## 4. B：Merkle root + on-chain chunked purchase-log UTXOs

### 4.1 目标结构

每个 chunk 保存固定数量 purchase-range records，例如 16/32/64：

```text
chunk:
  round_id
  chunk_index
  first_purchase_index
  record_count
  records[
    purchase_index
    start_ticket
    count
    payout_spk or sufficient canonical payout data
  ]
  prev_chunk reference / next reference
  authentication commitment
```

### 4.2 Persistence

如果 chunk data 直接编码在仍未花费的 UTXO ScriptPublicKey 中，数据可以留在当前 UTXO set，不依赖创建该 UTXO 的旧 block body。这一点在原则上满足 persistence。

但需要注意：

- 普通 UTXO entry 只返回 SPK、amount、covenant id 等字段；没有额外 arbitrary UTXO payload 字段。
- 因此 data 必须位于 SPK/script bytes，或位于由 SPK 明确承诺且另有可取得载体的数据；不能假设 UTXO 可以存一段 RPC 私有 metadata。
- 若使用非标准 version-0 SPK 承载 chunk bytes，mempool/relay/script-class standardness 及 `max_script_public_key_len` 必须重新审计；不能把“共识可能解析”当作“可 relay”。
- 若使用 P2SH covenant，P2SH hash 本身只承诺脚本，不让 fresh browser 从 hash 逆推出 chunk records。

### 4.3 Discoverability：chunk head/prev 链方案

**当前候选失败**：只在 current state 保存 head outpoint，然后沿 `prev_chunk` 回溯。

原因：pinned native RPC 没有通用 outpoint->current UTXO lookup。`get_utxos_by_addresses` 只能按地址查询，并且只在 `--utxoindex` 启用时可用。

**确定性 round-specific address 枚举也不能自动解决**：

- 如果每个 chunk 的 SPK/address 可由 `round_id + chunk_index` 确定，fresh browser 理论上可枚举 index；
- 但必须逐地址调用 `get_utxos_by_addresses` 或等价 UTXO index；
- 普通节点未启用 `--utxoindex` 时请求失败；
- 对 P=100,000，即使按 64 条/chunk，也需要枚举约 1,563 个候选 chunk namespace，不能把该行为称为 native 普通 RPC 的无条件能力；
- 如果地址不是标准可索引地址，则该 RPC 也不能发现它。

**把所有 chunk outpoints 放入 current state 也不可取**：这会把 discovery list 本身变成 O(P/K) 的可变 state；同时增加 state script、transition witness 和 successor 验证成本，并没有消除大状态问题。

### 4.4 Authentication

可行的 authentication 方向：

- round_id 与 chunk_index 固定绑定；
- chunk records 的 commitment 与 BUY ticket_root 绑定；
- chunk UTXO 的 lineage/covenant binding 防止任意用户伪造或替换 chunk；
- 每个 refund/finalize witness 重新验证 record 与 ticket_root/round state 的关系。

但 authentication 不能补足 discovery。一个不可发现的正确 UTXO 与一个错误 UTXO 对当前浏览器都一样不可用。

### 4.5 资源数量：只给出确定的记录数，不冒充 mass 测量

```text
chunk capacity 16: ceil(P / 16)
chunk capacity 32: ceil(P / 32)
chunk capacity 64: ceil(P / 64)
```

| P | 16 records/chunk | 32 records/chunk | 64 records/chunk |
|---:|---:|---:|---:|
| 100 | 7 | 4 | 2 |
| 1,000 | 63 | 32 | 16 |
| 10,000 | 625 | 313 | 157 |
| 100,000 | 6,250 | 3,125 | 1,563 |

当前没有合法 batch chunk prototype，因此以下数值必须标为 **未测量**：

- SPK/data wire size；
- storage mass；
- transient mass；
- BUY fee increase；
- chunk creation transaction mass；
- chunk update/cleanup mass；
- 16/32/64 是否满足 script/transaction/block limits。

不能用单 claim REFUND_CLAIMS 的 27 siblings 结果线性外推 chunk 资源。

### 4.6 Cleanup liability

成功 PAID 后，chunk UTXOs 若仍 live，就会成为永久 UTXO-set garbage，除非另有 cleanup path。cleanup 需要：

- 消费所有 chunk UTXOs；
- 同时验证 winner/finalize 不会跳过或伪造 purchase data；
- 允许 chunk cleanup 的 fee 来源和拓扑；
- 处理 cleanup 中断、reorg 与部分消费。

full unsold refund completion 也需要消费所有 chunks，或设计一种终局状态允许剩余 chunks 被安全忽略而不再承担 UTXO liability。当前没有证明这种 cleanup 不会形成 O(P) 额外责任。

因此 B 目前同时有两个未解决问题：

1. 普通 native RPC discovery 不成立；
2. chunk live-data cleanup 的最终拓扑和资源未证明。

## 5. C：per-purchase receipt UTXO

### 5.1 结构

每个 BUY 创建一个 authenticated receipt UTXO，承载：

```text
round_id
purchase_index
start_ticket
count
payout_spk
```

同时保留一个 mutable Kaswin STATE continuation。

### 5.2 Persistence

若 receipt data 直接存在 live receipt UTXO 的 SPK/script bytes 中，理论上可以绕过旧 BUY block-body pruning，满足 persistence。

但 receipt 不能依赖 P2SH hash 逆向恢复原文；也必须重新审计标准ness、SPK size、UTXO entry growth 和 covenant validation。

### 5.3 KIP-20/topology

一个 BUY 若同时创建：

- 一个继续演化的 Kaswin STATE UTXO；
- 一个 purchase receipt UTXO；

这是 1:N 或 1:2 输出拓扑，而不是简单 singleton 1:1。必须明确：

- receipt 是否有自己的 covenant family/ID；
- STATE 是否仍是唯一可变主状态；
- receipt 是否允许任何人消费；
- receipt 是否能被 winner/finalize 或 refund batch 消费；
- KIP-20 auth/cov grouping 是否允许该跨 family flow；
- ordinary receipt output 是否会被误当作 STATE successor。

KIP-20 可以表达不同 lineage，但“一个 STATE 继续存在”不等于 receipt 自动被认证。receipt 的 script/template、round identity、purchase index 和 relation 必须被主状态或 receipt 自身验证。

### 5.4 Discoverability

Per-purchase receipt 的优势是 data 可以在 live UTXO 中保留；但按地址发现仍受相同 native RPC 限制：

- 没有通用 outpoint lookup；
- `get_utxos_by_addresses` 只在 `--utxoindex` 开启时可用；
- 枚举 P 个确定性 receipt addresses 对 P=100,000 是 100,000 个查询/候选，不能称作普通节点无条件 discovery；
- 如果 current STATE 不存全部 receipt outpoints，fresh browser 无法定位 receipt；
- 如果 current STATE 存全部 outpoints，则回到 O(P) state replication。

因此 C 满足 persistence 的潜力高于 A，但在本产品要求的普通 native RPC discoverability 上仍失败。

### 5.5 Winner lookup and refund batching

- Winner lookup：若 receipt 可发现，可按 purchase_index 做确定性区间查找；但 winner_index 到 purchase record 的 mapping 仍要求发现 receipts。没有 discovery，仍无法 finalize。
- Refund batching：receipt records 天然按 purchase_index 可排序，适合 deterministic batches；不需要 arbitrary root mutation 的 batch proof。但每个 receipt 的消费和输出拓扑仍须新 covenant 设计。
- Receipt 结构可能降低单批 proof 更新复杂度，却把 data persistence 费用从历史 witness 转移到每个 BUY 的 storage mass 与 live UTXO growth。

### 5.6 Cleanup loser receipts

这是 C 的决定性经济问题：

- 成功 PAID 只需要 winner receipt；其余 P-1 receipts 必须被消费、聚合、过期销毁或被安全证明为不再需要；
- 若没有 permissionless cleanup，loser receipts 成为永久 UTXO garbage；
- 若允许任何人清理，必须防止清理者夺取 payout、伪造 winner relation 或消耗仍需的 receipt；
- 若由 finalize 一次性消费所有 receipts，最大输入数受 pinned `max_tx_inputs = 1000` 限制，且 P 大时 transaction/block mass 不可行；
- 分批 cleanup 会增加 O(P) 交易/依赖链，并重新引入 liveness/fee 问题。

C 因此不能仅以“数据在 UTXO”判定优于 B；其 loser cleanup liability 尚未解决。

## 6. D：full purchase list inside current state（baseline）

将完整 purchase list 放在可演化 STATE 的 script/state 中，可以解决 persistence 和直接 discoverability 的概念问题，但代价是：

- 每个 BUY 都要重建/复制 O(P) state 或 O(P) script；
- successor script/witness 迅速增长；
- storage/transient mass 和 relay fee 随 P 增长；
- script-size、signature-script、stack 和 compute budget 约束先于 `MAX_TOTAL_TICKETS=100M` 成为硬上限；
- current state 仍是所有用户的全局 contention point，违反优先 partition 的架构原则。

没有明确 `MAX_PURCHASE_COUNT`、费用模型和最坏资源证明前，不推荐 D，也不能把它当作无 indexer 解决方案。

## 7. Fresh-browser recovery test

场景：

```text
round 很久以前创建
早期 BUY block bodies 已 pruning
无浏览器缓存
无 Kaswin indexer
Kaspa.stream 不可用
只连接普通 pruned TN10 node
```

| 架构 | 1. OPEN 状态继续 BUY | 2. sold-out 找 winner purchase | 3. 构造 FINALIZE/payout | 4. 构造下一 refund batch | 5. 已有 batch 后 resume |
|---|---|---|---|---|---|
| A Merkle + indexer | **REQUIRES OPTIONAL EXTERNAL DATA PROVIDER**：继续 BUY 本身可能只需 current state，但发现历史 purchase_count/root 对账仍依赖历史数据 | **REQUIRES OPTIONAL EXTERNAL DATA PROVIDER** | **REQUIRES OPTIONAL EXTERNAL DATA PROVIDER** | **REQUIRES OPTIONAL EXTERNAL DATA PROVIDER** | **REQUIRES OPTIONAL EXTERNAL DATA PROVIDER** |
| B chunked log UTXO | **REQUIRES OPTIONAL EXTERNAL DATA PROVIDER**，除非 chunk discovery namespace 被 native RPC 实际支持 | **REQUIRES OPTIONAL EXTERNAL DATA PROVIDER** under ordinary node；live UTXO data may exist but is not locatable | 同左 | 同左 | 同左 |
| C receipt UTXO | **REQUIRES OPTIONAL EXTERNAL DATA PROVIDER** under ordinary node; current state may permit BUY validation but not full historical discovery | **REQUIRES OPTIONAL EXTERNAL DATA PROVIDER** | **REQUIRES OPTIONAL EXTERNAL DATA PROVIDER** | **REQUIRES OPTIONAL EXTERNAL DATA PROVIDER** | **REQUIRES OPTIONAL EXTERNAL DATA PROVIDER** |
| D full list in current state | **PASS in principle**, if bounded and actually fits all limits | **PASS in principle** | **PASS in principle** | **PASS in principle** | **PASS in principle** |

D 的 PASS 只是架构性质，不是可接受的 V1 资源结论；其 O(P) replication/contension 使它当前不合格。

## 8. A/B/C 比较

| 维度 | A Merkle + indexer | B chunked on-chain log | C receipt UTXO |
|---|---|---|---|
| persistence after pruning | FAIL without provider | Potentially PASS if live SPK data retained | Potentially PASS if live receipt retained |
| discoverability on ordinary native RPC | FAIL | FAIL without `--utxoindex`/new primitive | FAIL without `--utxoindex`/new primitive |
| external provider dependency | Required in failure case | Required for current discovery design | Required for current discovery design |
| authentication | Strong, root-verifiable | Can be strong with lineage + root binding | Can be strong with receipt lineage + root binding |
| data size | Lowest on-chain storage | O(ceil(P/K)) live UTXOs; records in SPKs | O(P) live UTXOs |
| BUY cost | Lowest | Increased by chunk creation/update or retained data | Increased on every BUY |
| winner lookup | Requires records/proofs | Requires chunk enumeration | Requires receipt enumeration |
| deterministic refund batches | Good once records available | Good if chunk order/index fixed | Good if receipt index fixed |
| paid cleanup | No on-chain data cleanup, provider retains history | Must consume/retire chunks or accept garbage | Must clean P-1 loser receipts |
| unsold cleanup | Refund proof availability blocker | Chunk cleanup blocker | Receipt cleanup blocker |
| no-indexer correctness | Consensus verifies data, but liveness unavailable | Consensus may verify data, discovery unavailable | Consensus may verify data, discovery unavailable |
| current status | INDEXER-AVAILABLE only | Unverified / discovery blocked | Unverified / discovery and cleanup blocked |

## 9. Architecture decision

None of A/B/C currently satisfies both requirements simultaneously under the exact fresh-browser scenario and ordinary pruned TN10 node:

- A fails persistence without an external provider;
- B can preserve data in live UTXOs, but pinned native RPC lacks universal outpoint lookup and address lookup requires `--utxoindex`; chunk cleanup is unproved;
- C can preserve data in live UTXOs, but has the same discovery limitation and an O(P) loser-receipt cleanup liability;
- D is only a bounded-P conceptual baseline and is not an acceptable V1 without explicit bounded economics.

The unresolved requirement is not SMT optimization. It is the existence of a **consensus-verifiable, persistently retained, and natively discoverable purchase-data primitive** that ordinary pruned nodes expose without an external indexer. Pinned rusty-kaspa does not provide that primitive.

## 10. Architecture preflight status

This audit keeps the covenant architecture gate **BLOCKED**. The 25 questions cannot all be PASS while purchase-data persistence/discoverability and terminal cleanup remain unresolved:

1. identity: Kaswin round identity is known; purchase-data carrier identity is unresolved.
2. genesis: STATE genesis is known historically; chunk/receipt genesis is not approved.
3. successor lineage: STATE lineage is known; auxiliary data lineage is unresolved.
4. current state: STATE UTXO is known; durable discoverable purchase data is unresolved.
5. immutable fields: round/purchase record fields are proposed, not approved.
6. mutable fields: cursor/root/balance candidates are proposed, not approved.
7. transitions: BUY, draw, finalize, refund and cleanup topology changes are unresolved.
8. trigger authorization: permissionless candidates exist; auxiliary carrier auth is unresolved.
9. topology: STATE 1:1 plus chunk/receipt 1:N is not yet proven under KIP-20 grouping.
10. authorized successors: auxiliary outputs and cleanup outputs are unresolved.
11. successor script: no production template approved.
12. successor binding: no chunk/receipt binding approved.
13. successor state: no durable discovery state approved.
14. invariants: state_deposit and frozen core rules remain fixed; purchase-data invariant unresolved.
15. conservation: new per-purchase refund fee rule is accepted in principle; batch implementation pending.
16. contention: STATE contention remains singleton; partition alternative unresolved.
17. contention surface: depends on selected data carrier and cleanup topology.
18. partitioning: chunk/receipt partitioning candidates exist but discovery/cleanup fail.
19. termination: PAID/UNSOLD termination carrier cleanup unresolved.
20. funds exit: payout/refund data availability unresolved.
21. indexer: optional discovery only; cannot be required under target product.
22. indexer disappearance: current A fails; B/C not discoverable with ordinary RPC.
23. foreign template: auxiliary carrier likely requires explicit foreign-template validation; unresolved.
24. multi-contract flow: likely for STATE plus data carriers; not approved.
25. L1 vs Based App: L1 state transitions remain plausible, but a missing durable/discoverable data layer blocks approval.

## 11. Final verdict

**PURCHASE DATA MODEL BLOCKED / EXACT BLOCKER**

Exact blocker:

```text
Pinned rusty-kaspa ordinary RPC has no universal outpoint -> current UTXO/data lookup.
get_utxos_by_addresses requires node-local --utxoindex and an enumerable address namespace.
Therefore live chunk/receipt UTXOs cannot be assumed discoverable by a fresh browser
on an ordinary pruned TN10 node after external historical providers disappear.
Merkle-root-only data is not persistent after pruning, while receipt/chunk cleanup and
resource bounds are not yet proven.
```

**唯一下一动作**：确定并原型验证一个新的 native discoverability/data-availability primitive（包括普通 pruned TN10 节点的 outpoint/round enumeration、persistence、authentication 与 PAID/UNSOLD cleanup），在该 primitive 通过前不进行 K=1/4/8/16/32/64 batch 优化。
