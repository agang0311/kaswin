# 浏览器实链测试（tests/web）

在真实 Kaswin 网页上用真实 Chromium 操作，完成 Testnet 10 的协议场景验收。
**所有事实来自页面自身 DOM**，不自行构造交易、不轮询 Indexer 当作状态来源。

- 页面：`http://127.0.0.1/kaswin.html`
- 节点：`wss://muon-10.kaspa.blue/kaspa/testnet-10/wrpc/json`
- 索引器：`http://127.0.0.1/indexer/tn10`
- 合约：`kaswin-v2.0.2`

以上全部由 [`config/network.json`](config/network.json) 提供，不写死在代码里。

---

## 1. 文件结构

```
tests/web/
├── harness.mjs        页面驱动核心：User 类（17 个方法）+ 链上状态查询 + 生命周期保护
├── quote-state.mjs    只做一件事：从 DOM 判断"报价是否就绪"
├── scenarios.mjs      8 个场景的编排器（1–7、9）
├── cleanup.mjs        把未终局轮次推进到终局（清理中断残留）
├── config.mjs         配置加载器（环境变量 > config/*.json > 内置默认）
└── config/
    ├── network.json   网络端点、超时、钱包路径
    ├── scenarios.json 每个场景的参数与预期
    └── cleanup.json   清理策略与启动预检
```

依赖只有 `playwright`。运行前：

```bash
# 进入项目根目录
npm i -D playwright@1.63.0
```

---

## 2. 快速开始

```bash
# 短场景（1/2/3/4），各约 70–100 秒
node tests/web/scenarios.mjs --scenarios=1,2,3,4 --budget=600

# 并发竞争（约 3 分钟）
node tests/web/scenarios.mjs --scenarios=9 --budget=400

# 长场景：单次跑不完，用 --resume 断点续跑
node tests/web/scenarios.mjs --scenarios=5 --budget=900
node tests/web/scenarios.mjs --scenarios=5 --budget=900 --resume=<CID>

# 清理中断残留
node tests/web/cleanup.mjs --dry     # 先看计划
node tests/web/cleanup.mjs           # 实际执行
```

> **不要用外层 `timeout` 硬杀。** 用 `--budget=<秒>`：脚本自己会在超预算时抛错，
> 并保留在途轮次信息。硬杀会留下 GENESIS 已上链但未推进的轮次。

---

## 3. 场景清单

| # | 标识 | 购买 | 总票数 | 终局 | 实测耗时 |
|---|---|:---:|:---:|:---:|---:|
| 1 | `empty` 空轮退盘 | 0 | 0 | `EMPTY` | ~70s |
| 2 | `refund-2ticket` 单笔多票不足额退款 | 1 | 2 | `REFUNDED` | ~72s |
| 3 | `payout` 标准开奖派奖 | 2 | 3 | `PAID` | ~96s |
| 4 | `A4` 临界卖满开奖 | 5 | 5 | `PAID` | ~72s |
| 5 | `R225` 225 笔多批退款 | 225 | 225 | `REFUNDED` | ~25–30min |
| 6 | `P256` 买满 256 笔派奖 | 256 | 256 | `PAID` | ~30–35min |
| 7 | `R256` 买满 256 笔退款 | 256 | 256 | `REFUNDED` | ~30–35min |
| 8 | `TIMEOUT_REFUND` 超时退款 | — | — | `REFUNDED` | **不可自动执行** |
| 9 | `concurrent-race` 多用户并发竞争 | 33 | 33 | `PAID` | ~183s |

**场景 8 为什么不能跑**：`SEALED` 必须滞留 432,000 DAA（约 12 小时）才能触发超时退款。
按《项目约定.md》由 SCRIPT_VM 注入时间戳覆盖，实链自动化中安全排除。
在 `config/scenarios.json` 里 `enabled: false`，选它会直接退出并说明原因。

### 各场景验证重点

