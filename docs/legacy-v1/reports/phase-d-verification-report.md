# Phase D: Authenticated Canonical First-Crossing Covenant 审计与验证报告

**快照日期**：2026-09-06 UTC  
**网络**：Kaspa Testnet-10  
**节点**：`wss://vector-10.kaspa.green/kaspa/testnet-10/wrpc/borsh`  
**固定基准**：`kaspanet/rusty-kaspa` `release v2.0.1` (`cfafeb4c093fa37a303f1b9f19c58f986b870ce3`)  

---

## 1. 结论 (RESULT)

**PASS**

**一句话结论**：  
成功废弃了旧有的 27 字节散装元数据原型，实现了**密码学完全自闭环的 Authenticated First-Crossing Covenant（65 字节 Redeem Script）**；证明了 $T_{\mathrm{daa}}$、$T_{\mathrm{parent0}}$ 和 $P_{\mathrm{daa}}$ 是直接从构造 BlockHash 的相同字节流中原地复用与绑定的，不存在任何调用者可单独伪造的元数据输入；在 Rust VM 中通过了全部 6/6 项对抗性矩阵测试（伪造 DAA、伪造 Parent0、后代块及早于边界块均被严格拦截）。

---

## 2. 真实区块头数据与边界 (REAL TARGET & BOUNDARY)

- **ARM 锚定与边界设定**：
  - 设定 $\Delta = 100$ DAA；
  - 选取真实规范首跨块 $T$ 与其前驱父块 $P$：
- **父块 $P$**：
  - **Hash**：`002e28a9428ca469265d9504d4818d18e73c06732100efcc1e658e30febcab81`
  - **DAA Score**：`562665287`
  - **JSON 快照**：`/root/kaswin/artifacts/tn10/phase-d/P-header.json`
- **目标块 $T$**：
  - **Hash**：`549f4a90e6566886af4d80167d3b86f4cb3b189a94caf734e634844d46d3bbaf`
  - **DAA Score**：`562665288`
  - **Parent[0]**：`002e28a9428ca469265d9504d4818d18e73c06732100efcc1e658e30febcab81`（严格等于 $P$ 的哈希）
  - **SeqCommit (`acceptedIdMerkleRoot`)**：`155cbfa45b736b7617e9bb4a91932207908b9e6b47c0a76a595cb06f20970a00`
  - **JSON 快照**：`/root/kaswin/artifacts/tn10/phase-d/T-header.json`
- **数值跨界关系**：
  $$P.\mathrm{daa} \, (562665287) < \mathrm{boundary} \, (562665288) \le T.\mathrm{daa} \, (562665288)$$

---

## 3. 字段密码学溯源与绑定保证 (FIELD BINDING PROVENANCE)

1. **$T_{\mathrm{parent0}}$ 溯源**：
   - 直接作为 Level 0 的第一个 32 字节直接父块推入栈；
   - 脚本原地使用 `OpDup` 复制一份用于后续断言，原件直接与前后字节经 `OpCat` 缝合为完整的 $T$ Header 原像；
   - **防伪保证**：如果调用者替换该 32 字节，$T$ 的 BlockHash 必然改变，导致无法通过 `OpChainblockSeqCommit`。
2. **$T_{\mathrm{daa}}$ 溯源**：
   - 直接作为 Nonce 之后的 8 字节小端序推入栈；
   - 脚本原地 `OpDup` 复制一份暂存至 AltStack，原件直接参与原像拼接；
   - 比较时通过 `OpBin2Num` 将该 8 字节小端序精确转换为脚本数值进行 $\ge \mathrm{boundary}$ 比较。
3. **$P_{\mathrm{daa}}$ 溯源**：
   - 同样作为 $P$ Header 的真实 DAA 8 字节小端序参与 $P$ 的原像哈希计算；
   - 经过 `OpBin2Num` 转换后执行 $< \mathrm{boundary}$ 比较。
4. **结论**：**不存在任何名为 `claimed_daa` 或 `claimed_parent0` 的独立输入，所有比较数值与计算哈希的原像字节严格同源**。

---

## 4. 真实合约脚本与反汇编 (REDEEM SCRIPT)

- **脚本长度**：65 字节
- **代码文件**：`/root/kaswin/contracts/phase_d_covenant.rs`
- **反汇编与谓词映射**：
  - `Op0 OpTxInputDaaScore <100> OpAdd OpToAltStack`: 计算 $\mathrm{boundary}$；
  - `OpSwap OpDup OpToAltStack OpSwap OpCat OpCat`: 绑定并拼装 $T$ 的 DAA 与尾部原像；
  - `OpSwap OpDup OpToAltStack OpSwap OpCat OpCat`: 绑定并拼装 $T$ 的 Parent[0] 与头部原像；
  - `OpData9 "BlockHash" OpBlake2bWithKey`: 计算出 $T$ 的真实 BlockHash；
  - `OpChainblockSeqCommit OpDrop`: 验证 $T$ 在主链上且在深度窗口内；
  - `OpSwap OpDup OpToAltStack OpSwap OpCat OpCat`: 绑定并拼装 $P$ 的 DAA 与完整原像；
  - `OpData9 "BlockHash" OpBlake2bWithKey`: 计算出 $P$ 的真实 BlockHash；
  - `OpFromAltStack OpFromAltStack OpRot OpEqualVerify`: **强制校验 $T_{\mathrm{parent0}} == P_{\mathrm{hash}}$**；
  - `OpBin2Num OpFromAltStack OpFromAltStack OpRot OpOver OpLessThan OpVerify`: **强制校验 $P_{\mathrm{daa}} < \mathrm{boundary}$**；
  - `OpSwap OpBin2Num OpSwap OpGreaterThanOrEqual OpVerify`: **强制校验 $T_{\mathrm{daa}} \ge \mathrm{boundary}$**；
  - `OpTrue`: 验证全部闭合通过。

---

## 5. 对抗性矩阵测试结果 (VM ADVERSARIAL RESULTS)

在 `/root/kaswin/tests/rust-vm-validation/src/bin/vm_phase_d_test.rs` 中运行完整测试：

1. **Valid Authenticated First-Crossing**：`Ok(())`（通过）
2. **Fake $T_{\mathrm{daa}}$ Mutation**：`Err(BlockNotSelected("33ba7c9b..."))`（原像哈希改变，主链检查拒绝）
3. **Fake $P_{\mathrm{daa}}$ Mutation**：`Err(VerifyError)`（$P$ 哈希改变，父子哈希匹配拒绝）
4. **Fake $T_{\mathrm{parent0}}$ Mutation**：`Err(BlockNotSelected("53bb9d27..."))`（原像哈希改变，主链检查拒绝）
5. **Later $T$ ($P_{\mathrm{daa}} \ge \mathrm{boundary}$)**：`Err(VerifyError)`（跨界前驱检查拦截）
6. **Earlier $T$ ($T_{\mathrm{daa}} < \mathrm{boundary}$)**：`Err(VerifyError)`（跨界目标检查拦截）
