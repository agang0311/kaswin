# Phase D: Bounded Dynamic Forward Header Parser 审计与验证报告

**快照日期**：2026-09-06 UTC  
**环境**：Kaspa Testnet-10 / Pinned Rusty-Kaspa  
**节点源码基准**：`kaspanet/rusty-kaspa` `release v2.0.1` (`cfafeb4c093fa37a303f1b9f19c58f986b870ce3`)  

---

## 1. 结论 (RESULT)

**PASS**

**一句话结论**：  
成功废除了“将 $L=61$ 编译为网络常量”与“假设 $L_P == L_T$”的错误设计，实现了**有界动态正向区块头解析合约（Bounded Dynamic Forward Header Parser，2,881 字节 Redeem Script）**；$L_T$ 与 $L_P$ 分别从各自原像前部 `H[2..10]` 独立动态读取并施加有界网络上限检查；采用单体无切分见证 `[H_P, H_T]`，证明了对任意完全相同的规范 Header 字节串，被认证的 DAA 字段位置存在且仅存在唯一的正向自描述确定性解（`accepted_authenticated_daa_positions == [canonical_offset_reference]`）；在真实 Script Units 预算限制虚拟机中通过了全部 9 项测试（包含 $L_P=60, L_T=61$ 与 $L_P=61, L_T=60$ 的独立非对称用例、畸变 $L=0$ 与 $L > \text{max\_levels}$ 的共识拒绝、以及 `ComputeBudget=36` 严格下界验证）。

---

## 2. 动态 L 设计原理 (DYNAMIC L DESIGN)

针对 Kaspa Script 无通用运行时循环的特性，采用**有界展开与条件求值（Bounded Unrolling with Conditional Advancement）**：

- **网络部署参数**：`max_levels`（Testnet-10 设为 70，主网参数设为 226，源自共识参数 `max_block_level + 1`）；
- **动态读取**：每个区块头自己读取自身实际层级数 $L = \text{OpBin2Num}(H[2..10])$；
- **合规范围检查**：
  $$\text{require}(1 \le L \le \text{max\_levels})$$
- **有界单步展开单元（compile-time $i \in [0, \text{max\_levels}-1]$）**：
  在栈上维护 `[H, L, offset]`，在第 $i$ 步执行：
  ```text
  OpOver <i> OpGreaterThan OpIf
      2 OpPick OpOver OpDup 8 OpAdd OpSubstr OpBin2Num 32 OpMul 8 OpAdd OpAdd
  OpEndIf
  ```
  - 若 $i < L$：动态读取该层级的 $k_i$，指针累加 $8 + 32 \times k_i$；
  - 若 $i \ge L$：`OpIf` 判定为 False，内部切片全部跳过，不触发越界、不消耗推栈 script units，`offset` 保持不动；
- **结束指针**：在 `max_levels` 步后，`offset` 严格停留在 `parents_by_level` 的结尾，随后加上 116 字节固定中间字段，得到精确唯一的 `daa_offset`。

---

## 3. 为什么 `expanded_len` 不是网络常量 (WHY EXPANDED_LEN IS NOT A CONSTANT)

依据 `rusty-kaspa v2.0.1` 源码：
1. `consensus/src/processes/parents_builder.rs:177-179`：
   ```rust
   if block_level > 0 && parents_at_level.as_slice() == std::slice::from_ref(&self.genesis_hash) {
       break;
   }
   parents.push(parents_at_level);
   ```
   区块构建循环在某个 level 的父块集合收敛到 `[genesis_hash]` 时**提前退出**，因此靠近创世或特定拓扑分支的区块其实际 level 数小于 `max_block_level + 1`；
2. `consensus/core/src/header.rs:22-24`：
   ```rust
   pub fn expanded_len(&self) -> usize {
       self.0.last().map(|(cum, _)| *cum as usize).unwrap_or(0)
   }
   ```
   `expanded_len` 严格定义为 RLE 压缩父块结构最后一个 run 的累计值，因此它属于**具体的区块头属性（Block Property）**，而非网络固定常数；
3. **$L_P \ne L_T$ 的必然性**：
   $T$ 在 GHOSTDAG 中可能包含合并分支（Anticone Merge），合并块可能在不同的深度收敛到创世，导致 $T$ 的高层父块结构与选定父块 $P$ 发生偏离。强制要求 $L_P == L_T$ 会导致合法跨界区块无法被兑付而锁死资金。

---

## 4. 规范 DAA 位置唯一性证明 (CANONICAL DAA POSITION PROOF)

