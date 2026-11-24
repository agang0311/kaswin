# Kaswin kUSDT v2 Contracts (256 Parallel Shards)

> 状态：**Phase 1 完成（7/7 `silverc 1.0.1` 离线编译通过；`tester` 真实 `kaswin-rolling-vm` 48/48 全量正/负例与 4 项工程边界校准通过；模板哈希已冻结）**。
> 验证边界：上述验证覆盖固定 `silverc 1.0.1` 编译与真实 `kaswin-rolling-vm` 离线 VM 验证；**Testnet 10 / 主网真实链上交易与 acceptance 验证为 `NOT_RUN`**。
> 上游规格：[KUSDT-PARALLEL-SHARDS-DRAFT.md](../../docs/KUSDT-PARALLEL-SHARDS-DRAFT.md)、[KUSDT-PARALLEL-SHARDS-SPEC.md](../../docs/KUSDT-PARALLEL-SHARDS-SPEC.md)。

## 冻结模板哈希清单（`MAX_BATCH=8`，主网 `KUSDT_CID`）

完整机读清单见 [artifacts/template-pins.json](artifacts/template-pins.json)（`kusdtCid = 50b3477e7368d0c5bfbd64483b4607350ec411377972f33e40b2d4b6d1513fd3`）：

| 编译顺序 | 模板 | 合约名 | Bytecode | Tail | 冻结 `templateHash` |
|---:|---|---|---:|---:|---|
| 1 | `s_payout` | `KusdtShardPayout` | 2,343 B | 2,230 B | `d9c495e42d7730616441e05335ab8e30a742e7004e67f467ad4498111452e950` |
| 2 | `s_refund` | `KusdtShardRefund` | 3,128 B | 3,045 B | `63f0f28aee985e1b3393c3722de1cbf1c4bec8eb565de75ee5125165c9a79983` |
| 3 | `s_frozen` | `KusdtShardFrozen` | 810 B | 695 B | `5f6a591bd11fc5d4f873ab17aa94cc5b41e688ff7b9bae34e157dd5f86dfc76a` |
| 4 | `s_open` | `KusdtShardOpen` | 2,678 B | 2,563 B | `30213f2234df0b1f67794ef5b8fd6e91f144a3d745ffa282d679218ac52165fc` |
| 5 | `m_dispatch` | `KusdtManagerDispatch` | 4,063 B | 3,936 B | `c19b021080e31fd1408bd7aa7455cf11cfd4324d1cae0d94dd8ce6139db00050` |
| 6 | `m_sealed` | `KusdtManagerSealed` | 15,608 B | 15,477 B | `e987429ff1ee8d5905fe6dc7c7a01ea5747f7e036d26d2a2e37e35c6d031f20f` |
| 7 | `m_open` | `KusdtManagerOpen` | 8,750 B | 8,688 B | `559e67acf808e5d48283421e01ac7dc3134d91109f09ac1257324fa85feb8f2a` |

## 真实 VM 边界校准摘要（`tester` 48/48 通过）

- **结论**：`MAX_BATCH=8` 与 `M_OPEN`/`M_SEALED` 68B/片直存名册（满载 17,468B）全部在 244 栈深与 `computeMass < 500k` / `transientMass < 1M` 安全余量内，无需降批或压缩名册格式。

