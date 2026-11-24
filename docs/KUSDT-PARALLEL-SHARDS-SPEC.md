# kUSDT 256 片并行轮次工程规格书（状态布局、动作表与模板校验）

> 状态：**SPEC DRAFT（编码前规格，尚未编写合约代码）**。编译、测试、VM 与网络验证均为 **NOT_RUN**。
> 上游业务与经济定案见 [KUSDT-PARALLEL-SHARDS-DRAFT.md](KUSDT-PARALLEL-SHARDS-DRAFT.md)。
> 目标工具链：SilverScript `1.0.1` + `rusty-kaspa v2.1.0`（Toccata Covenants 激活环境）+ Trestly 主网 `KCC20.sil`。

---

## 1. 固定协议常量

| 常量 | 值 | 说明 |
|---|---|---|
| `KUSDT_CID` | `50b3477e7368d0c5bfbd64483b4607350ec411377972f33e40b2d4b6d1513fd3` | 主网官方 kUSDT Covenant ID（测试网部署时按网络配置替换） |
| `KCC20_EXT_TEMPLATE_HASH` | `734850b0af0aeef49f009167bf9ddd238fd8c5cdbe214234f97181ac6f5cc498` | 外部合约 6 字段视角校验 `KCC20` 输出的 `blake3` 模板哈希 |
| `KCC20_PREFIX` | `0x6b20` + `9703112ee6e3555107cd168858992b77d3b74f655205b2b463b1f9ec2ec73cf7`（34B） | `0x6b` + `0x20` + `gen__kcc20_template` |
| `KCC20_SUFFIX_LEN` | `3885` 字节 | 标准未修改 `KCC20` 模板尾长度 |
| `MANAGER_DEPOSIT` | `400_000_000` sompi（`4 KAS`） | 创建者出资，终局管理销毁时 100% 退还创建者 |
| `SHARD_LEDGER_DEPOSIT` | `200_000_000` sompi（`2 KAS`） | 首购买家出资，分片账本 UTXO 持有 |
| `SHARD_VAULT_DEPOSIT` | `200_000_000` sompi（`2 KAS`） | 首购买家出资，分片金库 KCC-20 UTXO 持有；销毁时合计 `4 KAS` 退还首购买家 |
| `WINNER_CARRIER_MIN` | `150_000_000` sompi（`1.5 KAS`） | 派奖时发给赢家的新 KCC-20 输出最低承载 KAS |
| `PRICE_MIN` | `1_000_000`（`1 kUSDT`，6 位小数） | 单票最低票价 |
| `EXECUTOR_REWARD` | `500_000`（`0.5 kUSDT`） | 第三方执行者单片派奖固定 kUSDT 激励 |
| `MAX_SHARDS` | `256` | 单轮最多可开分片数 |
| `MAX_RECORDS_PER_SHARD` | `256` | 单片最多购买记录条数（单笔可买 `1..N` 票） |
| `MAX_BATCH` | 暂定 `8`（待原型编译与 VM mass 实测校准） | `COLLECT_BATCH` / `DISPATCH_BATCH` 单笔最多推进片数 |
| `MIN_DRAW_TICKETS` | `3` | 满 3 票开奖；1～2 票走小额退款；0 票直接空轮结清 |
| `DRAW_DELAY_DAA` | `100` | `M_SEALED` 锁定后至少等待 100 DAA 取锚点 `d + 100` |
| `REROLL_TIMEOUT_DAA` | `432_000`（≈ 12 小时，10 BPS） | 超过此保护期仍无人开奖时允许重掷锚点 |
| `FEE_CAP` | `50_000_000` sompi（`0.5 KAS`） | 协议级防误操作手续费上限（待 mass 实测微调） |

---

## 2. 模板集合与无环依赖拓扑（DAG）

整套协议拆为 **7 个单职责 P2SH 模板**（管理 3 个 + 分片 4 个），采用 `0x6b || pushData(stateBytes) || tail` 打包（与现行 Kaswin V2 风格一致，便于单 `byte[]` 切片与栈深控制）：

