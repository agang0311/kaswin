# Kaswin Winner Selection: Stateful Rejection Sampling Specification & VM Audit Report

**快照日期**：2026-09-06 UTC  
**网络**：Kaspa Testnet-10 (TN10)  
**共识基准**：`kaspanet/rusty-kaspa` `v2.0.1` (`cfafeb4c093fa37a303f1b9f19c58f986b870ce3`)  
**状态**：WINNER SELECTION = **PASS** (ENGINE VERIFIED)  

---

## 1. 结论 (RESULT)

**PASS**

**一句话结论**：  
依据 pinned `rusty-kaspa v2.0.1`，采用 56-bit 无符号整数采样域（$R = 2^{56}$）与确定性状态机拒绝采样（Stateful Rejection Sampling）架构，彻底替换了占位符版本的 `DRAW_READY`；证明了在每一个被接受的候选数（$\text{candidate\_num} < \text{LIMIT}$）上，$\text{candidate\_num} \pmod N$ 的条件分布在数学上严格无偏；证明了调用者无法选择或枚举计数器（$\text{counter}$ 属于 UTXO 内部状态，仅允许严格递进 $c \to c+1$）；通过纯 Rust 数学 Reference Oracle 逐项对齐；全套 9 项关键正负测试及边界测试在原生虚拟机中全部通过。

---

## 2. 随机整数域与类型保证 (RANDOM INTEGER DOMAIN)

- **采样域**：$R = 2^{56} = 72,057,594,037,927,936$；
- **提取方法**：
  从 32 字节 candidate 哈希切片前 7 字节并在高位拼接 `0x00`：
  $$\text{cand\_bytes} = \text{candidate\_hash}[0..7] \mathbin{\Vert} [0x00]$$
- **符号位与数字解释**：
  在 Kaspa TxScript 中，第 8 字节为 `0x00` 严格保证了符号位（最高位）为 0，经 `OpBin2Num` 解码后必然是严格落在 $[0, 2^{56})$ 内的非负 64 位有符号整型数（$i64$）。所有算术运算均在 $i64$ 的安全范围内，无溢出风险。

---

## 3. 最大总票数限制 (MAX_TOTAL_TICKETS)

- 协议规定：$1 \le \text{total\_tickets} \le \text{MAX\_TOTAL\_TICKETS}$；
- 协议上限固定为：$\mathbf{100,000,000}$（1亿张彩票，且数学计算安全上界至 $6 \times 10^{16}$）；
- 即使当 $N = 100,000,000$ 时，单次拒绝采样的拒绝概率仅为：
  $$P_{\text{reject}} = \frac{R \pmod N}{R} < \frac{10^8}{7.2 \times 10^{16}} \approx 1.38 \times 10^{-9}$$
  （即超过 99.9999998% 的概率在 counter = 0 处单次成功命中）。

---

## 4. 候选数原像格式与域隔离 (CANONICAL CANDIDATE PREIMAGE)

严格杜绝复用 `KaspaPoWRandomnessV1` 域，采用专用二进制对齐原像：
$$\text{candidate\_hash} = \text{BLAKE2b-256}(\text{"KaswinWinnerCandidateV1"} \mathbin{\Vert} \text{random\_seed}_{[32]} \mathbin{\Vert} \text{le\_u64}(\text{counter})_{[8]})$$

- 字节序列：
  - 前缀：`b"KaswinWinnerCandidateV1"`（23 字节）
  - 随机种子：`random_seed`（32 字节，来自前序 PASS-A 冻结）
  - 计数器：`le_u64(counter)`（8 字节小端序）
  - 总长度：63 字节原像。

---

## 5. 拒绝采样阈值与无偏数学证明 (REJECTION THRESHOLD PROOF)

对于给定的 $R = 2^{56}$ 与 $N = \text{total\_tickets}$：
$$Q = \left\lfloor \frac{R}{N} \right\rfloor, \quad \text{LIMIT} = Q \times N$$

1. **若 $\text{candidate\_num} < \text{LIMIT}$ (Accept Path)**：
   区间 $[0, \text{LIMIT})$ 包含恰好 $Q \times N$ 个离散整数。
   将该区间划分为 $Q$ 个连续等长区间 $[k \cdot N, (k+1) \cdot N)$（$0 \le k < Q$）。
   在每一个小区间内，模 $N$ 运算均等可能地映射到集合 $\{0, 1, \dots, N-1\}$ 中的每一个余数。
   因此，对于任意 $w \in \{0, 1, \dots, N-1\}$：
   $$|\{x \in [0, \text{LIMIT}) \mid x \equiv w \pmod N\}| = Q$$
   即每一个中奖索引 $w$ 的原像数量完全相等（均为 $Q$ 个），在被接受的候选数上：
   $$P(\text{winner\_index} = w \mid \text{Accepted}) = \frac{Q}{Q \cdot N} = \frac{1}{N}$$
   **数学条件分布严格均匀，彻底消除了取模偏置（Modulo Bias）！**

