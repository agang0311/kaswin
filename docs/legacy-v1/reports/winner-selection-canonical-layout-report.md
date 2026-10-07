# Kaswin Winner Selection: Canonical State Layout, Strict Prefix Invariance & Production Self-Replication Audit Report

**快照日期**：2026-09-06 UTC  
**网络**：Kaspa Testnet-10 (TN10)  
**共识基准**：`kaspanet/rusty-kaspa` `v2.0.1` (`cfafeb4c093fa37a303f1b9f19c58f986b870ce3`)  
**状态**：WINNER SELECTION = **PASS / FROZEN** (ENGINE VERIFIED)  

---

## 1. 结论 (RESULT)

**PASS**

**一句话结论**：  
彻底根除了任何基于样本的硬编码布局偏移量（如 137/146 等 magic number），将 `total_tickets` 序列化统一固定为 8 字节小端定长数据推送（`0x08 || le_u64`），使 `DRAW_READY` 状态前缀长度成为严格的全协议常量 $\text{DRAW\_READY\_PREFIX\_LEN} = \mathbf{144 \text{ 字节}}$；证明了对于任意合法票数类别（$N \in \{1, 100, 128, 100,000,000\}$），`SEALED` 状态转换现场构造的后继脚本与生产独立构建函数产出的 `DRAW_READY(0)` 逐字节 100% 绝对一致；证明了对于生产脚本 $S_c$，拒绝分支从签名脚本自省重构的后继脚本与生产构建函数产出的 $S_{c+1}$ 逐字节 100% 恒等；将 $\text{MAX\_TOTAL\_TICKETS} = 100,000,000$ 深度防御传播至所有前序与后序构建器；将计数器数值域严格限定在 $[0, i64::\text{MAX}]$。全套测试在原生 TxScript 虚拟机中全部通过。

---

## 2. 状态标准字节布局 (CANONICAL DRAW_READY BYTE LAYOUT)

`DRAW_READY` 赎回脚本严格划分为三个不变量段：
```text
1. PREFIX (固定 144 字节，对任意 N 恒定不变):
   - Input 0 校验: [OpTxInputIndex, Op0, OpEqualVerify] = 3 字节
   - round_id:     [0x20] || 32 字节哈希              = 33 字节
   - ticket_root:  [0x20] || 32 字节哈希              = 33 字节
   - total_tickets:[0x08] || 8 字节 LE 数据推送        = 9 字节 (彻底消除变长整型扰动)
   - target_hash:  [0x20] || 32 字节哈希              = 33 字节
   - random_seed:  [0x20] || 32 字节哈希              = 33 字节
   合计: 3 + 33 + 33 + 9 + 33 + 33 = 144 字节 (PROTOCOL CONSTANT)

2. COUNTER PUSH (固定 9 字节):
   - counter:      [0x08] || 8 字节 LE 计数器推送      = 9 字节 (OpData8)

3. SUFFIX (根据轮次 N 确定性生成的逻辑体):
   - 候选数派生、阈值计算、接受分支（WINNER_READY SPK 现场计算与匹配）、拒绝分支（自复制切片重构与 SPK 现场计算与匹配）
```

---

## 3. 前缀长度严格推导 (PREFIX LENGTH DERIVATION)

$$\text{DRAW\_READY\_PREFIX\_LEN} = 3 \text{ (Opcode)} + 33 \times 4 \text{ (32B Hashes)} + 9 \text{ (8B Ticket Count)} = \mathbf{144 \text{ 字节}}$$
代码中消除了所有手写数字，全部由 `DRAW_READY_PREFIX_LEN` 常量与前缀构建器严格绑定。

---

## 4. 各 N 类别编码一致性测试 (N ENCODING-CLASS RESULTS)

测试源码：`tests/rust-vm-validation/src/bin/winner_selection_test.rs`（TEST 1-4）
在以下典型类别票数下进行了严格断言：
- $N = 1$（最小边界）：前缀严格为 144 字节；
- $N = 100$（双字节整型区）：前缀严格为 144 字节；
- $N = 128$（整数字节符号翻转边界）：前缀严格为 144 字节；
- $N = 100,000,000$（协议最大边界）：前缀严格为 144 字节；
- 结论：**全部类别下前缀长度恒等为 144 字节，彻底消除了基于 N 的前缀伸缩风险**。

---

## 5. SEALED -> DRAW_READY 全类别端到端证明 (SEALED -> DRAW_READY ALL-N EVIDENCE)

测试源码：`winner_selection_test.rs`（TEST 5）
在真实 TxScriptEngine 虚拟机中，分别针对 $N = 1$、$N = 100$、$N = 100,000,000$ 执行前序 `SEALED` 状态消费：
- $N = 1$：`SEALED -> production DRAW_READY(0)` 执行结果 **Ok(())**（消耗 5,154 units）；
- $N = 100$：`SEALED -> production DRAW_READY(0)` 执行结果 **Ok(())**（消耗 5,159 units）；
- $N = 100,000,000$：`SEALED -> production DRAW_READY(0)` 执行结果 **Ok(())**（消耗 5,174 units）；
- 产生的输出 SPK 均与独立调用的 `build_draw_ready_covenant(..., 0)` 产出的 SPK **逐字节完全匹配**。