```text
叶节点（无后继模板依赖）
  ├── S_PAYOUT   （单片派奖：执行者激励 / 赢家自推）
  └── S_REFUND   （仅 1~2 票小额退款，买家自助领 Pull）
          ▲
          ├── S_FROZEN    （硬编码 S_PAYOUT_HASH, S_REFUND_HASH）
          │      ▲
          │      └── S_OPEN      （硬编码 S_FROZEN_HASH + 自延续）
          │
          └── M_DISPATCH  （硬编码 S_PAYOUT_HASH, S_REFUND_HASH + 自延续）
                 ▲
                 └── M_SEALED    （硬编码 M_DISPATCH_HASH + 自延续）
                        ▲
                        └── M_OPEN      （硬编码 S_OPEN_HASH, S_FROZEN_HASH, M_SEALED_HASH, M_DISPATCH_HASH + 自延续）
```

- **严格有向无环图（DAG）**：编译时按「`S_PAYOUT / S_REFUND` → `S_FROZEN` → `S_OPEN / M_DISPATCH` → `M_SEALED` → `M_OPEN`」顺序注入模板哈希常量，**零循环依赖**。
- **官方 Profile 识别**：前端与 Indexer 仅需钉扎最终生成的 `M_OPEN_HASH`（及全部 7 个模板哈希清单）与 `KUSDT_CID`。

---

## 3. 详细状态字节布局

约定：所有整数均采用 **小端序（LE）**；`u16` 为 2B、`u32` 为 4B、`u63` 为 8B 非负有符号整数（兼容 SilverScript `OpBin2Num` 64 位有符号算术，最高位固定为 0）；公钥 `pk` 为 32B x-only Schnorr 公钥。

### 3.1 管理 UTXO 状态布局

#### 公共管理头 `M_HEADER`（固定 `60` 字节）

| 偏移 | 长度 | 字段 | 类型 | 说明 |
|---|---:|---|---|---|
| `0` | 1 | `stage` | `u8` | `0x01`=`M_OPEN`, `0x02`=`M_SEALED`, `0x03`=`M_DISPATCH` |
| `1` | 1 | `version` | `u8` | 协议版本，固定 `0x01` |
| `2` | 32 | `creatorPk` | `byte[32]` | 创建者公钥（管理 UTXO 销毁时退还 `4 KAS`） |
| `34` | 8 | `price` | `u63` | 固定票价（kUSDT 最小单位，`>= 1_000_000`） |
| `42` | 8 | `closeDaa` | `u63` | 封盘 DAA 截止点 |
| `50` | 2 | `openedCount` | `u16` | 已合法创建分片数（`0..256`） |
| `52` | 2 | `cursor` | `u16` | `M_OPEN` 中为 `collectedCount`；`M_DISPATCH` 中为 `dispatchedCount`；`M_SEALED` 中固定 `0` |
| `54` | 4 | `totalTickets` | `u32` | 已汇总累计总票数（`M_OPEN` 汇总过程中递增，`M_SEALED`/`M_DISPATCH` 固定） |
| `58` | 1 | `decision` | `u8` | `0x00`=未定（`M_OPEN`/`M_SEALED`），`0x01`=派奖（`PAYOUT`），`0x02`=退款（`REFUND`） |
| `59` | 1 | `reserved` | `u8` | 保留位，固定 `0x00` |

#### 管理分片名册条目 `M_ENTRY`（固定 `68` 字节/片）

| 偏移 | 长度 | 字段 | 类型 | 说明 |
|---|---:|---|---|---|
| `0` | 32 | `shardCid` | `byte[32]` | 该分片独立 Covenant ID（开片时写入，终身不变） |
| `32` | 32 | `ledgerHash` | `byte[32]` | 封盘前为 `0x00*32`；`COLLECT_BATCH` 冻结该片时写入 `blake2b(shardFrozenState)` |
| `64` | 4 | `cumTickets` | `u32` | 封盘前为 `0`；`COLLECT_BATCH` 冻结时写入截至本片的全轮累计票数（前缀和） |

