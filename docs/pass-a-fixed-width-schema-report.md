# Kaswin PASS-A Randomness Freeze Audit: Fixed-Width Schema & On-Chain Boundary Enforcement

**快照日期**：2026-09-06 UTC  
**网络**：Kaspa Testnet-10 (TN10)  
**共识基准**：`kaspanet/rusty-kaspa` `v2.0.1` (`cfafeb4c093fa37a303f1b9f19c58f986b870ce3`)  
**状态**：PASS-A RANDOMNESS AUTHENTICATION = **PASS**  

---

## 1. 结论 (RESULT)

**PASS**

**一句话结论**：  
依据 pinned `rusty-kaspa v2.0.1`，通过在 Redeem Script 内部添加 `OpDepth == 12` 见证项计数及全部 12 个字段的严密字节长度断言（`OpSize == 8 / 32`），彻底根除了 SAME-BYTES Repartition 栈边界歧义漏洞；通过 `OpTxInputIndex == 0` 与 `OpTxInputDaaScore(0) + delta_daa` 将开奖边界严格绑定到不可伪造的链上真实 UTXO 包含 DAA，根除了客户端传入 base DAA 的伪造风险；经官方 `kaspa_hashes::SeqCommitMergesetContext` 与 `SeqCommitMerkleBranch` 权威 Oracle 比对，脚本重构的 $C_T$ 达到 100% 逐字节一致；真实 Wire 序列化体积仅为 1,015 字节，单笔最小中继费仅 0.0041 KAS。所有 8 项强制验收测试全部通过。

---

## 2. 字段定长规范 (FIXED-WIDTH OPENING SCHEMA)

在任何 DAA 算术运算及任何 `OpCat` 之前，Covenant 脚本通过 `OpPick + OpSize + OpNumEqualVerify` 严格断言全部 12 项见证栈元素：

- **栈深度限制**：`OpDepth == 12`（多项/少项均直接拦截）
- **Target 区块开箱字段（共 6 项，120 字节）**：
  - `target_hash`：严格 **32 字节**
  - `target_activity`：严格 **32 字节**
  - `target_payload`：严格 **32 字节**
  - `target_sp_ts`：严格 **8 字节**
  - `target_daa`：严格 **8 字节**
  - `target_blue`：严格 **8 字节**
- **Parent 区块开箱字段（共 6 项，120 字节）**：
  - `p_parent_seq`：严格 **32 字节**
  - `p_activity`：严格 **32 字节**
  - `p_payload`：严格 **32 字节**
  - `p_sp_ts`：严格 **8 字节**
  - `p_daa`：严格 **8 字节**
  - `p_blue`：严格 **8 字节**

总见证净载荷：严格 **240 字节**，不存在任何可拉伸或重新切片的空间。

---

## 3. SAME-BYTES 重新切片攻击测试结果 (SAME-BYTES REPARTITION RESULTS)

测试源码：`tests/rust-vm-validation/src/bin/sealed_to_draw_ready_test.rs`

### 3.1 P Context 重切片攻击 (TEST 2: 9/8/7 攻击)
- **攻击手法**：保持底层 24 字节拼接 `ts || daa || blue` 绝对一致（使 $C_P$ 与 $C_T$ 的 Blake3 哈希值保持不变），但将原本为 `[8, 8, 8]` 的切片伪造为 `ts'[9]`, `daa'[8]`, `blue'[7]`，试图篡改虚拟机数字解释使实际大于 boundary 的父块假冒首跨；
- **拦截表现**：在第一条长度断言处直接触发 `OpNumEqualVerify` 失败，返回 `Err(VerifyError)`；
- **结论**：**FAIL (攻击被成功拦截)**。

### 3.2 T Context 重切片攻击 (TEST 3: 7/8/9 攻击)
- **攻击手法**：将 Target 块的 `[8, 8, 8]` 切片伪造为 `[7, 8, 9]`，企图改变 `target_daa` 的解释；
- **拦截表现**：在 Target 长度断言处精准拦截，返回 `Err(VerifyError)`；
- **结论**：**FAIL (攻击被成功拦截)**。

---

## 4. 边界可信来源 (BOUNDARY SOURCE)

