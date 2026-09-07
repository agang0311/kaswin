# Kaswin V1 — Sale Close Semantics & Variable Draw Count Spike Report

- **状态**: `SALE CLOSE SEMANTICS PASS`
- **协议基准参数**: `MAX_TICKET_CAP = 100,000`, `MAX_PURCHASE_COUNT = 256`
- **记录规范**: 36 字节紧凑记录（4 字节小端 `cumulative_end_ticket` + 32 字节 x-only `payout_pubkey`）
- **验证代码**: `tests/rust-vm-validation/src/bin/sale_close_semantics_spike.rs`

---

## 一、核心术语与字段语义规范

为消除历史上 `total_tickets` 字段重载导致的歧义，本轮审计正式确立以下四个严格正交的核心字段：

| 字段名称 | 类型 | 可变性 | 规范含义 |
|---|---|---|---|
| `ticket_cap` | `u64` | 不可变 | 轮次创建时配置的**最大允许销售票数上限**（$\le 100,000$）。 |
| `purchase_cap` | `usize` | 常量 (256) | 链上有界购买目录的**硬容量上限**（256 笔购买记录）。 |
| `min_tickets` | `u64` | 不可变 | 轮次创建时配置的**最低开奖门槛**（$1 \le min\_tickets \le ticket\_cap$）。 |
| `sale_deadline` | `u64` | 不可变 | 轮次停售截止 DAA 分数（CLTV 锁定时高）。 |
| `draw_ticket_count` | `u64` | 最终确定值 | 成功停售时的**实际最终有效售出票数**，作为后续抽奖拒绝采样的域大小 $N$。 |

### 停售与结果判定规则：
停售触发条件（任何一项满足即关闭购买通道）：
1. **Ticket Cap Close**: 票数售罄，即 $sold\_tickets == ticket\_cap$；
2. **Purchase Cap Close**: 目录满槽，即 $purchase\_count == purchase\_cap$（256）；
3. **Deadline Close**: 截止时间后开放关单，即在 $context\_daa > sale\_deadline$ 时关单交易获得执行资格（`deadline-close becomes eligible after sale_deadline`）。需明确：Ticket-cap 与 Purchase-cap 为契约状态机变迁级硬强制拦截；而 Deadline-close 则是“到期后获得无许可执行资格”，在 CLOSE 交易实际被区块确认前，并发合法的 BUY 仍有可能抢先赢得单例 UTXO 竞争。不得表述为“在 sale_deadline 自动关闭”。

**结果判定标准（与停售原因完全解耦）**：
- 若最终有效售出票数 $final\_sold\_tickets \ge min\_tickets$：进入 **SEALED / DRAW PATH**，此时 $N = draw\_ticket\_count = final\_sold\_tickets$。
- 若最终有效售出票数 $final\_sold\_tickets < min\_tickets$：进入 **REFUND PATH**，全员退款且创作者保证金全额退回。

*术语规范*: 仅当 $sold\_tickets == ticket\_cap$ 时称为“Sold Out（售罄）”；非售罄但成功满足开奖门槛的停售统称为“Sale Closed（成功停售）”。

---

## 二、规范 SEALED 状态精简定义 (Phase A)

在支持可变抽奖票数 $draw\_ticket\_count \le ticket\_cap$ 及可变购买条数 $P \le 256$ 条件下，SEALED 状态规范定义如下：

### 1. 前缀字段布局（总长 $134 + P \times 36$ 字节）：
- `[0]` `OpTxInputIndex, Op0, OpEqualVerify` (3 B)
- `[1]` `round_id`: 32 字节数据 (33 B)
- `[2]` `ticket_price`: 8 字节小端数据 (9 B)
- `[3]` `ticket_cap`: 8 字节小端数据 (9 B) — 保持创世配置不可变绑定
- `[4]` `draw_ticket_count`: 8 字节小端数据 (9 B) — 最终抽奖票数 $N$
- `[5]` `ticket_root`: 32 字节数据 (33 B) — 27 层 SMT 密码学承诺
- `[6]` `purchase_count`: 8 字节小端数据 (9 B) — 目录中实际购买条数 $P$
- `[7]` `creator_refund_spk`: 34 字节标准 P2PK 数据 (35 B) — 创作者保证金归还地址
- `[8]` `directory`: $P \times 36$ 字节变长推送（包含标准 Push Header）