#### 各阶段管理状态总长度
- **`M_OPEN` / `M_SEALED`**：`M_HEADER (60B) || M_ENTRY[0 .. openedCount-1]`
  - 空轮：`60` 字节；满载 256 片：`60 + 256 * 68 = 17,468` 字节（注：若后续实测 `17,468B` 偏大，可在 `M_OPEN` 阶段仅存 32B `shardCid`，冻结后再追加 `(ledgerHash, cumTickets)` 或拆为定长分段，当前按单表直存基准估算）。
- **`M_DISPATCH`**：`M_HEADER (60B) || winnerPk (32B) || shardCid[0 .. openedCount-1]`（每片仅需 32B `shardCid`，不再需要 `ledgerHash` 与 `cumTickets`！）
  - 满载 256 片仅 `92 + 256 * 32 = 8,284` 字节，`winnerPk` 在 `decision == 0x02 (REFUND)` 时填 `0x00*32`。

---

### 3.2 分片账本 UTXO 状态布局

#### 购买记录条目 `RECORD`（固定 `36` 字节/条）

| 偏移 | 长度 | 字段 | 类型 | 说明 |
|---|---:|---|---|---|
| `0` | 4 | `cumTickets` | `u32` | 本片内截至本条记录的累计票数（严格递增，`rec[0].cumTickets >= 1`） |
| `4` | 32 | `buyerPk` | `byte[32]` | 该笔购票买家公钥 |

#### 1. `S_OPEN` / `S_FROZEN` 状态布局

| 偏移 | 长度 | 字段 | 类型 | 说明 |
|---|---:|---|---|---|
| `0` | 1 | `stage` | `u8` | `0x11`=`S_OPEN`, `0x12`=`S_FROZEN` |
| `1` | 1 | `version` | `u8` | 固定 `0x01` |
| `2` | 32 | `managerCid` | `byte[32]` | 所属管理 UTXO 的 CID（建片时由 `M_OPEN` 写入校验） |
| `34` | 32 | `firstBuyerPk` | `byte[32]` | 首购买家公钥（分片销毁时退还 `4 KAS` 押金） |
| `66` | 8 | `price` | `u63` | 固定票价（与管理一致） |
| `74` | 2 | `recordCount` | `u16` | 当前记录数（`1..256`） |
| `76` | `36 * N` | `records[]` | `RECORD[]` | 购买记录数组（`length == 76 + 36 * recordCount`） |

- 满载 256 条记录：`76 + 256 * 36 = 9,292` 字节。
- `S_OPEN` → `S_FROZEN` 时仅将偏移 `0` 的 `stage` 改为 `0x12`，其余字节完全不变。

#### 2. `S_PAYOUT` 状态布局（精简终态，固定 `110` 字节）

进入派奖后原购买记录已无用途，丢弃记录数组以大幅压缩派奖交易体积：

| 偏移 | 长度 | 字段 | 类型 | 说明 |
|---|---:|---|---|---|
| `0` | 1 | `stage` | `u8` | 固定 `0x13` (`S_PAYOUT`) |
| `1` | 1 | `version` | `u8` | 固定 `0x01` |
| `2` | 32 | `firstBuyerPk` | `byte[32]` | 退还 `4 KAS` 押金目标公钥 |
| `34` | 32 | `winnerPk` | `byte[32]` | 中奖赢家公钥（来自 `M_DISPATCH`） |
| `66` | 8 | `vaultAmount` | `u63` | 本片金库应有 kUSDT 总额（`= shardTickets * price`，由 `S_FROZEN` 切态时算定写死） |
| `74` | 32 | `managerCid` | `byte[32]` | 审计保留字段 |
| `106` | 4 | `shardTickets` | `u32` | 本片总票数 |

#### 3. `S_REFUND` 状态布局（仅全轮 1～2 票，最多 2 条记录）

