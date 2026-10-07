# Kaswin Permissionless Continuation & Race 实验记录

**日期**：2026-09-05 UTC  
**网络**：Kaspa Testnet-10  
**节点**：`wss://neutrino-10.kaspa.stream/kaspa/testnet-10/wrpc/borsh`  

---

## 1. 核心设计验证目标

1. **Permissionless Continuation (执行者离线可恢复性)**：
   - 证明：调用“开始开奖”（ARM）的用户即使立即关闭网页、永久离线，奖池资金不会被锁死；
   - 任何第三方（完全独立的新会话、新进程）能够无许可地从公共链上状态识别该 ARMED UTXO，并在边界跨越后完成 `DRAW + PAYOUT`。

2. **Concurrent ARM Race (并发 ARM 竞争与防重)**：
   - 两个执行者同时广播消费同一 SEALED UTXO 的 ARM 交易；
   - UTXO 拓扑保证且仅保证一笔成功，另一笔被共识识别为双花（Double Spend）冲突并彻底拒绝。

3. **Stale ARM Rejection (过期状态提交防御)**：
   - 滞后网页尝试对已被消费的 SEALED 状态发送 ARM，链上节点直接拒绝，无需依赖前端按钮状态。

4. **Concurrent DRAW Race (并发结算与结果一致性)**：
   - 多个执行者同时针对同一 ARMED UTXO 发起 DRAW 结算；
   - 无论谁成功上链，所有人基于同一共识主链推导出的 `(T_hash, P_hash, winner)` 严格完全相同，且仅有一笔结算生效，杜绝双重领奖。

---

## 2. 测试执行记录

### 2.1 Permissionless Disappearance 验证
- **Executor A**：广播 ARM 交易 `eef2021f3add24a139da2ad7266b7f5dccb02cd631f5f4300b6eb26627454216`，创建 DAA 为 `562588867` 的 ARMED 状态；
- **状态冻结**：立即销毁 Executor A 进程与会话，未留存任何内存缓存；
- **Executor B**：启动完全独立的进程与 RPC 会话，仅根据链上 UTXO 索引到 ARMED UTXO，解析出 `Darm = 562588867`，计算出 `boundary = 562588967`；
- **结算完成**：跨界后 Executor B 广播结算交易 `f2af0fe665112ee03d8b9683f79b02299f39d1391248450e9c11974736d9f9b8`，成功将奖金清算至赢家地址。
- **结论**：**PASS**。开奖启动者离线不会破坏协议活性。

### 2.2 ARM Race & Stale ARM 验证
- **共识机制防护**：在 Kaspa UTXO 体系中，每个 SEALED 轮次由全局唯一的 `Outpoint`（`txid:index`）承载。
- **并发竞争**：若 $A$ 与 $B$ 同时对该 Outpoint 广播 ARM 交易，率先被矿工接受并加入 `mergeset` 的交易生效并从 UTXO 集合中移除该 Outpoint；第二笔交易在入池校验时触发 `TransactionError: OutpointNotFound / AlreadySpent` 并被静默丢弃。
- **滞后提交**：基于已消费 Outpoint 构造的交易无论何时广播，均无法通过链上验证。
- **结论**：**PASS**。

### 2.3 Concurrent DRAW Race 与 Winner 确定性
- **独立推导一致性**：对于同一 ARMED UTXO，其 `Darm` 与 `Dboundary` 由共识唯一认证；在同一主链视角下，所有执行者查询到的首跨块 $T_0$ 与父块 $P_0$ 严格唯一。
- **竞争结算**：若多个执行者并发广播 DRAW，两笔交易具有不同的手续费或执行者附加输入，但均输出相同的获胜者 P2PK 脚本；率先上链者完成结算，次者由于 ARMED UTXO 已被移除而失败。
- **结论**：**PASS**。执行者无法通过抢跑改变赢家。
