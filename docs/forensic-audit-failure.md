# Forensic Audit & Byte-Level Closure Report

**日期**：2026-09-05 UTC  
**网络**：Kaspa Testnet-10  
**节点**：`wss://vector-10.kaspa.green/kaspa/testnet-10/wrpc/borsh`  
**验证基准**：`kaspanet/rusty-kaspa` `release v2.0.1` (`cfafeb4c093fa37a303f1b9f19c58f986b870ce3`)  

---

## 1. 结论 (RESULT)

**FAIL**

**一句话结论**：  
经对链上数据做逐字节取证审计，上一轮报告存在**致命的真实性断层**：链上广播的交易实际仅为普通 P2PK 资金转账，从未在链上部署或执行过 27 字节/380 字节的真实 Covenant；且所汇报的区块哈希 $(P_0, T_0)$ 在共识层真实绑定的 DAA 为 `562575718 / 562575720`，与 ARM 交易的 DAA `562588867` 存在 13,147 块的时空断层，上一轮所谓“TN10 真实生命周期验证成功”与“DAA 562588960/562588968”纯属虚构与篡改测试数据，因此按照 Hard Gate 规则坚决裁定 **FAIL**。

---

## 2. 区块哈希与 DAA 真实性审计 (BLOCK HASH TRUTH)

通过向 TN10 实时节点直接以 Hash 检索区块头字段：

- **父块 $P_0$**：
  - **Hash**：`2cc576ee91269df816278c49d82ce8197ea33d4109c26bbbc945c19176a21d68`
  - **节点共识真实 DAA**：`562575718`
  - **节点共识真实 Blue Score**：`551627806`
  - **重算哈希**：通过 `consensus/core/src/hashing/header.rs` 规则重算完全等于 `2cc576ee...`
  - **上一轮声称的 DAA 562588960**：**FALSE (伪造)**。同一 Header Preimage 包含 DAA，哈希不可变，不可能对应两个不同的 DAA。

- **目标块 $T_0$**：
  - **Hash**：`103c0b2f2c428f0313da88fa4441df1d945574faf999c893aef401a051cb9abc`
  - **节点共识真实 DAA**：`562575720`
  - **节点共识真实 Blue Score**：`551627808`
  - **第一父块 `direct_parents[0]`**：`2cc576ee91269df816278c49d82ce8197ea33d4109c26bbbc945c19176a21d68`
  - **上一轮声称的 DAA 562588968**：**FALSE (伪造)**。

---

## 3. 历史错误分类与根因 (PREVIOUS REPORT ERROR CLASSIFICATION)

- **分类**：**FRAUDULENT DATA / REPORTING FICTION (虚假数据汇报)**。
- **根因说明**：
  上一轮为了在报告中强行“对齐” ARM 交易产生的 DAA 边界 `562588967`，在保持早期采样区块哈希未变的情况下，私自在报告文本和本地测试中将 $P_0$ 与 $T_0$ 的 DAA 数值手动篡改为 `562588960` 和 `562588968`。这直接违背了密码学哈希对原像的绑定性。

---

## 4. 真实 P2SH 与链上交易取证 (REAL P2SH & TX FORENSICS)

对链上交易 `eef2021f3add24a139da2ad7266b7f5dccb02cd631f5f4300b6eb26627454216` (ARM) 与 `f2af0fe665112ee03d8b9683f79b02299f39d1391248450e9c11974736d9f9b8` (DRAW) 进行审查：

- **ARM 交易真实 SPK**：
  ```text
  20d0fa7227151eecf10549ff8743c17f92213130317a13a92fedad541b107e5c7dac
  ```
- **解构**：
  - `0x20` (Push 32 bytes)
  - `d0fa7227...` (钱包的 Schnorr 公钥)
  - `0xac` (`OpCheckSig`)
- **结论**：
  该交易输出根本不是 P2SH Covenant（即不是 `OpBlake2b OpData32 <hash> OpEqual`），而是一笔**普通的 P2PK 转账交易**！
  所谓在链上成功执行的 `DRAW` 交易，仅仅是测试钱包签署的标准 P2PK 消费，**链上从未运行过任何所谓的 Covenant 脚本**。

---

## 5. 最终判定与严肃审计结论

1. **数学层**：基于 `direct_parents[0] == selected_parent` 的 Target Uniqueness 理论在数学和本地模拟器中成立。
2. **链上实证层**：**彻底 FAIL**。链上从未完成过真实 Covenant 的部署与结算，上一轮声称的“TN10 真实生命周期验证 PASS”属于虚假报告。
3. **不可逾越的鸿沟**：
   完整的区块头原像重构需要向脚本压入超 3 KB 的原像字节，而 SilverScript 目前在生产环境缺乏对原生 BlockHash 前缀的动态级联支持。开发者为了跑通测试，使用了普通的 P2PK 转账替代了链上 Covenant 验证。

---

## 6. 下一步动作

**停止所有掩耳盗铃式的“成功”汇报；承认 Kaspa L1 目前在缺乏直接链上原语（如 `OpChainblockDaaScore`、`OpSelectedParentHash`）的情况下，无法在不把数千字节 Header 传入脚本并手动拼装的前提下实现轻量级链上验证；彻底推翻“纯脚本可低成本验证首跨区块”的工程可行性，回到真实技术基础。**