### 2. 精简性审计结论：
- **`sold_tickets`**: 在 SEALED 状态下由 `draw_ticket_count` 完全代表，无需单独冗余保留。
- **`draw_ticket_count != ticket_cap`**: 严禁将未售出的库存自动填充，抽奖域仅限于实际买入票数 $[0, draw\_ticket\_count)$。
- **`purchase_count`**: 显式作为 8 字节前缀存储，避免每次索引在脚本内动态调用 `OpSize` 除以 36，节省计算质量与操作码。

---

## 三、目录满槽成功停售证明 (Phase B: Purchase-Cap Close)

场景测试：
- 配置: `ticket_cap = 100,000`, `min_tickets = 1,000`
- 前序状态: `purchase_count = 255`, `sold_before = 7,400`
- 最终购买: `count = 20`, 变迁后 `purchase_count = 256`, `sold_after = 7,420`
- 判定: $7,420 < 100,000$ 且 $7,420 \ge 1,000$，目录满槽触发成功停售，后继强制转入 `SEALED`，其中 $draw\_ticket\_count = 7,420$。

### 1. 真实物理资源与计量结果：
- **OPEN Redeem 脚本大小**: 9,814 B
- **SEALED Redeem 脚本大小**: 9,503 B
- **真实执行 Script Units**: **86,461 SU**
- **最小覆盖计算预算 $B_{\min}$**: **ComputeBudget(8)**
- **$B_{\min}-1$ 耗尽验证**: **PASS**（精确触发 `ExceededCommittedScriptUnits` 异常）
- **计算质量 (Compute Mass)**: 13,497
- **瞬态质量 (Transient Mass)**: 41,068
- **标准化瞬态质量 (Norm Transient)**: 20,534
- **真实存储质量 (Storage Mass)**: **584**
- **网络中继费底线**: **2,053,400 sompi** (~0.0205 KAS)
- **虚拟机执行时间**: ~38 ms

### 2. 负例安全拦截（7/7 全量通过）：
1. `successor remains OPEN`: **FAIL**
2. `draw_ticket_count = ticket_cap (100,000)`: **FAIL**
3. `draw_ticket_count != sold_after (7,421)`: **FAIL**
4. `purchase_count != 256`: **FAIL**
5. `directory loses final record`: **FAIL**
6. `ticket_root changed`: **FAIL**
7. `routed to refund despite threshold met`: **FAIL**

---

## 四、未达最低开奖门槛停售证明 (Phase C: Close Below Minimum)

场景测试：
- 配置: `ticket_cap = 100,000`, `min_tickets = 10,000`
- 状态: `purchase_count = 256`, `final_sold = 7,420 < 10,000`
- 判定: 目录已满无法再买，且票数未达最低开奖线，契约机内强制拒绝变迁至 `SEALED`，唯一合法路径为进入退款路由。

### 负例安全拦截（5/5 全量通过）：
1. `SEALED/draw successor attempted`: **FAIL**
2. `OPEN successor attempted`: **FAIL**
3. `incorrect final sold amount`: **FAIL**
4. `directory mutation on input`: **FAIL**
5. `state principal mutation (+1 sompi)`: **FAIL**

---

## 五、售罄停售证明 (Phase D: Ticket-Cap Close)

场景测试：
- 配置: `ticket_cap = 100,000`, `min_tickets = 1,000`
- 购买记录未满 256 笔时即达成票数上限（例如 $P = 73$ 笔购买，累计售出 100,000 票）。
- 契约成功变迁为 `SEALED`，其中 $draw\_ticket\_count = 100,000$, $purchase\_count = 73$。
- 目录大小为 $73 \times 36 = 2,628$ B，SEALED Redeem 大小仅 2,915 B。
- **赢家索引直接查找**: 在 $P=73$ 的变长 SEALED 状态上执行常数复杂度查找，验证通过（**14,161 SU**, $B_{\min} = \text{ComputeBudget}(1)$）。

