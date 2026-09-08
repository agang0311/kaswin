# Production consensus final gate — BLOCKED checkpoint

历史实现基线：`403cb0467a4edd12e6288fdb46b58c940acd2b33`，分支 `audit/state-deposit-v1`。以下 BLOCKED 状态后来已 checkpoint 并推送于 `97d42155c5f160435ce52abe2b15a535e2c20472`。无节点或广播。后续 storage admission 增量研究见 [storage 报告](storage-mass-admission-report.md)；整体 connected E2E gate 仍未关闭。

固定源码：rusty-kaspa `cfafeb4c093fa37a303f1b9f19c58f986b870ce3`。仅授权合成测试交易的内存离线密钥/签名，不读取真实钱包，不输出私钥。

## 当前实际证据

- `v1_production_covenants_test` 本轮运行成功：包含 creator Class A 正例、Class B/C/畸形拒绝，以及 EMPTY close 脚本正负例。这不是整笔交易/网络验证完成。
- `v1_production_e2e_full_lifecycle_test` 本轮失败，不得沿用旧的全通过报告。
- 新增 acceptance helper 对所有实际输入使用其 `compute_commit.allowed_script_units()`；普通 sponsor Schnorr 输入修正为可覆盖验证成本的预算，独立交易不共享 sighash 中间缓存。
- helper 调用未修改的 pinned TransactionValidator isolation/header/populated rules。populated 阶段采用 SkipScriptChecks 是因为所有输入已经显式执行 committed VM；不是省略签名检查。PASS-A 的 selected-chain/sequence commitment 访问仍由离线 fixture 提供，不能称为在线 acceptance。
- 实际签名后按最终输入/输出求 fee，并断言 relay floor，contextual mass 计算失败不得当作零。新增单交易不得超过区块 compute/transient/storage 容量的断言。

## 当前精确失败

`REFUND Step 0 (K=9)`：storage mass **1,041,647**，超过 **500,000** 区块容量。此前只有 fee floor 断言，错误地遗漏此阻断。

此前 P=256 fixture 非终局 storage mass **2,764,642**、终局 **2,756,876**，同样超限。尚未决定其是否仅为 fixture 金额问题或覆盖生产最小经济参数的真实活性缺口；不得仅调高票价然后声称全域活性通过。

## 尚未关闭

1. P=17 起点仍为合成 OPEN(sold=51, P=17)，必须替换为 canonical CREATE + 17 次 BUY 连续链。其原 min_tickets=60 / ticket_price=3,000,000 的 CREATE 经济门槛也须实际校验。
2. CREATE 尚有占位签名，须真正内存签名、完整验证，并连接后续状态。
3. P=1/P=256、EMPTY 的全部交易 provenance、budget 和容量/relay 证据仍需补齐。
4. B_min 探测和实际 transaction ComputeCommit 的最终构建顺序需统一，保留 B_min=0 无 B_min-1 的诚实说明。
5. 完整回归、最终资源表、文档矩阵同步、commit/push 尚未完成。

## 退出语义

P>=1 failed-sale refund：无许可、从买家本次退款中收取有界费用、可恢复推进。

P=0 没有买家本金。V1 保留创建者押金精确全额返回，由外部普通 fee sponsor 支付 EMPTY recovery 网络费；不能把该路径称为普通 self-funded refund。

最终裁决保持 **V1 PRODUCTION CONSENSUS GATE BLOCKED**。
