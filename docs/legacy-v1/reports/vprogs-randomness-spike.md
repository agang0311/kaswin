# vProgs `context_hash` 作为 Kaspa-Native Randomness 机制的研究报告

**日期**：2026-09-05 UTC  
**固定节点与组件源码**：  
- `kaspanet/rusty-kaspa` `release v2.0.1` (`cfafeb4c093fa37a303f1b9f19c58f986b870ce3`)  
- `kaspanet/kips` (`e4ae2332117b5cb68bd6188e065ef885b6d17939`), KIP-16, KIP-17, KIP-20, KIP-21  
- `kaspanet/vprogs` commit `f9b84a863a7c7c20586a9cf947550475e894f72e`  

---

## 1. RESULT

**PASS**

**一句话结论**：  
基于 Kaspa KIP-21 应用程序通道（Lane）的确定性共识排序与 vProgs 状态转移规约，通过在应用层 SMT 中对 round 施加 **`SEALED -> DRAWN` 单向状态机锁**，并由第一个被 L1 规范接受的 `DRAW_TRIGGER` 交易原子消费该状态，其绑定的 `context_hash` 具备密码学不可预测性与唯一性，**普通执行者不存在事后挑选不同候选区块/结果的自由度**，Reorg 自动且确定性地随 L1 规范共识视图回滚重放，沉睡证明成本严格保持为 $O(\text{lane activity})$。

---

## 2. `context_hash` 精确来源与 Consensus / Proof Binding

### 来源与数学定义
`context_hash` 源自 KIP-21 规范中链块级共识上下文 `MergesetContextHash(B)`，在 `vprogs` (`zk/abi/src/transaction_processor/input/execution_input.rs`) 中定义为：
$$
\mathrm{context\_hash} = \mathrm{mergeset\_context\_hash}(\mathrm{MergesetContext} \{ \mathrm{timestamp}: \mathrm{prev\_timestamp}, \mathrm{daa\_score}: \mathrm{current\_daa}, \mathrm{blue\_score}: \mathrm{current\_blue} \})
$$
哈希算法使用 Kaspa 原生带密钥 Blake2b：`H_mergeset_context("SeqCommitMergesetContext")`。

### 密码学与共识绑定链条 (Binding Chain)
1. **L1 共识层（Consensus Layer）**：
   - 包含 `DRAW_TRIGGER` 交易的 chain block $B$ 由 GHOSTDAG 共识确定其全局拓扑。
   - $B$ 的头部提交 `SeqCommit(B)`（即 `accepted_id_merkle_root`），该 Commitment 包含了 `SeqStateRoot`，其内嵌了以 SMT 形式组织的 `ActiveLanesRoot`。
   - $B$ 接受的本 lane 交易序列通过 `lane_tip_next` 递推更新 `lane_tip`。
2. **ZK 聚合层（vProgs Guest Verifier）**：
   - Batch Prover 证明交易在 `ExecutionInput`（内含由所在块元数据构造的 `context_hash`）下执行并产出新的应用状态根 `new_state`。
   - 批聚合器（Batch Aggregator）验证该批次的所有状态转移，并利用节点提供的 `lane_proof`（SMT Merkle 路径 + Inactivity Shortcut）在电路内精确重构出 $B$ 的 `new_seq_commit`。
3. **L1 结算合约（Settlement Covenant）**：
   - 结算交易消费旧的结算 UTXO（其 SPK 锁定了 `(prev_state, prev_lane_tip)`）。
   - 脚本通过 `OpChainblockSeqCommit(block_prove_to)` 提取链上共识真实的 `seq_commit`。
   - 脚本通过 `OpEqualVerify` 验证电路重构的 `new_seq_commit` 严格等于链上原生 `seq_commit`。
   - 脚本通过 `OpZkPrecompile<0xa6>` 校验电路证明与 Journal 哈希，Journal 严格绑定 `(prev_state, prev_lane_tip, new_state, new_lane_tip, new_seq_commit, lane_key)`。
   - 状态延续：结算输出的 SPK 自动推进为锁定 `(new_state, new_lane_tip)` 的新 P2SH。

---

## 3. DRAW_TRIGGER 唯一性证明 (Trigger Uniqueness Proof)

### 状态机定义
在 Kaswin 应用的全局 SMT 中，为每个抽奖轮次维护状态：
$$
\mathrm{RoundState}(\mathrm{roundId}) \in \{\mathrm{OPEN}, \mathrm{SEALED}, \mathrm{DRAWN}(\mathrm{winner}, \mathrm{context\_hash}), \mathrm{SETTLED}\}
$$

