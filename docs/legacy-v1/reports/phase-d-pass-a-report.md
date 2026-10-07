# Kaswin Phase D: KIP-21 PASS-A 升级与验收报告

**日期**：2026-09-06 UTC  
**网络**：Kaspa Testnet-10 (TN10)  
**共识基准**：`kaspanet/rusty-kaspa` `v2.0.1` (`cfafeb4c093fa37a303f1b9f19c58f986b870ce3`)  
**状态**：
- **ENGINE LEVEL**: PASS-A VERIFIED (7/7 tests passed in native TxScriptEngine)
- **CHAIN LEVEL**: PENDING BROADCAST (受限于无离线私钥与受限广播权限，链上 spend txid 待执行节点触发)

---

## 1. 架构升级与旧 Phase D 废弃原因

- **旧 Phase D v1**: **FAIL**
  - **失败原因**：依赖完整区块头原像（Monolithic Two-Header Witness）。Kaspa 区块头包含变长 `parents_by_level` 动态数组，在极端但共识合法的网络拓扑下（例如 $L=251$），两个区块头体积可能超过 250,000 字节的 `SignatureScript` 硬上限，导致持有资金的合约发生资源诱导的永久性死锁（NOT GLOBALLY LIVE）。
  - **处置方式**：旧动态解析器与双区块头代码彻底移出生产路径（DEPRECATED / ARCHIVED）。
- **新 Phase D PASS-A**: **ENGINE VERIFIED / CHAIN PENDING**
  - **架构创新**：基于 KIP-21 递归承诺树，仅提交 240 字节固定去重 Opening Witness（$C_P$ 代入 $T$ 的左子节点），在栈上调用 8 次 `OpBlake3WithKey` 重构并比对 `OpChainblockSeqCommit(T)`。
  - **资源有界性**：彻底消除无界区块头，常数大小（240B Raw Witness），资源诱导死锁风险降为 0。

---

## 2. 核心密码学与操作码统计修正

### 2.1 实际 `OpBlake3WithKey` 次数：**严格为 8 次**
- **重构 $C_P$（4 次哈希）**：
  1. `H_ctx(P)`: `OpBlake3WithKey("SeqCommitMergesetContext", P_sp_timestamp || P_daa || P_blue)`
  2. `P_pd`: `OpBlake3WithKey("SeqCommitmentMerkleBranchHash", P_ctx || P_miner_payload_root)`
  3. `P_sr`: `OpBlake3WithKey("SeqCommitmentMerkleBranchHash", P_activity_root || P_pd)`
  4. `C_P`: `OpBlake3WithKey("SeqCommitmentMerkleBranchHash", P_parent_seq_commit || P_sr)`
- **重构 $C_T$（4 次哈希）**：
  5. `H_ctx(T)`: `OpBlake3WithKey("SeqCommitMergesetContext", T_sp_timestamp || T_daa || T_blue)`
  6. `T_pd`: `OpBlake3WithKey("SeqCommitmentMerkleBranchHash", T_ctx || T_miner_payload_root)`
  7. `T_sr`: `OpBlake3WithKey("SeqCommitmentMerkleBranchHash", T_activity_root || T_pd)`
  8. `C_T`: `OpBlake3WithKey("SeqCommitmentMerkleBranchHash", C_P || T_sr)`
- **说明**：共识树每一层均为二叉 Merkle 分支，P 树与 T 树各包含 1 个上下文哈希与 3 个二叉分支哈希，合计 **8 次**，无跳级。

---

## 3. 真实网络最低 Relay Fee 与资源实测 (TESTNET_PARAMS)

基于 `kaspa_consensus_core::mass::MassCalculator` 与 `TESTNET_PARAMS` 实测：

```text
======================= 真实资源与费率测量 =======================
1. Raw Witness Payload        : 240 bytes
2. RedeemScript 长度           : 315 bytes
3. SignatureScript 实际长度   : 570 bytes (含数据 PUSH 及 redeemScript 压栈)
4. Full Transaction 估算体积  : 698 bytes
5. OpBlake3WithKey 操作数     : 8 次
6. Compute Mass (非上下文)    : 1,130 (单输入免除 50,000 script units 额度后)
7. Transient Mass             : 3,080
8. Fee Mass                   : max(1130, 3080) = 3,080
9. 最低 Relay 费率要求         : 100 sompi / gram
10. 最低网络中继手续费         : 308,000 sompi (0.003080 KAS)
=================================================================
```

---

## 4. 随机数安全与活性边界澄清

1. **安全表述规范**：
   - 本方案提供的是 **未来不可预测（Future Unpredictable）+ 唯一选定目标（Uniquely Selected Target）+ 经济抗偏置（Economically Bias-Resistant）** 的 PoW 随机性；
   - 本方案并未消除矿工发现不利区块后的弃块攻击（Block Withholding Attack）理论偏置能力，严禁宣传为“绝对密码学无偏（Cryptographically Unbiased）”。
2. **活性（Liveness）边界划分**：
   - **Resource-bounded Liveness**: **PASS**（消除了双区块头无界膨胀造成的交易超限死锁）。
   - **Randomness Authentication**: **PASS**（经 TxScript 引擎严格验证）。
   - **Access-window Recovery**: **OPEN**（若超过 12 小时 Finality 窗口未执行 `SEALED -> DRAW_READY` 冻结，目标区块将无法通过 `OpChainblockSeqCommit`，该超期挽救机制作为独立治理议题保持 OPEN）。
