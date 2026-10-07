# Kaswin V1 有界目录顺序批量退款生命周期与真实连接 + 中继费联合证明报告 (Connected + Relayable Joint Audit Report)

## 1. 架构定位与审计裁决

本报告对 Kaswin V1 针对未达到抽奖门槛 (`final_sold < min_tickets`) 关闭销售的彩票，在变长有界购买目录 (`purchase_count P ∈ [1..256]`, 变长目录 `directory_len = P * 36` 字节) 下的链上顺序批量退款协议，就 **真实连续连接的 UTXO 状态转换链 (Connected-UTXO Compositionality)** 与 **真实交易中继费用完全自给 (Standard-Relayable Self-Funding)** 完成最终联合证明。

- **最终裁决**: **`REFUND CONNECTED+RELAYABLE PASS`**
- **生产代码影响**: **严格零修改** (`contracts/*.rs` 严格保持未修改)
- **基线与回归保证**:
  - `golden_vector_regression_test`: 100% byte-for-byte 匹配通过
  - `reject_successor_vm_test`: 全部 4 项回归测试 100% 通过
  - 全 34 个 cargo 目标编译正常，examples test (21/21)、check-links (39 文件 154 链接 0 错误)、kaswin test (27/27) 全绿。
- **验证源码文件**: `tests/rust-vm-validation/src/bin/bounded_directory_refund_spike.rs`

---

## 2. 状态机体与链上调度策略

### 2.1 紧凑通用自复制状态体 (Compact Universal Body)
- 彻底废除按不同 K 生成互不兼容静态体的旧方案，收敛为单一紧凑通用体：
  `compute_converged_compact_universal_body` 长度收敛于 **`6,131 字节`**。
- 单一静态体在所有批次中完全不变，非终结步提取出的静态体与预期后继 redeem script 100% 字节一致，彻底解决 UTXO 链式花费时的 SPK 继承组合性问题。

### 2.2 链上自执行无死尾调度算法 (On-Chain Dead-Tail Protection)
在通用体执行首部，直接在链上根据当前栈上的 `purchase_count P` 与 `cursor` 动态计算合法步长 $k_{expected}$：
```rust
pub fn min_k_for_p(p: usize) -> usize {
    if p <= 5 { 1 }
    else if p <= 27 { 2 }
    else if p <= 48 { 3 }
    else if p <= 70 { 4 }
    else if p <= 92 { 5 }
    else if p <= 114 { 6 }
    else if p <= 135 { 7 }
    else if p <= 157 { 8 }
    else if p <= 179 { 9 }
    else if p <= 201 { 10 }
    else if p <= 223 { 11 }
    else if p <= 245 { 12 }
    else { 13 }
}

pub fn schedule_next_k(remaining: usize, p_total: usize, k_max: usize) -> usize {
    if remaining <= k_max {
        return remaining;
    }
    let m = min_k_for_p(p_total);
    let num_steps = (remaining + k_max - 1) / k_max;
    let base = remaining / num_steps;
    let rem = remaining % num_steps;
    let candidate = base + if rem > 0 { 1 } else { 0 };
    candidate.min(k_max).max(m)
}
```
链上通过 `OpEqualVerify` 强断言 `witness_k == expected_k`，无许可调用者无法挑选偏离规范调度的步长制造不可中继的死尾批次。

---

## 3. 真实费用分配与交易守恒 (Real Fee Allocator)

每一笔真实交易不再使用人为假数据或无意义的满额扣费，而是根据该交易真实拓扑与序列化质量：
1. 精确计算 `relay_floor`:
   ```text
   fee_mass = max(compute_mass, normalized_transient_mass)
   relay_floor = max(100_000, fee_mass * 100_000 / 1000)
   ```
2. 确定性均衡分摊费用：
   - $base = \lfloor relay\_floor / k \rfloor$
   - 前 $rem = relay\_floor \pmod k$ 个买家分摊 $base + 1$，其余买家分摊 $base$。
   - 保证 $\sum fee_i == relay\_floor$ 且每个 $fee_i \le MAX\_REFUND\_FEE$。
3. 交易实际矿工费通过真实账目守恒产生：
   $actual\_fee = \sum input\_amounts - \sum output\_amounts$
   严格满足：
   $actual\_fee == \sum fee_i \ge relay\_floor$。

---

## 4. 经济学约束与 state_deposit 性质说明

1. **候选 CREATE 经济学约束规则**:
   - `MAX_REFUND_FEE = 1,500,000 sompi` (`0.015 KAS`)
   - `MIN_REFUND_PAYOUT = 10,000 sompi` (`0.0001 KAS`)
   - **CREATE 准入强制条件**: `ticket_price >= 1,510,000 sompi` (`0.0151 KAS`)。
2. **最低边界 Fixture 真实测试 (TICKET_PRICE = 1.51M, count_i = 1)**:
   - 测试了 $P \in [1, 17, 256]$ 在每位买家仅买 1 张票、总票价仅 1.51M sompi 的极端最恶劣条件下：
     - $P=1$: 终结步实扣费用 1,306,200 sompi，买家实收退款 $1,510,000 - 1,306,200 = 203,800 \ge 10,000$ sompi。
     - $P=17$: 2 步连续花费，每位买家实收退款均 $\ge 10,000$ sompi。
     - $P=256$: 16 步连续花费，每位买家实收退款均 $\ge 10,000$ sompi。
   - 全部最低边界用例在 `TxScriptEngine` 中 100% PASS。