| 偏移 | 长度 | 字段 | 类型 | 说明 |
|---|---:|---|---|---|
| `0` | 1 | `stage` | `u8` | 固定 `0x14` (`S_REFUND`) |
| `1` | 1 | `version` | `u8` | 固定 `0x01` |
| `2` | 32 | `firstBuyerPk` | `byte[32]` | 末笔退完时退还 `4 KAS` 押金目标公钥 |
| `34` | 8 | `price` | `u63` | 固定票价 |
| `42` | 1 | `recordCount` | `u8` | `1` 或 `2` |
| `43` | 1 | `claimedMask` | `u8` | 已领退款位图（初始 `0x00`；第 `0` 条已领置 `0x01`，第 `1` 条已领置 `0x02`） |
| `44` | `36 * N` | `records[]` | `RECORD[]` | 原购买记录（`N ∈ {1, 2}`，总长 `80` 或 `116` 字节） |

---

### 3.3 KCC-20 金库输出状态布局（外部只读校验基准）

依据 Trestly 主网 `KCC20.sil` 与 `silverscript-v1.0.1` `state.rs` 一手核对结果，外部合约以 6 字段视角重构并校验一个 `KCC20` 金库 UTXO 的 `scriptPubKey`：

```text
encoded_kcc20_state (112B) =
  0x08 || OpNum2Bin(amount, 8)        // 9B : 8字节小端有符号整数
  0x20 || owner[32]                   // 33B: 32字节 owner（CID 或 P2PK 公钥）
  0x01 || owner_scheme[1]             // 2B : 0x00=P2PK_SCHNORR, 0x04=OWNER_COVENANT_ID
  0x01 || 0x00                        // 2B : borrow_scheme = BORROW_DISABLED (0x00)
  0x20 || 0x00*32                     // 33B: borrow_guard = ZERO
  0x20 || 0x00*32                     // 33B: extension_commitment = ZERO

redeemScript (4031B) = KCC20_PREFIX (34B) || encoded_kcc20_state (112B) || kcc20Suffix (3885B)
scriptPubKey (35B)   = 0xaa || 0x20 || blake2b(redeemScript)[32] || 0x87
```

校验 `kcc20Suffix` 正版性：
- 校验 `blake3(i64le(34) || KCC20_PREFIX || i64le(3885) || kcc20Suffix) == KCC20_EXT_TEMPLATE_HASH`（或在 SilverScript 中直接使用 `validateOutputStateWithTemplate`）。
- 金库状态约束：`owner_scheme == 0x04`、`owner == shardCid`、`borrow_scheme == 0x00`、`borrow_guard == ZERO`、`extension_commitment == ZERO`。
- 赢家/执行者/退款接收输出约束：`owner_scheme == 0x00`、`owner == targetPk`、`borrow_scheme == 0x00`、`borrow_guard == ZERO`、`extension_commitment == ZERO`。

---

## 4. 完整动作输入/输出表

> 说明：所有交易均为 `tx.version == 1`。`fee` 均满足 `0 < sum(inputs) - sum(outputs) <= FEE_CAP`。

### 4.1 建轮与售票阶段