- **1**：无人购票即封盘，4.00 TKAS 押金 100% 全退。
- **2**：单笔 2 票 < 3 门槛；**单记录多票只扣一次 0.02**（退 1.98 而非 2×0.98）。
- **3**：100 DAA 后开奖，核验 PASS-A 目标块 100+ blueScore 确认，原子派发三笔。
- **4**：第 5 条记录触发账本 `PUSHDATA1`(224B) → `PUSHDATA2`(260B) 编码跳变；卖满免等时间立即封盘。
- **5**：8 批退款，前 7 批各满 32 笔产生 **34 个输出**，尾批清算押金；游标 32→…→224。
- **6**：满目录 256 条、账本 **9,296 字节**极限；卖满立即封盘。
- **7**：8 批全部满载 34 输出。
- **9**：两个独立浏览器会话 + 两个钱包同时购票/封盘/开奖；链上归属须等于 `cap`，封盘与开奖各恰一方成功。

---

## 4. 命令行参数

### `scenarios.mjs`

| 参数 | 说明 |
|---|---|
| `--scenarios=1,2,3,9` | 要跑的场景（默认 `1,2,3,4,9`） |
| `--budget=<秒>` | 整轮总预算；超出立即抛错并指明卡在哪一步 |
| `--resume=<CID>` | 断点续跑（场景 5/6/7 用） |
| `--allow-open` | 跳过"发现未终局轮次"的提示 |

### `cleanup.mjs`

| 参数 | 说明 |
|---|---|
| `--dry` | 只扫描打印计划，不提交任何交易 |
| `--only=<CID>` | 只处理指定 CID（可重复） |
| `--phases=1,2,5` | 只处理指定 phase |

### 环境变量（优先级高于配置文件）

| 变量 | 作用 |
|---|---|
| `KASWIN_IDX` | 覆盖索引器地址 |
| `KASWIN_NODE` | 覆盖节点地址 |
| `KASWIN_PAGE` | 覆盖页面地址 |
| `KASWIN_CONTRACT` | 覆盖合约前缀 |
| `KASWIN_STEP_MS` | 覆盖单步超时（默认 30000） |
| `KASWIN_WALLETS` | 覆盖钱包目录 |
| `KASWIN_LOG=0` | 静音 |
| `KASWIN_LOG=verbose` | 打印每次轮询细节 |

---

## 5. 配置文件

### `config/network.json`

```json
{
  "network": {
    "indexer": "http://127.0.0.1/indexer/tn10",
    "node": "wss://muon-10.kaspa.blue/kaspa/testnet-10/wrpc/json",
    "page": "http://127.0.0.1/kaswin.html",
    "contractPrefix": "kaswin-v2.0.2"
  },
  "timing": { "stepMs": 30000, "quotePollMs": 250, "statePollMs": 1200, "heartbeatMs": 5000 },
  "round": { "defaultMinutes": 1 },
  "wallets": {
    "dir": null,
    "roles": { "creator": "tn10-test-only.json", "b1": "tn10-f3-buyer-1.json", "b2": "tn10-f3-buyer-2.json" }
  }
}
```

### 5.1 Indexer 路径必须带网络前缀

本地 indexer 按网络分区，**旧的无前缀路径已失效**：

| 路径 | 结果 |
|---|---|
| `http://127.0.0.1/indexer/v1/status` | ❌ `400 UNKNOWN_NETWORK`（`networks: ["tn10","mainnet"]`） |
| `http://127.0.0.1/indexer/tn10/v1/status` | ✅ `network: testnet-10` |
| `http://127.0.0.1/indexer/mainnet/v1/status` | ✅ `network: mainnet` |

所以 `network.indexer` 必须写成 `http://127.0.0.1/indexer/tn10`（或 `/mainnet`），
脚本里所有请求都以 `${IDX}/v1/...` 拼接，前缀在 `IDX` 里一次配好即可。

切换网络只需改 `config/network.json`：

```json
// TN10
"indexer": "http://127.0.0.1/indexer/tn10",
"node": "wss://muon-10.kaspa.blue/kaspa/testnet-10/wrpc/json"

// Mainnet（注意：测试钱包是 kaspatest: 地址，主网不可用）
"indexer": "http://127.0.0.1/indexer/mainnet",
"node": "wss://<mainnet-node>/kaspa/mainnet/wrpc/json"
```

`wallets.dir` 默认 `"./wallets"`，**相对 `tests/web/` 解析**，即 `tests/web/wallets`。
绝对路径按原样使用；为 `null` 时依次尝试 `$KASWIN_WALLETS` → `tests/web/wallets` → `../../wallets`。

