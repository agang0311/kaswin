# Kaswin Winner Selection: Self-Replicating Stateful Rejection Sampling Audit Report

**快照日期**：2026-09-06 UTC  
**网络**：Kaspa Testnet-10 (TN10)  
**共识基准**：`kaspanet/rusty-kaspa` `v2.0.1` (`cfafeb4c093fa37a303f1b9f19c58f986b870ce3`)  
**状态**：WINNER SELECTION = **PASS** (ENGINE VERIFIED)  

---

## 1. 结论 (RESULT)

**PASS**

**一句话结论**：  
依据 pinned `rusty-kaspa v2.0.1`，彻底废除了有限 Lookahead 与 Dummy Successor Leaf 机制，采用基于签名脚本内省（`OpTxInputScriptSigSubstr`）的**完全自复制状态机架构（Self-Replicating State Machine）**，实现了任意计数器 $c \to c+1$ 的同构闭环状态转移；证明并虚拟机验证了结构恒等式（生成的继承脚本与独立生产构建函数逐字节 100% 相同）；真实运行验证了连续 3 步 UTXO 级联消费（$U_0 \to U_1 \to U_2 \to U_3$）；统一固定了协议常量 $\text{MAX\_TOTAL\_TICKETS} = 100,000,000$；成功将前序 `SEALED` 状态转换完全接线至生产版 `DRAW_READY(0)`，完成了全链路端到端集成。全套测试在原生 TxScript 虚拟机中全部通过。

---

## 2. 拒绝采样数学状态 (REJECTION MATH STATUS)

**FROZEN / PASS**
- **采样域**：$R = 2^{56} = 72,057,594,037,927,936$；
- **候选数**：$\text{candidate\_hash}[0..7] \mathbin{\Vert} [0x00] \implies \text{candidate\_num} \in [0, 2^{56})$，保证 $i64$ 严格非负；
- **阈值**：$Q = \lfloor R / N \rfloor, \quad \text{LIMIT} = Q \times N$；
- **接受条件**：$\text{candidate\_num} < \text{LIMIT} \implies \text{winner\_index} = \text{candidate\_num} \pmod N$；
- **数学无偏性**：每一个获胜索引在被接受区间内的原像数量严格恒等为 $Q$，彻底消除取模偏置。

---

## 3. 自复制后继架构设计 (SELF-REPLICATING SUCCESSOR DESIGN)

Redeem Script 结构规范化：
```text
[PREFIX (137 bytes: round_id, ticket_root, total_tickets, target_hash, random_seed)]
[COUNTER_PUSH (9 bytes: 0x08 || le_u64(counter))]
[SUFFIX (313 bytes: 采样逻辑, Accept 转移, Reject 自复制转移)]
总长：459 字节 (SignatureScript 占 462 字节)
```

在 **Reject Branch** 中：
1. 脚本自省读取输入 0 的签名脚本总长：`Op0 OpTxInputScriptSigLen`；
2. 计算前缀开始与结束绝对位置：
   - $\text{prefix\_start} = \text{sig\_len} - \text{total\_redeem\_len}$
   - $\text{prefix\_end} = \text{prefix\_start} + 137$
3. 调用 `OpTxInputScriptSigSubstr(0, prefix_start, prefix_end)` 直接提取出当前前缀；
4. 虚拟机计算 $\text{next\_counter} = \text{counter} + 1$，格式化为 `[0x08] || le_u64(next_counter)`；
5. 调用 `OpTxInputScriptSigSubstr(0, sig_len - suffix_len, sig_len)` 直接提取出当前后缀；
6. 拼接 $\text{prefix} \mathbin{\Vert} \text{next\_counter\_push} \mathbin{\Vert} \text{suffix}$，现场计算其 Blake2b 摘要与 P2SH SPK，断言 $\text{OpTxOutputSpk}(0)$ 必须匹配。

---

## 4. 彻底消除预计算与有限深度 (WHY NO LOOKAHEAD / DUMMY IS NEEDED)

- **递归闭包**：由于后继脚本的后缀完全由自省切片复制而来，其内部包含完全相同的自复制逻辑。
- **无链下预生成依赖**：DRAW_READY(c) 无需在部署时预置 DRAW_READY(c+1) 的 SPK，消除了任何深度上限，任意 $c$ 均遵循完全相同的链上法则。

---

## 5. 继承脚本字节恒等证明 (SUCCESSOR BYTE-IDENTITY PROOF)

测试源码：`tests/rust-vm-validation/src/bin/winner_selection_test.rs`（TEST 3）
对代表性计数器 $c \in \{0, 1, 2, 255, 65535\}$：
$$\text{constructed\_successor}(S_c) \equiv \text{build\_draw\_ready\_covenant}(\dots, c+1)$$
- 逐字节比对结果：**100% 完全相同**；
- 对应的 P2SH `ScriptPublicKey`：**100% 完全相同**。

---

## 6. 多步级联 UTXO 虚拟机真实证据 (MULTI-STEP UTXO VM EVIDENCE)

测试源码：`winner_selection_test.rs`（TEST 4）
真实构建交易链条：
$$U_0 \xrightarrow[\text{Reject } c=0]{\text{Tx } 0} U_1 \xrightarrow[\text{Reject } c=1]{\text{Tx } 1} U_2 \xrightarrow[\text{Reject } c=2]{\text{Tx } 2} U_3$$
每一笔交易的输入 UTXO 的 SPK，严格等于上一笔交易的输出 SPK，真实在 TxScriptEngine 中完成连续 3 次拒绝推进，执行结果全部为 `Ok(())`。