| 动作 | 执行模板 | 输入列表 | 输出列表 | 核心链上不变量 |
|---|---|---|---|---|
| **CREATE_ROUND**（创世） | 无（创世交易，链下/Indexer 验真） | `0`: 创建者普通 KAS（`>= 4 KAS + fee`） | `0`: `M_OPEN`（`4 KAS`，genesis `manager_cid`）<br>`[1]`: 创建者 KAS 找零 | 前端/Indexer 验 `templateHash == M_OPEN_HASH`、`openedCount == 0`、`cursor == 0`、`totalTickets == 0`、`price >= PRICE_MIN`、`closeDaa > 0` |
| **OPEN_SHARD**（开新片 + 首购，单笔完成） | `M_OPEN`（输入 0）+ 买家 `KCC20`（输入 2） | `0`: `M_OPEN`（`4 KAS`, `manager_cid`）<br>`1`: 首购买家普通 KAS（`>= 4 KAS + fee`, `cid == ZERO`，作新分片创世授权输入）<br>`2..a`: 首购买家 `KCC20` 输入（`kUSDT_CID`）<br>`[a+1..b]`: 可选额外买家普通 KAS | `0`: 新 `M_OPEN`（`4 KAS`, 延续 `manager_cid`, `openedCount+1`, 末尾追加 `shard_cid`）<br>`1`: 新 `S_OPEN`（`2 KAS`, genesis `shard_cid`, `authInput == 1`）<br>`2`: 新金库 `KCC20`（`2 KAS`, `kUSDT_CID`, `owner=CID(shard_cid)`, `amount=qty*price`）<br>`[3]`: 可选买家 `KCC20` 找零<br>`[4]`: 可选买家普通 KAS 找零 | 1. `cursor == 0 && openedCount < 256 && qty >= 1`<br>2. `M_OPEN` 亲手拼出 `S_OPEN` 初始状态（`recordCount == 1`, `records = [(qty, buyerPk)]`）并验 `S_OPEN_HASH`<br>3. `shard_cid = OpOutputCovenantId(1)` 满足 `!= ZERO && != manager_cid && != kUSDT_CID`<br>4. 只读校验输出 `2` 为正版 `KCC20` 且 `owner=CID(shard_cid)`, `amount=qty*price`<br>5. `OpCovOutputCount(manager_cid) == 1` |
| **BUY**（已有分片并行买票，不碰管理） | `S_OPEN`（输入 0）+ 金库/买家 `KCC20` | `0`: `S_OPEN`（`2 KAS`, `shard_cid`）<br>`1`: 旧金库 `KCC20`（`2 KAS`, `kUSDT_CID`, `owner=CID(shard_cid)`, `oldAmt`）<br>`2..a`: 买家 `KCC20` 输入（`kUSDT_CID`）<br>`a+1..b`: 买家普通 KAS（凑 fee） | `0`: 新 `S_OPEN`（`2 KAS`, 延续 `shard_cid`, `recordCount+1`, 追加 `(oldTickets+qty, buyerPk)`）<br>`1`: 新金库 `KCC20`（`2 KAS`, `kUSDT_CID`, `owner=CID(shard_cid)`, `oldAmt + qty*price`）<br>`[2]`: 可选买家 `KCC20` 找零<br>`[3]`: 可选买家普通 KAS 找零 | 1. `recordCount < 256 && qty >= 1`<br>2. 校验输入 `1` 与输出 `1` 均为正版 `KCC20`（`owner=CID(shard_cid)`），且 `oldAmt == oldTickets * price`, `newAmt == (oldTickets + qty) * price`<br>3. `OpCovOutputCount(shard_cid) == 1` |

### 4.2 封盘、开奖、重掷与终局下发阶段