3. **state_deposit 性质澄清**:
   - `STATE_DEPOSIT = 50,000,000 sompi (0.5 KAS)` 仅为测试夹具数值，**绝非协议冻结常量**！
   - 协议不变式为：终结步创建者退款输出金额严格等于 `Input0Amount - final_gross_batch`，即创建者无论抵押多少保证金，在退款终结步 100% 完整无损归还。

---

## 5. 关键目标联合连接轨迹 (Connected + Relayable Traces)

### 5.1 P=17 联合连接轨迹 ([9, 8])
- **Step 0 (K=9, Non-Terminal)**:
  - 输入：初始状态 UTXO (`cursor=0`), 金额: 17,050,000,000 sompi。
  - 实测质量：Compute 11,742, Transient 30,528, NormTransient 15,264 => `relay_floor = 1,526,400 sompi`。
  - 分配真实费用：$actual\_fee = 1,526,400$ sompi (买家分摊 169,600 sompi)。
  - 生成 `tx0.outputs[0]` (`cursor=9`): 金额 8,050,000,000 sompi，Covenant ID 延续。
  - VM 执行：`Ok(())`，真实交易费：$1,526,400 \ge 1,526,400$。
- **Step 1 (K=8, Terminal)**:
  - 输入：精确花费 `tx0.id():0`，输入金额与 SPK 与 `tx0.outputs[0]` 100% 逐字节一致。
  - 实测质量：Compute 10,976, Transient 30,144, NormTransient 15,072 => `relay_floor = 1,507,200 sompi`。
  - 分配真实费用：$actual\_fee = 1,507,200$ sompi。
  - 终结步退还创建者：`STATE_DEPOSIT = 50,000,000 sompi`，所有输出无 Covenant。
  - VM 执行：`Ok(())`，真实交易费：$1,507,200 \ge 1,507,200$。
  - 联合证明结论：**100% 真实连接且 100% 自给中继**。

### 5.2 P=256 联合连接轨迹 (16 步链式交易)
- 从 `cursor=0` 到 `cursor=256` 共 16 个批次（前 15 步非终结，最后 1 步终结）：
  - 每一笔交易 `tx[i]` 严格引用 `tx[i-1].id():0` 作为 `Input 0`。
  - 每一笔交易的实际扣费 $\sum fee_j$ 严格精确覆盖其当前的 `relay_floor`（非终结步约 3,332,600 sompi，终结步约 3,325,600 sompi）。
  - 第 16 步终结步：保证金 50,000,000 sompi 100% 返还创建者，买家退款总额 + 矿工费总额 = 742,000,000,000 sompi（本金 100% 严格守恒）。

---

## 6. P=1..256 全域联合 Connected + Relayable Sweep 结果

- **测试范围**: $P \in [1..256]$ 全部 256 种购买人数。
- **执行方式**: 每一层真实花费前序交易的 `Output 0`，分配覆盖 `relay_floor` 的真实费用，全部通过 `TxScriptEngine` 真实执行并断言实际交易费。
- **验证结果**: **`256 / 256 全部 100% PASS`**！
- **全域指标统计**:
  - 最坏中继裕度 (Worst Relay Margin): `+193,800 sompi` (在 $P=1, K=1$ 终结步，扣费上限 1,500,000 sompi，中继底线 1,306,200 sompi)。
  - 最大 Redeem 脚本长度: `15,448 B` (发生在 $P=256$)。
  - 最大 SigScript 见证长度: `15,596 B`。
  - 最大交易序列化体积: `16,663 B`。
  - 最大执行计算单元: `403,538 SU` (`ComputeBudget(40)`)。
  - 最大计算质量: `26,793 grams`。
  - 最大瞬态质量: `66,652 grams` (折算后 `33,326 grams`)。
  - 最大标准中继底线: `3,332,600 sompi` (`0.0333 KAS`)。

---

## 7. 10 项组合性与中继策略对抗测试矩阵结果 (全部 100% 拒绝)

1. `#1` 前序为 K=9，后序伪造为特化体 K=8: **REJECTED (SPK 不匹配 + VM 拒绝)**
2. `#2` 后续输入 SPK 与前序 `Output0 SPK` 不一致: **REJECTED (VerifyError)**
3. `#3` 后续输入金额人为虚增 1 sompi: **REJECTED (VerifyError)**
4. `#4` 后续输入金额人为克扣 1 sompi: **REJECTED (VerifyError)**
5. `#5` 后续交易引用伪造的 previous outpoint: **REJECTED (Outpoint 不匹配)**
6. `#6` 无许可调用者试图选择偏离调度的 $k \neq k_{expected}$ 制造死尾: **REJECTED (OpEqualVerify 强制阻断)**
7. `#7` 后续游标与前序输出游标不一致: **REJECTED (SPK 不匹配)**
8. `#8` 契约血统 Covenant ID 被篡改或伪造: **REJECTED (Consensus CovenantsContext 拒绝)**
9. `#9` actual_fee = relay_floor - 1: **CONSENSUS-VALID (Ok(())) 但 RELAY-REJECTED (证明中继策略不是共识规则)**
10. `#10` actual_fee == relay_floor: **CONSENSUS-VALID 且 RELAY-PASS (证明费用分配达到标准中继底线)**
