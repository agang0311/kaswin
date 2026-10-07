# Phase D: Witness Size Bound & Monolithic Two-Header Audit Report

**快照日期**：2026-09-06 UTC  
**网络**：Kaspa Testnet-10 / Pinned Rusty-Kaspa  
**节点源码基准**：`kaspanet/rusty-kaspa` `release v2.0.1` (`cfafeb4c093fa37a303f1b9f19c58f986b870ce3`)  

---

## 1. 结论 (RESULT)

**FAIL**

**一句话结论**：  
虽然已成功修复 Blocker B（隔离测试证明 $L=252$ 真实在有效 BlockHash 与 SeqCommit 之后被 parser 的 `max_levels=251` 断言以 `VerifyError` 严格拦截），但在对共识规则进行严格源码推导后确认：**`rusty-kaspa v2.0.1` 仅对 Level 0 直接父块施加了 `max_block_parents = 16` 限制，对所有间接层级（Levels 1..250）未施加任何有限且足够小的全局基数不变量**；由于无法证明合法区块头原像尺寸 $|H_P| + |H_T| \le 239,618$ 字节，单体双区块头见证在病态或宽分叉拓扑下必然存在溢出 `NEW_MAX_SIGNATURE_SCRIPT_LEN = 250,000` 字节硬限制的风险；因此 **Monolithic Two-Header 方案无法保证全域活性（NOT GLOBALLY LIVE）**，按照 Hard Gate 规则严肃判定为 **FAIL**，坚决禁止进行真实 TN10 广播。

---

## 2. L=252 隔离解析器测试结果 (L=252 ISOLATED PARSER RESULT)

测试源码：`/root/kaswin/tests/rust-vm-validation/src/bin/prod_candidate_test.rs`
- **测试方法（方案 A 优先实施）**：
  1. 构造类型上可序列化的 $L=252$ 完整区块头夹具；
  2. 调用官方 `header_hashing::hash(&t_l252)` 计算其真实 BlockHash；
  3. 将该新哈希注册到 Mock SeqCommit 中，确保 `OpChainblockSeqCommit` 验证**完全通过**；
  4. 运行虚拟机执行完整 Covenant：
     - `BlockHash(H_T)` 计算成功；
     - `OpChainblockSeqCommit` 成功消费；
     - 进入正向解析器读取 $L = 252$；
     - 执行 `252 <= 251`（`OpLessThanOrEqual`）返回 False，触发 `OpVerify`；
     - 虚拟机精准返回：`Err(TxScriptError::VerifyError)`！
- **结论**：Blocker B 彻底解决，确认了超限层级是在解析器断言级别被精准拒绝，而非被无效哈希掩盖。

---

## 3. 间接父块基数不变量审查 (INDIRECT-PARENT CARDINALITY INVARIANTS)

深入审查 `rusty-kaspa v2.0.1` 共识源码：
1. **直接父块限制 (`consensus/core/src/config/bps.rs:57-65`)**：
   ```rust
   pub const fn max_block_parents() -> u8 { ... 16 }
   ```
   并在 `pipeline/header_processor/pre_ghostdag_validation.rs:53` 中强制检查：`header.direct_parents().len() <= max_block_parents`。该限制**严格仅作用于 Level 0**！
2. **间接父块构建 (`consensus/src/processes/parents_builder.rs:73-104`)**：
   在 Level $i \ge 1$ 处，候选父块集合为所有直接父块在 Level $i$ 的父块并集。算法通过 `level_candidates_to_reference_blocks.retain(...)` 仅做 DAG 反链（Antichain）过滤，**没有任何代码行对 `parents_at_level.len()` 施加 $\le 16$ 的硬截断**；
3. **后置验证 (`pipeline/header_processor/post_pow_validation.rs:56-65`)**：
   `check_indirect_parents` 仅断言传入的 `parents_by_level` 必须严格等于节点重新运行 `calc_block_parents()` 的结果，**没有对总字节数或总父块数设置独立上限**；
4. **不变量结论**：**NOT PROVEN（共识层未提供间接父块数量的严格常数界限）**。

---

## 4. 共识合法 |H_P| + |H_T| 最大理论尺寸推导 (MAX CONSENSUS-VALID |H_P| + |H_T|)

- **单区块头原像理论最坏情况**：
  在 Testnet-10 上，$L \le 251$。若在最恶劣或高并发未收敛拓扑下，每个层级平均包含 16 个直接反链候选：
  - 每层尺寸：$8 + 16 \times 32 = 520$ 字节；
  - 251 层总尺寸：$251 \times 520 = 130,520$ 字节；
  - 固定字段（版本、时间戳、Merkle根、DAA、Work、剪枝点等）：216 字节；
  - 单区块头理论极值：
    $$\text{MAX\_SINGLE\_HEADER} \approx 130,520 + 216 = \mathbf{130,736} \text{ 字节 (约 130.7 KB)}$$
