# Kaspa-Native Randomness & Reorg-Safe Draw 研究与形式化报告

**日期**：2026-09-05 UTC  
**环境**：Kaspa Testnet-10 (TN10 wRPC: `wss://vector-10.kaspa.green/kaspa/testnet-10/wrpc/borsh`)  
**节点源码**：`kaspanet/rusty-kaspa` `release v2.0.1` (`cfafeb4c093fa37a303f1b9f19c58f986b870ce3`)  
**标准规范**：`kaspanet/kips` (`e4ae2332117b5cb68bd6188e065ef885b6d17939`), KIP-16, KIP-17, KIP-20, KIP-21  

---

## 1. 核心结论 (Result)

**RESULT: FAIL**

**一句话结论**：  
在 Kaspa 现行共识与脚本体系中，**不存在任何可在无状态/局部状态 Covenant 内以 O(1) 成本唯一认证特定未来共识状态（无论按区块、DAA、时间戳或事件窗口）的原语**；只要依赖链上自推导，执行者永远拥有在可达共识状态集合中挑选有利结果的选择权；若采用 KIP-16 ZK 证明全局共识链，其证明成本退化为 $O(\text{dormancy history})$，违背小额抽奖与沉睡不变性。

---

## 2. 系统化研究路径评判 (Research Directions)

### Direction A: 固定未来观测点（按 DAA / Blue Score 唯一绑定）
- **设想**：不选“跨界首块”，而是预先指定精确目标 $D_{\mathrm{target}} = D_{\mathrm{arm}} + \Delta$。
- **证伪**：
  1. Kaspa 高速 BlockDAG 中，特定 DAA 分数可能有 0 个、1 个或多个并发块。
  2. 脚本中缺乏 `OpChainblockDaaScore(block)` 或 `OpChainblockBlueScore(block)`。
  3. 执行者传入的 Header preimage 依然无法由节点原生证明“该区块在全局链上的序数是精确的第 $K$ 个”。执行者仍可通过替换 anticone 块或后代块进行选择。
- **判定**：FAIL。

### Direction B: 固定窗口整体 Commitment
- **设想**：以一段区间内的聚合 commitment（如 SeqCommit / SMT / Merkle Root）作为熵源。
- **证伪**：
  1. KIP-21 的 `OpChainblockSeqCommit` 只能返回某一特定 selected-parent 区块的 `accepted_id_merkle_root`。
  2. 节点不存在跨块聚合的 Range Commitment 访问器。
  3. 区间的起点与终点依然需要依托于具体区块的选定，再次退化为区块选择问题。
- **判定**：FAIL。

### Direction C: SeqCommit 作为纯熵源
- **分析**：SeqCommit 包含丰富的执行状态和 Mergeset Context，确实具备高度不可预测性（PoW 熵）。
- **瓶颈**：**Entropy generation $\ne$ Entropy selection**。虽然 `SeqCommit(T)` 本身不可预测，但在同一 ARMED 状态下，执行者可以在 access window 内的数十个候选块 $T_0, T_1, \dots, T_k$ 中挑选对自己有利的 `SeqCommit(T_i)`。
- **判定**：FAIL。

### Direction D: 基于交易排序/状态转移 (Transaction Ordering / Acceptance)
- **分析**：Kaspa KIP-15/21 规定了确定性交易拓扑排序。
- **瓶颈**：Covenant 无法内省当前块之前的区块中所包含的交易集。脚本内省能力（`OpTx*`）严格局限于当前消费输入所在的这笔交易本身，无法感知外部交易历史。
- **判定**：FAIL。

### Direction E: KIP-16 ZK 递归证明 (Verifiable Computation)
- **分析**：KIP-16 已在 rusty-kaspa 中引入 `OpZkPrecompile<0xa6>`（支持 RISC Zero 与 Groth16）。Prover 理论上可以在链下读取节点完整 DAG，证明“根据 GHOSTDAG 规范，$T^*$ 是该 ARMED UTXO 唯一确定的 canonical 目标”。
- **代价与失效**：
  1. **历史依赖**：证明 GHOSTDAG 拓扑排序需要向 zkVM 输入从 ARMED 确认点到开奖点的所有区块头（10 BPS 下每分钟 600 个块，每小时 36,000 个块）。
  2. **Dormancy 违背**：一旦 SEALED/ARM 状态沉睡数小时或数天，证明计算量爆炸，$O(\text{dormancy})$ 彻底击穿小额抽奖的经济可行性。
- **判定**：FAIL（不满足小额与沉睡不变性约束）。

---

## 3. Kaspa VSPC Reorg 实测数据 (TN10 Real Evidence)

通过对 TN10 实时节点 (`wss://vector-10.kaspa.green/kaspa/testnet-10/wrpc/borsh`) 订阅 `virtual-chain-changed` 监听连续 15 秒（134 个事件）：
- **事件总数**：134 次
- **Reorg 发生次数**：14 次（在 10 BPS 网络下，tip 发生微重组是常态）
- **重组深度分布**：
  - 1 块深度回滚：10 次
  - 2 块深度回滚：4 次
- **典型案例**：
  - 事件 #7: 移除 `[d36b2f13..., 859b575c...]`，加入 `[8c117a4d..., fc4cb290...]`
  - 事件 #8（立即发生反转）: 移除 `[fc4cb290..., 8c117a4d...]`，重新采纳 `[859b575c..., d36b2f13..., dae9a823...]`
- **结论**：
  Kaspa BlockDAG tip 处于高频微重组状态。若采用浅层区块作为熵源，开奖结果存在极高的临时不确定性。

---

## 4. Finality 与 Accessor 窗口冲突 (Finality vs Access Window)

根据 `rusty-kaspa` 参数配置：
- `target_time_per_block` = 100 ms (TN10)
- `finality_depth` = 432,000 块（约 12 小时）
- `OpChainblockSeqCommit` access threshold $F$ 严格等于 `finality_depth`：
  $$\text{target.blue\_score} + F > \text{selected\_parent.blue\_score}$$
- **矛盾**：
  若要求熵目标达到完全 finality 状态（即经过 432,000 块确认），该区块在被共识确认 finality 的瞬间，其相对深度正好滑出 `OpChainblockSeqCommit` 的可访问窗口！
  因此，**链上脚本不可能引用一个“既达到永久 finality 又仍在访问器窗口内”的区块**。

---

## 5. 核心矛盾根源与缺失 Primitive

Kaswin 要在纯 Kaspa 原生共识下成立，必须解决“如何在无状态脚本中锚定唯一的未来共识事件”。目前缺少的根本共识原语是：
1. **`OpChainblockDaaScore / OpChainblockBlueScore`**：直接由节点共识环境返回链上已确认区块的精确计分，杜绝伪造 Header preimage。
2. **`OpSelectedParentHash`**：直接由节点内省当前链的 selected parent，剥夺执行者使用 anticone 侧枝父块替代的自由度。
3. **`OpUniqueTransitionAnchor`**：允许 UTXO 挂载由共识流水线推进的单调递增计数器。

在没有上述共识原语升级之前，任何试图在纯 Kaspa 脚本内由执行者提交区块参数自推导随机数的设计，均无法防御“执行者选择权（Executor Selection Bias）”。

---

## 6. 下一步动作 (Next Action)

**停止在 Kaspa 脚本内单方面自推导共识熵；协议应转向由外部无偏门限随机信标（如 drand / 门限聚合）提供链上验签证据，或明确将 Kaswin 判定为受限于 Kaspa L1 现行 Covenant 表达能力而暂不可行。**
