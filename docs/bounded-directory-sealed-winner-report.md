# Bounded Directory SEALED Preservation & Winner Owner Proof Report

- **状态**: DIRECTORY SEALED + WINNER OWNER PASS
- **基准参数**: `MAX_TOTAL_TICKETS = 100,000`, `MAX_PURCHASE_COUNT = 256`
- **记录规格**: 36 字节紧凑记录（4 字节小端 `cumulative_end_ticket` + 32 字节 x-only `payout_pubkey`）
- **满售目录尺寸**: $256 \times 36 = 9,216$ 字节

---

## 一、架构决策与 SEALED 状态定义 (Phase A)

### 1. 为什么必须在售罄时保留完整购买目录？
在纯链上无外部信任索引器（Zero Required Indexer）架构下，若在最终购买（Final BUY）从 `OPEN` 变迁到 `SEALED` 时将购买目录丢弃，仅保留 32 字节的 Merkle `ticket_root`，则一旦轮次售罄进入抽奖阶段，全新的无状态客户端（Fresh Browser）将立即丧失购买记录可用性：
- 无法知道中奖号码落在哪个买家的购买区间内；
- 无法自主构造中奖者兑奖交易；
- 无法自主复核 `ticket_root` 的真实性。

因此，V1 强制性架构不变性规则为：
> **一旦购买数据在状态中提交，它必须在当前活状态（Live Kaswin State）中保持可恢复，直到中奖者支付不再需要它为止。**

### 2. 规范 SEALED 状态布局 (Canonical SEALED State Layout)
经过最小必要性评估：
- `sold_tickets`: 在售罄状态下恒等于 `total_tickets`，可安全省略，无需在脚本前缀中冗余占用 9 字节。
- `purchase_count`: 售罄状态下为实际购买笔数（256），显式作为 8 字节存放在前缀中，比在脚本内动态除以 36 省去约 15 个操作码和运算质量。
- `ticket_root`: 显式保留（32 字节），作为抗量子与密码学不可篡改的 SMT 根承诺，并用于 `application_commitment` 派生。
- `creator_refund_spk`: 显式保留（34 字节标准 P2PK），用于抽奖结算或退款时将创作者 `state_deposit`（100 KAS）原样退回。
- `directory`: 完整的 9,216 字节购买目录，以标准 `OP_PUSHDATA2`（`[0x4d, 0x00, 0x24]`）编码推送。

规范 SEALED 前缀布局：
- `[0]` `OpTxInputIndex, Op0, OpEqualVerify` (3 B)
- `[1]` `round_id`: 32 字节数据 (33 B)
- `[2]` `ticket_price`: 8 字节小端数据 (9 B)
- `[3]` `total_tickets`: 8 字节小端数据 (9 B)
- `[4]` `ticket_root`: 32 字节数据 (33 B)
- `[5]` `purchase_count`: 8 字节小端数据，即 256 (9 B)
- `[6]` `creator_refund_spk`: 34 字节标准 P2PK (35 B)
- `[7]` `directory`: 9,216 字节全量目录 (9,219 B)

**前缀总长度**: 9,350 字节。
**静态 Body 长度**: 142 字节。
**完整 SEALED Redeem 脚本长度**: 9,492 字节。

---

## 二、最终购买：OPEN -> SEALED 契约证明 (Phase B)

在 $N=256$ 规模下，测试真实的最终合法购买变迁：
- 变迁前状态: `purchase_count = 255`, `sold_before = 99,609`
- 本笔购买数量: `count = 100,000 - 99,609 = 391`
- 变迁后状态: `sold_after = 100,000 == MAX_TOTAL_TICKETS`, `purchase_count = 256`

### 1. 契约机内证明的 14 项完整不变性
1. 消费前 Input 0 为 Kaswin 唯一单例状态输入；
2. KIP-20 单例延续约束满足（`covenant_id == C`, `authorizing_input == 0`, `cov_output_count == 1`）；
3. 输出 0 必须为唯一单例延续输出；
4. 不可变参数（`round_id`, `ticket_price`, `total_tickets`, `creator_refund_spk`）严格无变化继承；
5. `purchase_count` 精确递增 1（255 $\to$ 256）；
6. `sold_after = sold_before + count`；
7. 最终记录的 `cumulative_end` 精确等于 `sold_after`（100,000）；
8. 买家公钥为标准 32 字节 x-only 格式，能重建标准 P2PK；
9. 状态金额精确增加 `ticket_price * count`（精确支付等式）；
10. `sold_after == total_tickets` 触发售罄分支；
11. 后继输出 0 状态必须是 `SEALED`，不得继续作为 `OPEN`；
12. `SEALED` 状态内包含精确的最终目录字节（`old_directory || new_record`，共 9,216 字节）；
13. `SEALED` 状态内包含精确的最终 `ticket_root`；
14. 任何对目录的篡改、删除、重排均导致后继 SPK 不匹配而被 VM 拒绝。