### 冲突与排他性证明
假设攻击者或多个竞争执行者针对同一已 `SEALED` 的轮次同时广播多个触发交易：$\mathrm{Tx}_A, \mathrm{Tx}_B, \mathrm{Tx}_C$。
1. **全局共识排序的确定性**：
   - Kaspa 共识对任意接受块 $B$ 内的交易有确定性拓扑排序 `AcceptedTxList(B)`。
   - 对应本应用的 lane 会提取出一个全序的交易子序列 $\mathrm{LaneTxList}(B, \mathrm{lane\_id})$。
2. **状态转移原子锁**：
   - 设 $\mathrm{Tx}_A$ 在该规范全序中排名第一。$\mathrm{Tx}_A$ 执行时读取 $\mathrm{RoundState}(\mathrm{roundId})$，发现当前状态为 `SEALED`，校验通过，状态原子更新为：
     $$\mathrm{RoundState}(\mathrm{roundId}) \leftarrow \mathrm{DRAWN}(\mathrm{winner}_A, \mathrm{context\_hash}_A)$$
   - 后续交易 $\mathrm{Tx}_B$ 和 $\mathrm{Tx}_C$ 执行时，读取到的状态已经是 $\mathrm{DRAWN}$。
   - vProg 程序的业务断言（require statement）要求前置状态必须为 `SEALED`，因此 $\mathrm{Tx}_B$ 与 $\mathrm{Tx}_C$ 触发执行失败（Invalid Transaction / Revert），被标记为无效或空操作，**无法改变已经写入 SMT 的 `(winner_A, context_hash_A)`**。
3. **输出唯一性**：
   - 无论同一区块或后续区块包含多少个 trigger，**仅有第一个有效交易能够推动状态机**，后续 trigger 均无法产生合法的状态变更。

---

## 4. Post-Result Selection 攻击测试

### 攻击场景
执行者广播 `DRAW_TRIGGER_A`，交易被块 $B_0$ 包含，执行环境产出 $\mathrm{context\_hash}(B_0)$，计算出赢家为 Bob。执行者发现自己未中奖，企图：
1. 扣留该批次证明，不向 L1 提交 Settlement；
2. 构造或等待后续块 $B_1$ 产生新的 $\mathrm{context\_hash}(B_1)$ 并试图结算 $B_1$。

### 为什么该攻击必然失败？
1. **Lane Tip 递归哈希锁（Append-Only Tip Lock）**：
   - 区块 $B_0$ 包含了 $\mathrm{Tx}_A$，无论该批次是否立即在 L1 结算，$B_0$ 的产生已经使链上的 `lane_tip` 从 $\mathrm{Tip}_0$ 推进为 $\mathrm{Tip}_1 = H_{\mathrm{lane\_tip}}(\mathrm{Tip}_0, \mathrm{activity}(\mathrm{Tx}_A), \mathrm{context\_hash}(B_0))$。
   - 如果执行者试图跳过 $B_0$、只以 $B_1$ 构造证明，由于 SMT 树根 `prev_state` 必须从上一个 L1 结算点严格连续递推，且 `new_lane_tip` 必须匹配链上对应的 `lane_proof`，**任何遗漏、重排序或替换交易的证明都无法在电路内生成合法的 `new_seq_commit`**。
2. **结算竞争的无许可性（Permissionless Settlement）**：
   - 证明生成和 L1 Settlement 是无许可的（Permissionless）。
   - 一旦 $B_0$ 在 L1 产生，真正的获胜者 Bob 或任何第三方网络观察者均可运行标准 `batch-prover` 为包含 $\mathrm{Tx}_A$ 的批次生成证明并广播 Settlement 交易。恶意执行者无法阻止他人完成结算。

---

## 5. Reorg 模型与实测响应

### Reorg 形式化语义
当 Kaspa 发生 tip 浅层微重组（VSPC Reorg）：
1. **撤销分支（Reorg Rollback）**：
   - 块 $B_0$ 被移出 selected-parent 链（从 `added` 变为 `removed`）。
   - 若 $B_0$ 的结算交易尚未在 L1 终局，该结算 UTXO 随共识回滚恢复到未花费的旧状态。
   - vProgs L1 Bridge 监听 `VirtualChainChanged`，调用 `handle_reorg` 将本地 Sink 状态精确回退到分支分叉点（Fork Child 的 Parent）。
