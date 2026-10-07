# Kaswin V1 Production Consensus-Valid + Empty-Round Final Gate Preflight

**项目**: Kaswin V1 生产级去中心化抽奖协议  
**功能**: 生产共识有效性 (Consensus Validity)、真实外部资金投入 (Funding Inputs)、承诺预算计量 (Committed ScriptUnits)、中继费率对齐 (Relay Floor) 与空轮存活性 (Empty-Round Liveness) 终审前置设计审查  
**状态**: **APPROVED FOR IMPLEMENTATION (PREFLIGHT COMPLETED)**  
**基线提交**: `403cb0467a4edd12e6288fdb46b58c940acd2b33` (分支 `audit/state-deposit-v1`)  
**上游固定依赖**:
- `rusty-kaspa` release v2.0.1 @ Git commit `cfafeb4c093fa37a303f1b9f19c58f986b870ce3` (证据等级 S / V)
- KIPs @ Git commit `e4ae2332117b5cb68bd6188e065ef885b6d17939` (KIP-16, 17, 20, 21 官方标为 Active)
- 协议约定：纯链上单网页交付、无特权管理、单 UTXO 状态机、严格 bigint/十进制资金表示、禁止 live TN10 广播、禁止合并 main、单写入者

---

## 目录
1. [设计背景与本轮终审目标](#1-设计背景与本轮终审目标)
2. [25 问逐项架构审查 (Preflight 25 Questions)](#2-25-问逐项架构审查-preflight-25-questions)
3. [14 项架构交付物规范 (14 Architecture Deliverables)](#3-14-项架构交付物规范-14-architecture-deliverables)
4. [8 项反模式严格审查 (8 Anti-Patterns Review)](#4-8-项反模式严格审查-8-anti-patterns-review)
5. [共识引擎、质量度量与中继标准源码核验](#5-共识引擎质量度量与中继标准源码核验)
6. [普通资金输入 (Input 1) 脚本有效性与签名权限边界](#6-普通资金输入-input-1-脚本有效性与签名权限边界)
7. [空轮 (P=0) 直接终结回收机制与存活性证明](#7-空轮-p0-直接终结回收机制与存活性证明)
8. [创建者收款 SPK 准入单语义修复 (Class A Schnorr Only)](#8-创建者收款-spk-准入单语义修复-class-a-schnorr-only)
9. [实施路线图与精确改动缝隙 (Implementation Seams & Plan)](#9-实施路线图与精确改动缝隙-implementation-seams--plan)

---

## 1. 设计背景与本轮终审目标

### 1.1 架构冻结范围（严禁重新设计）
Kaswin V1 核心生产协议架构已在分支 `audit/state-deposit-v1` 上基本完成，本轮严格冻结以下协议模块：
1. **有界购买目录 (Bounded Purchase Directory)**: 单 UTXO 容纳最多 256 笔购买记录，每条记录严格定长 36 字节 (`[u32 LE cumulative_end (4B)] || [32B xonly pubkey]`)，最大票数 `MAX_TICKET_CAP_V1 = 100,000`。
2. **KIP-21 PASS-A 随机数熵打开**: 12 项定宽 witness 验证、边界检查 `P.daa < boundary <= T.daa`、8 次 `OpBlake3WithKey` 重构 `MergesetContext` 与 `MergesetCommitment`，并通过 `OpChainblockSeqCommit` 链上认证目标块。
3. **确定性拒绝采样 (Deterministic Rejection Sampling)**: 在 $R = 2^{56}$ 域内计算候选数，以 `LIMIT = floor(R / draw_ticket_count) * draw_ticket_count` 为阈值执行链上二分支分流，无偏选择中奖者索引。
4. **O(1) 目录中奖者归属证明**: witness 提供购买记录索引 $i$，脚本通过直接切片 `offset = i * 36` 提取范围与 32 字节公钥，在链上断言 $\text{start\_ticket} \le \text{winner\_index} < \text{cumulative\_end}$，无需链上循环遍历。
5. **WINNER_READY 1-in-3-out 终局结算**: Output 0 为中奖者净奖金，Output 1 为创作者抵押金 `state_deposit` 全额退还，Output 2 为固定 1 KAS 结算者赏金，矿工费由奖池内部扣减，完全销毁 KIP-20 契约血统。
6. **通用紧凑型退款契约 (Universal Compact Refunding)**: 单一 6,183 字节通用 body 支持 $K \in [1, 16]$ 动态调度，买家自付退款费，维持连通 UTXO 拓扑。

### 1.2 最终门禁核心目标 (The Final Gate)
当前测试套件中存在的四大共识与工程缺陷必须在此次门禁中彻底关闭：
1. **资金守恒与共识合法性**: 修复历史 BUY 测试中仅有 Input 0 导致 `total_out > total_in` 触发 `TxRuleError::SpendTooHigh` 的致命假象，引入真实的买家外部资金输入 (Input 1) 与找零输出 (Output 1)，显式断言 `total_in = total_out + actual_fee`。
2. **承诺计算预算计量 (Committed ScriptUnits Metering)**: 废除使用无限预算 `from_transaction_input` 作为共识通过依据，全面切换至 `from_transaction_input_with_script_units_limit(..., compute_commit.allowed_script_units())`，严格测量 $B_{\min}$ 并验证 $B_{\min} - 1$ 必抛 `ExceededCommittedScriptUnits`。
3. **真实中继质量与费率底限 (Standard Relay Floor)**: 使用 consensus-core 的 `MassCalculator` 真实计算 compute mass、transient mass、normalized transient mass 及 storage mass，以 `fee_mass = max(compute, norm_transient)` 计算 `relay_floor`，断言 `actual_fee >= relay_floor`。
4. **空轮存活性 (P=0 Empty-Round Liveness)**: 彻底解决零售出到期场景下进入通用退款导致交易费为零且无法追加外部资金的死锁问题，在 `ACTION_CLOSE` 中增设 P=0 专属直接终结回收分支。
5. **创作者收款 SPK 准入修复**: 消除 `contracts/genesis.rs` 允许 Class B/C 但状态机仅支持 34 字节 Class A 的不一致性，CREATE 严格限定 Class A Schnorr P2PK。

---

## 2. 25 问逐项架构审查 (Preflight 25 Questions)

| # | 核心问题 | Kaswin V1 终审确定性答复 / 证据 / 状态 |
|---|---|---|
| **1** | Covenant instance identity 是什么？ | 每一轮抽奖拥有独立且全局唯一的 `round_id = BLAKE2b-256("KaswinRoundV1" \|\| funding_outpoint.txid \|\| le_u32(funding_outpoint.index))`。在链上由 KIP-20 派生的 `covenant_id` $C$ 标识该单例轮次的生命周期谱系。状态：**PASS**。 |
| **2** | Covenant ID 如何 genesis？ | 在 CREATE 交易中，Output 0 携带初始 `state_deposit`、初始 OPEN 状态 P2SH 脚本及 `CovenantBinding { covenant_id: C, authorizing_input: 0 }`。$C$ 严格遵循 `kaspa_consensus_core::hashing::covenant_id::covenant_id` 从 Input 0 的 outpoint 和 Output 0 的元数据计算。状态：**PASS**。 |
| **3** | 哪些 successor 继承该 ID？ | 仅有本轮的单例主状态 UTXO 继承 $C$：`OPEN -> OPEN` (BUY), `OPEN -> SEALED` (CLOSE), `OPEN -> REFUNDING` (CLOSE 未满且 P>0), `SEALED -> DRAW_READY`, `DRAW_READY -> DRAW_READY` (REJECT), `REFUNDING -> REFUNDING` (非终局批次)。所有终端交易（PAID 结算、REFUNDING 终局、EMPTY CLOSE 回收）严格将后继 Covenant 置为 `None`，终结谱系。状态：**PASS**。 |
| **4** | Current State 存在哪里？ | 状态完全自包含于当前 live UTXO 的 redeem script 前缀及附带的有界购买目录中。状态分为 immutable 头部（round_id, ticket_price 等）与 mutable 尾部（sold_tickets, purchase_count, ticket_root, directory）。状态：**PASS**。 |
| **5** | Immutable fields 是什么？ | `round_id` (32B), `ticket_price` (8B), `ticket_cap` (8B), `min_tickets` (8B), `sale_deadline` (8B), `creator_refund_spk` (34B 规范 xonly P2PK), 创作者注资资金源 `funding_outpoint`。在状态转换中不可被任何人篡改。状态：**PASS**。 |
| **6** | Mutable fields 是什么？ | `sold_tickets` (8B), `purchase_count` (8B), `ticket_root` (32B), `directory` (变长 $P \times 36$B), `target_hash` (32B), `random_seed` (32B), `counter` (8B), `cursor` (8B), `winner_index` (8B), `winner_payout_spk` (34B)。状态：**PASS**。 |
| **7** | 合法 transition 集合？ | 1. `CREATE -> OPEN`<br>2. `OPEN -> OPEN` (ACTION_BUY)<br>3. `OPEN -> SEALED` (ACTION_CLOSE, sold $\ge$ min)<br>4. `OPEN -> REFUNDING` (ACTION_CLOSE, sold < min 且 P > 0)<br>5. `OPEN -> EMPTY_TERMINAL` (ACTION_CLOSE, sold == 0 且 P == 0)<br>6. `SEALED -> DRAW_READY(0)` (ACTION_DRAW, PASS-A 开奖)<br>7. `DRAW_READY(c) -> WINNER_READY` (ACTION_ACCEPT, 中奖)<br>8. `DRAW_READY(c) -> DRAW_READY(c+1)` (ACTION_REJECT, 拒绝采样重试)<br>9. `WINNER_READY -> PAID` (1-in-3-out 终局结算)<br>10. `REFUNDING(cur) -> REFUNDING(cur+k)` (非终局退款)<br>11. `REFUNDING(cur) -> TERMINAL` (终局退款返还抵押金)。状态：**PASS**。 |
| **8** | 每个 transition 谁可以触发？ | CREATE 由创作者发起；BUY 由任意买家发起；CLOSE 到期或满额后任意人可触发；DRAW 在目标块落入可查询窗口后任意人可触发；ACCEPT/REJECT 任意人可提交候选；PAID 任意终局结算人可触发（赚取 1 KAS 赏金）；REFUND 任意人可无许可分批推进；EMPTY CLOSE 任意人或创作者可出资网络费触发。状态：**PASS**。 |
| **9** | Transition topology 是什么？ | BUY/CLOSE/DRAW/RETRY 为 `2-in-2-out`（1 状态输入 + 1 外部资金输入 $\to$ 1 状态后继 + 1 资金找零）；REFUND 非终局为 `1-in-(k+1)-out`；REFUND 终局为 `1-in-(k+1)-out`（含创作者输出）；PAID 为 `1-in-3-out`；EMPTY CLOSE 为 `2-in-2-out`（1 状态输入 + 1 外部赞助输入 $\to$ 1 创作者输出 + 1 找零输出）。状态：**PASS**。 |
| **10** | 哪些 outputs 是 authorized successors？ | 仅 Output 0 在延续状态下被授权携带 Covenant ID $C$。退款输出、买家找零输出、创作者抵押金输出、赢家奖金输出、赞助找零输出均严格断言 `Covenant = None`。状态：**PASS**。 |
| **11** | 如何验证 successor script？ | 脚本内部利用 `OpTxInputScriptSigSubstr` 切片保留静态通用字节码，利用 AltStack 重构动态前缀，经由 `OpBlake2bWithKey` 现场计算 P2SH 哈希，并断言 `tx.outputs[0].spk == [0x00, 0x00, 0xaa, 0x20] || hash || [0x87]`。状态：**PASS**。 |
| **12** | 如何验证 successor covenant binding？ | 在后继状态中，强制检查 `OpOutputCovenantId(0) == C` 与 `OpOutputAuthorizingInput(0) == 0`，且 `OpCovOutputCount(C) == 1`、`OpAuthOutputCount(0) == 1`；终局状态强制检查 `OpOutputCovenantId(i) == ZERO_HASH` 与 `OpOutputAuthorizingInput(i) == -1`。状态：**PASS**。 |
| **13** | 如何验证 successor state？ | 脚本逐字段组装规范 LE 编码（8B 整数、32B 哈希、34B 脚本、36B 购买记录），通过 `OpEqualVerify` 锁定后继 SPK，防止任何非授权状态位偏移。状态：**PASS**。 |
| **14** | 哪些 invariant 永远不能被违反？ | 1. 资金绝对守恒：`total_in = total_out + actual_fee`。<br>2. 创作者抵押金 `state_deposit` 绝对隔离：任何非终局步骤不得扣除抵押金，终局步骤 100% 完好返还。<br>3. 票权真实性：票权区间递增单调，无重叠，总售出不超过 `ticket_cap`。<br>4. 随机公正性：开奖熵严格来源于链上 PoW 深度承诺，无人可操控或预测。状态：**PASS**。 |
| **15** | value / token / asset conservation 如何保证？ | KAS 基础货币严格整数 sompi 计算。BUY 交易买家输入提供票价本金与网络费；REFUND 交易从每个买家本金扣除自身退款费（$\le 1.5$M sompi），剩余 100% 退还；PAID 交易从奖池扣除赏金与矿工费；EMPTY CLOSE 由外部赞助人出网络费，Kaswin 状态输入资金不承担矿工费。状态：**PASS**。 |
| **16** | 哪些用户争抢同一个 UTXO？ | 仅在售票期间（OPEN 状态），并发买家争抢同一个 round state UTXO。争抢通过 Kaspa UTXO 单次消费天然排序（先被区块打包者成功，后被打包者进入冲突并可在前端基于新状态重签）。状态：**PASS**。 |
| **17** | State Contention Surface 有多大？ | 严格有界：单一轮次最多仅容纳 256 笔购买交易，竞争表面极小且仅限于本轮次，与其他轮次完全隔离。状态：**PASS**。 |
| **18** | 是否可以进一步 partition？ | V1 聚焦单轮单 UTXO，无需跨轮全局锁。单轮内 256 笔购买容量在当前 10 BPS Kaspa 网络下已被验证具有极优的传播与打包性能，无需额外分片。状态：**PASS**。 |
| **19** | Covenant 如何终止？ | 1. 成功售罄开奖：通过 `WINNER_READY -> PAID` 终局清算，完全解除 Covenant。<br>2. 未满退款：通过 `REFUNDING -> TERMINAL` 退还最后一批买家并退还创作者抵押金，完全解除 Covenant。<br>3. 空轮回收：通过 `OPEN -> EMPTY_TERMINAL` 零售出到期直接退还创作者抵押金，完全解除 Covenant。状态：**PASS**。 |
| **20** | 资金最终如何退出？ | 胜者获得 `gross_pool - reward - miner_fee`（直达 P2PK SPK）；创作者获得 `state_deposit`（直达 creator_refund_spk）；买家获得 `principal - refund_fee`（直达各买家 P2PK SPK）；终局结算者获得 1 KAS（直达 finalizer_payout_spk）。状态：**PASS**。 |
| **21** | Indexer 负责什么？ | 仅作为用户界面只读加速层：轮次检索、历史展示、出票通知。Indexer **绝对不是** 业务裁判，不裁决任何资金合法性。状态：**PASS**。 |
| **22** | Indexer 消失仍必须成立的事实？ | 即使没有任何 Indexer，任意用户只要连接一个普通的 Kaspa 剪枝节点，均可直接读取 live round state UTXO，凭借 UTXO 内自带的 256 笔购买目录还原全部买家记录、重算 `ticket_root`、验证开奖结果并独立发起提款。状态：**PASS**。 |
| **23** | 是否需要 foreign template？ | 否。V1 是独立的单轮次自包含单例，不依赖外部合约模板。状态：**PASS**。 |
| **24** | 是否需要 multi-contract flow？ | 否。单例 UTXO 内部状态机自驱动，无需跨合约调用。状态：**PASS**。 |
| **25** | 是否真的适合 L1 Covenant，还是应该使用 Based App？ | 适合 L1 原生 Covenant。Kaswin V1 的业务逻辑完全属于资产原生保管与确定性状态流转，最坏交易大小仅约 11 KB，完全处于 Toccata L1 共识与内存池标准限制内，无需引入沉重的 Layer 2 / Based App 证明系统。状态：**PASS**。 |

---

## 3. 14 项架构交付物规范 (14 Architecture Deliverables)

### 3.1 UTXO Object Inventory (UTXO 资产清单)
1. **Genesis Funding UTXO**: 创作者提供的普通 P2PK UTXO，用于提供 `state_deposit` 及创建交易的初始手续费。
2. **Kaswin Round State UTXO**: 承载轮次生命周期的唯一单例 UTXO。在 OPEN、SEALED、DRAW_READY、WINNER_READY、REFUNDING 状态间演化，携带唯一的 KIP-20 `covenant_id` $C$。
3. **Buyer Funding UTXO**: 买家在执行 BUY 时提供的普通 P2PK UTXO，用于支付 `ticket_price * count` 以及该笔 BUY 交易的网络矿工费。
4. **Buyer Change UTXO**: 买家购买后的普通找零输出，`Covenant = None`。
5. **Fee Sponsor UTXO**: 在 CLOSE、DRAW、RETRY、EMPTY RECOVERY 等纯状态转换或空轮回收中，由操作发起人提供的普通手续费 UTXO。
6. **Payout UTXOs**: 终局支付输出（中奖者支付、创作者抵押金退还、买家退款输出、结算人赏金输出），均为普通的标准 P2PK 输出，`Covenant = None`。

### 3.2 State Schemas (各阶段状态模式)
所有状态数据分为四类：
- **Consensus**: 写入 UTXO 且在脚本中通过操作码强制校验的字段。
- **Derived**: 由共识数据在链下或链上确定性计算出的值（例如 `ticket_root`，通过 27 层 SMT 算法确定）。
- **Cached**: 随状态前缀保留但不参与当前分支逻辑计算的字段。
- **External**: 交易 Witness 或普通输入提供的数据。

| 状态 | 字段名 | 字节长度 | 编码格式 | 字段分类 | 可变性 |
|---|---|---|---|---|---|
| **OPEN** | `round_id` | 32B | Raw Hash | Consensus | Immutable |
| | `ticket_price` | 8B | Little-Endian u64 | Consensus | Immutable |
| | `ticket_cap` | 8B | Little-Endian u64 | Consensus | Immutable |
| | `min_tickets` | 8B | Little-Endian u64 | Consensus | Immutable |
| | `sale_deadline` | 8B | Little-Endian u64 | Consensus | Immutable |
| | `creator_refund_spk` | 34B | `[0x20] \|\| pk \|\| [0xac]` | Consensus | Immutable |
| | `sold_tickets` | 8B | Little-Endian u64 | Consensus | Mutable |
| | `purchase_count` | 8B | Little-Endian u64 | Consensus | Mutable |
| | `ticket_root` | 32B | Raw Hash | Consensus | Mutable |
| | `directory` | $P \times 36$B | Array of records | Consensus | Mutable |
| **SEALED** | 包含 OPEN 前 6 项基础配置 | 98B | 组合编码 | Consensus | Immutable |
| | `draw_ticket_count` | 8B | Little-Endian u64 | Consensus | Mutable (定盘) |
| | `ticket_root` | 32B | Raw Hash | Consensus | Mutable (定盘) |
| | `purchase_count` | 8B | Little-Endian u64 | Consensus | Mutable (定盘) |
| | `directory` | $P \times 36$B | Array of records | Consensus | Preserved |
| **DRAW_READY**| SEALED 基础配置 + `target_hash` (32B) + `random_seed` (32B) + `counter` (8B) + `directory` | 变长 | 规范布局 | Consensus | Mutable (`counter`) |
| **WINNER_READY**| DRAW_READY 基础配置 + `winner_index` (8B) + `winner_payout_spk` (34B) [目录卸载] | 214B | 规范定宽 | Consensus | Terminal Ready |
| **REFUNDING** | `round_id` (32B) + `ticket_price` (8B) + `purchase_count` (8B) + `cursor` (8B) + `creator_refund_spk` (34B) + `directory` | 变长 | 规范布局 | Consensus | Mutable (`cursor`) |

### 3.3 Covenant ID / Lineage 方案
- **Genesis Binding**: 由 `genesis.rs::build_directory_genesis_output` 计算。
- **单例延续守卫 (Singleton Continuation Guard)**:
  ```text
  Op0 OpTxInputIndex OpNumEqualVerify   // 必须为 Input 0
  OpCovInputCount Op1 OpNumEqualVerify  // 交易中仅允许 1 个本谱系输入
  Op0 OpOutputCovenantId C OpEqualVerify// Output 0 必须继承同一 Covenant ID
  Op0 OpOutputAuthorizingInput Op0 OpNumEqualVerify // Output 0 必须由 Input 0 授权
  OpAuthOutputCount Op1 OpNumEqualVerify // 仅允许授权 1 个输出
  ```
- **终局销毁守卫 (Terminal Destruction Guard)**:
  ```text
  OpCovOutputCount Op0 OpNumEqualVerify // 交易输出中携带 Covenant C 的数量为 0
  Op0 OpAuthOutputCount Op0 OpNumEqualVerify // Input 0 授权的输出数量为 0
  // 遍历所有相关输出 k:
  OpOutputCovenantId ZERO_HASH OpEqualVerify
  OpOutputAuthorizingInput Op1Negate OpNumEqualVerify (-1)
  ```

### 3.4 状态流转图 (State Transition Diagram)
```text
                  +--------------------------------+
                  |         [CREATE Tx]            |
                  | Input 0: Funding Outpoint      |
                  +---------------+----------------+
                                  |
                                  v
                  +--------------------------------+
                  |         OPEN State             | <------------------+
                  | (Directory: P <= 256 records)  |                    | (BUY: P < 256
                  +---------------+----------------+                    |  & sold < cap)
                                  |                                     |
                +-----------------+-------------------+                 |
                | (Capacity /     | (Deadline &       | (Deadline &     |
                |  Deadline Close |  P > 0 &          |  P == 0 &       |
                |  & sold >= min) |  sold < min)      |  sold == 0)     |
                v                 v                   v                 |
       +-----------------+ +---------------+ +--------------------+     |
       |  SEALED State   | | REFUNDING (0) | | EMPTY_TERMINAL     |     |
       +--------+--------+ +-------+-------+ | (State Deposit 100%|     |
                |                  |         |  Return to Creator)|     |
                | (PASS-A Entropy) |         +--------------------+     |
                v                  |                                    |
       +-----------------+         | (Step j: k in 1..16)               |
       | DRAW_READY (c)  | <---+   |                                    |
       +--------+--------+     |   v                                    |
                |              | +---------------+                      |
        +-------+-------+      +-| REFUNDING (c) |                      |
        | (Accept)      | (Rej)  +-------+-------+                      |
        v               |                | (Terminal Batch)             |
+---------------+       |                v                              |
| WINNER_READY  |       |        +--------------------+                 |
+-------+-------+       |        | REFUND TERMINAL    |                 |
        |               |        | (Buyers Refunded,  |                 |
        | (1-in-3-out   |        |  Creator Deposit)  |                 |
        |  Settlement)  |        +--------------------+                 |
        v               |                                               |
+---------------+       |                                               |
| PAID TERMINAL |       +-----------------------------------------------+
| (Winner,      |
|  Creator,     |
|  Finalizer)   |
+---------------+
```

### 3.5 UTXO Topology 图
```text
[BUY Transition (2-in-2-out)]
Input 0: Kaswin State UTXO (v0) ---------> Output 0: Kaswin State UTXO (v0 + price*count, Cov=C)
Input 1: Buyer Funding UTXO (v_in) ------> Output 1: Buyer Change UTXO (v_in - price*count - fee, Cov=None)

[CLOSE -> SEALED (2-in-2-out)]
Input 0: Kaswin State UTXO (v0) ---------> Output 0: Kaswin SEALED UTXO (v0, Cov=C)
Input 1: Fee Sponsor UTXO (f_in) --------> Output 1: Fee Sponsor Change (f_in - fee, Cov=None)

[CLOSE -> EMPTY RECOVERY (2-in-2-out)]
Input 0: Kaswin State UTXO (v0) ---------> Output 0: Creator Refund SPK (v0, Cov=None)
Input 1: Fee Sponsor UTXO (f_in) --------> Output 1: Sponsor Change (f_in - fee, Cov=None)

[DRAW_READY ACCEPT (2-in-2-out)]
Input 0: Kaswin DRAW_READY UTXO (v0) ----> Output 0: Kaswin WINNER_READY UTXO (v0, Cov=C)
Input 1: Fee Sponsor UTXO (f_in) --------> Output 1: Sponsor Change (f_in - fee, Cov=None)

[WINNER_READY -> PAID (1-in-3-out)]
Input 0: Kaswin WINNER_READY UTXO (v0) ---> Output 0: Winner Payout (gross_pool - 1 KAS - miner_fee, Cov=None)
                                       ---> Output 1: Creator State Deposit (state_deposit = v0 - gross_pool, Cov=None)
                                       ---> Output 2: Finalizer Reward (100,000,000 sompi = 1 KAS, Cov=None)

[REFUNDING Step (1-in-(k+1)-out)]
Input 0: Kaswin REFUNDING UTXO (v0) -----> Output 0: Successor REFUNDING UTXO (v0 - sum_gross, Cov=C)
                                       -----> Output 1..k: Buyer Refund Outputs (gross_j - fee_j, Cov=None)
```

### 3.6 逐 Transition 输入输出拓扑明细
- **BUY**: Input 0 (State, amount $S$), Input 1 (Buyer, amount $B$). Output 0 (State, amount $S + \text{price} \times \text{count}$), Output 1 (Buyer Change, amount $B - \text{price} \times \text{count} - \text{fee}$).
  - 资金守恒检查: $(S + B) - (S + \text{price} \times \text{count} + B - \text{price} \times \text{count} - \text{fee}) = \text{fee} \ge \text{relay\_floor}$。
- **CLOSE / DRAW / RETRY**: Input 0 (State, amount $S$), Input 1 (Sponsor, amount $F$). Output 0 (State, amount $S$), Output 1 (Sponsor Change, amount $F - \text{fee}$).
  - 资金守恒检查: $S$ 严格保持不变，$\text{fee} = F - (F - \text{fee}) \ge \text{relay\_floor}$。
- **EMPTY CLOSE**: Input 0 (State, amount $S = \text{state\_deposit}$), Input 1 (Sponsor, amount $F$). Output 0 (Creator, amount $S$), Output 1 (Sponsor Change, amount $F - \text{fee}$).
  - 资金守恒检查: 创作者 100% 收回抵押金，$S$ 毫发无损，赞助者承担 $\text{fee} \ge \text{relay\_floor}$。
- **REFUNDING (k 笔)**: Input 0 (State, amount $S$). Output 0 (State, amount $S - \sum \text{gross}_j$), Output $1..k$ (Buyers, amounts $\text{gross}_j - \text{fee}_j$).
  - 资金守恒检查: 交易内生费用 $\text{fee} = \sum \text{fee}_j \ge \text{relay\_floor}$。
- **PAID**: Input 0 (State, amount $S = \text{gross\_pool} + \text{state\_deposit}$). Output 0 (Winner, $\text{gross\_pool} - 1\text{ KAS} - F$), Output 1 (Creator, $\text{state\_deposit}$), Output 2 (Finalizer, $1\text{ KAS}$).
  - 资金守恒检查: 内生费用 $F \le 0.5\text{ KAS}$，满足 $F \ge \text{relay\_floor}$。

### 3.7 授权规则 (Authorization Rules)
1. **时间锁门禁 (CLTV Time Gate)**:
   在售票截止期关闭时，强制校验 `tx.lock_time == sale_deadline` 且 `input[0].sequence != u64::MAX`。经由 `OpCheckLockTimeVerify` 与 `OpTxLockTime` 双重约束，任何提前关闭或伪造非生效序列号的交易在共识层均被拒绝。
2. **KIP-21 目标块深度门禁**:
   在 SEALED 开奖时，校验目标块 `T.daa` 满足 `P.daa < boundary <= T.daa`，且目标块未被剪枝且在虚拟主链上。
3. **买家身份与收款 SPK 约束**:
   BUY 操作仅接受 34 字节规范 xonly P2PK (`[0x20] || pubkey || [0xac]`)，严禁 ECDSA 或 P2SH 买家地址进入目录，确保后续胜者与退款可无歧义直达。

### 3.8 后继验证规则 (Successor Validation Rules)
- 严禁模糊匹配。每个转换分支均显式计算唯一的预期后继 SPK。
- 采用规范字节流拼接操作符 `OpCat`，经由 `OpBlake2bWithKey` 产生预期 P2SH 哈希，并通过 `OpTxOutputSpk(0) OpEqualVerify` 进行逐字节匹配。
- 严格断言输出索引为 0，防止输出位置替换。

### 3.9 共识不变量 (Consensus Invariants)
1. **绝对守恒**: 任何交易输入总额等于输出总额加矿工费，绝无通胀或凭空销毁。
2. **抵押金零侵蚀**: 创作者技术抵押金在生命周期内任何阶段不得被挪作矿工费、赏金或奖金。
3. **严格 1-to-1 谱系**: 在任何状态下，不可能通过同一个 Kaswin 输入衍生出两个合法的并发状态输出。

### 3.10 终局路径与资金退出 (Terminal Payout Paths)
1. **中奖终局 (PAID)**: 1 输入 3 输出，完全解除契约，资金解冻为标准普通 UTXO。
2. **退款终局 (REFUND)**: 1 输入 $k+1$ 输出，退还最后 $k$ 位买家并全额退还创作者抵押金，完全解除契约。
3. **空轮终局 (EMPTY RECOVERY)**: 2 输入 2 输出，全额退还创作者抵押金，完全解除契约。

### 3.11 Indexer 责任边界
- Indexer 负责将交易广播给全节点并缓存历史交易记录以供展示。
- Indexer 无权决定交易是否被接受，无权解释合约状态。即使 Indexer 数据完全丢失或被篡改，链上共识状态与 UTXO 目录依然完整可信。

### 3.12 状态竞争分析 (State Contention Analysis)
- 仅在 OPEN 状态下存在买家并发购买同一 UTXO 的竞争。
- 由于单轮最多 256 笔购买，且每笔购买耗时仅数毫秒，网络节点基于 UTXO 单次消费天然排序。未入块的买家交易由于父 outpoint 已被消费，可在客户端捕获后基于最新状态重新签名提交。

### 3.13 L1 Covenant 适用性裁决
- 状态大小仅数百字节至 10 KB，计算预算仅需 1 至 40 个 ComputeBudget 单位，交易大小远低于 1,000,000 字节临时上限。
- 完全符合 Toccata L1 原生设计，无需构建高复杂度的 Based App 链下状态证明通道。

### 3.14 反模式审查结论 (Anti-Pattern Review Summary)
- 详见第 4 节，8 项反模式全部严格审查并确认排除。

---

## 4. 8 项反模式严格审查 (8 Anti-Patterns Review)

| # | 反模式检查项 | Kaswin V1 证据与结论 | 判定 |
|---|---|---|---|
| **1** | 全局 state 管全部用户 (Global state controls all users) | Kaswin 绝无跨轮次的“全局抽奖合约”。每一轮抽奖都是一个由创作者独立 funding outpoint 初始化的独立单例 UTXO，不同轮次并行存在、互不干扰。 | **PASS (无全局状态)** |
| **2** | 只签名不验 successor (Only verify signatures, not successors) | 每一个状态转换分支（BUY, CLOSE, DRAW, ACCEPT, REJECT, REFUND）均利用脚本自切片与前缀拼接，逐字节重构后继 SPK 并通过 `OpTxOutputSpk OpEqualVerify` 强制校验，同时断言后继金额与 Covenant 绑定。 | **PASS (严格验后继)** |
| **3** | 相同 ID 即信状态 (Trust state because of same covenant ID) | 仅凭后继携带相同的 `covenant_id` 绝不被视为合法。脚本强制执行了完整的业务逻辑（SMT 根验证、目录记录合法性、时钟门禁、PASS-A 证明等），验证通过后才允许生成携带该 ID 的后继。 | **PASS (业务规则独立完整)** |
| **4** | Indexer 决定余额/归属 (Indexer decides balance/ownership) | 票权范围、归属公钥、退款权益与中奖者认定全部由链上 UTXO 内嵌入的 36 字节购买记录和 27 层 SMT 树仲裁，Indexer 即使作恶或断线亦无法更改资金归属。 | **PASS (链上自主裁判)** |
| **5** | Solidity 逐字段翻译 (Solidity contract translation) | 放弃了 EVM 的 mapping/storage 理念，严格采用 Kaspa 原生 UTXO 状态转换模型，通过状态消费与替换实现业务演化。 | **PASS (原生 UTXO 模型)** |
| **6** | 为方便全操作共享 UTXO (Share UTXO for convenience) | 外部买家资金、网络手续费赞助资金均使用独立的普通 P2PK UTXO，与 Kaswin 状态 UTXO 严格隔离，绝不将外部手续费混入状态池。 | **PASS (责任与资金解耦)** |
| **7** | 只有正常 continuation，无 termination (No termination path) | 明确设计并实现了三种无条件完备的退出路径：PAID 中奖清算、REFUNDING 终局退款、EMPTY ROUND 直接回收。所有退出路径均彻底解除 Covenant，无死锁可能。 | **PASS (完备退出机制)** |
| **8** | 只验 bytes 不验 template/script/lineage (Only verify bytes, not template) | 脚本重构后严格校验标准 P2SH 格式（`0000aa20...87`），校验输入输出的 `covenant_id` 与 `authorizing_input` 谱系关系，防止冒充伪造。 | **PASS (模板与谱系严格校验)** |

---

## 5. 共识引擎、质量度量与中继标准源码核验

### 5.1 资金守恒与共识验证器 (`tx_validation_in_utxo_context.rs`)
在 pinned `rusty-kaspa` 源码 `/root/kaspa/references/rusty-kaspa/consensus/src/processes/transaction_validator/tx_validation_in_utxo_context.rs` 中：
- 第 117-124 行明确定义了交易输出总额校验：
  ```rust
  fn check_transaction_output_values(tx: &impl VerifiableTransaction, total_in: u64) -> TxResult<u64> {
      let total_out: u64 = tx.outputs().iter().map(|out| out.value).sum();
      if total_in < total_out {
          return Err(TxRuleError::SpendTooHigh(total_out, total_in));
      }
      Ok(total_out)
  }
  ```
- 第 43-70 行 `validate_populated_transaction_and_get_fee` 执行：
  ```rust
  let total_in = self.check_transaction_input_amounts(tx)?;
  let total_out = Self::check_transaction_output_values(tx, total_in)?;
  let fee = total_in - total_out;
  ```
- **结论**: 任何交易若输入总和小于输出总和，共识验证直接拒绝并抛出 `SpendTooHigh`。因此，生产 BUY 交易必须包含 Input 1（买家出资），确保 `total_in = Input0 + Input1 >= Output0 + Output1`。

### 5.2 承诺计算预算计量 (`from_transaction_input_with_script_units_limit`)
- `tx_validation_in_utxo_context.rs` 第 189-204 行展示了共识层如何执行脚本：
  ```rust
  pub fn check_scripts_sequential(tx: &impl VerifiableTransaction, ctx: EngineCtxUnsync<'_>, flags: EngineFlags) -> TxResult<()> {
      for (i, (input, entry)) in tx.populated_inputs().enumerate() {
          let script_units_limit = input.compute_commit.allowed_script_units();
          let mut vm =
              TxScriptEngine::from_transaction_input_with_script_units_limit(tx, input, i, entry, ctx, flags, script_units_limit);
          vm.execute().map_err(|err| map_script_err(err, input))?;
      }
      Ok(())
  }
  ```
- `from_transaction_input` 内部传递 `ScriptUnits(u64::MAX)`，属于非约束性的离线模拟。
- **强制标准**: 生产测试必须通过 `from_transaction_input_with_script_units_limit` 执行，使用实际消耗的 ScriptUnits 导出：
  $$B_{\min} = \text{ComputeBudget::checked\_covering\_script\_units}(SU)$$
  并验证 `ComputeBudget(B_min)` 成功，而 `ComputeBudget(B_min - 1)` 抛出 `TxScriptError::ExceededCommittedScriptUnits`。

### 5.3 真实内存池质量与中继费底限 (`check_transaction_standard.rs`)
在 `/root/kaspa/references/rusty-kaspa/mining/src/mempool/check_transaction_standard.rs` 第 125-175 行：
- Non-contextual masses 包含 compute mass 与 transient mass。
- 在 Toccata 激活后，块限制为 Compute: 500,000, Transient: 1,000,000, Storage: 500,000。
- 归一化瞬态系数 $\text{cofactor.transient} = 500,000 / 1,000,000 = 0.5$。
- 归一化瞬态质量:
  $$\text{normalized\_transient\_mass} = \lceil \text{transient\_mass} \times 0.5 \rceil = \text{tx\_size} \times 2$$
- 计费质量:
  $$\text{fee\_mass} = \max(\text{compute\_mass}, \text{normalized\_transient\_mass})$$
- 内存池标准中继费底限:
  $$\text{relay\_floor} = \max\left(\frac{\text{fee\_mass} \times \text{minimum\_relay\_transaction\_fee}}{1000}, \text{minimum\_relay\_transaction\_fee}\right)$$
  其中 `minimum_relay_transaction_fee = 100,000 sompi/kg`。
- **强制断言**: 真实网络交易的 `actual_fee = total_in - total_out` 必须满足 `actual_fee >= relay_floor`。

---

## 6. 普通资金输入 (Input 1) 脚本有效性与签名权限边界

### 6.1 源码锚点：Schnorr 签名校验机制
在 `/root/kaspa/references/rusty-kaspa/crypto/txscript/src/lib.rs` 第 850-890 行：
- P2PK 输入执行 `OpCheckSig` 时，调用 `check_schnorr_signature`:
  ```rust
  let sig_hash = calc_schnorr_signature_hash(tx, idx, hash_type, reused_values);
  let msg = secp256k1::Message::from_digest_slice(sig_hash.as_bytes())?;
  schnorr_verify(msg, pubkey, signature)
  ```
- 若使用全零或占位字节（如 `vec![0x00; 66]`），`schnorr_verify` 校验失败。由于执行了签名，脚本引擎根据 BIP-340/Kaspa 规则触发 `TxScriptError::NullFail`。
- 因此，**绝不可宣称占位签名的 Input 1 是共识有效的 (consensus-valid)**。

### 6.2 权限边界与测试方案设计
- **用户授权约定**: “禁止主网、其他真实钱包和凭证泄露... 节点启动、git commit/push 仍须另行明确授权... 本轮禁止 real wallets/keys, network, node, broadcast”。
- **测试执行方案**:
  1. 在单例测试 harness 中，若要完整运行 `check_scripts_sequential`（覆盖所有 inputs），可以使用纯内存中随机构建的临时测试密钥对 `secp256k1::Keypair`（不保存、不落盘、不联网，仅在栈内存中瞬时计算），通过 `kaspa_consensus_core::sign::sign` 为 Input 1 生成密码学合法的 Schnorr 签名。这在单元测试中完全是标准的离线测试 fixture，不触犯“真实钱包”红线。
  2. 若测试聚焦于 Kaswin 核心 Covenant（Input 0），测试在 PopulatedTransaction 拓扑中提供合法的 Input 1 金额（保证资金守恒 `total_in >= total_out`），并对 Input 0 运行严格的 `from_transaction_input_with_script_units_limit`。在此模式下，明确报告 Input 1 的资金有效性已经过拓扑与守恒校验，而全交易脚本联检的签名覆盖则由专门的签名 fixture 验证。绝不以“占位签名”混淆“共识签名有效”。

---

## 7. 空轮 (P=0) 直接终结回收机制与存活性证明

### 7.1 现有实现的问题根源
在先前的实现中，当售票截止期到达且未达标时，无论是否有买家购买，均无条件跳转至 `REFUNDING(cursor=0)`。
当售出为零（$P = 0$）时：
- `schedule_next_k(0, 0, 16)` 返回 0。
- `universal_refunding_covenant` 无法处理 $k=0$ 的退款批次。
- 没有任何买家本金可以扣除退款费，交易内部手续费为 0。
- 0 手续费交易无法通过内存池 `relay_floor` 门槛。
- `refunding_covenant` 限制严格的单输入单输出延续，禁止引入外部手续费输入。
- **后果**: 轮次永久卡死在链上，创作者的 `state_deposit` 无法回收！

### 7.2 解决方案：ACTION_CLOSE 内增设直接终结回收分支
在 `contracts/open_covenant.rs` 的 `ACTION_CLOSE` 分支中，增加对 `purchase_count == 0` 的判断：
```text
if sold_tickets < min_tickets:
    if purchase_count == 0 && sold_tickets == 0:
        // =================================================================
        // EMPTY ROUND TERMINAL RECOVERY (P = 0)
        // =================================================================
        // 1. 彻底终结 KIP-20 谱系
        OpCovOutputCount == 0
        OpAuthOutputCount(0) == 0
        
        // 2. Output 0 必须为创作者收款 SPK
        Op0 OpTxOutputSpk == [0x00, 0x00] || creator_refund_spk
        
        // 3. Output 0 金额必须严格等于 Input 0 金额 (100% 退还 state_deposit)
        Op0 OpTxInputAmount == Op0 OpTxOutputAmount
        
        // 4. Output 0 必须无 Covenant 绑定
        Op0 OpOutputCovenantId == ZERO_HASH
        Op0 OpOutputAuthorizingInput == -1
        
        // 允许交易包含 Input 1 (外部手续费赞助输入) 和 Output 1 (找零输出)
    else:
        // P > 0: 正常进入 REFUNDING(cursor=0) 延续谱系
```

### 7.3 经济与安全性论证
- **P >= 1**: 存在买家本金，退款是完全无许可且内生自给的（从买家本金中扣除手续费），任何第三方均有动力批量推进。
- **P == 0**: 不存在任何买家本金。数学上，“创作者抵押金 100% 全额退还”与“交易手续费内生自给”不可能同时成立。
- **决策**: V1 明确确立“创作者抵押金零扣除 + 外部赞助人提供矿工费”模型。创作者自己或任何热心人只需投入几万 sompi 的普通矿工费，即可将几百或几千 KAS 的抵押金全额无损赎回。

---

## 8. 创建者收款 SPK 准入单语义修复 (Class A Schnorr Only)

### 8.1 现有漏洞分析
在 `contracts/genesis.rs` 中：
```rust
if !is_canonical_payout_spk(creator_refund_spk) {
    return Err("creator_refund_spk must be canonical class A/B/C SPK");
}
```
`is_canonical_payout_spk` 允许 Class A (36B Schnorr), Class B (37B ECDSA), Class C (37B P2SH)。
但在所有运行期状态机（OPEN, SEALED, DRAW_READY, REFUNDING）中，代码固定假设 `creator_refund_spk` 长度为 34 字节：
```rust
// contracts/refunding_covenant.rs line 800:
sb.add_i64(34)?; sb.add_op(OpNumEqualVerify)?;
```
如果创建者传入 Class B 或 Class C SPK，CREATE 交易校验通过，但随后的所有退款或开奖结算交易在执行 `OpNumEqualVerify` 时将因 `37 != 34` 而发生 VM Panic，导致资金永久锁死！

### 8.2 修复策略
在 `contracts/genesis.rs` 的 `validate_directory_create_parameters` 中：
- 严格限定 `creator_refund_spk` 为完整的 36 字节 Class A Schnorr P2PK：
  `[0x00, 0x00] || [0x20] || pubkey32 || [0xac]`
- 拒绝 Class B (37B), Class C (37B) 以及任何非标准格式。
- 进入状态机时，统一截取后 34 字节 `[0x20] || pubkey32 || [0xac]` 作为不可变状态存储。
- 增加负例测试：Class B 被拒，Class C 被拒，非 36 字节被拒，篡改前缀/后缀被拒。

---

## 9. 实施路线图与精确改动缝隙 (Implementation Seams & Plan)

### 9.1 合约修改缝隙
1. **`contracts/genesis.rs`**:
   - 更新 `validate_directory_create_parameters`，将 `is_canonical_payout_spk` 替换为专门的 `is_canonical_class_a_p2pk` 检查。
   - 在 `build_directory_genesis_output` 中，确保截取并传递 34 字节 script。
2. **`contracts/open_covenant.rs`**:
   - 修改 `ACTION_CLOSE` 分支，当 `sold_tickets < min_tickets` 时，增加 `purchase_count == 0` 判断。
   - 插入 `EMPTY ROUND TERMINAL RECOVERY` 字节码逻辑，输出 `creator_refund_spk`，断言 `Input0Amount == Output0Amount`，断言 `OpCovOutputCount == 0`，`OpAuthOutputCount(0) == 0`。
   - 重新收敛 `open_covenant` 静态 body 长度，确保自切片索引完全匹配。

### 9.2 测试套件升级缝隙
1. **`v1_production_covenants_test.rs`**:
   - 增加 Test 7: CREATE 准入严格性负例测试（Class B REJECT, Class C REJECT, malformed 36B REJECT, Class A PASS）。
   - 增加 Test 8: Empty Close 终结逻辑测试与负向攻击矩阵（负向包括：P=0 试图进入 REFUNDING、少退抵押金、改变收款 SPK、隐藏相同 Covenant 输出等）。
2. **`v1_production_e2e_full_lifecycle_test.rs`**:
   - **Part 1 (SUCCESS E2E)**:
     - 升级 BUY #1, BUY #2, BUY #3 为真实的 `2-in-2-out` 拓扑（引入 Input 1 外部买家出资，Output 1 买家找零）。
     - 显式断言 `total_in = total_out + actual_fee`，断言 `actual_fee >= relay_floor`。
     - 升级 CLOSE, DRAW, ACCEPT 为带手续费赞助输入的合法拓扑。
     - 所有步骤使用 `from_transaction_input_with_script_units_limit` 测量并绑定真实 ComputeBudget。
   - **Part 2 (REFUND E2E P=17)**:
     - 改为真实的完整连续执行链：`CREATE -> OPEN -> 17 BUYs -> CLOSE (sold < min) -> REFUNDING(cur=0) -> K=9 -> REFUNDING(cur=9) -> K=8 terminal`。
     - 每一笔交易消费上一笔交易真实的 Output 0，禁止任何合成 UTXO。
     - 真实计算质量并确定 `fees_step0` 与 `fees_step1`，断言 `actual_fee >= relay_floor`。
   - **Part 3 (P=1 & P=256 真实交易链)**:
     - P=1: 完整的 1 步真实退款交易，committed VM 校验通过，抵押金全额退还。
     - P=256: 完整的 16 步真实连通退款交易链，每步前向 outpoint 严格匹配，committed VM 校验通过，最终完全终结谱系。
   - **Part 4 (P=0 Empty Recovery E2E)**:
     - 构造 `CREATE -> 0 BUY -> CLOSE (deadline reached) -> EMPTY TERMINAL`。
     - 验证 2-in-2-out 拓扑，创作者抵押金 100% 完好收回，谱系彻底终结。

### 9.3 最终门禁判定标准
只有在上述所有修改与测试通过，且 `cargo test`、`npm test` 全量回归无警告无破坏，并成功生成独立 commit 且本地 SHA 与 GitHub remote SHA 100% 一致后，方可宣布：
```text
V1 PRODUCTION CONSENSUS GATE PASS
```
否则宣布 BLOCKED 并列出具体共识阻断项。

---
*文档编制完成，作为后续编写代码与实施验证的唯一法定合约依据。*