### 2. 真实物理资源与计量结果 (Final BUY OPEN -> SEALED)
- **OPEN Redeem 长度**: 9,677 字节
- **SEALED Redeem 长度**: 9,492 字节
- **签名脚本长度**: 9,755 字节
- **交易预估大小**: 10,130 字节
- **执行消耗 Script Units**: **85,986 SU**
- **最小覆盖计算预算 $B_{\min}$**: **ComputeBudget(8)**
- **$B_{\min}-1$ 预算耗尽检查**: **PASS**（精确抛出 `ExceededCommittedScriptUnits` 异常）
- **计算质量 (Compute Mass)**: 13,360
- **瞬态质量 (Transient Mass)**: 40,520
- **标准化瞬态质量 (Norm Transient)**: 20,260
- **真实存储质量 (Storage Mass)**: **587**
- **网络中继费底线**: **2,026,000 sompi** (~0.0203 KAS)
- **虚拟机执行时间**: ~25 ms

### 3. Phase B 负例攻击测试拦截结果 (9/9 全量通过)
1. `correct ticket_root but mutated directory`: **FAIL** (`VerifyError` / SPK 不匹配)
2. `correct directory but wrong ticket_root`: **FAIL** (`VerifyError` / SPK 不匹配)
3. `directory omitted in successor`: **FAIL** (`VerifyError` / SPK 不匹配)
4. `directory truncated (255 records)`: **FAIL** (`VerifyError` / SPK 不匹配)
5. `directory extended (257 records)`: **FAIL** (`VerifyError` / SPK 不匹配)
6. `records reordered`: **FAIL** (`VerifyError` / SPK 不匹配)
7. `final record payout key changed`: **FAIL** (`VerifyError` / SPK 不匹配)
8. `OPEN successor despite sold_after == total_tickets`: **FAIL** (`VerifyError` / 强制转入 SEALED)
9. `wrong SEALED covenant binding`: **FAIL** (`CovenantsError` / 非法创作者授权绑定)

---

## 三、全新浏览器无索引器自恢复属性证明 (Phase C)

测试场景：
- 客户端为一台首次打开的浏览器；
- 无历史区块扫描、无外部提供者（Provider）、无 Kaspa.stream 索引器、无本地浏览器缓存；
- 仅通过标准节点 RPC 获取到已确认的单一 `SEALED` UTXO 及其 Redeem 脚本。

恢复流程验证：
1. 从 `SEALED_prefix` 字节 `[55..87]` 提取链上承诺的 `SEALED.ticket_root`；
2. 从 `SEALED_prefix` 提取 9,216 字节目录，反序列化出全部 256 笔购买记录；
3. 为全部 256 笔记录独立计算：
   - $start_i = 0$ (若 $i=0$)，否则 $end_{i-1}$
   - $count_i = end_i - start_i$
   - $payout\_spk_i = [0x20] \mathbin{\Vert} key_i \mathbin{\Vert} [0xac]$
4. 客户端在本地内存中对 256 个区间叶子独立重构 27 层 SMT 默克尔树并计算根哈希；
5. **等式断言**:
   $$\text{recomputed\_ticket\_root} == \text{SEALED.ticket\_root} == \text{0x8552f652520fdb7488c5f441a30d6de090fa9b823bc7eecc2026583c70024e96}$$
   断言 100% 成立！证明全新客户端可完全基于链上活状态自行重构完整历史与默克尔树。

---

## 四、中奖者归属直接索引证明 (Phase D)

彻底摈弃 $O(P)$ 循环全表遍历，利用 Kaspa TxScript 原生的 `OpSubstr` 与算术操作码，实现常数复杂度 $O(1)$ 的直接偏移索引校验。

### 1. 验证原理
Host 侧计算出中奖号码 `winner_index`（$0 \le winner\_index < 100,000$），并定位其中奖购买索引 $i \in [0, 255]$。
Witness 仅提供极简数据：
- `winner_index` (8 字节小端数值)
- `purchase_index i` (数值)

Covenant 脚本执行：
1. 校验索引边界: $0 \le i < 256$；
2. 计算记录偏移: $offset_i = i \times 36$；
3. 直接抽取当前购买区间终点:
   $$current\_end = \text{OpBin2Num}(directory[offset_i .. offset_i + 4])$$
   断言 $winner\_index < current\_end$；
4. 确定区间起点:
   - 若 $i = 0$: $start = 0$；
   - 若 $i > 0$: 抽取上一笔记录终点:
     $$prev\_end = \text{OpBin2Num}(directory[(i - 1) \times 36 .. (i - 1) \times 36 + 4])$$
     $start = prev\_end$；
   断言 $start \le winner\_index$；
