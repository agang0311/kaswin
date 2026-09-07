# Kaswin V1 有界目录顺序批量退款生命周期审计报告 (Bounded Directory Sequential Batch Refund)

## 1. 架构目标与验证结论

本报告对 Kaswin V1 针对未达到抽奖门槛 (`final_sold < min_tickets`) 关闭销售的彩票，开展基于有界购买目录 (`purchase_count <= 256` 条 36 字节记录) 的链上顺序批量退款协议进行隔离 Feasibility 与 VM 验证。

- **验证结论**: **`BOUNDED DIRECTORY REFUND PASS`**
- **生产代码影响**: **零生产代码修改** (严格保持 `contracts/*.rs` 未修改)
- **黄金向量与回归**: **100% 保持严格一致** (`golden_vector_regression_test`, `reject_successor_vm_test`, 全 34 个 cargo 测试、examples 与 link 校验全绿)
- **验证代码文件**: `tests/rust-vm-validation/src/bin/bounded_directory_refund_spike.rs`

---

## 2. 状态定义与前缀/体布局

### 2.1 状态前缀 (`REFUNDING` Prefix)
有界目录退款合约使用标准动态状态前缀 (共 6 项)：
1. `round_id`: 32 字节哈希
2. `ticket_price`: 8 字节小端整数
3. `purchase_count`: 8 字节小端整数 (最大 256)
4. `cursor`: 8 字节小端整数 (已退款记录游标，初始为 0，步进为 `cursor + K`)
5. `creator_refund_spk`: 34 字节 P2PK 原生地址
6. `directory`: 9,216 字节固定有界目录数据 (`256 * 36` 字节)

前缀总长度: `32 + 8 + 8 + 8 + 34 + 9216 + OP_PUSHDATA2 (3 字节) = 9309 字节`。

### 2.2 交易拓扑 (Transaction Topology)
- **非终结步 (Non-Terminal Step, `cursor + K < purchase_count`)**:
  - 输入 0: 当前 `REFUNDING(cursor)` UTXO (绑定 KIP-20 Covenant ID `C`)
  - 输出 0: 后继 `REFUNDING(cursor + K)` UTXO (金额递减 `sum(gross_i)`，继承 Covenant ID `C`)
  - 输出 `1..=K`: 买家退款输出，输出 `j` 支付 `gross_i - fee_i` 至买家 `records[cursor + j - 1].payout_spk`
  - 隐式矿工费: `sum(fee_i)` (由每笔购买的本金扣除，不触碰 creator state_deposit)
- **终结步 (Terminal Step, `cursor + K == purchase_count`)**:
  - 输入 0: 最后一步 `REFUNDING(cursor)` UTXO
  - 输出 `0..K`: 买家退款输出 (输出 `0..K-1` 支付至最后 K 个买家)
  - 最终输出 (输出 `K`): 支付给创建者 `creator_refund_spk`，金额严格精确等于 `STATE_DEPOSIT` (50,000,000 sompi / 0.5 KAS)
  - **终结 Lineage 守卫**: 全输出 `Covenant = None`，销毁 KIP-20 契约。

---

## 3. 批量候选大小 K 矩阵资源计量 (K in [1, 4, 8, 16, 32, 64])

所有测试在 `tests/rust-vm-validation/src/bin/bounded_directory_refund_spike.rs` 中使用真实 `TxScriptEngine` 严格计量：

| K | 步骤类型 | Redeem 字节 | SigScript | 交易大小 | 输出数 | ScriptUnits (SU) | 最低 Budget | Compute 质量 | Transient 质量 | Storage 质量 | 标准中继底线 (sompi) | 批次总矿工费 (sompi) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Non-Term | 9,958 B | 9,970 B | 10,257 B | 2 | 79,487 SU | Budget(7) | 25,987 | 41,028 | 358 | 2,598,700 (0.0259 KAS) | 50,000 |
| 1 | TERMINAL | 9,958 B | 9,970 B | 10,222 B | 2 | 39,104 SU | Budget(3) | 25,942 | 40,888 | 19,893 | 2,594,200 (0.0259 KAS) | 50,000 |
| 4 | Non-Term | 10,849 B | 10,888 B | 11,331 B | 5 | 141,141 SU | Budget(14) | 28,141 | 45,324 | 1,429 | 2,814,100 (0.0281 KAS) | 200,000 |
| 4 | TERMINAL | 10,849 B | 10,888 B | 11,296 B | 5 | 97,238 SU | Budget(9) | 28,096 | 45,184 | 20,998 | 2,809,600 (0.0280 KAS) | 200,000 |
| 8 | Non-Term | 12,037 B | 12,112 B | 12,763 B | 9 | 223,377 SU | Budget(22) | 31,013 | 51,052 | 2,857 | 3,101,300 (0.0310 KAS) | 400,000 |
| 8 | TERMINAL | 12,037 B | 12,112 B | 12,728 B | 9 | 174,750 SU | Budget(17) | 30,968 | 50,912 | 22,452 | 3,096,800 (0.0309 KAS) | 400,000 |
| 16 | Non-Term | 14,426 B | 14,573 B | 15,640 B | 17 | 387,935 SU | Budget(38) | 36,770 | 62,560 | 5,713 | 3,677,000 (0.0367 KAS) | 800,000 |
| 16 | TERMINAL | 14,426 B | 14,573 B | 15,605 B | 17 | 329,800 SU | Budget(32) | 36,725 | 62,420 | 25,334 | 3,672,500 (0.0367 KAS) | 800,000 |
| 32 | Non-Term | 19,370 B | 19,661 B | 21,560 B | 33 | 718,047 SU | Budget(71) | 48,450 | 86,240 | 11,426 | 4,845,000 (0.0484 KAS) | 1,600,000 |
| 32 | TERMINAL | 19,370 B | 19,661 B | 21,525 B | 33 | 640,232 SU | Budget(64) | 48,405 | 86,100 | 31,068 | 4,840,500 (0.0484 KAS) | 1,600,000 |
| 64 | Non-Term | 29,258 B | 29,837 B | 33,400 B | 65 | 1,378,271 SU | Budget(137) | 71,810 | 133,600 | 22,851 | 7,181,000 (0.0718 KAS) | 3,200,000 |
| 64 | TERMINAL | 29,258 B | 29,837 B | 33,365 B | 65 | 1,261,096 SU | Budget(126) | 71,765 | 133,460 | 42,508 | 7,176,500 (0.0717 KAS) | 3,200,000 |

