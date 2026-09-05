# 可行性核验 01：时间与链锚有效窗口

2026-09-05 UTC；验证层 S（本机固定源码阅读），不是 VM 或节点集成。节点源码固定 `cfafeb4c093fa37a303f1b9f19c58f986b870ce3`。本轮不安装依赖、不执行签名或广播。

## F1：输入 DAA 不是当前时间

[opcode 源码](https://github.com/kaspanet/rusty-kaspa/blob/cfafeb4c093fa37a303f1b9f19c58f986b870ce3/crypto/txscript/src/opcodes/mod.rs) 的 OpTxInputDaaScore 读取 `utxo.block_daa_score`。它不能直接提供“本次交易接受时刻小于截止”的检查。

[交易终局检查](https://github.com/kaspanet/rusty-kaspa/blob/cfafeb4c093fa37a303f1b9f19c58f986b870ce3/consensus/src/processes/transaction_validator/tx_validation_in_header_context.rs) 在 lock_time 小于上下文时间/DAA 时放行；即使 locktime 尚未到达，所有输入 sequence 为 u64::MAX 仍可放行。因此只比较 tx.locktime 不足以实施退款时间下界。必须使用具有对应 sequence 约束的正确锁定语义并验证边界。

**设计决定**：不把前端倒计时、输入 DAA 或单纯 locktime 当作当前时间上界。A 型未满退出暂按“达到条件可发起退款”建模，不宣称截止一到网络自动禁止购买。此选择是待证明安全性的候选语义，不能静默对用户宣传为严格到期取消。购买/退款竞争必须在随机信息尚不可知的状态解决。

## F2：OpChainblockSeqCommit 不是永久随机信标

同一 opcode 源码要求目标为执行视角下 selected-chain ancestor；已裁剪、非 selected 或超过深度的目标会失败。

[SeqCommitAccessor](https://github.com/kaspanet/rusty-kaspa/blob/cfafeb4c093fa37a303f1b9f19c58f986b870ce3/consensus/src/model/services/seq_commit_accessor.rs) 实现：

- 按当前 selected_parent 判断链祖先关系；
- 目标须处于 Toccata 激活范围；
- 使用 `target.blue_score + threshold > selected_parent.blue_score` 的严格深度条件；
- 返回目标 header 的 `accepted_id_merkle_root`。

DAA 分数与 blue score 不能混用。此处没有将配置 threshold 换算为某个未经核验的小时数。

**直接后果**：即使第三方永久保存 header 或把 HTML 保存到本地，目标超过执行窗口后也不能靠提供旧 header 让该 opcode 通过。历史可获得性不等于合约可执行性。

## F3：旧链锚思路存在必须处理的终结缺口

若满额后固定唯一未来锚，但无人及时提交，锚可能超出可调用窗口。下列“修复”不能直接采用：

| 候选补救 | 为什么不接受为现成解法 |
|---|---|
| 随便选更新的锚 | 允许延迟并选择结果 |
| 超时取消并退款 | 已知结果后可能选择取消 |
| 要求官方 keeper 始终在线 | 引入项目方服务可用性依赖，不满足核心目标 |
| 提高奖励 | 激励不是总有人行动的证明，仍有审查/网络故障 |
| 保存档案 | 不改变 opcode 的深度限制 |

**决定**：链锚仅作为研究候选，不指定为首版正式开奖算法。满额后无人推进仍能恢复、且不能选结果的证据路径是接收资金前的阻塞条件。

## 后续论证顺序

1. 查明 sequence commitment 与证明接口能否对早已冻结的历史事件提供另一种长期有效验证路径，及其实际资源成本。不能仅因存在 ZK opcode 就假定已有可用证明系统。
2. 研究原子保存随机证据的状态方案，检查是否只是把“无人保存”的问题前移，以及冻结交易是否给结果选择权。
3. 若所有候选都要求有界时间内至少一名执行者行动，明确列为附加活性假设；不宣称已经满足无条件恢复。不得为了推进实现偷偷换成可信 oracle。

## 当前结论

单 HTML 的打包可作为交付工程目标，但公平随机与满额后安全终结仍未证明可同时实现。可以继续完善数据/资金/恢复规格，不应制作看似可投注的演示并把它当作协议已完成。保留本轮发现，包括失败方案，不删除中间研究材料。