5. 抽取该买家的收益公钥:
   $$payout\_pubkey = directory[offset_i + 4 .. offset_i + 36]$$
   组装标准 P2PK 脚本:
   $$payout\_spk = [0x20] \mathbin{\Vert} payout\_pubkey \mathbin{\Vert} [0xac]$$
6. 断言输出 0 SPK 严格等于 $payout\_spk$，且金额等于奖金池；
7. 断言输出 1 SPK 严格等于 `creator_refund_spk`，且金额等于创作者保证金 `state_deposit`（100 KAS）。

### 2. 真实物理资源与计量结果 (Winner Owner Lookup, Case B, $i=128$)
- **SEALED Redeem 长度**: 9,492 字节
- **签名脚本长度**: 9,502 字节
- **交易预估大小**: 9,754 字节
- **执行消耗 Script Units**:
  - Case A (首笔购买, $i=0$): **37,813 SU**
  - Case B (中间购买, $i=128$): **47,076 SU**
  - Case C (末笔购买, $i=255$): **47,077 SU**
- **最小覆盖计算预算 $B_{\min}$**: **ComputeBudget(4)**
- **$B_{\min}-1$ 预算耗尽检查**: **PASS**（精确抛出 `ExceededCommittedScriptUnits` 异常）
- **计算质量 (Compute Mass)**: 11,474
- **瞬态质量 (Transient Mass)**: 39,016
- **标准化瞬态质量 (Norm Transient)**: 19,508
- **真实存储质量 (Storage Mass)**: 9,704
- **网络中继费底线**: **1,950,800 sompi** (~0.0195 KAS)
- **虚拟机执行时间**: **~2.5 ms**

### 3. Phase D 负例攻击测试拦截结果 (11/11 全量通过)
1. `i - 1` (索引偏小，导致 $winner \ge current\_end$): **FAIL**
2. `i + 1` (索引偏大，导致 $winner < start$): **FAIL**
3. `wrong previous_end` (篡改上一笔终点导致 $prev\_end > winner$): **FAIL**
4. `wrong current_end` (篡改当前终点导致 $current\_end \le winner$): **FAIL**
5. `wrong payout pubkey` (买家公钥不匹配导致输出 SPK 不一致): **FAIL**
6. `winner == start - 1` (边界下溢): **FAIL**
7. `winner == current_end` (边界上溢): **FAIL**
8. `malformed index (negative)`: **FAIL**
9. `index >= purchase_count (256)`: **FAIL**
10. `mutated directory`: **FAIL** (UTXO SPK 哈希不匹配)
11. `directory from another round`: **FAIL** (跨轮次目录欺骗被拒绝)

---

## 五、与随机数状态机的交互生命周期 (Phase E)

### 1. 生命周期方案对比
- **方案 A**: `SEALED(directory)` $\to$ `DRAW_READY(directory, seed, counter)` $\to$ 结算
- **方案 B**: `SEALED(directory)` $\to$ `DRAW_READY(seed, counter)` (丢弃目录) $\to$ 结算

### 2. 结论与架构约束
**强制选择方案 A，严禁在 `SEALED -> DRAW_READY` 阶段丢弃目录。**

**原因**:
1. 当 `SEALED` 执行 `ACTION_DRAW` 开启 KIP-21 PASS-A 随机数承诺时，仅仅派生出了不可预测的 `random_seed`。
2. 赢家中奖号码 `winner_index` 必须经过 `DRAW_READY` 的拒绝采样（Rejection Sampling）确定：
   - 若 `counter = 0` 不落入合法均匀区间，则必须自复制变迁至 `counter = 1, 2, ...`；
   - 只有当某一计数器 $c$ 被 **ACCEPT** 接受时，最终合法的 `winner_index` 才会诞生！
3. 因此，在进入 `DRAW_READY` 时，中奖号码根本尚未确定，更无法预先知晓中奖者属于哪一笔购买。若在 `SEALED -> DRAW_READY` 变迁中丢弃购买目录，后续的全新客户端在开出赢家时将再次陷入无购买数据可用性的困境。
4. **精确的安全丢弃点**:
   购买目录必须在 `SEALED` 与 `DRAW_READY(counter)` 中全程保持完好。
   **只有在 `DRAW_READY` 成功 ACCEPT 中奖候选者、并通过 Phase D 的 $O(1)$ 查找直接在链上锁定该赢家标准 P2PK 收益地址之后，目录数据才完成了它的全部使命，此时方可在向 `PAID` 或 `WINNER_READY` 变迁时将其彻底丢弃。**

---

## 六、最终裁决

```text
DIRECTORY SEALED + WINNER OWNER PASS

recommended V1 candidate:
    MAX_TOTAL_TICKETS = 100,000
    MAX_PURCHASE_COUNT = 256

NEXT:
    integrate frozen PASS-A randomness with directory-preserving SEALED/DRAW state
```
