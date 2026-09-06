# Kaswin SEALED -> DRAW_READY Randomness Freeze Audit Report

**快照日期**：2026-09-06 UTC  
**网络**：Kaspa Testnet-10 (TN10)  
**共识基准**：`kaspanet/rusty-kaspa` `v2.0.1` (`cfafeb4c093fa37a303f1b9f19c58f986b870ce3`)  
**状态**：ENGINE VERIFIED (All 8 Test Cases Passed) / CHAIN PENDING AUTHORIZATION  

---

## 1. 架构与状态机集成 (STATE MACHINE INTEGRATION)

Kaswin 完整协议状态机演进：
$$\text{OPEN / SELLING} \longrightarrow \text{SEALED} \xrightarrow[\text{Randomness Freeze}]{\text{KIP-21 PASS-A}} \mathbf{DRAW\_READY} \longrightarrow \text{PAID}$$

本阶段正式闭环了 **`SEALED -> DRAW_READY`** 状态转换：
1. **输入验证**：消费处于 `SEALED` 状态的奖池 UTXO（包含 `sealed_base_daa`，锁定目标边界 $\text{boundary} = \text{sealed\_base\_daa} + \Delta_{\text{daa}}$）；
2. **密码学重构**：见证提供 240 字节紧凑型 Opening 数据，在虚拟机栈上通过 8 次 `OpBlake3WithKey` 递归重构 $C_P$ 与 $C_T$；
3. **共识认证**：调用 `OpChainblockSeqCommit(target_hash)` 强校验目标区块 $T$ 确实位于活跃主链，并验证首跨断言 $P.\text{daa} < \text{boundary} \le T.\text{daa}$；
4. **确定性派生**：Covenant 脚本基于 $T\text{\_hash}$ 与轮次上下文自主计算 `random_seed`，严禁任何外部调用者操纵或直接提交种子；
5. **状态冻结**：构造继承 UTXO，将 `(target_hash, random_seed)` 以及本轮所有参数永久硬编码写入 `DRAW_READY` 的 Redeem Script，并在链上断言输出 `OpTxOutputSpk(0)` 严格匹配。

---

## 2. 随机数派生规范 (CANONICAL RANDOM SEED DERIVATION)

为防止跨轮次重放并确保与应用层状态完全绑定，采用严谨的域隔离双层哈希派生：

### 2.1 应用层承诺 (Application Commitment)
$$\text{app\_commitment} = \text{BLAKE2b-256}(\text{"KaswinAppV1"} \mathbin{\Vert} \text{round\_id}_{[32]} \mathbin{\Vert} \text{ticket\_root}_{[32]} \mathbin{\Vert} \text{le\_u64}(\text{total\_tickets}))$$

### 2.2 终态随机数种子 (Random Seed)
$$\text{random\_seed} = \text{BLAKE2b-256}(\text{"KaspaPoWRandomnessV1"} \mathbin{\Vert} \text{target\_hash}_{[32]} \mathbin{\Vert} \text{app\_commitment}_{[32]})$$

- **字节序与编码**：纯二进制严格对齐（Little-Endian 整数、大端/原生哈希字节序），杜绝平台相关序列化。

---

## 3. 跨生命周期解耦 (SEQCOMMIT DECOUPLING)

进入 `DRAW_READY` 状态后：
- `target_hash` 与 `random_seed` 已作为常量固化在 successor UTXO 中；
- 后续所有的中奖计算、开奖证明（Ticket Merkle Proof）以及资金结算（Payout）**绝不再次调用 `OpChainblockSeqCommit`，也不再需要提供任何 $P/T$ 区块头或 Opening 数据**；
- 彻底免疫未来因结算延迟导致超出 SeqCommit Access Window（~12小时）的资金锁定风险。

---

## 4. 测试与攻击防护矩阵 (TEST & SECURITY MATRIX)

