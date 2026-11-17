# Rolling 第3项集成交接

用户要求完成 Rolling 外部钱包、生产索引接入、独立 TS 核心接入；实现会话专注实现，测试统一交 tester。当前实现工作区 `/root/kaspa/kaswin`，历史 `/root/kaswin-publish-20261005`只读。Profile b56...保持UNVALIDATED，网络仅testnet-10，TIMEOUT保留用户手测。

## 所有权

- `kaswin实现`：页面、controller、钱包、客户端索引核验、运行时接线、构建与本交接文档。
- TS实施子任务已结束：`scripts/rolling/core/src/`4个文件和`core.mjs`已交回父会话，未运行检查。
- `kci-rolling-eval`（稳定session id `887a8ca6`）：`scripts/rolling/indexer/`以及必要KCI侧封装；旧kaswin-indexer不再参与。现有Rust V2.0.2接口/数据库不迁移、不共写。
- `tester`（稳定session id `684030ae`）：新增测试、构建、差分、复测、验收记录。测试不得由实现会话自行执行。

## 已实现源码

### 独立 TS 核心

`scripts/rolling/core.mjs`为统一运行时入口，注入既有SHA-256/地址codec，保留六份旧MJS的68项导出及旧函数参数形式。TS补齐状态字节工具、类型收窄、构建默认参数和错误行为。原 `experiments/rolling/{state,profile,transactions,mass,accepted,receiver}.mjs`保持不动，供差分基线。

web/rolling-tn10非测试模块以及deployment-profile、tn10-proof、实验indexer/node-adapter/archive/engine-gate/http/measure/CLI核心导入已切到该入口。sidecar目录由kci统一切换。ResourceLimit必须与相应quoteMass一起使用，不能把旧实现class的instanceof套到新实现。

`build/rolling-tn10.mjs`先构建独立核心，再动态加载运行时/类型检查/打包；缺少基础核心声明时先生成基础核心。浏览器图只允许新核心生成物，禁止六份旧核心混入；清单包含TS源码和生成物哈希。构建输出与主网页分离。`package.json`增加 `build:rolling` 和 `start:rolling-indexer`。

### 外部钱包

新增 `web/rolling-tn10/extension-wallet.mjs`，支持KasWare requestAccounts/getAccounts/getPublicKey/getNetwork/signPskt与Kastle connect/getAccount/getNetwork/signTx。固定TN10，Schnorr地址/公钥一致性校验；仅签指定普通输入/SIGHASH_ALL；比较返回交易承诺字段，使用自己上下文验签，只复制授权签名，保持页面自己交易的预算/mass等字段，不使用扩展广播。

账户/网络事件撤销wallet与未发送报价；签名前后重新核对账户/网络/provider；controller walletEpoch在报价、保存意图前和真正提交前复查，已持久化后仍走原状态机/原字节恢复。连接与签名有界等待；未采用的迟到签名不能进入意图。provider原始异常映射为受控代码，不记入日志。

UI新增扩展tab并保留内存私钥/仅收款模式；所有需要资金的动作接收extension钱包；REFUND_SELF可通过扩展资金辅助。确认页根据实际授权输入显示签名要求。

### Indexer

kci实现独立sidecar/独立持久目录，默认回环 `127.0.0.1:18212`；现有Rust生产KCI/DB保持。根API `/tn10/rolling/v1/{profileId}`，另有`/v1`/完整genesis别名。端点info、rounds列表/详情/export/history、txid→CID。金额字符串、单writer锁、原子持久化、accepted Full发现、回滚、stale、分页/响应/限流边界；不开公网写接口。

新增浏览器 `indexer-client.mjs`。每个响应核对schema/network/genesis/profile；按CID或交易ID加入、发现列表、手动/后台同步。候选roundText从自身节点acceptedAt获取真实Full及spent contexts/witness，decodeSpend+interpretAccepted独立重算head；DRAW再向自身节点取header承诺。活动轮额外liveRound核对manager+全部冻结片；终态必须由实际交易重算得出，不能只信REST标签。同步不覆盖本机intent/pending/halted（后者仅显式同步允许恢复）。远端读取在写队列外，最终apply重新检查连接、本地revision和未决状态。

