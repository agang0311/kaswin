# R3 成本审查：重证书退出首版主路径

日期 2026-09-05 UTC。用户指出高成本证明可能无人执行。此轮为固定源码/规范核对，没有部署、TKAS 花费或费用实测。

## 决定

R1/R2 保留为研究，不作为首版已经选定的开奖与恢复方案。单步有界不等于总费用可接受。公平/恢复未成立前不增加新的证书合约、ZK 框架或后台服务。

## 新发现：共识内置 shortcut，但不是免费历史查询

KIPs e4ae2332117b5cb68bd6188e065ef885b6d17939 的 [KIP-21 §5.4](https://github.com/kaspanet/kips/blob/e4ae2332117b5cb68bd6188e065ef885b6d17939/kip-0021.md) 将 InactivityShortcut 承诺到 ActivityRoot。它指向约一个 F 窗口以前的 selected-parent 祖先 commitment。

固定节点 cfafeb4c093fa37a303f1b9f19c58f986b870ce3 的 [hashing.rs](https://github.com/kaspanet/rusty-kaspa/blob/cfafeb4c093fa37a303f1b9f19c58f986b870ce3/consensus/seq-commit/src/hashing.rs) 和 [verify.rs](https://github.com/kaspanet/rusty-kaspa/blob/cfafeb4c093fa37a303f1b9f19c58f986b870ce3/consensus/seq-commit/src/verify.rs) 可核对其绑定：activityRoot=H(shortcut,lanesRoot)，逐层绑定至可信 SeqCommit。

只认证 shortcut 指向的 commitment，不等于证明某 app 在跨越区间无活动；后者还需正确 lane 不包含证明和对应语义。不能把只读到跳转指针称为完成开奖边界证明。

## 复杂度边界

令 n 为历史跨度、F 为窗口（同种 score 量纲），先跳远期窗口、到目标附近再逐步验证：粗略工作由逐块 O(n) 改善到 O(n/F + F)，还未计见证构造、score 跨越和目标边界证明成本。它不是 O(log n)，也不是常数大小证明。F 范围内尾部可能依然很大；不得按该式给出未经测量的网络费。

对于 lane 无活动证明可利用 O(n/F) 跳转，但开奖需要证明特定历史目标，不可直接套用“只看应用活动”的复杂度。新项目也不创建自己的共识 lane 来规避这个区别。

## 数据接口检查

固定节点 [RPC service](https://github.com/kaspanet/rusty-kaspa/blob/cfafeb4c093fa37a303f1b9f19c58f986b870ce3/rpc/service/src/service.rs) 存在 get_seq_commit_lane_proof_call，返回 smt_proof、lane、payload_and_ctx_digest、parent_seq_commit、inactivity_shortcut。不能据此断言任意旧块可查。当前官方下载 SDK v2.0.1 nodejs/kaspa.d.ts 未发现 getSeqCommitLaneProof 声明；需要进一步核对 wire DTO/方法和节点能力，不编造 SDK API。

## 更重要的安全/活性冲突

若开奖结果在时刻 t 可知，而同一未终结状态在未来 t+d 允许无许可退款：在足够长的无人执行、审查或故障之后，退款与派奖会竞争，输家可能尝试取消。这不是单纯费用问题。

因此不采用“锚窗口内开奖，窗口外全额退款”作为公平等价替代。只有当取消资格在任何人可知结果之前不可逆固定，且正常网络时序能落实此分离，才值得重新评估；不能仅依赖执行者承诺不抢跑。

## 经济验收门槛（不伪造数值）

候选必须列出：正常/故障每条路径的最大 witness、mass、交易次数、数据服务要求、费用承担者，以及竞争失败损失。设最小开放奖池 P_min、可验证结算费上界 C_max，至少要求赢家自行执行存在正净收益，并给出安全余量；这只是必要条件，不是充分活性证明。公开执行奖励不得凭自报工作量累积。

小奖池如果不足以覆盖允许故障路径，应拒绝创建该参数，不能先让用户付费再提示恢复不划算。若 C_max 无统一上界，则不将该方案作为首版的成本可控路径。

## 本轮结论

shortcut 是值得继续核验的优化线索，但没有推翻“重证书不适合直接进 V1”的结论。最小产品必须先找到成本可控且不允许看结果退出的结算结构；本轮没有形成满足全部核心要求的正式算法。保留反例与失败方向，不靠增加测试数量假装进展。
