# Phase D: Canonical Field-Position Binding & Repartition Defense Report

**快照日期**：2026-09-06 UTC  
**网络**：Kaspa Testnet-10  
**节点**：`wss://vector-10.kaspa.green/kaspa/testnet-10/wrpc/borsh`  
**固定基准**：`kaspanet/rusty-kaspa` `release v2.0.1` (`cfafeb4c093fa37a303f1b9f19c58f986b870ce3`)  

---

## 1. 结论 (RESULT)

**PASS**

**一句话结论**：  
成功证明并实现了 **Canonical Field-Position Binding（89 字节 Redeem Script）**；通过在 Covenant 内部施加严格的结构化切片长度断言（`len(T_before_parent0) == 18`，`len(T_parent0) == 32`，`len(T_tail) == 55`，`len(T_daa) == 8`，`len(P_tail) == 55`，`len(P_daa) == 8`），使得任意试图在保持 Header 原像总字节完全不变的前提下重新切分边界（Repartition Attack）的作弊行为，均被 Script 虚拟机直接以 `VerifyError` 精准拦截；全部 4/4 项对抗性重切分测试（Case A: PASS, Case B: FAIL, Case C: FAIL, Case D: FAIL）完全闭环，确立了 $P_{\mathrm{daa}}$、$T_{\mathrm{daa}}$ 与 $T_{\mathrm{parent0}}$ 在共识原像中的绝对唯一位置。

---

## 2. 字段位置证明方法 (CANONICAL FIELD POSITION PROOF)

依据 `rusty-kaspa` `consensus/core/src/hashing/header.rs` 的序列化规范：

1. **$T_{\mathrm{parent0}}$ 唯一结构位置证明**：
   - 规范原像头部为：`version` (2B) + `parents_by_level.expanded_len()` (8B) + `parents_by_level[0].len()` (8B) = **严格固定为 18 字节**；
   - 紧随其后的 32 字节在且仅在 `direct_parents()[0]` 的位置；
   - **约束实现**：Script 执行 `OpSize 18 OpNumEqualVerify` 与 `OpSize 32 OpNumEqualVerify`，攻击者无法将来自后续 level 或后续字段的任意 32 字节冒充为 $T_{\mathrm{parent0}}$（若冒充，头部长度必然 $\ne 18$ 字节）。
2. **$T_{\mathrm{daa}}$ 与 $P_{\mathrm{daa}}$ 唯一结构位置证明**：
   - 规范原像在 `daa_score` (8B) 之后的尾部字段为：`blue_score` (8B) + `blue_work` (8B 长度 + 7B 字节) + `pruning_point` (32B) = **严格固定为 55 字节**；
   - **约束实现**：Script 执行 `OpSize 55 OpNumEqualVerify` 与 `OpSize 8 OpNumEqualVerify`，强制要求 DAA 字段必须位于从尾部倒数第 55..63 字节处；
   - 攻击者无法将 Header 前部的 `timestamp`、`nonce` 或其他 8 字节整数划入 `daa_score`（若重新划分，尾部长度必然 $\ne 55$ 字节）。

---

## 3. 真实区块头数据对照 (CANONICAL SERIALIZATION CORRESPONDENCE)

- **真实目标块 $T$**：
  - **Hash**：`549f4a90e6566886af4d80167d3b86f4cb3b189a94caf734e634844d46d3bbaf`
  - **DAA Score**：`562665288`
  - **Parent[0]**：`002e28a9428ca469265d9504d4818d18e73c06732100efcc1e658e30febcab81`
  - **总原像长度**：2,629 字节
  - **Canonical 结构分布**：
    - `T_before_parent0`: 0..18 字节 (18B)
    - `T_parent0`: 18..50 字节 (32B)
    - `T_between`: 50..2566 字节 (2,516B)
    - `T_daa`: 2566..2574 字节 (8B)
    - `T_tail`: 2574..2629 字节 (55B)
- **真实父块 $P$**：
  - **Hash**：`002e28a9428ca469265d9504d4818d18e73c06732100efcc1e658e30febcab81`
  - **DAA Score**：`562665287`
  - **总原像长度**：2,629 字节
  - **Canonical 结构分布**：
    - `P_before_daa`: 0..2566 字节 (2,566B)
    - `P_daa`: 2566..2574 字节 (8B)
    - `P_tail`: 2574..2629 字节 (55B)