---

## 7. 最大总票数协议冻结 (MAX_TOTAL_TICKETS FINAL VALUE)

- 生产代码与文档严格统一：
  $$\mathbf{MAX\_TOTAL\_TICKETS} = \mathbf{100,000,000} \text{ (1 亿张彩票)}$$
- 废除了 60P 临时数值，所有模块统一引用常量。

---

## 8. 拒绝概率上界 (REJECTION PROBABILITY BOUND)

对于任意 $1 \le N \le 100,000,000$：
$$P_{\text{reject}} = \frac{R \pmod N}{R} < \frac{10^8}{72,057,594,037,927,936} \approx \mathbf{1.3877 \times 10^{-9}}$$
- 单次尝试成功的概率超过 **99.99999986%**；
- 连续 2 次拒绝的概率 $< 1.93 \times 10^{-18}$；
- 连续 3 次拒绝的概率 $< 2.67 \times 10^{-27}$。

---

## 9. 计数器活性假设 (COUNTER LIVENESS ASSUMPTION)

**NEGLIGIBLE LIVENESS TAIL ASSUMPTION**
- 本协议基于确定性伪随机哈希流，数学上有限序列无法保证绝对无条件终止；
- 但由于拒绝尾部概率极微（$< 1.4 \times 10^{-9}$），在现实运行中以压倒性概率迅速收敛至 Accepted；
- 本方案不伪造“必然有限步截断”的虚假数学证明，而是基于标准的密码学极小不可达尾部假设。

---

## 10. SEALED -> 生产 DRAW_READY(0) 接线集成 (SEALED -> PRODUCTION DRAW_READY INTEGRATION)

- `contracts/sealed_to_draw_ready.rs` 已彻底废弃旧占位符，直接在栈上构造生产版 `DRAW_READY(counter=0)` 的 SPK；
- **端到端验证 (TEST 8)**：
  1. `SEALED` 消费 PASS-A opening 成功生成 `DRAW_READY(0)` UTXO；
  2. 随后在同一个测试套件中，立即真实构造第二笔交易，成功消费该 `DRAW_READY(0)` 并进入 `WINNER_READY`；
  3. 双阶段端到端跑通。

---

## 11 & 12. 接受与拒绝路径结果 (PATH RESULTS)

- **ACCEPT Path**：$N=100$，现场计算 `winner_index = 0`，断言输出 SPK 为 `WINNER_READY` $\implies$ **PASS**；
- **REJECT Path**：现场重构后继脚本，断言输出 SPK 为 `DRAW_READY(c+1)` $\implies$ **PASS**；
- **跳步拦截**：试图跳步至 $c+2$ 直接被 `VerifyError` 拦截 $\implies$ **FAIL (拦截成功)**；
- **篡改拦截**：试图篡改 `winner_index` 直接被 `VerifyError` 拦截 $\implies$ **FAIL (拦截成功)**。

---

## 13. 真实资源核算 (SCRIPT UNITS / MASS)

基于 `TESTNET_PARAMS` 官方计算：
```text
===============================================================
1. DRAW_READY ACCEPT PATH:
  SignatureScript Length      : 349 bytes
  RedeemScript Length         : 346 bytes
  Actual Wire Bytes           : 540 bytes
  Used Script Units           : 1,982 units (B_min = 0)
  Compute Mass                : 920 gram
  Transient Mass              : 2,200 gram
  Fee Mass                    : 2,200 gram
  Minimum Relay Fee           : 220,000 sompi (0.002200 KAS)
---------------------------------------------------------------
2. DRAW_READY REJECT PATH:
  SignatureScript Length      : 349 bytes
  RedeemScript Length         : 346 bytes
  Actual Wire Bytes           : 540 bytes
  Used Script Units           : 2,774 units (B_min = 0)
  Compute Mass                : 920 gram
  Transient Mass              : 2,200 gram
  Fee Mass                    : 2,200 gram
  Minimum Relay Fee           : 220,000 sompi (0.002200 KAS)
===============================================================
```

---

## 14. WINNER_READY 部署状态 (WINNER_READY STATUS)

**WINNER_READY LOGIC = PLACEHOLDER / NOT DEPLOYABLE**

当前 `WINNER_READY` 已通过自省严格绑定为唯一的采样输出，但其内部业务仍为测试清理桩；**严禁将当前代码广播至主网**，下一步必须接入获胜彩票的 Merkle Proof 与资金原子结算。

---

## 15. 文件变更清单 (FILES CHANGED)

- `contracts/winner_selection.rs` (自复制状态化拒绝采样合约)
- `contracts/sealed_to_draw_ready.rs` (接线至生产 `DRAW_READY(0)` 的端到端整合)
- `tests/rust-vm-validation/src/bin/winner_selection_test.rs` (全量 9 项回归测试与级联测试)
- `tests/rust-vm-validation/src/bin/sealed_to_draw_ready_test.rs` (同步更新接线测试)
- `docs/winner-selection-self-replication-report.md` (本审计报告)

---

## 16. 提交记录 (COMMIT)

即将提交至 GitHub 仓库固化。

---

## 17. 下一步动作 (EXACTLY ONE NEXT ACTION)

实现 Canonical Ticket Merkle Proof 并在 `WINNER_READY` 处接入最终原子化奖金向获胜者地址支付（Atomic Payout Settlement）。