| 动作 | 执行模板 | 输入列表 | 输出列表 | 核心链上不变量 |
|---|---|---|---|---|
| **EMPTY_CLOSE**（0 票空轮结清） | `M_OPEN`（输入 0） | `0`: `M_OPEN`（`4 KAS`, `manager_cid`）<br>`1..m`: 调用方普通 KAS（凑 fee） | `0`: 退创建者 `P2PK(creatorPk)`（`4 KAS`, `cid == ZERO`）<br>`[1]`: 调用方找零 | `tx.lockTime >= closeDaa && openedCount == 0 && OpCovOutputCount(manager_cid) == 0` |
| **COLLECT_BATCH**（游标分批封盘汇总，`1 <= k <= MAX_BATCH`） | `M_OPEN`（输入 0）+ `k` 个 `S_OPEN`（输入 `1..k`） | `0`: `M_OPEN`（`4 KAS`, `manager_cid`）<br>`1..k`: 按名册 `cursor .. cursor+k-1` 顺序的 `S_OPEN`（各 `2 KAS`）<br>`k+1..m`: 调用方普通 KAS（凑 fee） | `0`: 管理后继（`4 KAS`, 延续 `manager_cid`）：<br>· 未汇完 → `M_OPEN`<br>· 汇完且 `total <= 2` → `M_DISPATCH(REFUND)`<br>· 汇完且 `total >= 3` → `M_SEALED`<br>`1..k`: 对应位置 `S_FROZEN`（各 `2 KAS`, 输入 `i` 延续 `shard_cid_i`）<br>`[k+1]`: 调用方找零 | 1. `tx.lockTime >= closeDaa && openedCount > 0 && cursor + k <= openedCount`<br>2. 对每个 `i ∈ 1..k`：`M_OPEN` 核对 `OpInputCovenantId(i) == entry[cursor+i-1].shardCid`、从 `S_OPEN` 见证解析票数 `t_i` 与完整冻结态 `frozen_i`、将 `blake2b(frozen_i)` 与 `cumTickets` 写入名册、校验输出 `i` 为 `S_FROZEN(frozen_i)`<br>3. 每个 `S_OPEN` 独立核对 `OpInputCovenantId(0) == managerCid` 且自身授权输出 `i` 为 `S_FROZEN` |
| **DRAW**（PASS-A 抽签定位唯一赢家） | `M_SEALED`（输入 0） | `0`: `M_SEALED`（`4 KAS`, `manager_cid`）<br>`1..m`: 调用方普通 KAS（凑 fee） | `0`: `M_DISPATCH`（`4 KAS`, 延续 `manager_cid`, `decision=PAYOUT`, `winnerPk`, `cursor=0`, 压缩名册为 `shardCid[]`）<br>`[1]`: 调用方找零 | 1. `this.ageDaa >= 100`；校验 240B PASS-A 证明锚点 `d + 100` 与 `OpChainblockSeqCommit`<br>2. 确定性无拒绝抽样（或固定次数重试）得 `t ∈ [0, totalTickets)`<br>3. 核对见证提供的第 `j` 片 `S_FROZEN` 原文满足 `blake2b(raw) == entry[j].ledgerHash`、`start <= t < end`、二分/索引定位中奖记录 `i` 提取 `winnerPk` |
| **REROLL**（12h 超时重掷锚点） | `M_SEALED`（输入 0） | `0`: `M_SEALED`（`4 KAS`, `manager_cid`）<br>`1..m`: 调用方普通 KAS（凑 fee） | `0`: 新 `M_SEALED`（`4 KAS`, 延续 `manager_cid`, **状态字节 100% 不变**）<br>`[1]`: 调用方找零 | `this.ageDaa >= 432_000`；输出 `0` 与输入 `0` 同模板同状态，仅更新 `outpoint` 与 `inputDaa` |
| **DISPATCH_BATCH**（游标分批下发终局，`1 <= k <= MAX_BATCH`） | `M_DISPATCH`（输入 0）+ `k` 个 `S_FROZEN`（输入 `1..k`） | `0`: `M_DISPATCH`（`4 KAS`, `manager_cid`）<br>`1..k`: 按名册 `cursor .. cursor+k-1` 顺序的 `S_FROZEN`（各 `2 KAS`）<br>`k+1..m`: 调用方普通 KAS（凑 fee） | `0`: <br>· 未下发完 → 新 `M_DISPATCH`（`4 KAS`, `cursor+k`）<br>· 最后一批 → **销毁管理**，输出 `P2PK(creatorPk)`（`4 KAS`, `cid == ZERO`）<br>`1..k`: 对应位置 `S_PAYOUT(winnerPk)` 或 `S_REFUND`（各 `2 KAS`, 输入 `i` 延续 `shard_cid_i`）<br>`[k+1]`: 调用方找零 | 1. `cursor + k <= openedCount`<br>2. 对每个 `i ∈ 1..k`：`M_DISPATCH` 核对 `OpInputCovenantId(i) == shardCid[cursor+i-1]`，校验输出 `i` 为正确终态模板（`PAYOUT` 时写对 `winnerPk` 与 `vaultAmount`；`REFUND` 时保留原记录且 `claimedMask=0`）<br>3. 每个 `S_FROZEN` 核对 `OpInputCovenantId(0) == managerCid` 且输入 `i` 授权输出 `i` |

### 4.3 派奖与小额退款阶段（完全并行，不碰管理）

