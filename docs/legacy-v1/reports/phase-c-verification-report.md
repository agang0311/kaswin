# Phase C: Real Header -> BlockHash -> DAA/Parent0 Binding 审计与链上验证报告

**快照日期**：2026-09-05 UTC  
**网络**：Kaspa Testnet-10  
**节点**：`wss://vector-10.kaspa.green/kaspa/testnet-10/wrpc/borsh`  
**固定基准**：`kaspanet/rusty-kaspa` `release v2.0.1` (`cfafeb4c093fa37a303f1b9f19c58f986b870ce3`)  

---

## 1. 结论 (RESULT)

**PASS**

**一句话结论**：  
成功实现了完整的原生 Header Preimage 规范序列化与 BlockHash 密码学重构；在真实 Kaspa Testnet-10 上通过 P2SH Covenant 成功创建并消费了 `HEADER_BINDING_V1` UTXO（Fund TxID: `02e3ea46...`, Redeem TxID: `f5d6d9fd...`）；全节点共识引擎真实执行了 `OpBlake2bWithKey("BlockHash")` 与 `OpChainblockSeqCommit`；通过了全部 3 项结构化突变测试（`daa_score + 1`, `parent[0]`, `nonce + 1` 均在 VM 中触发 `BlockNotSelected` 拦截）；四方证据完全闭合，证明了在无需 `OpChainblockDaaScore` 的前提下，Covenant 能够通过原像哈希强行绑定 DAA 与 Parent[0]。

---

## 2. 真实区块头数据 (REAL HEADER ARTIFACT)

- **选定主链埋深区块 T**：
  - **Block Hash**：`0d44aacf38d466c6d31b7c1fe648bdb46d8fec1815d79f5fe0ee0eddfc06ccd9`
  - **DAA Score**：`562636838`
  - **Blue Score**：`551688913`
  - **Parent[0] (Selected Parent)**：`2d515cc4b444b1a9a165de131ee7850d517569d947c56ef065226f605013a8ae`
  - **acceptedIdMerkleRoot (SeqCommit)**：`7cfcf003460492cb705cb19e2bb900f074d284f6735c026ec17dffac90f968d8`
  - **Preimage 字节数**：`2,629` 字节
  - **完整 JSON 数据快照**：`/root/kaswin/artifacts/tn10/phase-c/phase-c-T-header.json`

---

## 3. 基准哈希重构与一致性 (REFERENCE HASH MATCH)

依据 `rusty-kaspa` `consensus/core/src/hashing/header.rs` 源码规则序列化 2,629 字节完整原像：
- **RPC 原生返回哈希**：`0d44aacf38d466c6d31b7c1fe648bdb46d8fec1815d79f5fe0ee0eddfc06ccd9`
- **Rust 原像重构计算哈希**：`0d44aacf38d466c6d31b7c1fe648bdb46d8fec1815d79f5fe0ee0eddfc06ccd9`
- **对比判定**：**MATCH (逐字节完全相等)**。

---

## 4. 真实 P2SH 链上 Funding 交易 (P2SH FUND)

- **Fund 交易 ID**：`02e3ea462eefd8afda9dbad88e8dda2f31044cb4c07050a65d29d2be1e04e478`
- **Outpoint**：`02e3ea462eefd8afda9dbad88e8dda2f31044cb4c07050a65d29d2be1e04e478:0`
- **金额**：`1,000,000` sompi (0.01 TKAS)
- **P2SH SPK**：`aa20cef5e248c73ead0a3fe832b0f8f469f74de66578fe3ca737d74e8ec38753015187`
- **P2SH 地址**：`kaspatest:pr80tcjgcul26z3laqetp785d8m5men90rlrefeh6a8gasu82vq4z98qnxs9g`
- **Explorer 验证链接**：`https://tn10.kaspa.stream/transactions/02e3ea462eefd8afda9dbad88e8dda2f31044cb4c07050a65d29d2be1e04e478`

---

## 5. 真实 P2SH 链上 Redeem 交易 (REAL REDEEM)

- **Redeem 交易 ID**：`f5d6d9fd5c2610783e9ea6cc45b43d546bca09fde21bda0a31a08fa42b432a7e`
- **消费的 Outpoint**：`02e3ea462eefd8afda9dbad88e8dda2f31044cb4c07050a65d29d2be1e04e478:0`
- **Signature Script 字节数**：`2,647` 字节（含 2,629 字节完整 Header Preimage）
- **手续费**：`1,000,000` sompi (0.01 TKAS)
- **共识接受状态**：**ACCEPTED AND CONFIRMED**
- **Explorer 验证链接**：`https://tn10.kaspa.stream/transactions/f5d6d9fd5c2610783e9ea6cc45b43d546bca09fde21bda0a31a08fa42b432a7e`

---

## 6. 真实脚本实现与反汇编 (REAL SCRIPT)

- **Redeem Script Hex (14 字节)**：
  ```text
  09426c6f636b48617368a7d47551
  ```
- **反汇编 (Disassembly)**：
  - `09 426c6f636b48617368`: OpData9 "BlockHash" (带密钥哈希的 Key)
  - `a7`: `OpBlake2bWithKey` (计算 Header Preimage 的 BlockHash)
  - `d4`: `OpChainblockSeqCommit` (将 Script 算出的哈希输入主链共识检查器)
  - `75`: `OpDrop` (弹出返回的 SeqCommit 结果)
  - `51`: `OpTrue` (验证通过结束)
- **Blake2b P2SH 承诺哈希**：`cef5e248c73ead0a3fe832b0f8f469f74de66578fe3ca737d74e8ec387530151`（与链上 SPK 逐字节匹配）

---

## 7. 结构化虚拟机突变测试 (VM MUTATIONS)

在 `/root/kaswin/tests/rust-vm-validation/src/bin/vm_header_binding_test.rs` 中使用真实 Header 结构体突变执行：
1. **Valid Header Replay**：`Ok(())`（通过）
2. **Structured DAA Mutation (`header.daa_score += 1`)**：`Err(BlockNotSelected("efc98837..."))`（精准拦截）
3. **Parent[0] Mutation (修改第 0 号直接父块)**：`Err(BlockNotSelected("5a4d21f4..."))`（精准拦截）
4. **Nonce Mutation (`header.nonce += 1`)**：`Err(BlockNotSelected("3281582f..."))`（精准拦截）
- **判定**：全部结构化突变均导致 Blake2b 算出的哈希改变，进而无法在当前链上匹配，在 `OpChainblockSeqCommit` 处触发 `BlockNotSelected` 失败。

---

## 8. 产物路径清单 (ARTIFACTS)

- `/root/kaswin/artifacts/tn10/phase-c/phase-c-T-header.json`
- `/root/kaswin/artifacts/tn10/phase-c/header-preimage.hex`
- `/root/kaswin/artifacts/tn10/phase-c/redeem-script.hex`
- `/root/kaswin/artifacts/tn10/phase-c/fund-txid.txt`
- `/root/kaswin/artifacts/tn10/phase-c/redeem-txid.txt`
- `/root/kaswin/artifacts/tn10/phase-c/broadcast-result.json`
- `/root/kaswin/artifacts/tn10/phase-c/redeem.decoded.json`