索引API在高级设置显式配置，默认留空；无索引仍可用分享链接。远端用户浏览器的127.0.0.1不是服务器地址；HTTPS页面需要可访问的HTTPS索引入口。未启动/部署sidecar、未修改unit/网关配置。

## 测试交接（tester负责）

实现会话没有运行任何本次测试、语法/类型/构建、VM、浏览器或网络检查，所有测试与验证由 `tester`（`684030ae`）执行。此前几千笔TN10是旧实现时点证据，不能冒充本次集成通过。

已向tester明确分两阶段：

1. **模块**：扩展provider注入与公开无资金fixture离线签名；正向KasWare/Kastle、非TN10、地址/公钥不一致、修改金额/收款/输入/非授权witness、坏签名、账户/网络/provider切换、超时迟到响应、关闭/保存前/真正发送前钱包世代改变。节点/HTTP用替身，不读取真实钱包。
2. **核心/构建/整体**：基础core→Rollingcore构建，68项导出及状态/Profile/CID/交易/witness/accepted/massfee/错误码差分，256记录冻结、N=256、1/16片支付、32退款批次/尾合并；真实VM与必要Controller/浏览器回归。kci已将sidecar源码/测试需求直接交tester。

建议候选构建使用独立输出目录（避免测试中提前替换线上dist）：

```sh
npm run build:core
npm run build:rolling-core
node build/rolling-tn10.mjs --out-dir=tests/output/rolling-integration/candidate
```

允许本次必要离线、类型/构建、真实VM、浏览器注入provider检查和只读既有TN10回放；本阶段不创建新实链轮次、不读取真实密钥/扩展账户、不签名广播、不TIMEOUT/主网、不启动节点或修改unit。任何失败交实现会话修复，再由tester复测。测试代码修改由tester负责，避免多writer。

## 验证与发布记录

以下为 `tester` 在本轮修复后实跑并输出到 `tests/output/rolling-integration/` 的结果（保持候选 Profile `b56bcd9c…c4e5` 为 `UNVALIDATED`）：