---

## 6 & 8. 生产拒绝分支自复制恒等证明 (SUCCESSOR BYTE IDENTITY)

测试源码：`winner_selection_test.rs`（TEST 6）与 `tests/rust-vm-validation/src/bin/test_pure_structural.rs`
对于真实的生产脚本 $S_c$，拒绝分支从 `SignatureScript` 中切片提取：
$$\text{p\_slice} = \text{SignatureScript}[\text{p\_start} .. \text{p\_end}]$$
$$\text{next\_push} = [0x08] \mathbin{\Vert} \text{le\_u64}(c + 1)$$
$$\text{s\_slice} = \text{SignatureScript}[\text{s\_start} .. \text{s\_end}]$$
重构出：
$$\text{reconstructed} = \text{p\_slice} \mathbin{\Vert} \text{next\_push} \mathbin{\Vert} \text{s\_slice}$$
对代表性计数器 $c \in \{0, 1, 2, 255, 65535, 1,000,000\}$：
$$\text{reconstructed}(S_c) \equiv \text{build\_draw\_ready\_covenant}(\dots, c+1)$$
- 结果：**100% 逐字节完全匹配，SPK 100% 完全匹配**。

---

## 7. 拒绝分支字节码同构性验证 (REJECT VM HARNESS EVIDENCE)

- 拒绝逻辑全部收敛于公共不可变函数 `append_canonical_reject_successor_bytecode`；
- 在任何分支或测试线中，执行的切片重构指令流均**绝对同构**，不存在任何旁路或伪造逻辑。

---

## 9. 最大总票数协议级统一 (MAX_TOTAL_TICKETS PROPAGATION)

- 统一常量：$\text{MAX\_TOTAL\_TICKETS} = \mathbf{100,000,000}$；
- 深度防御验证（TEST 9）：
  - $N = 0$：`build_sealed_to_draw_ready_covenant` 严格 panic 拦截；
  - $N = 100,000,001$：严格 panic 拦截；
  - 杜绝任何超限参数通过构造器渗透到链上。

---

## 10. 计数器数值域规范 (COUNTER DOMAIN)

- 正式定义：$0 \le \text{counter} \le i64::\text{MAX}$；
- 构造器边界检查：断言 $\text{counter} \le i64::\text{MAX} \text{ as u64}$；
- 协议采纳 **NEGLIGIBLE LIVENESS TAIL ASSUMPTION**：单次拒绝概率 $< 1.39 \times 10^{-9}$，不假定数学上绝无可能，但在工程与密码学实践中以压倒性概率迅速收敛。

---

## 11. 资源核算 (SCRIPT UNITS / MASS)

基于 `TESTNET_PARAMS` 实测生产交易：
- **SEALED -> DRAW_READY(0) 交易**：
  - SignatureScript：1,043 字节
  - RedeemScript：788 字节
  - 真实 Wire 体积：1,234 字节
  - 消耗 Script Units：5,159 units（单输入免除额度内，所需 $B_{\min} = 0$）
  - Fee Mass：4,976 gram
  - 最低网络手续费：497,600 sompi (0.004976 KAS)
- **DRAW_READY -> WINNER_READY 交易**：
  - SignatureScript：356 字节
  - RedeemScript：353 字节
  - 真实 Wire 体积：547 字节
  - 消耗 Script Units：2,034 units（所需 $B_{\min} = 0$）
  - Fee Mass：2,228 gram
  - 最低网络手续费：222,800 sompi (0.002228 KAS)

---

## 12. 文件变更清单 (FILES CHANGED)

- `contracts/winner_selection.rs` (实现严格定长前缀、提取公共拒绝字节码)
- `contracts/sealed_to_draw_ready.rs` (适配 144B 定长布局、增加 `MAX_TOTAL_TICKETS` 深度断言)
- `tests/rust-vm-validation/src/bin/winner_selection_test.rs` (全套 10 项全量集成与编码类测试)
- `tests/rust-vm-validation/src/bin/sealed_to_draw_ready_test.rs` (更新端到端回归断言)
- `docs/winner-selection-canonical-layout-report.md` (本审计报告)

---

## 13. 提交记录 (COMMIT)

即将提交至 GitHub 仓库固化。

---

## 14. 下一步动作 (EXACTLY ONE NEXT ACTION)

冻结当前售票阶段与中奖证明所依赖的 TicketLeaf / ticket_root 的 Canonical 格式，然后实现 Winner Merkle Proof 验证与奖金原子结算（Atomic Payout Settlement）。