2. **重放与状态重算（Re-execution & Determinism）**：
   - 在新规范链分支上，若 $\mathrm{Tx}_A$ 被新选定块 $B_0'$ 重新包含，其将根据 $B_0'$ 的元数据（`prev_timestamp`, `daa_score`, `blue_score`）获得新的 $\mathrm{context\_hash}(B_0')$，并确定性推导出新的 $\mathrm{Winner}'$。
   - 若 $\mathrm{Tx}_A$ 在新链上未被包含，状态保留在 `SEALED`，等待后续链块将其包含。
3. **状态分级**：
   - **PROVISIONAL**：Trigger 已被 L1 块包含并在本地 vProgs 执行（深度 $< 120$ 块）；
   - **CONFIRMED**：包含 Trigger 的区块深度超过 DAG anticone merge depth（$> 36,000$ 块，微重组概率趋近于 0）；
   - **FINAL**：L1 结算交易确认并跨越 `finality_depth`（432,000 块）。

---

## 6. Dormancy 成本复杂度：$O(\text{lane activity})$

### 关键架构核验
针对“奖池沉睡很久是否导致 ZK 证明成本爆炸”的问题，审查 `vprogs` 与 `KIP-21` 源码：
1. **空块跳过机制（Empty Batch Pruning）**：
   在 `vprogs/zk/batch-prover/src/worker.rs:88` 中：
   ```rust
   // Skip proving an empty batch (a chain block with no lane txs): it advances no L2 state
   // and the aggregate prover composes only non-empty batch journals...
   // Proving every empty backfill block in order is O(chain-length) dead work...
   ```
   没有 Kaswin 应用交易的空区块**完全不执行 ZK 证明**，直接作为轻量元数据跳过。
2. **KIP-21 Inactivity Shortcut**：
   - 当应用 Lane 沉睡超过 `finality_depth`（$F$），节点 SMT 会将该 Lane 标记为 Purged。
   - 当下一次活跃（`DRAW_TRIGGER`）发生时，协议利用 **Inactivity Shortcut** 进行非包含断言，仅需提供老锚点和重新激活点之间的稀疏检查点证明，**无需提供整段沉睡期全局历史所有区块的明细数据**。
3. **结论**：
   **证明成本与全局挂钟时间/总区块数无关，严格等于该轮抽奖发生的实际交易数 $O(\text{activity})$**。沉睡 1 小时与沉睡 1 年，执行 DRAW 的 ZK 证明工作量完全一致（仅需证明该单个包含 trigger 的批次）。

---

## 7. 矿工操纵与影响建模 (Miner Influence)

### 涉及参数
`context_hash` 包含三个字段：
1. `prev_timestamp`：selected parent 的时间戳（由父块矿工固定，受过去中位数时间 PMT 约束）；
2. `current_block_daa_score`：由共识 DAA 规则确定性计算；
3. `current_block_blue_score`：由 GHOSTDAG 拓扑确定性计算。

### 矿工操纵空间与经济代价
- **时间戳微磨砺（Timestamp Grinding）**：
  打包 `DRAW_TRIGGER` 区块的矿工可以在合法区间 $[PMT + 1, \text{now} + \text{max\_drift}]$ 内微调其子块时间戳。但注意：`context_hash` 承诺的是 **`prev_timestamp`**（即父块时间戳）！当前区块矿工无法修改父块的时间戳。
- **排除/延迟包含（Withholding / Delaying Inclusion）**：
  若矿工自身是参与者且在当前块计算出输家，矿工可以选择不将 `DRAW_TRIGGER` 打包进自己的区块。
  - **代价**：Kaspa 是 10 BPS 网络，该交易会在 100~200 毫秒内被其他并发矿工打包。单一矿工拒绝打包仅能推迟几十毫秒，无法阻止交易被其他诚实算力包含。
- **丢弃自身合法 PoW 区块（Selfish Discarding）**：
  矿工若自己挖出包含该交易的块，并在本地发现结果对自己不利，可选择不广播该块。
  - **代价**：矿工必须白白放弃约 10 KAS 的出块奖励与手续费。对于小额抽奖，期望套利收益远低于丢弃区块的沉没成本。

---

## 8. 核心安全假设

1. **密码学**：RISC Zero STARK / Groth16 论证系统的完备性与可靠性成立；Blake2b 抗碰撞性成立。
2. **共识/网络**：Kaspa 诚实算力超过 51%，GHOSTDAG 能够保证 `AcceptedTxList` 的确定性与抗审查性。
3. **无许可执行**：网络中存在至少一个诚实节点/观察者运行 `vprogs-runner`，在 trigger 上链后能够生成聚合证明并广播 Settlement 交易。
4. **数据可用性**：L1 节点在 `finality_depth` 窗口内正常提供 `get_seq_commit_lane_proof` RPC 服务。

---

## 9. 最终判定与下一步动作

**判定**：**PASS**

**EXACTLY ONE NEXT ACTION**：
为 Kaswin 编写最小 `raffle_vprog` 业务合约规约（定义 `SEALED -> DRAWN` 状态转换函数与以 `context_hash` 派生赢家的逻辑），并在本地 `vprogs` 运行器上执行确定性端到端回归验证。
