# V1 历史归档（2026-09 现场审计快照，非 V2 / F3.2 现行代码）

本目录完整保留 Kaswin 早期 V1 协议与研发探索的历史资产，以确保协议可溯源性与非破坏性保留（Non-destructive Retention）。当前 V2 协议不依赖本目录下的任何文件。

---

## 归档目录结构

```text
docs/legacy-v1/
├── README.md               # 本文档（V1 阶段说明与历史结论）
├── src/                    # V1 早期单页应用静态源码（离线设计原型）
├── tools/                  # V1 旧版构建工具与只读测试脚本
├── tests/                  # V1 针对早期原型的测试套件与 Rust VM 验证代码
├── contracts/              # V1 早期纯 Rust 模拟 Covenant 原型（14 个 .rs 文件）与旧实验脚本
├── artifacts/              # V1 阶段的各门禁执行日志（gate-closure、storage-admission 等）
├── research/               # V1 早期 TN10 节点交互记录、领水日志与状态快照
└── reports/                # V1 阶段的 58 份可行性、攻关与审计报告
```

---

## 历史设计报告索引（归档至 reports/）

- [A 型最小协议草案](reports/type-a.md)
- [决策与实施门槛](reports/decisions.md)
- [最小必要验证计划](reports/validation.md)
- [固定来源与兼容边界](reports/sources.md)
- [可行性 01：时间与链锚有效窗口](reports/feasibility-01.md)
- [随机证据恢复：旧目标与近期验证锚](reports/randomness-recovery.md)
- [原子派奖结算报告](reports/atomic-payout-settlement-report.md)
- [批量退款可行性审计报告](reports/batched-refund-feasibility-audit-report.md)
- [有界购买目录方案](reports/bounded-purchase-directory-preflight.md)
- [存储质量门禁分析报告](reports/storage-mass-admission-report.md)
- [无许可结算竞争分析](reports/permissionless-settlement-race.md)

---

## 历史验证状态（V1 现场审计快照基线）

- **Real TN10 P2SH Covenant**: **PASS**
- **Real OpTxInputDaaScore**: **PASS**
- **Real OpChainblockSeqCommit**: **PASS**
- **Header-bound first-crossing**: **UNDER INDEPENDENT AUDIT**

注：以上结论仅属于 2026-09 的 V1 早期原型阶段，不代表当前 V2 链式模板哈希架构的验证状态。当前 V2 状态请参阅 [docs/kaswin-v2/](../../docs/kaswin-v2/)。