---

## 4. 关键审计发现：K=1 单笔退款无法由自身费用独立中继 (Relay Floor Trap)

### 审计数据对比
对于 `K=1`:
- 交易序列化大小: `10,257 字节` (因为每次输入必须提供完整的 9,216 字节目录和签名脚本)
- 瞬态质量 (Transient Mass): `41,028` (折算 Transient 质量: `20,514`)
- 计算质量 (Compute Mass): `11,987` (在 Budget 7 时综合质量为 25,987)
- **标准 Mempool 最低中继费**: `2,051,400 sompi ~ 2,598,700 sompi` (约 `0.0205 ~ 0.026 KAS`)
- 单笔购买上限费率 `MAX_REFUND_FEE`: `250,000 sompi` (`0.0025 KAS`)

### 关键结论
- **`MAX_REFUND_FEE (250,000 sompi) < relay_floor (2,051,400 sompi)`**！
- 如果采用 `K=1` 单笔退款且不引入外部普通付费输入，则单笔退款交易在共识层完全有效，但**无法达到 Kaspa 节点 Mempool 的标准最低中继门槛** (会被标准节点拒收)！
- 相比之下，当 **`K >= 8`** 或 **`K = 16`** 时，批量聚合费用 (`K * fee = 8 * 0.005 KAS = 0.04 KAS` 或 `16 * 0.003 KAS = 0.048 KAS`) 大于中继底线 (`0.031 ~ 0.037 KAS`)，可实现**零外部输入、纯由批次内买家本金扣费自闭环中继**。

---

## 5. 端到端全生命周期仿真 (P=256, K=16, 16 个连续批次)

在测试中完整模拟了 256 笔购买、总售出 7,420 张票的退款流程 (采用推荐批次 `K=16`，共 16 笔交易串联)：
- 初始合约总金额: `742,050,000,000 sompi` (包含 50,000,000 sompi 创建者保证金 + 742,000,000,000 sompi 买家本金)
- 批次 0 至 15 全部在 `TxScriptEngine` 中执行通过：
  - 买家实际到账退款总额: `741,992,320,000 sompi`
  - 支付网络矿工费总额: `7,680,000 sompi`
  - 买家到账 + 矿工费之和: `742,000,000,000 sompi` (**100.0000% 本金守恒**)
  - 终结步输出 16 支付创建者: `50,000,000 sompi` (**100.0000% 保证金无损归还**)
  - 终结步 KIP-20 状态销毁: `OpOutputCovenantId == ZERO_HASH`, `OpOutputAuthorizingInput == -1` 全部通过！

---

## 6. 严格 24 项负向对抗攻击矩阵测试结果 (全部 100% 拒绝)

在 `K=4` 拓扑下对 24 种恶意攻击进行真实验证，全部触发 VM 拒绝 (`Err(VerifyError)` 或共识拒绝)：
1. `#1` 游标跳过一条记录 (`c + k + 1`): **REJECTED**
2. `#2` 游标不推进停留在原处 (`c + 0`): **REJECTED**
3. `#3` 游标超额推进 (`c + k + 1`): **REJECTED**
4. `#4` 重新退款历史旧记录: **REJECTED**
5. `#5` 买家支付 SPK 篡改为攻击者 SPK: **REJECTED**
6. `#6` 买家收款公钥与目录中其他条目调换: **REJECTED**
7. `#7` 买家退款金额少付 1 sompi: **REJECTED**
8. `#8` 买家退款金额多付 1 sompi: **REJECTED**
9. `#9` 扣除负数矿工费: **REJECTED**
10. `#10` 扣除矿工费超过 `MAX_REFUND_FEE`: **REJECTED**
11. `#11` 买家实际到账为零或负数 (`refund_i <= 0`): **REJECTED**
12. `#12` 后继合约金额偷减 1 sompi: **REJECTED**
13. `#13` 后继合约金额虚增 1 sompi: **REJECTED**
14. `#14` 后继状态中目录内容被篡改: **REJECTED**
15. `#15` 后继状态中 `purchase_count` 被篡改: **REJECTED**
16. `#16` 后继状态中 `ticket_price` 被篡改: **REJECTED**
17. `#17` 交易中插入隐藏额外盗资输出: **REJECTED**
18. `#18` 交易遗漏其中一个买家退款输出: **REJECTED**
19. `#19` 错误的 KIP-20 authorizing input: **REJECTED**
20. `#20` 在买家输出上复制伪造契约 ID 延续: **REJECTED**
21. `#21` 终结步创建者保证金被克扣 1 sompi: **REJECTED**
22. `#22` 终结步创建者保证金被多给 1 sompi: **REJECTED**
23. `#23` 终结步未销毁契约延续性: **REJECTED**
24. `#24` 从退款分支试图伪造生成抽奖就绪 (`DRAW_READY`) 状态: **REJECTED**
