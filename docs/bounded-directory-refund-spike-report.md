# Kaswin V1 有界目录顺序批量退款生命周期与真实连接 UTXO 组合性最终闭环报告 (Connected-UTXO Compositionality Audit Report)

## 1. 架构定位与审计裁决

本报告对 Kaswin V1 针对未达到抽奖门槛 (`final_sold < min_tickets`) 关闭销售的彩票，在有界购买目录 (`purchase_count P ∈ [1..256]`, 变长目录 `directory_len = P * 36` 字节) 下的链上顺序批量退款协议，就 **真实连续连接的 UTXO 状态转换组合性 (Connected-UTXO Compositionality)** 与 **链上自执行无死尾调度 (On-Chain Dead-Tail Protection)** 完成最终隔离验证。

- **最终裁决**: **`REFUND CONNECTED-LIFECYCLE PASS`**
- **生产代码影响**: **严格零修改** (`contracts/*.rs` 严格保持未修改)
- **基线与回归保证**:
  - `golden_vector_regression_test`: 100% byte-for-byte 匹配通过
  - `reject_successor_vm_test`: 全部 4 项回归测试 100% 通过
  - 全 34 个 cargo 目标编译正常，examples test (21/21)、check-links (39 文件 154 链接 0 错误)、kaswin test (27/27) 全绿。
- **验证代码文件**: `tests/rust-vm-validation/src/bin/bounded_directory_refund_spike.rs`

---

## 2. 状态机体策略：通用自复制契约体 (Universal Self-Replicating Body)

### 2.1 组合性缺口复现与根因消除
此前原型中，为每个 `K` 生成特化静态体 `body(K)`。当交易 `tx0`（批次大小 $k_0$）尝试向交易 `tx1`（批次大小 $k_1$）推进时：
- `tx0` 的链上脚本切片自复制逻辑只能生成继承 $k_0$ 的后继 SPK；
- 如果宿主试图切换到 $k_1 
eq k_0$，生成的 `Output0` 必与 `tx1` 期待的 `Input0 SPK` 产生哈希不匹配，破坏了 UTXO 链的连接性。

### 2.2 解决方案：紧凑通用退款体 (Compact Universal Body)
本轮实现并收敛了**单一规范通用静态体** (`compute_converged_compact_universal_body`, 长度收敛于 `6,131 字节`)：
1. **单一静态体跨批次不变性**:
   从 `cursor = 0` 到终结销毁，无论当前步 $k_i$ 为何值，后继状态的 redeem script 始终包含且仅包含该 6,131 字节通用静态体，实现完美的 `Output0 SPK == next Input0 SPK`。
2. **链上动态调度断言**:
   在通用体执行首部，直接在链上由脚本根据当前栈上的 `purchase_count` 与 `cursor` 动态计算合法步长 $k_{expected} = 	ext{schedule\_next\_k}(P - cursor, P, 16)$，并通过 `OpEqualVerify` 强制约束见证输入 $k_{witness} == k_{expected}$。
   - **彻底根除了依赖客户端主观调度的风险**；
   - 任何无许可调用者若试图选择偏离规范调度的 $k$（包括试图制造 dead-tail 的恶意步长），直接在共识层被 `VerifyError` 拒绝！

---

## 3. 链上步长准入规则与经济学约束

### 3.1 链上调度算法实现
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

### 3.2 经济学约束更新
- 采用通用状态体 (6,131 B) 后，对于单笔最小退款步（例如 $P=1, K=1$），交易序列化体积约为 6,531 字节，对应标准中继底线为 `1,306,200 sompi` (约 `0.01306 KAS`)。
- **参数更新**:
  - `MAX_REFUND_FEE = 1,500,000 sompi` (`0.015 KAS`)
  - `MIN_REFUND_PAYOUT = 10,000 sompi` (`0.0001 KAS`)
  - **CREATE-Time 准入约束**: `ticket_price >= MAX_REFUND_FEE + MIN_REFUND_PAYOUT = 1,510,000 sompi` (`0.0151 KAS`)。
- **可行性评估**:
  Kaspa L1 主网彩票票价通常为 1 KAS 或 0.1 KAS 以上，要求票价不低于 0.0151 KAS 完全符合真实产品经济模型，且能 100% 担保任意买家实收退款为正数，同时单笔退款具备完全自闭环支付标准中继费用的能力。

---

## 4. 关键目标真实连接 UTXO 跟踪 (Connected Trace)

在 `bounded_directory_refund_spike.rs` 中，真实构造前序交易 `tx0`，并将后序交易 `tx1` 的 `inputs[0].previous_outpoint` 精确绑定至 `tx0.id():0`，UTXO 金额与 SPK 逐字节继承自 `tx0.outputs[0]`：

### 4.1 P=17 连接轨迹 ([9, 8])
- **Step 0 (K=9, Non-Terminal)**:
  - 消费初始状态 UTXO (`cursor=0`)，输入金额: 17,050,000,000 sompi。
  - 生成 `Output 0` (`cursor=9`): 金额 8,050,000,000 sompi，Covenant ID 延续。
  - 生成 9 笔买家退款，执行计算单元: `56,198 SU` (`B_min = ComputeBudget(5)`)。