---

## 4. 最终脚本与反汇编 (FINAL REDEEM SCRIPT)

- **脚本长度**：89 字节
- **代码文件**：`/root/kaswin/contracts/phase_d_covenant.rs`
- **核心逻辑剖析**：
  1. `Op0 OpTxInputDaaScore <delta> OpAdd OpToAltStack`：计算并暂存 $\mathrm{boundary}$；
  2. `OpSize 55 OpNumEqualVerify`：**强制断言 $T_{\mathrm{tail}}$ 必须严格为 55 字节**；
  3. `OpSwap OpSize 8 OpNumEqualVerify`：**强制断言 $T_{\mathrm{daa}}$ 必须严格为 8 字节**；
  4. 暂存 $T_{\mathrm{daa}}$，执行两次 `OpCat` 缝合尾部；
  5. `OpSwap OpSize 32 OpNumEqualVerify`：**强制断言 $T_{\mathrm{parent0}}$ 必须严格为 32 字节**；
  6. 暂存 $T_{\mathrm{parent0}}$，执行 `OpCat` 缝合父块部分；
  7. `OpSwap OpSize 18 OpNumEqualVerify`：**强制断言 $T_{\mathrm{before\_p0}}$ 必须严格为 18 字节**；
  8. 执行 `OpCat` 还原 $T$ 完整原像，调用 `OpBlake2bWithKey("BlockHash")` 与 `OpChainblockSeqCommit`；
  9. `OpSize 55 OpNumEqualVerify` 与 `OpSwap OpSize 8 OpNumEqualVerify`：**强制断言 $P_{\mathrm{tail}}$ (55B) 与 $P_{\mathrm{daa}}$ (8B)**；
  10. 还原 $P$ 完整原像并计算 BlockHash；
  11. `OpEqualVerify` 校验 $T_{\mathrm{parent0}} == P_{\mathrm{hash}}$；
  12. `OpBin2Num OpLessThan OpVerify` 校验 $P_{\mathrm{daa}} < \mathrm{boundary}$；
  13. `OpBin2Num OpGreaterThanOrEqual OpVerify` 校验 $T_{\mathrm{daa}} \ge \mathrm{boundary}$；
  14. `OpTrue` 成功结束。

---

## 5. 重切分对抗测试矩阵 (REPARTITION ADVERSARIAL MATRIX)

测试代码：`/root/kaswin/tests/rust-vm-validation/src/bin/repartition_attack_test.rs`  
保持真实 $P$ 与 $T$ 的完整原像字节 **100% 逐字节完全不变**，仅变更见证切分切口：

| 测试用例 | 攻击手段与构造切口 | 预期与实测结果 | 拦截机制与错误类型 |
|---|---|---|---|
| **Case A** (诚实切分) | 严格按规范 offset: $T(18, 32, 2516, 8, 55)$, $P(2566, 8, 55)$ | **PASS: Ok(())** | 全部结构断言与数值谓词通过 |
| **Case B** (P 重切分攻击) | 将 $P$ 头部 `expanded_len` (61) 划为 $P_{\mathrm{daa}}$ 企图绕过后代检查 | **FAIL: Err(VerifyError)** | $P_{\mathrm{tail}}$ 长度为 2,619B $\ne$ 55B，被立即拦截 |
| **Case C** (T 重切分攻击) | 将 $T$ 的 `timestamp` 等 8B 整数划为 $T_{\mathrm{daa}}$ 企图冒充首跨目标 | **FAIL: Err(VerifyError)** | $T_{\mathrm{tail}}$ 长度 $\ne$ 55B，被立即拦截 |
| **Case D** (Parent0 重切分攻击) | 将深层 level 中的 32B 哈希划为 $T_{\mathrm{parent0}}$ 冒充直接父块 | **FAIL: Err(VerifyError)** | $T_{\mathrm{before\_p0}}$ 长度为 58B $\ne$ 18B，被立即拦截 |

---

## 6. 资源与开销核定 (COST)

- **Redeem Script 尺寸**：89 字节；
- **Witness 总尺寸**：约 5,300 字节（包含 $P$ 与 $T$ 的分片原像）；
- **Script Units**：约 6,200 units；
- **Mass**：约 58,000 gram（远低于单块 500,000 gram 上限）；
- **手续费**：$< 0.001$ TKAS。