测试代码：`tests/rust-vm-validation/src/bin/sealed_to_draw_ready_test.rs`

| 用例编号 | 测试目标与攻击场景 | 预期行为 | 实测结果 |
| :--- | :--- | :--- | :--- |
| **TEST A** | 正常合规开奖冻结流程 (Normal Freeze) | $C_P, C_T$ 重构通过，种子正确写入，输出 SPK 匹配 | **PASS** (Used units: 3,469) |
| **TEST B** | 篡改 $T.\text{daa}$ 伪造跨越点 (Tampered Target DAA) | 导致 Merkle 上下文哈希不匹配，SeqCommit 断言失败 | **FAIL (拦截成功)** |
| **TEST C** | 越界 $P.\text{daa} \ge \text{boundary}$ (P DAA Invalid) | 首跨谓词检查不满足，`OpLessThan` 触发 `OpVerify` 失败 | **FAIL (拦截成功)** |
| **TEST D** | 滞后目标攻击 (Later-Target Attack, 矿工跳过首跨块) | 后续区块的父块已跨界，首跨谓词被拦截，无法选择有利于矿工的后续块 | **FAIL (拦截成功)** |
| **TEST E** | 伪造目标区块哈希 (Mismatched Target Hash) | `OpChainblockSeqCommit` 返回承诺与树结构不符，`OpEqualVerify` 拦截 | **FAIL (拦截成功)** |
| **TEST F** | 种子篡改攻击 (Seed Tampering, 调用者试图注入有利于自己的种子) | 输出 SPK 计算与脚本内置计算不匹配，`OpEqualVerify` 拦截 | **FAIL (拦截成功)** |
| **TEST G** | 跨轮次重放攻击 (Cross-Round Replay Attack) | 轮次 ID 与应用承诺变更导致输出 SPK 不匹配，拦截非法结算 | **FAIL (拦截成功)** |
| **TEST H** | 完整交易开销与费率核算 (Resource Measurement) | 完整 1-in-1-out 交易尺寸及费率远低于共识上限 | **PASS** |

---

## 5. 完整交易资源核算 (REALISTIC TRANSACTION RESOURCES)

基于 `TESTNET_PARAMS` 官方 `MassCalculator` 针对完整 `SEALED -> DRAW_READY` 交易进行测量：

- **Witness 原始数据**：240 bytes
- **SignatureScript 长度**：738 bytes（含数据 Push 前缀及 P2SH RedeemScript 压栈）
- **RedeemScript 长度**：483 bytes（含 8 次 Blake3、SeqCommit、Seed 派生与 SPK 现场构造）
- **完整序列化交易预估体积**：375 bytes
- **实际消耗 Script Units**：**3,469 units**（远低于单输入免费的 9,999 units 额度，所需 $B_{\min} = 0$）
- **Compute Mass**：1,309 gram
- **Transient Mass**：3,756 gram
- **Storage Mass**：0 gram
- **Fee Mass**：$\max(1309, 3756) = \mathbf{3,756 \text{ gram}}$
- **最低网络中继手续费**：**375,600 sompi (0.003756 KAS)**

---

## 6. 活性与治理边界说明

- **Randomness Authentication**: **PASS**（经 native TxScriptEngine 严密校验通过）。
- **Target Uniqueness**: **PASS**（严格拦截 Later-Target 攻击，确保全链首跨块唯一性）。
- **Resource Boundedness**: **PASS**（常数见证体积，彻底消除旧 Phase D 见证膨胀风险）。
- **Access-window Recovery**: **OPEN**（若超过约 12 小时无人触发，由于未在窗口内冻结，该超期挽救/退款机制作为独立治理议题继续保持 OPEN）。
- **威胁模型规范**：本方案提供的是**未来不可预测（Future-Unpredictable）+ 唯一选定（Uniquely Selected）+ PoW 衍生**的随机性，威胁模型保留矿工经济弃块偏置（Miner-Withholding Bias）。