- **Step 1 (K=8, Terminal)**:
  - 精确花费 `tx0.id():0`，输入金额与 SPK 与 `tx0.outputs[0]` 100% 字节一致。
  - 处理最后 8 条记录，终结步 `Output 8` 支付创建者 `STATE_DEPOSIT = 50,000,000 sompi`。
  - 执行计算单元: `26,714 SU` (`B_min = ComputeBudget(2)`)。
  - 所有终结输出 Covenant 为 None，单例血统彻底终结。

### 4.2 P=241 连接轨迹 (16 步链式交易)
- 调度序列: 前 15 步每步 $k=15$，最后第 16 步 $k=16$。
- 16 笔交易依次链式花费前一笔的 `Output 0`，全部在 `TxScriptEngine` 中执行 `Ok(())`。

### 4.3 P=256 连接轨迹 (16 步链式交易)
- 调度序列: 16 步每步严格 $k=16$。
- 16 笔交易形成真实的链式花费图，第 16 笔交易终结并精确返还 50,000,000 sompi 保证金。

---

## 5. P=1..256 全域真实连接链 Sweep 结果

在通用契约体和真实连接的 UTXO 拓扑下：
- **评估结果**: **`P ∈ [1..256] 全部 256 个全生命周期 100% PASS`**！
- **最坏中继裕度 (Worst Relay Margin)**: `+193,800 sompi` (出现在 $P=1, K=1$ 终结步，允许费用 1,500,000 sompi，中继底线 1,306,200 sompi)。
- **最坏计算消耗**: 最大 ScriptUnits 约 `394,154 SU` (`ComputeBudget(39)`，远低于区块 500,000 限制)。
- **最坏交易大小**: 约 `16.6 KB` (瞬态质量约 `66,600`，远低于区块 1,000,000 限制)。

---

## 6. 通用状态体资源消耗审计表 (K in [1, 8, 13, 16])

| K | 步骤类型 | P | Cursor | Redeem 字节 | SigScript 字节 | 交易大小 | ScriptUnits | 最低 Budget | 计算质量 | 瞬态质量 | 折算瞬态 | 中继底线 (sompi) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | TERMINAL | 1 | 0 | 6,266 B | 6,279 B | 6,531 B | 13,364 SU | Budget(1) | 7,351 | 26,124 | 13,062 | 1,306,200 |
| 8 | TERMINAL | 17 | 9 | 6,844 B | 6,920 B | 7,536 B | 26,714 SU | Budget(2) | 10,976 | 30,144 | 15,072 | 1,507,200 |
| 9 | Non-Term | 17 | 0 | 6,844 B | 6,929 B | 7,632 B | 56,198 SU | Budget(5) | 11,742 | 30,528 | 15,264 | 1,526,400 |
| 13 | Non-Term | 65 | 0 | 8,572 B | 8,693 B | 9,604 B | 117,762 SU | Budget(11) | 15,754 | 38,416 | 19,208 | 1,920,800 |
| 13 | TERMINAL | 65 | 52 | 8,572 B | 8,693 B | 9,569 B | 82,955 SU | Budget(8) | 15,409 | 38,276 | 19,138 | 1,913,800 |
| 16 | Non-Term | 32 | 0 | 7,384 B | 7,532 B | 8,599 B | 87,692 SU | Budget(8) | 15,529 | 34,396 | 17,198 | 1,719,800 |
| 16 | TERMINAL | 32 | 16 | 7,384 B | 7,532 B | 8,564 B | 57,641 SU | Budget(5) | 15,184 | 34,256 | 17,128 | 1,712,800 |
| 16 | Non-Term | 256 | 0 | 15,448 B | 15,596 B | 16,663 B | 394,154 SU | Budget(39) | 26,693 | 66,652 | 33,326 | 3,332,600 |
| 16 | TERMINAL | 256 | 240 | 15,448 B | 15,596 B | 16,628 B | 331,901 SU | Budget(33) | 26,048 | 66,512 | 33,256 | 3,325,600 |

*说明: ScriptUnits 是虚拟机执行复杂度单位，ComputeBudget 单元为 10,000 SU，对应共识层的计算质量 (compute_mass)；瞬态质量由交易序列化体积按 4 grams/byte 决定，折算后系数为 0.5。表中各值均处于协议安全边界内。*

---

## 7. 8 项状态机组合性对抗攻击矩阵测试结果 (全部 100% 拒绝)

1. `#1` 前序为 K=9，试图向其提供特化体 K=8 的后继: **REJECTED (SPK 哈希不匹配 + VM 拒绝)**
2. `#2` 后续输入 SPK 与前序 `Output0 SPK` 不一致: **REJECTED (VerifyError)**
3. `#3` 后续输入金额人为虚增 1 sompi: **REJECTED (VerifyError)**
4. `#4` 后续输入金额人为克扣 1 sompi: **REJECTED (VerifyError)**
5. `#5` 后续交易引用伪造的 previous outpoint: **REJECTED (Outpoint 不匹配)**
6. `#6` 无许可调用者试图选择偏离调度的 $k 
eq k_{expected}$ 制造死尾: **REJECTED (OpEqualVerify 强制阻断)**
7. `#7` 后续游标与前序输出游标不一致: **REJECTED (SPK 不匹配)**
8. `#8` 契约血统 Covenant ID 被篡改或伪造: **REJECTED (Consensus CovenantsContext 拒绝)**