| 动作（边界场景） | `sig0` | `tx size` | `computeMass` | `transientMass` | `storageMass` | `used_script_units` | `minBudget` |
|---|---:|---:|---:|---:|---:|---:|---:|
| `OPEN_SHARD`（0→1 片） | 15,253 B | 15,909 B | 23,749 | 63,636 | 54,182 | 282,568 | `28` |
| `OPEN_SHARD`（255→256 满载） | 32,595 B | 33,251 B | 41,091 | 133,004 | 54,182 | 993,555 | `99` |
| `BUY`（1→2 记录） | 6,613 B | 7,236 B | 16,706 | 28,944 | — | 142,017 | `14` |
| `BUY`（255→256 满片） | 15,758 B | 16,381 B | 25,851 | 65,524 | — | 489,541 | `48` |
| `EMPTY_CLOSE` | — | — | — | — | — | 19,169 | `1` |
| `COLLECT_BATCH`（256 片, `k=8`, 8×256 记录） | 42,404 B | 144,689 B | 178,379 | 578,756 | 42,587 | `M_OPEN` 3,177,669 / `S_OPEN` 239,069 | `317` / `23` |
| `DRAW`（256 片满载 + 9,292B frozen） | 46,437 B | 46,778 B | 53,508 | 187,112 | 90,089 | 7,244,015 | `724` |
| `REROLL` | — | — | — | — | — | 332,471 | `33` |
| `DISPATCH_BATCH`（256 片, `k=8`, PAYOUT） | 14,822 B | 114,384 B | 148,064 | 457,536 | 34,566 | `M_DISPATCH` 301,831 / `S_FROZEN` 137,636 | `30` / `13` |
| `PAYOUT_EXECUTOR` / `PAYOUT_SELF` | — | — | — | — | — | 87,453 / 87,385 | `8` / `8` |
| `CLAIM_REFUND`（非末笔 / 末笔） | — | — | — | — | — | 175,704 / 89,087 | `17` / `8` |

## 编译命令（离线，不跑测试/VM/节点）

```bash
# 默认主网 KUSDT_CID + MAX_BATCH=8
node /root/kaspa/kaswin/contracts/kusdt-v2/compile-contracts.mjs

# 校准不同 MAX_BATCH（如 4 或 8）或覆盖测试网 KUSDT_CID（输出到独立目录避免覆盖）
node /root/kaspa/kaswin/contracts/kusdt-v2/compile-contracts.mjs --max-batch 4 --out-dir /tmp/kusdt-v2-b4
```

脚本会校验 `../toolchain.json` 中固定 `silverc 1.0.1` 二进制 SHA-256，按严格 DAG 顺序（`s_payout → s_refund → s_frozen → s_open → m_dispatch → m_sealed → m_open`）展开 `.sil` 并输出 `artifacts/*.json` 与 `artifacts/template-pins.json`。

## 7 个合约 Entry 签名与 Witness 编码

所有交易均为 `tx.version == 1`，手续费满足 `0 < sum(inputs) - sum(outputs) <= FEE_CAP (50,000,000 sompi)`。

1. **`s_payout.sil` (`KusdtShardPayout`)**
   - `spend(int action, byte[] kcc20Suffix)`
   - `action = 1` (`PAYOUT_EXECUTOR`): `vaultAmount > 500_000`；输入 `0=S_PAYOUT(2 KAS)`, `1=KCC20金库(2 KAS, owner=CID(shard_cid))`, `2..m=普通KAS`（总输入 `<= 8`）；输出 `0=firstBuyerPk(4 KAS)`, `1=赢家KCC20(>=1.5 KAS, vaultAmount-500_000)`, `2=执行者KCC20(500_000)`, `[3]=普通找零`。
   - `action = 2` (`PAYOUT_SELF`): 输出 `0=firstBuyerPk(4 KAS)`, `1=赢家KCC20(>=1.5 KAS, vaultAmount)`, `[2]=普通找零`。

2. **`s_refund.sil` (`KusdtShardRefund`)**
   - `spend(int recIdx, int ownTailBytes, byte[] kcc20Suffix)`
   - 仅 1~2 票轮次（`recordCount ∈ {1, 2}`）；非末笔（`rc=2, mask=0`）传自身 `ownTailBytes`，输出 `0=S_REFUND(2 KAS, 更新claimedMask)`, `1=金库KCC20(2 KAS, remAmt)`, `2=买家KCC20(refundAmt)`, `[3]=普通找零`；末笔 `ownTailBytes=0`，销毁账本，输出 `0=firstBuyerPk(4 KAS)`, `1=买家KCC20(refundAmt)`, `[2]=普通找零`。