2. **若 $\text{candidate\_num} \ge \text{LIMIT}$ (Reject Path)**：
   本步骤绝不强行取模或妥协降级；而是拒绝该候选数，进入拒绝路径推进计数器。

---

## 6. DRAW_READY 状态格式 (DRAW_READY STATE FORMAT)

`DRAW_READY` 承接前序状态，内部封存完整参数：
$$\text{DRAW\_READY} = \{\text{round\_id}, \text{ticket\_root}, \text{total\_tickets}, \text{target\_hash}, \text{random\_seed}, \text{counter}\}$$

- 初始进入时：$\text{counter} = 0$；
- 脚本自检：强制执行于 Input 0，任何第三方均可无许可（Permissionless）提交交易。

---

## 7. 接受路径状态转移 (ACCEPTED TRANSITION)

- **条件**：$\text{candidate\_num} < \text{LIMIT}$；
- **计算**：$\text{winner\_index} = \text{candidate\_num} \pmod N$；
- **目标输出**：现场由脚本构造 `WINNER_READY` Redeem Script 并计算其 P2SH 地址，断言：
  $$\text{OpTxOutputSpk}(0) == \text{expected\_WINNER\_READY\_spk}$$
- **资金保全**：$\text{OpTxOutputAmount}(0) \ge \text{OpTxInputAmount}(0)$；
- **状态进入**：$\mathbf{WINNER\_READY} \{\text{round\_id}, \text{ticket\_root}, \text{total\_tickets}, \text{target\_hash}, \text{random\_seed}, \text{winner\_index}\}$。

---

## 8. 拒绝路径状态转移 (REJECTED TRANSITION)

- **条件**：$\text{candidate\_num} \ge \text{LIMIT}$；
- **目标输出**：由脚本静态绑定后继 $\text{counter} + 1$ 的 `DRAW_READY` P2SH 地址，断言：
  $$\text{OpTxOutputSpk}(0) == \text{expected\_DRAW\_READY(counter + 1)\_spk}$$
- **资金保全**：$\text{OpTxOutputAmount}(0) \ge \text{OpTxInputAmount}(0)$（执行者自付微量手续费，奖池全额留存）；
- **状态进入**：$\text{DRAW\_READY}(\text{counter} + 1)$。

---

## 9. 计数器不可选性证明 (COUNTER NON-SELECTION PROOF)

1. **不可跳跃性**：$\text{counter}$ 固化在当前 UTXO 的 Redeem Script 中，调用者无法自行提交候选 $\text{counter}$；
2. **唯一后继性**：在拒绝分支中，Redeem Script 内部硬编码检查 Output 0 必须为 $\text{counter} + 1$ 的地址，跳跃到 $\text{counter} + 2$ 或任意其它数均会被 `OpEqualVerify` 拒绝（见测试 3）；
3. **确定性序列**：全网任何人观察到的状态机路径都是唯一且确定的：$c \to c+1 \to \dots \to \text{WINNER\_READY}$，矿工或攻击者无法通过挑选 counter 偏置中奖结果。

---

## 10. 纯 RUST REFERENCE ORACLE 一致性比对 (RUST REFERENCE MATCH)

纯 Rust 数学参考函数 `reference_winner_step`（独立普通算法，不包含任何脚本栈模拟）与虚拟机执行结果比对：
- $N=100$: 虚拟机计算出 winner = 0，与 reference 结果一致；
- $N=37$: 虚拟机计算出 winner = 18，与 reference 结果一致；
- $N=10,000,000$: 虚拟机计算出 winner = 3,875,724，与 reference 结果一致；
- 拒绝用例：虚拟机准确进入拒绝路径，与 reference 结果一致。

---

## 11. 边界与异常处理 (EDGE CASES)

- **$N = 0$**：断言拒绝，协议禁止 $N=0$；
- **$N = 1$**：$\text{winner\_index} \equiv 0$（测试 6 验证通过）；
- **$N$ 为 2 的幂**：$R \pmod N \equiv 0 \implies \text{LIMIT} = R$，拒绝域自然为 0，100% 首次接受；
- **$\text{counter}$ 溢出**：因拒绝率极低（$< 1.4 \times 10^{-9}$），实际步数以高概率 $\le 3$ 步收敛，64 位整型数绝无溢出可能。