钱包文件格式与生成方法见 [`wallets/README.md`](wallets/README.md)；
模板 [`wallets/WALLET-TEMPLATE.json`](wallets/WALLET-TEMPLATE.json)；
校验已有文件：`node tests/web/wallets/derive-address.mjs --check <文件>`。

### `config/scenarios.json`

改参数不用动代码。例如把场景 1 的总票数改成 7：

```json
"1": { "cap": 7, "min": 3, "minutes": 1, "buy": [] }
```

字段说明：

| 字段 | 含义 |
|---|---|
| `cap` / `min` | 总票数 / 最低票数 |
| `minutes` | 最早封盘时间（分钟） |
| `buy` | 显式购票计划 `[{who, qty}]`，`who` ∈ `creator`/`b1`/`b2` |
| `buys` | 批量购票笔数（场景 5/6/7） |
| `buyAlternate` | 批量购票的钱包轮换顺序 |
| `refundBatches` | 退款批次数 |
| `concurrency` | 场景 9 的并发配置 |
| `expect` | 预期结果（文档性，不参与断言） |
| `enabled` | `false` 时拒绝执行 |

### `config/cleanup.json`

```json
{
  "cleanup": { "phases": [1,2,5], "maxRefundBatches": 12, "settleBudgetMs": 120000 },
  "preflight": { "enabled": true, "failOnOpen": false, "showLimit": 20 }
}
```

---

## 6. 输出与实时性

每一笔操作都实时打印，不缓冲：

```
[+  16s]   ⚠ 已登记在途轮次 fcd6cb0cdf44ec68（中断时用 cleanup.mjs 收尾）
[+  16s] [S1] GENESIS tx=03b93adef1d6ddf3 ms=2801 CID=fcd6cb0c…
[+  17s] [S1] 等待 1 分钟封盘时间锁到期并执行封盘...
[+  18s]   [S1] 等待封盘时间锁: 还差约 464 DAA
[+  22s]     勾选批准 → 点签名并提交
[+  26s]     回执 machine=CONFIRMING state=确认中 2799ms
[+  69s] [S1] CLOSE tx=c381bdec5cc7339b state=确认中 ms=54482
[+  69s] [S1] 终局结果: terminal=EMPTY value=0 -> ✅ 通过
```

**不要管道到 `tail`** —— 它会把输出缓冲到进程结束才显示，等于关掉实时性。
要看开头用 `head`，要看全部就直接输出。

长任务用后台运行 + 分次轮询，单次 shell 调用不超过 30 秒：

```bash
nohup node tests/web/scenarios.mjs --scenarios=5 --budget=900 > tests/output/s5.log 2>&1 &
# 之后每次：sleep 25 && tail -6 tests/output/s5.log
```

### 6.1 运行归档（每次运行独立目录，永不覆盖）

```
tests/output/
├── runs/
│   ├── 2026-10-18T15-11-35Z-scenarios-1/
│   │   ├── run.json     结果汇总（机器可读）
│   │   ├── run.log      本次运行完整 stdout 副本
│   │   └── summary.md   人读摘要（含结果表）
│   └── 2026-10-18T15-11-23Z-cleanup-1-2-5/
│       └── ...
├── latest -> runs/2026-10-18T15-11-35Z-scenarios-1    符号链接，指向最近一次
└── index.jsonl                                        追加式索引，永不重写
```

| 特性 | 说明 |
|---|---|
| 目录命名 | `<ISO时间戳>-<kind>-<标签>`，如 `2026-10-18T15-11-35Z-scenarios-1` |
| 同秒冲突 | 自动加后缀 `-2`、`-3` |
| 不覆盖 | `scenarios` 与 `cleanup` 各自独立目录，互不覆盖 |
| 完整日志 | `teeTo()` 劫持 stdout/stderr，控制台实时输出同时写 `run.log` |
| 历史索引 | `index.jsonl` 每次追加一行，记录时间/类型/耗时/通过数 |
| 提前退出 | `--dry` 或无轮次可清理时同样写 `run.json` + `summary.md` |
| 快速定位 | `cat tests/output/latest/summary.md` |

`run.json` 结构：