- **双区块头联合极值**：
  若相邻的 $P$ 与 $T$ 均处于高分叉拓扑（$L_P \approx 250, L_T \approx 251$）：
  $$\text{MAX\_PAIR\_HEADER\_BYTES} = |H_P| + |H_T| \approx 130,736 + 130,736 = \mathbf{261,472} \text{ 字节 (约 261.5 KB)}$$

---

## 5. 签名脚本最坏情况精确核算 (EXACT WORST-CASE SIGNATURE SCRIPT BYTES)

依据 pinned `ScriptBuilder::canonical_data_size` 规范：
- Payload $> 65,535$ 字节时，采用 `OpPushData4`，单项推送前缀开销为 **5 字节**；
- 生产 Redeem Script（10,369 字节）采用 `OpPushData2`，推送前缀开销为 **3 字节**（$10,369 + 3 = 10,372$ 字节）；
- **最大签名脚本字节数公式**：
  $$\text{MAX\_SIG\_SCRIPT\_BYTES} = (|H_P| + 5) + (|H_T| + 5) + 10,372 = (|H_P| + |H_T|) + 10,382$$
- **容纳上限**：
  依据 `consensus/core/src/config/params.rs`：`NEW_MAX_SIGNATURE_SCRIPT_LEN = 250,000` 字节；
  双区块头净原像允许的最大空间为：
  $$|H_P| + |H_T| \le 250,000 - 10,382 = \mathbf{239,618} \text{ 字节}$$
- **算术冲突判定**：
  $$\text{最坏情况需求 } (261,472 \text{ B}) > \text{共识最大允许 } (239,618 \text{ B})$$
  **超限 21,854 字节**！

---

## 6. 最坏情况 SCRIPT UNITS 评估 (WORST-CASE SCRIPT UNITS)

- 在 $L_P = 251, L_T = 251$ 极端情况下，实测单个展开层级消耗约 5,279,484 units；
- 双向 251 层全展开消耗：约 **10,500,000 units**；
- 该消耗在计算资源层面虽未超限（仍可用 `ComputeBudget` 表达），但签名脚本字节尺寸已在共识反序列化阶段直接违规。

---

## 7. 最坏情况最小 COMPUTE BUDGET (WORST-CASE MINIMUM COMPUTEBUDGET)

- 依据 $\lceil (10,500,000 - 9,999) / 10,000 \rceil$：
  $$B_{\min} \approx \mathbf{1,050} \text{ units}$$
- 满足 $u16$（上限 65,535）取值范围，但在字节超限前提下已失去意义。

---

## 8. 最坏情况 MASS (WORST-CASE MASS)

- **Compute Mass**：$1,050 \times 100 = 105,000$ gram；
- **Transient Mass**：$> 260,000$ gram；
- 违反单交易签名脚本尺寸上限。

---

## 9. MONOLITHIC TWO-HEADER 是否具备全域活性？

**结论：NOT GLOBALLY LIVE（不具备全域活性）**

**原因**：
虽然在日常运行中区块头通常较小（约 2.6 KB ~ 4.2 KB），但在 Kaspa 去中心化无许可网络中，任何依赖“两个完整 Monolithic 区块头必须塞进单笔交易的签名脚本”的 Covenant，都无法在数学上证明不会遭遇极端拓扑导致见证突破 250 KB 硬限制。一旦首跨区块 $T$ 或其父块 $P$ 的层级父块膨胀，该 ARMED UTXO 将因签名脚本超限而永久无法被任何节点打包，形成**不可逆的资金卡死（Permanent Liveness Failure）**。

---

## 10. 文件变更清单 (FILES CHANGED)

- `docs/witness-size-bound-and-monolithic-audit.md` (本审计报告)
- `tests/rust-vm-validation/src/bin/prod_candidate_test.rs` (修复 Blocker B，实现真实的 $L=252$ 隔离测试并验证 VerifyError 拦截)
- `tests/rust-vm-validation/src/bin/measure_script_units.rs` (统一调用生产单一构建源)

---

## 11. 提交记录 (COMMIT)

即将提交至 GitHub 仓库作为证据固化。

---

## 12. 下一步动作 (EXACTLY ONE NEXT ACTION)

**坚决停止当前 Monolithic Two-Header 见证方案；下一步只重新设计 Phase D 的见证解构结构（例如：将完整 Header 拆分为分片提交、或通过前序交易分别锚定 P 与 T 的承诺、或采用 Merkle 证明），彻底消除将两个数千字节完整区块头同时压入单笔交易 Signature Script 的单点尺寸瓶颈。**