| 检查项 | 命令 | 结果 | 输出 / 产物 |
|---|---|---|---|
| TS 核心与候选页面构建 | `npm run build:core && npm run build:rolling-core && npm run check:core && npm run check:rolling-core && node build/rolling-tn10.mjs --out-dir=tests/output/rolling-integration/candidate` | 通过（15/45 核心产物，7/21 Rolling 核心产物，64 个图源文件，无漂移） | `tests/output/rolling-integration/build-and-candidate.log`；候选 HTML `tests/output/rolling-integration/candidate/rolling-tn10.html`（325,061 bytes，`sha256=defbe4e0ce63977e904ddbae8691ff8f8a630e6cf2016413f7a434d5fb7658d0`） |
| TS 核心 68 项差分 | `node --test experiments/rolling/core-diff.test.mjs` | 4 pass / 0 fail / 0 skip | `tests/output/rolling-integration/core-diff.log` |
| 前端模块、页面图门与扩展/索引客户端 | `node --test web/rolling-tn10/*.test.mjs` | 77 pass / 0 fail / 7 skip（跳过项为 `REAL ENGINE`） | `tests/output/rolling-integration/web-rolling-tn10.log`；`tests/output/rolling-integration/indexer-client.log`（2 pass / 0 fail） |
| 独立 Rolling Sidecar | `for f in scripts/rolling/indexer/*.mjs; do node --check "$f" || exit 1; done && node --test scripts/rolling/indexer/sidecar.test.mjs` | 语法全通过；6 pass / 0 fail / 0 skip | `tests/output/rolling-integration/sidecar.log` |
| 实验套件（排除 TIMEOUT） | `node --test --test-name-pattern='^(?!.*TIMEOUT)' experiments/rolling/*.test.mjs` | 51 pass / 0 fail / 7 skip（跳过项为 `REAL ENGINE`） | `tests/output/rolling-integration/experiments.log` |
| Playwright 离线浏览器注入（扩展钱包与索引发现/同步） | `node --test tests/rolling-web/external-wallet-browser.test.mjs` | 1 pass / 0 fail / 0 skip（加载候选 `rolling-tn10.html`，注入 mock `window.kasware` / `window.kastle` 与离线 HTTP/WS 替身） | `tests/output/rolling-integration/browser-extension.log` |
| 真实 VM 引擎全量复测（前端与控制器） | `KASWIN_VM_BIN=/root/kaspa/references/toolchains/rolling-vm-target/release/kaswin-rolling-vm node --test web/rolling-tn10/*.test.mjs` | **84 pass / 0 fail / 0 skip**（原 7 项 `REAL ENGINE` 跳过项全部通过） | `tests/output/rolling-integration/web-rolling-tn10-vm.log` |
| 真实 VM 引擎全量复测（实验套件，排除 TIMEOUT） | `KASWIN_VM_BIN=/root/kaspa/references/toolchains/rolling-vm-target/release/kaswin-rolling-vm node --test --test-name-pattern='^(?!.*TIMEOUT)' experiments/rolling/*.test.mjs` | **58 pass / 0 fail / 0 skip**（原 7 项 `REAL ENGINE` 跳过项全部通过） | `tests/output/rolling-integration/experiments-vm.log` |
| 真实 VM 全语料回归 | `KASWIN_VM_BIN=/root/kaspa/references/toolchains/rolling-vm-target/release/kaswin-rolling-vm node experiments/rolling/vm-run.mjs` | **3,316 / 3,316**（`bases: 48/48 pass; mutations: 3,268/3,268 match; mismatches: 0`，耗时 2.1s） | `tests/output/rolling-integration/vm-run.log` |
| 外部 TN10 节点只读探测 | `node experiments/rolling/tn10-run.mjs --preflight --node=<url>` | `vector-10.kaspa.green`、`quark-10.kaspa.red`、`electron-10.kaspa.stream` 均 `isSynced: true`（2.1.0，DAA `624221394–624224208`），3 个专用钱包余额正常；`muon-10` 无法连接、`tn10.kaspay.top` 超时 | `tests/output/rolling-integration/external-preflight.log`、`external-preflight-all.log` |
| 外部 TN10 节点只读回放 | `node experiments/rolling/tn10-replay.mjs --node=<url> ...` | 早期小轮次（`empty` / `refund` / `payout`）在公共裁剪节点已超保留窗口（`does not have retention root` / `cannot find header`）；近轮次 `three-shard-refund` 在 `vector-10` 回放前 11 笔 `revalidated: true` 后遇 `ACCEPTANCE_READ_TIMEOUT`，`batch-payout` 在 `electron-10.kaspa.stream` 连续通过 52 笔 `revalidated: true`（`revision` 1..52，约 3.4s/笔，因单次 180s 限制未跑完 4359 笔全长） | `tests/output/rolling-integration/external-replay.log`、`external-replay-small.log` |
| 本机节点只读回放（`ws://127.0.0.1:18210`） | `node experiments/rolling/tn10-replay.mjs --run=experiments/rolling/artifacts/tn10/three-shard-refund-1794728861633 --out-dir=experiments/rolling/artifacts/tn10-index/replay-local-recent-20261116` | 本机节点已同步（`isSynced: true`）；30s 窗口内连续通过 `117` 笔（`revision` `1..117` 全部 `revalidated: true`），在 30s 命令超时截断退出（`EXIT=124`） | `tests/output/rolling-integration/local-replay.log` |
| **新版候选页 + 真实 VM + 本机同步节点 + Rolling Sidecar 实链全链路冒烟** | `KASWIN_VM_BIN=/root/kaspa/references/toolchains/rolling-vm-target/release/kaswin-rolling-vm node tests/rolling-web/candidate-integration.mjs --execute` | **通过（`pass: true`）**：`cid=9eccbd8497356d79708b080a9e09db4458a485b89318e292d2f17af13527a256`、`terminal=PAID`、`7` 笔（`GENESIS:1, BUY:3, CLOSE:1, DRAW:1, PAY_SELF:1`）、总费用 `18846480` sompi、7/7 逐笔 `accepted: true` 且深度 `121–1124` DAA（≥100 DAA）；Sidecar 实时索引至 `revision=7, terminal=PAID`，`/info`、`/rounds`、`/rounds/:cid`、`/txid/:txid` 与第二个无状态页面发现并经节点 `acceptedAt` 独立重算一致（`receipts=7`）；`active-rounds.json` 归零（`slotCount=0`） | `tests/output/rolling-integration/candidate-integration.log`；`tests/output/rolling-runs/2026-11-15T23-56-53Z-candidate-integration/`（含 `run.json`、`acceptance.json`、`round.json`、`sidecar-info.json`、`sidecar-round.json`、`indexed-round.json`、`final.png`、`indexed-view.png`） |
| **用户手测 `TIMEOUT` 前置 `sealed` 轮次建盘** | `KASWIN_VM_BIN=/root/kaspa/references/toolchains/rolling-vm-target/release/kaswin-rolling-vm node tests/rolling-web/candidate-integration.mjs --execute --sealed-only` | **已就绪（停在 `sealed`，未执行 `DRAW`/`TIMEOUT`）**：`cid=3fa890ddaa2f591e6c936d9f9f30296352cbd7396b0aa2bddb083621340569d2`，5 笔（`GENESIS:1, BUY:3, CLOSE:1`，总费用 `9138968` sompi）均已接受且深度 `148–783` DAA；`closeAcceptingDaa=624532334`，`timeoutEligibleDaa=624964334`（预计 UTC `2026-11-16T12:23:08Z` / 北京时间 `20:23:08` 后可手动点 `TIMEOUT`）；`active-rounds.json` 记录 `slotCount=1` | `tests/output/rolling-integration/prepare-sealed-timeout.log`；`tests/output/rolling-runs/2026-11-16T00-21-48Z-sealed-for-timeout/`（含可导入浏览器的 `sealed-round-export.json`、`run.json`、`acceptance.json`） |
| **分片点图与按片下钻购买记录改动复测及发布** | `KASWIN_VM_BIN=/root/kaspa/references/toolchains/rolling-vm-target/release/kaswin-rolling-vm node --test --test-concurrency=1 web/rolling-tn10/*.test.mjs`；`node build/rolling-tn10.mjs` | **86 pass / 0 fail / 0 skip**（`round.test.mjs` + `views.test.mjs` + `page.test.mjs` 为 **31 pass / 0 fail**）；已将上一版本归档至 `dist/archive/rolling-tn10-defbe4e0.*`，并构建发布新版 `dist/rolling-tn10.html`（`335,865 bytes`，`sha256=2aa0215f0c284cd1bb2aaf2d198a9b3062e86776371a2edeeaeeb7cfd9bcd516`，Profile `b56bcd9c…c4e5` 保持 `UNVALIDATED`）；线上 `https://cd311.cn:888/www/rolling-tn10/` SHA-256 核对一致，`/api/info` 正常，`dist/index.html` 维持 `0ee7ec5d…` 不变 | `tests/output/rolling-integration/round-views-page.log`、`tests/output/rolling-integration/web-rolling-tn10-vm.log`；线上产物 [rolling-tn10.html](../dist/rolling-tn10.html) |
| **常驻 Rolling Sidecar 上线、历史终态分片点图与默认接入** | `KASWIN_VM_BIN=/root/kaspa/references/toolchains/rolling-vm-target/release/kaswin-rolling-vm node --test scripts/rolling/indexer/sidecar.test.mjs web/rolling-tn10/round.test.mjs web/rolling-tn10/views.test.mjs web/rolling-tn10/indexer-client.test.mjs web/rolling-tn10/page.test.mjs`；`node build/rolling-tn10.mjs` | **39 pass / 0 fail / 0 skip**；归档旧版至 `dist/archive/rolling-tn10-2aa0215f.*`，发布 [rolling-tn10.html](../dist/rolling-tn10.html)（`338,870 bytes`，`sha256=1f5121071b65d3fd38460b5dc4d34809c9ee55c0966e26ccddcb65ea5572e6fe`）；新增并启用 `kaswin-rolling-indexer.service`（`127.0.0.1:18212`，数据目录 `/var/lib/kaswin-rolling-indexer`，`--start-hash=f750ddfb...` 从 17 分片 `batch-payout` 起点起追链），Caddy 暴露同源 `/www/rolling-tn10/indexer/*`，前端默认连接该只读索引且支持终端轮次历史分片零信任校验与点图下钻；`dist/index.html` 维持 `0ee7ec5d…` 不变 | `tests/output/rolling-integration/sidecar-and-shards-tests.log`、`tests/output/rolling-integration/build-and-candidate.log`；`/etc/systemd/system/kaswin-rolling-indexer.service` |
| **大轮次详情点击卡顿与展示精简优化、Sidecar 吞吐与拥堵降级** | `node --test experiments/rolling/indexer.test.mjs scripts/rolling/indexer/sidecar.test.mjs`；`KASWIN_VM_BIN=... node --test web/rolling-tn10/views.test.mjs web/rolling-tn10/round.test.mjs web/rolling-tn10/page.test.mjs`；`node build/rolling-tn10.mjs` | 后端：`Sidecar` 修复 `committedView` 并发一致性（`9 pass`）、`RollingIndexer` 缓存不可变 `frozen` 原像解码（`10 pass`）、`scanner.mjs` 兼容 `NODE_CLOSED` 拥堵窗 V1 并发降级（`8 pass`）；前端：`selectedShardPanel` 默认只展示 V2.0.2 风格点图与图例（`256` 行文字表按需开关）、`txTable()` 略去已确认购买交易只保留阶段性交易与确认中交易、`mineView` 列表限制最近 `100` 条（**31 pass / 0 fail**）；归档 `380bfdc1` 至 `dist/archive/rolling-tn10-380bfdc1.*`，发布新版 [rolling-tn10.html](../dist/rolling-tn10.html)（`340,154 bytes`，`sha256=1d554ecdfab8fbffe76bc399cc4aca765ac276b7d52b1bc93b4299ff83017dc6`），线上 SHA-256 核对一致，`dist/index.html` 维持 `0ee7ec5d…` 不变 | `tests/output/rolling-integration/views-round-page-perf.log`、`sidecar-race-fix.log`、`indexer-perf-regression.log`、`sidecar-v1-fallback.log` |
| **购买点图内嵌 TXID 与中奖标记精确定位到单笔购买** | `KASWIN_VM_BIN=/root/kaspa/references/toolchains/rolling-vm-target/release/kaswin-rolling-vm node --test web/rolling-tn10/views.test.mjs web/rolling-tn10/round.test.mjs web/rolling-tn10/indexer-client.test.mjs web/rolling-tn10/page.test.mjs`；`node build/rolling-tn10.mjs` | **33 pass / 0 fail / 0 skip**；从 `DRAW` 交易 witness 与目标块承诺核验出精确 `{txid, shard, record, ticket}`，仅标示具体中奖分片与单笔购买记录（不再匹配同地址全部购买），点击购买方格的详情卡片直接显示该笔 `BUY` 交易 TXID（仅在分片总记录数与 `BUY` 回执 1:1 完整对应时展示）；归档 `1d554ecd` 至 `dist/archive/rolling-tn10-1d554ecd.*`，发布 [rolling-tn10.html](../dist/rolling-tn10.html)（`342,836 bytes`，`sha256=8feeb75a3822ccefe53a7e6dedb8159494282da962cacc8c7eabd04c25d7da2e`），线上核对一致；Sidecar 已完全追平实时链顶（`cursor.daa=624660425`, `virtualDaa=624660525`, `roundsCount=27`, `stale=false`），`dist/index.html` 维持 `0ee7ec5d…` 不变 | `tests/output/rolling-integration/draw-hint-and-matrix-tx.log`、`tests/output/rolling-integration/build-and-candidate.log` |
| **16 列点图与参照 V2.0.2 重构「轮次广场」统一列表** | `node --test web/rolling-tn10/views.test.mjs`；`KASWIN_VM_BIN=... node --test --test-concurrency=1 web/rolling-tn10/*.test.mjs`（含 `multi-batch 40-shard payout` 单跑复测）；`node build/rolling-tn10.mjs` | `views.test.mjs` **16 pass / 0 fail**；全套 `web/rolling-tn10/*.test.mjs` **85 pass + 40 分片派奖单跑复测通过（0 遗留失败）**；彻底移除点图下方冗余文字明细，分片/购买点图统一改为 16 列布局（16×16）；参照 V2.0.2 精简并统一「轮次广场」（移除广场内单独的「索引发现」按钮堆叠与重复的「我的轮次」分区，保留独立「我的」标签页），本机轮次（`data-open`）与索引发现轮次（`data-indexed`）按 `cid` 去重后共用同一套 KPI、筛选、搜索、排序与 `.grid` 卡片视图，并补充卡片键盘可访问性；归档 `264f9dc8` 至 `dist/archive/rolling-tn10-264f9dc8.*`，发布 [rolling-tn10.html](../dist/rolling-tn10.html)（`344,194 bytes`，`sha256=538722886d7f003c8e0f443d4a0b01c58fd72ffa13696b72723464add4209e66`），线上 HTTPS 与 `/api/info`、`/indexer/.../info`（`roundsCount=27`, `stale=false`）核对一致，`dist/index.html` 维持 `0ee7ec5d…` 不变 | `tests/output/rolling-integration/views-explore-quick.log`、`web-rolling-tn10-vm.log`、`controller-40shard-retry.log`、`build-and-candidate.log` |
| **更新规则页与创建页的 Testnet 10 已验证边界说明** | `node --test web/rolling-tn10/views.test.mjs web/rolling-tn10/page.test.mjs`；`node build/rolling-tn10.mjs` | **21 pass / 0 fail / 0 skip**；将 `VERIFIED_TICKET_CAP` 从 `515` 更新为实测已达到的 `4,355`（17 个封存分片派奖），补充 771 张 / 3 个封存分片批量退款、同钱包并发避让与跨节点并发抢购实测情况，将尚未实链完全验证项修正为：`TIMEOUT`、真实 `KasWare` / `Kastle` 扩展实链签名、>17 分片派奖 / >3 分片退款 / 三人以上同时抢购及深重组恢复，并反映已默认连接只读索引的现状；归档 `53872288` 至 `dist/archive/rolling-tn10-53872288.*`，发布 [rolling-tn10.html](../dist/rolling-tn10.html)（`344,741 bytes`，`sha256=7c813ea1a3c25098a0df1da169a0b7ce6027dbfa1c4347fcebff9410c82eeb6f`），线上核对一致，`dist/index.html` 维持 `0ee7ec5d…` 不变 | `tests/output/rolling-integration/views-page-boundaries.log`、`tests/output/rolling-integration/build-and-candidate.log` |
| **KCI `:8790` vs Node Sidecar `:18212` 27 轮对账与前端零信任核验（评估阶段）** | `node --input-type=module -e '...'`（`createIndexerClient` + `verifyIndexedSnapshot` + `shardCatalog` 连本机 `ws://127.0.0.1:18210`） | **27 轮列表 0 差异、6 类典型轮次零信任核验 6/6 PASS**（含 17 分片 `3c1e593ba747` 4,352 条购买记录全部解码与 `draw=3:189#957`、3 分片退款 `36840ec21eef` 768 条解码、单分片、空轮与活跃 `sealed` `3fa890dd...`）；随后由 `kci-rolling-eval` 修复临时库 `8.8G` 膨胀并降至 **`209M`**、`cargo test` **17 pass / 0 fail**、`/info`/`/rounds/:cid`/`/history`/`/export`/`/txid` 全量对齐 | `tests/output/rolling-integration/kci-vs-sidecar-e2e.log`、`kci-cargo-test-v2.log`、`kci-vs-sidecar-e2e-v2.log` |
| **正式切换 KCI `:8790` 与启用专用无私钥 TN10 注册地址上线** | `KASWIN_VM_BIN=... node --test --test-concurrency=1 web/rolling-tn10/*.test.mjs`；`node build/rolling-tn10.mjs` | **86 pass / 0 fail / 0 skip**；在 `protocol.mjs` / `prepare.mjs` / `round.mjs` / `app.ts` / `views.ts` 接入专用无私钥 TN10 注册地址 `kaspatest:qz5ksvzrlr5qjkltejvadpvc2u36d5u7ul2krjqfh9jpzm5jk5f2cpctvz792`（`0.2 TKAS`）并将 `GENESIS_SHAPE` 放宽至 `<=3` 且禁止后续输出夹带 `covenant`（`GENESIS_EXTRA_COVENANT`）；KCI 托管为独立常驻服务 `kci-rolling-lab.service`（`/opt/kci-rolling-lab/bin/kci`，`127.0.0.1:8790`，`/var/lib/kci-rolling-lab`，`--networks tn10 --pool --reconcile-ms 15000`，仅占约 `209M` 磁盘 / `83M` RSS），归档 `7c813ea1` 至 `dist/archive/rolling-tn10-7c813ea1.*`，发布 [rolling-tn10.html](../dist/rolling-tn10.html)（`345,225 bytes`，`sha256=0b0b85c28f7c6fb4ecb2ebb15226df06606237f4d88d7c6c21706f2953e26d0b`），Caddy `/www/rolling-tn10/indexer/*` 已从 `18212` 切至 `8790` 并停用/禁用旧 `kaswin-rolling-indexer.service` | `tests/output/rolling-integration/web-rolling-tn10-vm.log`、`build-and-candidate.log`；`/etc/systemd/system/kci-rolling-lab.service`、`/etc/caddy/caddy_routes.inc` |
| **移除后端预算引擎服务依赖，切为纯静态单网页 SPA** | `KASWIN_VM_BIN=/root/kaspa/references/toolchains/rolling-vm-target/release/kaswin-rolling-vm node --test --test-concurrency=1 web/rolling-tn10/*.test.mjs`；`node build/rolling-tn10.mjs` | **88 pass / 0 fail / 0 skip**（含新增 `budget.test.mjs` 真实 `kaswin-rolling-vm` 全 8 动作有限预算测试与全部 `controller.test.mjs` `REAL ENGINE` 端到端测试）；新增纯前端本地拟合预算模块 `web/rolling-tn10/budget.mjs`（参数来自 `experiments/rolling/artifacts/vm/budget-model.json` + `+1` 余量），在 `prepare.mjs` / `controller.mjs` / `bridge.ts` / `types.ts` / `app.ts` / `views.ts` / `page.test.mjs` 中完全移除 `/api/measure` / `/api/verify`、`service-client.mjs` 与「预算服务」UI 依赖；归档 `0b0b85c2` 至 `dist/archive/rolling-tn10-0b0b85c2.*`，构建发布纯单网页 [rolling-tn10.html](../dist/rolling-tn10.html)（`337,608 bytes`，`sha256=8179650786b4d03bb51c0dba2d1cdd1ff21dac887518f1af6bc348862e238330`），Caddy `/www/rolling-tn10/*` 改为纯静态 `file_server` 托管并停用/禁用 `kaswin-rolling-tn10.service`（`:8792`）；线上哈希、`/indexer/.../info`、V2.0.2 `:8788`、`dist/index.html`（`0ee7ec5d…`）与 `3fa890dd...`（`sealed`）均核对正常 | `tests/output/rolling-integration/web-rolling-tn10-vm.log`、`build-and-candidate.log`；`/etc/caddy/caddy_routes.inc` |

