# Final consensus gate — BLOCKED

基线 `137374814a1e663f50b6f859aa617b2fae4b5cd6`。没有修改生产constants或协议，没有TN10广播、main合并、force push。沿用既有架构preflight；本轮只替换测试的真实交易链及共识依赖。

## 已完成

- 正常path依赖 `kaspa-consensus` 指向 `/root/kaspa/references/rusty-kaspa/consensus`，固定HEAD `cfafeb4c093fa37a303f1b9f19c58f986b870ce3`。删除直接引入上游transaction_validator/mod.rs的做法。
- 安装系统libclang-dev供bindgen/RocksDB编译，不改上游源码。正常cargo check及完整cargo test已通过；后者不会执行bin main，实际bin另跑。
- SUCCESS旧票价改为1KAS，BUY资金输入随count供应本金和费用；CREATE添加真正内存Schnorr签名、找零、全部输入committed验证、isolation/UTXO规则及mass断言。
- 新增 `production_connected_refunds.rs.inc` 作为原E2E helper，准备canonical CREATE→P笔BUY→CLOSE→退款，P0/1/17/256。SMT采用稀疏frontier，不构造空树；每层UTXO来自前一交易输出，费用平衡分配。**该helper尚未跑过CREATE门槛，不能宣称后续BUY或退款通过。**
- pinned public TransactionValidator可导入，但header-context方法pub(crate)，外部不能直接调用。当前只有fixture DAA lock断言，不将它冒称完整header validator调用；仍是另一未闭合证据项。

## 精确失败

实际运行 `v1_production_e2e_full_lifecycle_test` 在第一条canonical P0 CREATE停止：

- Input0 ordinary P2PK：105,000,000 sompi；真实Schnorr签名。
- Output0 covenant P2SH：5,000,000 sompi，plurality=2。
- Output1 ordinary change：90,000,000 sompi，plurality=1。
- 实际fee：10,000,000 sompi。
- pinned `calc_contextual_masses`：**801,588**。
- storage block limit：500,000。

脚本、资金及最低relay费不能覆盖区块storage超限。新boundary chain还未达到BUY，不能报告完整connected E2E。

这说明此前5M押金的退出路径storage通过，不等于从常见ordinary funding形态创建该state同样可包含。它不证明所有funding拓扑都不可能；也未授权以额外特殊输入拓扑或修改押金常量绕过。当前只保留失败证据，不把提高fixture金额当边界通过。

## 实际回归

`artifacts/final-consensus-gate/`保存命令和原始输出。

- cargo test：PASS，正常依赖已解决cfg(test)编译问题。
- core / golden / reject：PASS。
- examples 21/21、links 0错误、npm 27/27：PASS。
- final E2E：FAIL，CREATE storage 801,588 > 500,000。

历史脚本内的SUCCESS/合成退款输出横幅不是最终验收证据；新增门槛在它们之前fail-fast。

最终 **V1 PRODUCTION CONSENSUS GATE BLOCKED**。先处理boundary CREATE可包含性的决策/fixture与公开header验证证据，再跑剩余连通链。禁止TN10。