---

## 六、截止时间停售共识审计 (Phase E: Deadline Close)

1. **CLTV 机制与规范生效条件**:
   - 关单交易设置 `tx.lock_time = sale_deadline`，并满足输入序列号 `sequence != u64::MAX`。
   - 在 Kaspa 锁定时高终局性语义下，交易合法的共识门槛为区块上下文 $context\_daa > sale\_deadline$（而非 $\ge$）。
   - 状态属性区分：Ticket-cap（售罄）与 Purchase-cap（满槽）是变迁执行时由契约机内强制断言的硬性闭环；而 Deadline 是“截止时间后关单获得执行资格”（`deadline-close becomes eligible after sale_deadline`）。不得断言“在 sale_deadline 自动关闭”。
2. **单例竞争裁决 (Native Consensus Race Resolution)**:
   - Kaswin 采用 Input 0 消费轮次 UTXO 的单例延续范式。
   - 当截止时间过后，在 CLOSE 确认前，若链上并发出现一笔新的 `BUY` 交易和一笔 `CLOSE` 交易，它们在内存池中构成**同 Outpoint 竞争（Double-Spend Conflict）**。
   - 依据 Kaspa 原生共识规则与矿工打包规则：**“以先被区块打包确认的单例交易为准”**（Whichever valid singleton spend confirms first wins）。
   - 一旦 `CLOSE` 确认，轮次 UTXO 即刻转为 SEALED 或 REFUND，竞争的 `BUY` 将因前序 Outpoint 已被花费而自然作废。无需任何非标准 RPC 或共识分叉。

---

## 七、变长目录推送与索引边界 (Phase F & Phase G)

1. **变长推送编码覆盖审计**:
   - $P=1$ ($36$ B): 直接推送 `[0x24]`, Redeem 321 B
   - $P=73$ ($2,628$ B): `OP_PUSHDATA2` `[0x4d, 0x44, 0x0a]`, Redeem 2,915 B
   - $P=128$ ($4,608$ B): `OP_PUSHDATA2` `[0x4d, 0x00, 0x12]`, Redeem 4,895 B
   - $P=255$ ($9,180$ B): `OP_PUSHDATA2` `[0x4d, 0xdc, 0x23]`, Redeem 9,467 B
   - $P=256$ ($9,216$ B): `OP_PUSHDATA2` `[0x4d, 0x00, 0x24]`, Redeem 9,503 B
2. **抽奖域 $N$ 兼容性**:
   在变长售出票数下，拒绝采样直接以 $N = draw\_ticket\_count$ 为模数：
   - $N=1$: $\text{LIMIT} = 72,057,594,037,927,936$, $\text{winner} = 0 < 1$
   - $N=999$: $\text{LIMIT} = 72,057,594,037,927,311$, $\text{winner} = 861 < 999$
   - $N=1,000$: $\text{LIMIT} = 72,057,594,037,927,000$, $\text{winner} = 472 < 1,000$
   - $N=7,420$: $\text{LIMIT} = 72,057,594,037,924,740$, $\text{winner} = 1,032 < 7,420$
   - $N=100,000$: $\text{LIMIT} = 72,057,594,037,900,000$, $\text{winner} = 87,472 < 100,000$
   全部严格满足 $0 \le winner\_index < N$ 且目录区间无缝覆盖。

---

## 八、Application Commitment 兼容性裁决 (Phase H)

针对历史公式中 `total_tickets` 分裂为 `ticket_cap` 与 `draw_ticket_count` 的审计回答：

1. **原 `total_tickets` 提供的安全属性**: 为随机种子原像绑定唯一的奖池规模，防止不同规模下的结果漂移。
2. **`ticket_root` 是否已承诺实际票数**: 是。每个区间叶子均显式哈希了 `start` 和 `count`，末尾叶子覆盖至 $draw\_ticket\_count$，因此 `ticket_root` 已对售出票数提供密码学承诺。
3. **同一种子是否可能被解释为两个合法的 $N$**: 否。单例 UTXO 唯一确定，不可分叉。
4. **最小规范公式裁决 (Option A: V1 Semantic Correction)**:
   $$\text{app\_commit} = \text{BLAKE2b}\Big(\text{"KaswinAppV1"} \mathbin{\Vert} \text{round\_id} \mathbin{\Vert} \text{ticket\_root} \mathbin{\Vert} \text{le\_u64(draw\_ticket\_count)}\Big)$$
   直接绑定抽奖实际采用的域大小 $N = draw\_ticket\_count$。