| 动作 | 执行模板 | 输入列表 | 输出列表 | 核心链上不变量 |
|---|---|---|---|---|
| **PAYOUT_EXECUTOR**（第三方执行者激励派奖） | `S_PAYOUT`（输入 0）+ 金库 `KCC20`（输入 1） | `0`: `S_PAYOUT`（`2 KAS`, `shard_cid`）<br>`1`: 金库 `KCC20`（`2 KAS`, `kUSDT_CID`, `owner=CID(shard_cid)`, `vaultAmount`）<br>`2..m`: 执行者普通 KAS（垫 `>= 1.5 KAS + 自身承载 + fee`） | `0`: 退首购买家 `P2PK(firstBuyerPk)`（`4 KAS`, `cid == ZERO`）<br>`1`: 赢家 `KCC20`（`>= 1.5 KAS`, `kUSDT_CID`, `owner=P2PK(winnerPk)`, `vaultAmount - 500_000`）<br>`2`: 执行者 `KCC20`（`kUSDT_CID`, `500_000`）<br>`[3]`: 可选执行者普通 KAS 找零 | 1. `vaultAmount > 500_000`<br>2. `OpCovOutputCount(shard_cid) == 0`（销毁账本）<br>3. `OpCovOutputCount(kUSDT_CID) == 2`（防夹带多余代币输出）<br>4. 校验输出 `1` 为正版 `KCC20` 且 `owner=P2PK(winnerPk)`、`amount == vaultAmount - 500_000`、`value >= 1.5 KAS` |
| **PAYOUT_SELF**（零激励 / 赢家自推兜底） | `S_PAYOUT`（输入 0）+ 金库 `KCC20`（输入 1） | `0`: `S_PAYOUT`（`2 KAS`, `shard_cid`）<br>`1`: 金库 `KCC20`（`2 KAS`, `kUSDT_CID`, `owner=CID(shard_cid)`, `vaultAmount`）<br>`2..m`: 赢家/资助人普通 KAS | `0`: 退首购买家 `P2PK(firstBuyerPk)`（`4 KAS`, `cid == ZERO`）<br>`1`: 赢家 `KCC20`（`>= 1.5 KAS`, `kUSDT_CID`, `owner=P2PK(winnerPk)`, `vaultAmount`）<br>`[2]`: 可选普通 KAS 找零 | 1. `vaultAmount > 0`<br>2. `OpCovOutputCount(shard_cid) == 0`（销毁账本）<br>3. `OpCovOutputCount(kUSDT_CID) == 1`（100% 代币归赢家，无需额外验签） |
| **CLAIM_REFUND**（1～2 票小额退款，Pull） | `S_REFUND`（输入 0）+ 金库 `KCC20`（输入 1） | `0`: `S_REFUND`（`2 KAS`, `shard_cid`）<br>`1`: 金库 `KCC20`（`2 KAS`, `kUSDT_CID`, `owner=CID(shard_cid)`）<br>`2..m`: 买家普通 KAS（自垫新 KCC-20 承载 KAS + fee） | **非末笔**（2 条剩 1 条）：<br>`0`: 新 `S_REFUND`（`2 KAS`, 更新 `claimedMask`）<br>`1`: 新金库 `KCC20`（`2 KAS`, `remAmt`）<br>`2`: 买家 `KCC20`（`owner=P2PK(buyerPk)`, `refundAmt`）<br>`[3]`: 可选找零<br>**末笔清空**：<br>`0`: 退首购买家 `P2PK(firstBuyerPk)`（`4 KAS`）<br>`1`: 买家 `KCC20`（`owner=P2PK(buyerPk)`, `refundAmt`）<br>`[2]`: 可选找零 | 1. 指定 `recIdx ∈ [0, recordCount)` 未领取（`claimedMask` 对应位为 0）<br>2. 校验买家 `KCC20` 输出为正版模板、`owner=P2PK(records[recIdx].buyerPk)`、`amount == qty_i * price`<br>3. 非末笔：`OpCovOutputCount(kUSDT_CID) == 2`、金库余额扣减准确且仍锁给 `shard_cid`；末笔：`OpCovOutputCount(shard_cid) == 0 && OpCovOutputCount(kUSDT_CID) == 1` |

---