3. **`s_frozen.sil` (`KusdtShardFrozen`)**
   - `spend(int decision, byte[32] winnerPk, byte[] nextTail)`
   - 与 `M_DISPATCH` 同笔执行（输入位 `own ∈ [1, MAX_BATCH]`，授权输出 `own`）；`decision=1`（`PAYOUT`，`winnerPk != 0`，`nextTail` 匹配 `S_PAYOUT_HASH`），`decision=2`（`REFUND`，`winnerPk == 0`，`nextTail` 匹配 `S_REFUND_HASH`）。

4. **`s_open.sil` (`KusdtShardOpen`)**
   - `spend(int action, int qty, byte[32] buyerPk, int ownTailBytes, byte[] nextTail, byte[] kcc20Suffix)`
   - `action = 1` (`BUY`): `nextTail` 为空；输入 `0=S_OPEN(2 KAS)`, `1=旧金库KCC20(2 KAS)`, `2..m=买家KCC20与普通KAS`（总输入 `<= 8`）；输出 `0=新S_OPEN(2 KAS)`, `1=新金库KCC20(2 KAS, oldAmt+qty*price)`, `[2..3]=可选买家KCC20找零与普通KAS找零`。
   - `action = 2` (`COLLECT` 分片侧): 与 `M_OPEN` 同笔执行（输入位 `own ∈ [1, MAX_BATCH]`，`qty=0, buyerPk=ZERO, ownTailBytes=0, kcc20Suffix=""`，`nextTail` 匹配 `S_FROZEN_HASH`）。

5. **`m_dispatch.sil` (`KusdtManagerDispatch`)**
   - `spend(int k, int ownTailBytes, byte[] shardTail, byte[] shardMeta)`
   - `decision = 1` (`PAYOUT`): `shardTail` 为 `S_PAYOUT` 尾，`shardMeta` 为 `k` 条 44B 记录 `firstBuyerPk(32) || vaultAmount(u63 LE, 8) || shardTickets(u32 LE, 4)`。
   - `decision = 2` (`REFUND`): `shardTail` 为 `S_REFUND` 尾，`shardMeta` 为 `k` 条 `len(u16 LE: 80|116) || sRefundState(80|116B)`。
   - 未下发完传 `ownTailBytes` 延续 `M_DISPATCH(cursor+k)`；最后一批 `ownTailBytes=0`，销毁管理并输出 `0=creatorPk(4 KAS)`。

6. **`m_sealed.sil` (`KusdtManagerSealed`)**
   - `spend(int action, int ownTailBytes, byte[] nextTail, byte[] data)`
   - `action = 1` (`DRAW`): `ownTailBytes=0`，`nextTail` 为 `M_DISPATCH` 尾，`data = passAProof(240B) || j(u16 LE) || i(u16 LE) || frozenState(112..9292B)`。采用 56 位无拒绝取模 `sample % totalTickets`（域分离 `"KASWIN_KUSDT_DRAW_V1"` / `"KASWIN_KUSDT_SAMPLE_V1"`），并将 68B/片名册压缩为 32B/片 `shardCid[]`。
   - `action = 2` (`REROLL`): `ageDaa >= 432_000`，`nextTail=""`，`data=""`，传 `ownTailBytes` 原地自延续状态 100% 不变。

7. **`m_open.sil` (`KusdtManagerOpen`)**
   - `spend(int action, int ownTailBytes, byte[] shardTail, byte[] extraBytes, byte[] data)`
   - `action = 1` (`OPEN_SHARD`): `shardTail = sOpenTail`，`extraBytes = kcc20Suffix (3885B)`，`data = qty(u32 LE, 4B) || buyerPk(32B)`。
   - `action = 2` (`EMPTY_CLOSE`): `tx.daa >= closeDaa && openedCount == 0`，其余见证均为空/0，销毁管理退 `creatorPk` 4 KAS。
   - `action = 3` (`COLLECT_BATCH`): `tx.daa >= closeDaa`，`shardTail = sFrozenTail`，`extraBytes = nextMgrTail`（仅最后一批切 `M_SEALED` 或 `M_DISPATCH` 时非空），`data = k(u16 LE) || sOpenTailLen(u32 LE) || redeemLen[0..k-1](u32 LE * k)`。