对于任意固定的规范 BlockHash 原像 $H$：
- `version` (2B) 与 `expanded_len` (8B) 位于固定偏移 `0..10`；
- $L$ 唯一决定了层级个数；
- 每个层级 $i$ 包含 8 字节长度前缀 $k_i$，由此唯一确定该层级占用 $8 + 32 \times k_i$ 字节，其下一个层级偏移 $100\%$ 唯一确定；
- 固定中间字段（Merkle roots, UTXO commitment, time, bits, nonce）恒为 116 字节；
- **唯一性推论**：
  $$\text{daa\_offset} = 10 + \sum_{i=0}^{L-1}(8 + 32 \times k_i) + 116$$
  该公式是关于 $H$ 的单值确定性函数。由于 Witness 采用单体原像输入，调用者无法提供任何替代切口。

---

## 5. 独立 $L_P \ne L_T$ 实测证据 (L_P != L_T EVIDENCE)

测试源码：`/root/kaswin/tests/rust-vm-validation/src/bin/bounded_dynamic_parser_test.rs`

- **用例 1 (现网样本：$L_T = 61, L_P = 61$)**：`Ok(())` -> **PASS** (Script Units: 358,218)
- **用例 2 ($L_P = 60, L_T = 61$)**：`Ok(())` -> **PASS** (Script Units: 352,969)
- **用例 2b ($L_P = 61, L_T = 60$)**：`Ok(())` -> **PASS** (Script Units: 352,929)
- **用例 3 (小动态层级：$L_P = 3, L_T = 5$)**：`Ok(())` -> **PASS** (Script Units: 13,032)
- **结论**：$T$ 与 $P$ 的层级解析器完全独立，彻底解除了对称性绑定。

---

## 6. 精确字节唯一性证据 (EXACT-BYTES UNIQUENESS EVIDENCE)

将脚本计算得到的 `daa_offset` 与 Rust 权威参考函数 `canonical_offset_reference(H)` 逐字节比对：
- $P$ ($L=61$): Reference = 2566, Script Extracted = 2566 (MATCH)
- $T$ ($L=61$): Reference = 2566, Script Extracted = 2566 (MATCH)
- $P$ ($L=60$): Reference = 2526, Script Extracted = 2526 (MATCH)
- $T$ ($L=5$): Reference = 326, Script Extracted = 326 (MATCH)
- **Accepted Alternative Positions**：**0**
- **Accepted Decompositions for Authenticated DAA**：**EXACTLY 1**

---

## 7. 真实 SCRIPT UNITS、COMPUTE BUDGET 与 MASS

通过 `TxScriptEngine::used_script_units()` 实测并调用 `from_transaction_input_with_script_units_limit` 进行严格边界测试：

- **实测真实消耗 Script Units**：**358,218 units**（双向 61 层解析）；
- **必要 ComputeBudget 承诺**：
  $$\lceil 358,218 / 10,000 \rceil = \mathbf{36} \text{ units}$$
- **产生的 Compute Mass**：$36 \times 100 = \mathbf{3,600} \text{ gram}$（远低于单块 500,000 gram 上限）；
- **边界下界验证**：
  - 传入精确上限 358,218 units：执行结果 **Ok(())**；
  - 传入 $358,218 - 1 = 358,217$ units：精准抛出 `ExceededCommittedScriptUnits { used: 358218, limit: 358217 }` 拒绝。

---

## 8. 见证尺寸与交易上限约束 (WITNESS SIZE BOUND)

- **Redeem Script 尺寸**：**2,881 字节**（`max_levels = 70` 时，远低于 1 MB 脚本上限）；
- **单笔交易总尺寸**：$H_P$ (~2.6 KB) + $H_T$ (~2.6 KB) + RedeemScript (2.88 KB) $\approx$ **8,140 字节**；
- **Consensus Limit 评估**：
  Toccata 激活后 `NEW_MAX_SIGNATURE_SCRIPT_LEN = 250,000` 字节，8,140 字节仅占其 **3.25%**；
  即使针对极端情况（直接父块数达到上限 10 个且跨越 226 层级），Header Preimage 上限约为 8 ~ 10 KB，双区块头见证总尺寸 $< 30$ KB，**绝对在 250 KB 交易见证硬限制的安全边界之内**。

---

## 9. 剩余风险与说明 (REMAINING RISKS)

- **网络参数配置化**：
  Covenant 部署时将 `max_levels` 作为参数（Testnet-10 设为 70，Mainnet 设为 226）。此参数属于部署级常量，不属于单块属性，符合网络级部署规范。
- **算力博弈**：
  单区块 PoW 随机性仍保留矿工丢块（主网单块成本 $\approx 2.31$ KAS）的经济摩擦属性。
