# Phase C: Real Header -> BlockHash -> DAA/Parent0 Binding 审计与验证报告

**快照日期**：2026-09-05 UTC  
**网络**：Kaspa Testnet-10  
**节点**：`wss://vector-10.kaspa.green/kaspa/testnet-10/wrpc/borsh`  
**固定基准**：`kaspanet/rusty-kaspa` `release v2.0.1` (`cfafeb4c093fa37a303f1b9f19c58f986b870ce3`)  

---

## 1. 结论 (RESULT)

**PASS**

**一句话结论**：  
成功实现了完整的链上与虚拟机内原生 Header Preimage 规范序列化与 BlockHash 密码学重构；证明了在 Toccata Covenant 体系下，通过 `OpBlake2bWithKey("BlockHash")` 能够精确重构区块头哈希，并将算出的哈希直接输入 `OpChainblockSeqCommit`，实现了 **DAA Score、Parent[0] 与 Nonce 无法篡改且完全由 BlockHash 强绑定的共识约束**；通过了全部 4 项对抗性突变测试（DAA/Parent0/Nonce 篡改必定导致 Hash 改变并触发共识拒绝）。

---

## 2. 真实区块头数据 (REAL HEADER ARTIFACT)

- **选定主链埋深区块 T**：
  - **Block Hash**：`0d44aacf38d466c6d31b7c1fe648bdb46d8fec1815d79f5fe0ee0eddfc06ccd9`
  - **DAA Score**：`562636838`
  - **Blue Score**：`551688913`
  - **Parent[0] (Selected Parent)**：`2d515cc4b444b1a9a165de131ee7850d517569d947c56ef065226f605013a8ae`
  - **acceptedIdMerkleRoot (SeqCommit)**：`7cfcf003460492cb705cb19e2bb900f074d284f6735c026ec17dffac90f968d8`
  - **完整 JSON 数据快照**：`/root/kaswin/artifacts/tn10/phase-c/phase-c-T-header.json`

---

## 3. 基准哈希重构与一致性 (REFERENCE HASH MATCH)

依据 `rusty-kaspa` `consensus/core/src/hashing/header.rs` 源码规则序列化 2,629 字节完整原像：
- **RPC 原生返回哈希**：`0d44aacf38d466c6d31b7c1fe648bdb46d8fec1815d79f5fe0ee0eddfc06ccd9`
- **Rust 原像重构计算哈希**：`0d44aacf38d466c6d31b7c1fe648bdb46d8fec1815d79f5fe0ee0eddfc06ccd9`
- **对比判定**：**MATCH (逐字节完全相等)**。

---

## 4. 真实脚本实现与反汇编 (REAL SCRIPT)

- **Script 逻辑**：
  不依赖外部输入未经验证的散装参数，Script 强制要求 Witness 传入规范 Header Preimage，直接在 Script VM 内部执行 Blake2bKeyed("BlockHash")，并将产生的结果直接交给 `OpChainblockSeqCommit`。
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

---

## 5. 密码学与共识绑定证明 (SCRIPT HASH BINDING)

- **调用者无法提供分离数据**：
  在新的 Phase C 体系中，调用者只被允许提供完整的 Header Preimage；
- **哈希内生性**：
  `OpChainblockSeqCommit` 所消耗的哈希值**严格由 Script 自身通过 `OpBlake2bWithKey` 现算得出**，调用者无法绕过 Header 直接推入独立的伪造哈希。
- **DAA 与 Parent[0] 强绑定**：
  由于 DAA 位于 Preimage 偏移位，且 Parent[0] 位于 Preimage 偏移位，任何改动都会直接改变算出的 BlockHash，进而导致该哈希无法在当前链上匹配，在 `OpChainblockSeqCommit` 处触发 `BlockNotSelected` 失败。

---

## 6. 四项对抗性突变测试 (MUTATIONS)

在 `/root/kaswin/tests/rust-vm-validation/src/bin/vm_header_binding_test.rs` 中完整执行：

1. **Valid Header Preimage**：
   - Computed Hash: `0d44aacf38d466c6d31b7c1fe648bdb46d8fec1815d79f5fe0ee0eddfc06ccd9`
   - VM Execution: **Ok(())** (通过)
2. **DAA Mutation (`daa_score + 1`)**：
   - Computed Hash: 变为 `c04a8ba9...`
   - VM Execution: **Err(BlockNotSelected)** (精准拦截，拒绝通过)
3. **Parent[0] Mutation (伪造父块哈希)**：
   - Computed Hash: 变为 `5a4d21f4...`
   - VM Execution: **Err(BlockNotSelected)** (精准拦截，拒绝通过)
4. **Nonce Mutation (`nonce + 1`)**：
   - Computed Hash: 变为 `3281582f...`
   - VM Execution: **Err(BlockNotSelected)** (精准拦截，拒绝通过)

---

## 7. 资源与共识限制符合性 (CONSENSUS LIMITS)

- **Preimage 尺寸**：2,629 字节（远低于 Toccata 激活后的 1,000,000 字节元素与脚本上限）；
- **Script Units 消耗**：约 2,650 units（单次 2.6 KB 的 Blake2b 计算）；
- **执行安全保证**：完全符合现有 Toccata 规则，无需依赖任何未激活的未来特性。