## 5. 跨合约模板与身份校验规格

### 5.1 本协议自身模板校验规则
- **模板打包**：`scriptFor(state, tail) = 0x6b || pushData(state) || tail`，其中 `tail` 首字节固定为 `0x6c`（`OpFromAltStack`），与现行 Kaswin V2 保持一致。
- **自延续校验**：通过 `OpTxInputScriptSigSubstr(this.activeInputIndex, len - tailLen, len)` 截取自身 `tail`，先用 `ScriptPubKeyP2SHFromRedeemScript(scriptFor(state, tail)) == tx.inputs[active].scriptPubKey` 认证，再原样复用于后继输出。
- **跨模板跃迁校验**：调用 `templateHash(0x6b, nextTail) == EXPECTED_NEXT_HASH`，确保只能跃迁到拓扑图中写死的正版后继模板。
- **全输出授权封堵**：所有涉及管理或分片延续的动作均强制 `OpCovOutputCount(cid) == OpAuthOutputCount(idx)`，杜绝同交易夹带未受约束的同 CID 幽灵输出。

### 5.2 协作动作（`COLLECT_BATCH` / `DISPATCH_BATCH`）的双向耦合规则
- **管理侧**：按名册游标严格验证 `OpInputCovenantId(i) == expectedShardCid`，防止乱序、跳过、重复或混入假分片；同时校验输出 `i` 的 `scriptPubKey` 与 `OpOutputCovenantId(i) == expectedShardCid`。
- **分片侧**：严格验证 `OpInputCovenantId(0) == managerCid`、`this.activeInputIndex == i`、`OpAuthOutputCount(i) == 1 && OpAuthOutputIdx(i, 0) == i && OpCovOutputCount(selfCid) == 1`，防止假管理 UTXO 劫持状态或把分片重映射到错位输出。

### 5.3 KCC-20 外部只读校验规则（防假币与串片）
- 凡涉及金库输入/输出的动作（`OPEN_SHARD`、`BUY`、`PAYOUT_*`、`CLAIM_REFUND`），均同时执行 3 项检查：
  1. `OpInputCovenantId` / `OpOutputCovenantId == KUSDT_CID`（防假代币）；
  2. 传入的 `kcc20Suffix`（3,885B）与固定 `KCC20_PREFIX`（34B）通过 `KCC20_EXT_TEMPLATE_HASH` 校验（防假代币模板）；
  3. 用精确的 112B `encoded_kcc20_state` 拼接重构 35B `scriptPubKey` 并与链上输出/输入比对（强制 `borrow_scheme == 0x00`、`borrow_guard == ZERO`、`extension_commitment == ZERO`、以及正确的 `owner_scheme`、`owner`、`amount`）。

---

## 6. 进入编码前待实测的工程边界（不阻塞规格）

以下 4 项数值须在后续获准编写最小原型并运行真实 VM 后实测校准，不提前拍脑袋写死：
1. **`MAX_BATCH` 上限**：实测 `COLLECT_BATCH` 与 `DISPATCH_BATCH` 在满载分片账本（9,292B）+ 满载管理名册（17,468B）时的 compute/transient mass 与 244 栈深度余量，确定安全上限（如 `k = 4` 或 `8`）。
2. **`M_OPEN` 名册存储形态**：实测 `17,468B` 管理状态在 `OPEN_SHARD`（同时携带 `3,885B` `kcc20Suffix` + `S_OPEN` 尾字节）时的单笔 transient/compute mass，若偏紧则将 `M_OPEN` 的未冻结名册压缩为 `32B/片`（8,192B），仅在 `COLLECT` 阶段按需追加冻结摘要。
3. **`OPEN_SHARD` 与 `BUY` 的 `kcc20Suffix` 传入成本**：`kcc20Suffix` 恒为 3,885B，需实测单笔携带时的 scriptSig 长度与手续费。
4. **`FEE_CAP` 与预算公式**：像现行 V2.0.2 一样通过全边界 VM 矩阵拟合每个动作的 `computeBudget` 公式（留 $\ge 10\%$ 余量）。