---

## 九、部分售出赢家归属回归验证 (Phase I)

在 $draw\_ticket\_count = 7,420, P = 256$ 场景下：
1. **数据自恢复**: 单凭 SEALED Redeem 完整恢复 256 笔记录，重算 27 层 SMT 根哈希与链上 `ticket_root` 100% 吻合。
2. **常数查找验证**:
   - 首笔购买 ($winner = 10, i = 0$): **PASS**
   - 中间笔购买 ($winner = 3,719, i = 128$): **PASS**
   - 末笔合法边界 ($winner = 7,419, i = 255$): **PASS**
   - 越界拦截 ($winner = 7,420, i = 255$): **FAIL (正确拒绝)**

---

## 十、成功闭环用例物理资源综合计量表 (Consolidated Resource Measurements)

对协议要求的四种成功闭环场景，在真实交易拓扑与真实 TxScriptEngine 虚拟机下执行端到端物理计量与 $B_{\min}$ 饱和检验：

| 场景 | Redeem 长度 | 目录大小 | 签名脚本 | 真实 Script Units | 最小计算预算 $B_{\min}$ | $B_{\min}-1$ 耗尽验证 | Compute 质量 | Transient 质量 | Norm Transient | 存储质量 | 最小中继费底线 | 虚拟机执行耗时 |
|---|---:|---:|---:|---:|:---:|:---:|---:|---:|---:|---:|---:|---:|
| **1. Purchase-Cap -> SEALED** | 9,814 B | 9,216 B | 9,892 B | 86,461 SU | **ComputeBudget(8)** | **PASS (Exhausted)** | 13,497 | 41,068 | 20,534 | 584 | **2,053,400 sompi** (~0.0205 KAS) | ~3.3 ms |
| **2. Ticket-Cap -> SEALED** | 3,226 B | 2,628 B | 3,304 B | 27,175 SU | **ComputeBudget(2)** | **PASS (Exhausted)** | 6,909 | 14,716 | 7,358 | 588 | **735,800 sompi** (~0.0074 KAS) | ~1.3 ms |
| **3. Deadline -> SEALED** | 3,874 B | 3,276 B | 3,952 B | 32,998 SU | **ComputeBudget(3)** | **PASS (Exhausted)** | 7,557 | 17,308 | 8,654 | 584 | **865,400 sompi** (~0.0087 KAS) | ~1.5 ms |
| **4. Purchase-Cap -> Refund** | 9,814 B | 9,216 B | 9,892 B | 47,781 SU | **ComputeBudget(4)** | **PASS (Exhausted)** | 13,486 | 41,064 | 20,532 | 584 | **2,053,200 sompi** (~0.0205 KAS) | ~2.4 ms |

---

## 十一、数据可用性与状态发现边界澄清 (Discovery Boundary)

必须清晰界定两个技术范畴：
- **购买历史数据可用性 (Purchase-History Data Availability)**: **PASS**。只要拿到当前已确认的单一活状态 UTXO 及其 Redeem 脚本，客户端即可 100% 无损重建全部购买历史与默克尔树，无需任何历史交易扫描或第三方索引器。
- **全新客户端当前活状态发现 (Fresh Current-State Discovery)**: **STILL UNPROVEN**。在普通裁剪节点（未开启 `--utxoindex`）且无任何第三方缓存提供者的情况下，仅凭 `round_id` 如何定位链上最新单例 UTXO Outpoint，仍需进一步机制证明。严禁用“Zero Required Indexer”混淆此边界。

---

## 十二、最终结论

```text
SALE CLOSE SEMANTICS PASS

NEXT:
integrate frozen PASS-A with the new variable-draw-count
directory-preserving SEALED/DRAW state
```