- **废除参数**：完全删除构建函数与 Redeem Script 中的客户端 `sealed_base_daa` 传参；
- **链上不变量约束**：
  1. `OpTxInputIndex == 0`：强制当前执行脚本必须消费 Input 0；
  2. `boundary = OpTxInputDaaScore(0) + delta_daa`：由共识引擎在 UTXO 包含时写入的 `UtxoEntry.block_daa_score` 作为唯一边界基准；
- **伪造不匹配验证 (TEST 5 & 6)**：
  当外部客户端声称 base DAA 为 1,000,000，但链上真实 UTXO 的 inclusion DAA 为 2,000,000 时，脚本严格依据 2,000,000 结合 delta 计算边界，导致伪造开箱必然被 `OpGreaterThanOrEqual + OpVerify` 拦截。

---

## 5. 官方 KIP-21 ORACLE 逐字节一致性 (OFFICIAL KIP-21 ORACLE MATCH)

在测试中直接调用 pinned `rusty-kaspa` 的官方 hasher 实现：
```rust
kaspa_hashes::SeqCommitMergesetContext
kaspa_hashes::SeqCommitMerkleBranch
```
- **测试结果 (TEST 7)**：
  - 虚拟机脚本内部 8 次 `OpBlake3WithKey` 重构计算出的承诺：
    `5574241a10c582bfa455d0ad60ea578e60e3bbbb90aef0814169be63adeadbe2`
  - 官方 `kaspa_seq_commit` 算法产出的真实根：
    `5574241a10c582bfa455d0ad60ea578e60e3bbbb90aef0814169be63adeadbe2`
- **结论**：**100% 逐字节完全匹配**。

---

## 6. 滞后区块攻击拦截 (LATER TARGET RESULT)

- **攻击场景 (TEST 4)**：矿工发现首跨块随机数对其不利，企图提交其后继块 $T+1$（其父块 $P$ 已经跨过 boundary，即 $P.\text{daa} \ge \text{boundary}$）；
- **执行表现**：脚本首先校验 `P.daa < boundary`，直接触发 `OpLessThan + OpVerify` 失败；
- **结论**：**FAIL (攻击被成功拦截)**，首跨目标具有全网唯一性。

---

## 7. DRAW_READY 部署状态明确说明 (DRAW_READY DEPLOYMENT STATUS)

**DRAW_READY LOGIC = PLACEHOLDER / NOT DEPLOYABLE**

当前 `build_draw_ready_redeem_script` 仅作为承接不可篡改随机数 `(target_hash, random_seed)` 并在测试中验证继承 SPK 构造的占位符；**严禁将包含当前 DRAW_READY 逻辑的合约广播至主网或持有真实资金的测试网**。真正的资金安全闭环将在随后的 Winner Selection 阶段完成。

---

## 8. 真实序列化体积与资源核算 (REALISTIC RESOURCES)

基于 `TESTNET_PARAMS` 与 `borsh::to_vec(&tx)` 真实线缆（Wire）序列化与 `MassCalculator` 精确核算：

```text
===============================================================
SEALED -> DRAW_READY Transaction Resource Audit:
  SignatureScript Length      : 824 bytes
  RedeemScript Length         : 569 bytes
  Actual Serialized Wire Bytes: 1,015 bytes (真实 Borsh 编码)
  Estimated Serialized Bytes  : 1,025 bytes (共识估算)
  Used Script Units           : 3,903 units (单输入免除额度内，所需 B_min = 0)
  Compute Mass                : 1,395 gram
  Transient Mass              : 4,100 gram
  Storage Mass                : 0 gram
  Fee Mass (Overall)          : 4,100 gram
  Minimum Relay Fee           : 410,000 sompi (0.004100 KAS)
===============================================================
```

---

## 9. 验收通过标准判定

- [x] 12-item opening count 被脚本强制认证 (`OpDepth == 12`)；
- [x] 所有 240B 字段宽度被脚本自省认证 (`OpSize == 8 / 32`)；
- [x] SAME-BYTES repartition 攻击无法逃逸长度检查；
- [x] boundary 100% 来源于链上原生不可伪造的 `OpTxInputDaaScore(0)`；
- [x] 虚拟机重构的 $C_T$ 与官方 `kaspa_seq_commit` 逐字节完全一致；
- [x] 真实 Wire 体积远低于标准限制。

**PASS-A RANDOMNESS AUTHENTICATION = PASS**