```json
{
  "schema": "KASWIN_TEST_RUN_1",
  "kind": "scenarios",
  "label": "1",
  "startedAt": "2026-10-18T15:11:35.440Z",
  "finishedAt": "2026-10-18T15:12:39.182Z",
  "elapsedSec": 64,
  "counts": { "total": 1, "pass": 1, "fail": 0, "skip": 0 },
  "network": { "indexer": "...", "node": "...", "page": "..." },
  "results": [ ... ]
}
```

`index.jsonl` 每行：

```json
{"at":"2026-10-18T15:12:39.182Z","kind":"scenarios","label":"1","dir":"runs/2026-10-18T15-11-35Z-scenarios-1","elapsedSec":64,"total":1,"pass":1,"fail":0,"skip":0}
```

查看历史：

```bash
cat tests/output/index.jsonl                      # 全部运行一览
cat tests/output/latest/summary.md                # 最近一次摘要
ls -1 tests/output/runs/ | tail -5                # 最近 5 次
```

---

## 7. 生命周期保护

GENESIS 一旦提交就已上链。若进程在推进到终局前退出，该轮次会留在售票中并锁住押金。
三层防护：

### 7.1 启动预检

```
=== 预检：链上未终局轮次 ===
  ⚠️  发现 2 个未终局轮次（可能是上次中断留下的）：
     fcd6cb0cdf44ec68…  phase=1  value=4.00 TKAS  23s 前更新
  收尾：node tests/web/cleanup.mjs
```

### 7.2 中断保护

收到 `SIGINT`/`SIGTERM` 时打印在途轮次与精确收尾命令，退出码 130：

```
⚠️  收到 SIGTERM，准备退出
   有 1 个在途轮次（GENESIS 已上链，可能停在售票中）：
     fcd6cb0cdf44ec68…  (runner cap=10 min=3 1min, 已 5s)
   收尾命令：
     node tests/web/cleanup.mjs
     node tests/web/cleanup.mjs --only=fcd6cb0cdf44ec68…
   提示：不要用外层 timeout 硬杀；用 --budget=<秒> 让脚本自己报错并保留收尾信息。
```

### 7.3 单步 ≤ 30 秒

任何单步（RPC、报价、页面动作）都不超过 `stepMs`（默认 30 秒）。
合约自身的时间锁（封盘 DAA、开奖 100 DAA）由**重复有界步骤**满足，而不是一次长等待。

---

## 8. 关键设计：为什么 `quote-state.mjs` 判定的是 `#approve`

页面里签名按钮的启用条件是：

```js
sign.disabled = s.stale || !approve.checked || Date.now() >= l
```

即**未勾选批准框时 `#sign` 永远 disabled**。所以"签名按钮已启用"不能作为报价就绪信号。

正确判定：弹窗已渲染出具体方案（`全部输出` / `网络费` / `合计`）且 `#approve` 未被页面禁用。

> 早期版本误用建轮次表单的 `#go` 按钮判断，导致封盘/开奖永远等不到 ready 而挂死。

---

## 9. 已知边界

| 项 | 说明 |
|---|---|
| 场景 8 | 需 12 小时物理等待，由 VM 层覆盖，配置中禁用 |
| 场景 5/6/7 | 单次 bash 调用跑不完，必须 `--resume` 断点续跑 |
| 索引器延迟 | 详情页偶发"同步中"；harness 会自动重开轮次重读，最多 3 次 |
| 页面端点 | `open()` 会按 `config/network.json` 自动纠正 `#sIdx`/`#sNodes`（页面默认值可能指向其他端点） |
| 钱包 | 仅 TN10 测试钱包；密钥只在进程内存，从不打印 |

---

## 10. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `找不到测试钱包目录` | 三个候选路径都没有钱包 | 设 `KASWIN_WALLETS=<目录>` |
| `Executable doesn't exist ...chromium-1248` | playwright 版本与缓存不匹配 | 装 `playwright@1.63.0` |
| 卡在"等待报价就绪" | 页面报价未就绪或 `#approve` 被禁用 | 加 `KASWIN_LOG=verbose` 看轮询细节 |
| `超出总预算（close）` | `--budget` 太小 | 场景 1/2/3/4 用 600，场景 9 用 400 |
| 预检报未终局轮次 | 上次中断残留 | `node tests/web/cleanup.mjs` |
| 封盘后一直不开奖 | 未满 100 DAA | `draw()` 会自己按步等待；看 `onWait` 输出 |