---

## 12. 虚拟机全测试矩阵 (VM TEST RESULTS)

测试源码：`tests/rust-vm-validation/src/bin/winner_selection_test.rs`

| 编号 | 测试场景 | 预期行为 | 实测结果 |
| :--- | :--- | :--- | :--- |
| **TEST 1** | $N=100$ 常规候选命中接受路径 | 产出合规 `WINNER_READY` SPK，与 Rust 参考一致 | **PASS** (winner = 0) |
| **TEST 2** | 人工构造进入拒绝域候选 | 产出且仅产出 `DRAW_READY(c+1)` SPK | **PASS** |
| **TEST 3** | 企图在拒绝路径跳步到 `counter + 2` | 被 `OpEqualVerify` 拦截 | **FAIL (拦截成功)** |
| **TEST 4** | 企图在拒绝路径强行产出 `WINNER_READY` | 被 `OpEqualVerify` 拦截 | **FAIL (拦截成功)** |
| **TEST 5** | 接受路径中篡改 `winner_index` | 被 `OpEqualVerify` 拦截 | **FAIL (拦截成功)** |
| **TEST 6** | $N=1$ 边界条件 | 恒定产出 winner = 0 | **PASS** |
| **TEST 7** | 非 2 的幂 $N=37$ | 严格无偏计算并匹配参考 | **PASS** |
| **TEST 8** | 大样本 $N=10,000,000$ (10M) | 无算术溢出并匹配参考 | **PASS** |
| **TEST 9** | 接受与拒绝路径真实交易资源测量 | 见下表 | **PASS** |

---

## 13 & 14. 资源测量与费率 (RESOURCES)

基于 `TESTNET_PARAMS` 与真实 Borsh 序列化测定：

```text
===============================================================
1. DRAW_READY ACCEPT PATH:
  SignatureScript Length      : 306 bytes
  RedeemScript Length         : 303 bytes
  Actual Serialized Wire Bytes: 497 bytes
  Used Script Units           : 1,581 units (单输入免除额度内，B_min = 0)
  Compute Mass                : 877 gram
  Transient Mass              : 2,028 gram
  Fee Mass (Overall)          : 2,028 gram
  Minimum Relay Fee           : 202,800 sompi (0.002028 KAS)
---------------------------------------------------------------
2. DRAW_READY REJECT PATH:
  SignatureScript Length      : 320 bytes
  RedeemScript Length         : 317 bytes
  Actual Serialized Wire Bytes: 511 bytes
  Used Script Units           : 904 units
  Compute Mass                : 891 gram
  Transient Mass              : 2,084 gram
  Fee Mass (Overall)          : 2,084 gram
  Minimum Relay Fee           : 208,400 sompi (0.002084 KAS)
===============================================================
```

---

## 15. WINNER_READY 部署状态 (WINNER_READY STATUS)

**WINNER_READY LOGIC = PLACEHOLDER / NOT DEPLOYABLE UNTIL TICKET PROOF + PAYOUT IS COMPLETE**

当前 `build_canonical_winner_ready_redeem_script` 仅作为承接不可篡改 `winner_index` 的继承状态占位符；**严禁将当前代码直接部署广播至主网或持有真实资金的网络**。

下一阶段必须实现的 Ticket Merkle 叶子节点标准格式：
$$\text{TicketLeafV1} = \text{BLAKE2b-256}(\text{"KaswinTicketV1"} \mathbin{\Vert} \text{round\_id}_{[32]} \mathbin{\Vert} \text{le\_u64}(\text{ticket\_index})_{[8]} \mathbin{\Vert} \text{winner\_payout\_spk})$$

---

## 16. 文件变更清单 (FILES CHANGED)

- `contracts/winner_selection.rs` (状态化拒绝采样核心合约与参考实现)
- `tests/rust-vm-validation/src/bin/winner_selection_test.rs` (完整 9 项关键测试套件)
- `docs/winner-selection-rejection-sampling-report.md` (本审计报告)

---

## 17. 提交记录 (COMMIT)

即将提交至 GitHub 仓库固化。

---

## 18. 下一步动作 (EXACTLY ONE NEXT ACTION)

实现 Canonical Ticket Merkle Proof 验证并在 `WINNER_READY` 处接入最终原子化奖金向获胜者地址支付（Atomic Payout Settlement）。