### 当前边界与未覆盖项

- **只读 TN10 完整外部回放**：公共外部节点与本机节点保留窗口内剩余大轮次（796 笔与 4359 笔），单次命令行窗口内（180s / 30s）分别稳定通过前 52 笔与前 117 笔，未跑完 796/4359 笔全长；早期 2–7 笔小轮次已被公网节点裁剪。
- **晋级 `VALIDATED` 的剩余阻断项**：
  1. `TIMEOUT` 路径仍保留由用户手测，尚未经过实链验收；
  2. 真实 `KasWare` / `Kastle` 浏览器扩展插件对新版候选页的**实链签名**尚未在真实带扩展浏览器中人工实测（当前自动化实链冒烟使用专用测试内存私钥，扩展签名仅在 Playwright mock 注入与离线单测中验证）；
  3. 代码层面 [profile.ts](../scripts/core/src/profile.ts)、[profile.mjs](../tests/contracts/profile.mjs)、[profile-data.mjs](../scripts/contract/profile-data.mjs) 等仍显式锁定并展示 `UNVALIDATED`，须在补齐上述真实证据且由用户明确批准晋级后再行改版。
- **线上产物与服务**：本次已将 [rolling-tn10.html](../dist/rolling-tn10.html)（`81796507…`，已归档 [0b0b85c2](../dist/archive/rolling-tn10-0b0b85c2.html)）改为无预算后端依赖的纯静态单网页 SPA，通过 Caddy `file_server` 直接托管（已停用并禁用原 `:8792` `kaswin-rolling-tn10.service` 及原 `:18212` `kaswin-rolling-indexer.service`）；`/www/rolling-tn10/indexer/*` 由独立 Rust KCI 服务 `kci-rolling-lab.service`（`127.0.0.1:8790`，独立目录 `/var/lib/kci-rolling-lab`）承载；未修改 `dist/index.html`（维持 `0ee7ec5d…`）或 V2.0.2 KCI 服务 `kci-rust-lab.service`（`127.0.0.1:8788`），sealed TIMEOUT 轮次 `3fa890dd…` 仍保持待用户手测。
