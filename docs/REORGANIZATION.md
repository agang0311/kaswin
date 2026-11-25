# Rolling 主实现目录重组记录

本轮以 Rolling 替代 V2.0.2 作为 Kaswin 的主源码实现，保留 `contracts/`、`scripts/`、`web/`、`build/`、`tests/`、`docs/` 顶层风格。工作区为 `<repo-root>`。这是源码布局迁移，不是协议批准、链上轮次迁移或发布。

候选 Profile 为 `b56bcd9cb654610b238a32bae25c41128ebd2837cc7a91b3ea835f8a102fc4e5`，状态仍为 **UNVALIDATED**，应用仅支持 **Testnet 10**。默认节点参照原 V2.0.2 的 `TN10.web.nodes`，默认索引为 `https://indexer.kaspay.top/tn10`；配置沿用不表示端点已经过本轮兼容性或可用性验证。

## 路径映射

下表是职责迁移对照，旧路径表示重组前来源；历史命令仍按原执行时点保留，不要求它们在新布局直接可执行。

| 原路径 / 内容 | 当前路径 / 用途 |
|---|---|
| `experiments/rolling/generated/{sales,sealed,win,refund,frozen}.sil` | `contracts/{sales,sealed,win,refund,frozen}.sil` 固定源码 |
| `experiments/rolling/contracts/*.sil.in`、`common.sil.inc` | `contracts/templates/` 模板输入与共用片段 |
| `experiments/rolling/artifacts/{sales,sealed,win,refund,frozen}.json` | `contracts/artifacts/` 五模板固定产物 |
| 实验产物的模板身份信息与工具链来源 | `contracts/pins.json`、`contracts/artifacts/template-pins.json`、`contracts/toolchain.json` |
| `scripts/rolling/core/src/` 与旧基础核心中的通用 primitives | `scripts/core/src/`，统一编译到 `scripts/core/lib/` |
| `scripts/rolling/core.mjs` | `scripts/core.mjs` 主运行时入口 |
| `web/rolling-tn10/{controller,round,prepare,budget,catchup,indexer-client}.mjs` | `scripts/round/` |
| `experiments/rolling/tn10-proof.mjs` 与开奖确认辅助 | `scripts/round/draw-proof.mjs`、`scripts/round/draw-confirmations.mjs` |
| `web/rolling-tn10/{codec,store}.mjs` | `scripts/store/codec.mjs`、`scripts/store/round-store.mjs` |
| `web/rolling-tn10/{intent,conflict}.mjs` | `scripts/tracking/` |
| `web/rolling-tn10/{wallet,extension-wallet,kaspire-wallet}.mjs` | `scripts/wallet/`，与通用地址/签名模块同层 |
| `web/rolling-tn10/{protocol,profile-data}.mjs` | `scripts/contract/` |
| `experiments/rolling/deployment-profile.mjs` | `scripts/contract/bundle.mjs` 固定产物加载 |
| `scripts/rolling/indexer/` | `scripts/indexer/` 只读索引服务 |
| `experiments/rolling/{archive,indexer,http,node-adapter}.mjs` | `scripts/indexer/` 归档、索引与节点适配 |
| `web/rolling-tn10/{app,bridge,types,settings,share}.ts`、`tsconfig.json`、环境声明 | `web/app/` |
| `web/rolling-tn10/` 样式、模板、views、ui、messages、format、interaction | `web/ui/` |
| 原 `web/ui/messages-en.mjs` 共享词典 | `web/ui/messages-common-en.mjs` |
| Rolling 英文词典 | `web/ui/messages-en.mjs` |
| `build/rolling-tn10.mjs` | `build/build.mjs`，导出 `buildKaswin` |
| 基础核心构建与 `build/rolling-core.mjs` 双流程 | `build/core.mjs` 统一核心编译 |
| `experiments/rolling/compile.mjs`、`prepare-sources.mjs` | `build/compile-contracts.mjs`、`build/prepare-sources.mjs`，仅显式合约重新生成 |
| `experiments/rolling/` 测试、VM、实验驱动和六份旧 MJS 协议实现 | `tests/contracts/`，旧 MJS 作为差分基线 |
| `tests/rolling-web/` | `tests/web/` 集成与场景驱动 |
| `web/rolling-tn10/*.test.mjs` | `tests/unit/` |
| `scripts/rolling/indexer/sidecar.test.mjs` | `tests/unit/sidecar.test.mjs` |
| `web/rolling-tn10/fake-node.mjs` | `tests/helpers/fake-node.mjs` |
| `experiments/rolling/*.md` 与证据 TSV | `docs/rolling/` |

主页面源码入口为 `web/app/app.ts`。运行时主核心只有 `scripts/core.mjs` / `scripts/core/src/` 一套；`tests/contracts/{state,profile,transactions,mass,accepted,receiver}.mjs` 是历史差分基线，不是网页依赖。通用 `scripts/chain/` 继续作为网络基础层，保留的主网定义不代表 Rolling 支持主网。

## 构建入口和现有产物

`npm run build` 默认 TN10，`npm run build:tn10` 为同一目标的别名，不支持 mainnet。`build/build.mjs` / `buildKaswin` 的主输出是 `dist/index.html` 与 `dist/build-manifest.json`。`build/core.mjs` 统一编译核心；普通 HTML 构建加载固定合约产物，不隐式执行 `compile-contracts.mjs` 或 `prepare-sources.mjs`。

旧 `build:rolling`、`build:rolling-core`、`check:rolling-core` 及独立 `rolling-tn10.html` 构建属于历史布局。既有 `dist/index.html`、`dist/rolling-tn10.html` 及清单、归档页面在本轮保留未改；隔离候选输出生成在 `tests/output/rolling-integration/candidate/`。不能说 `https://win.kaspay.top/` 已切换。

## 本轮执行状态（`tester` 验证结果）

| 项目 | 状态与边界 |
|---|---|
| 统一核心编译与一致性（`build:core` / `check:core`） | **通过**（`16 sources, 48 outputs`，日志：`tests/output/rolling-integration/reorg-validation-t32nqp24/build.log`） |
| 隔离候选页面构建（`build/build.mjs --out-dir=tests/output/rolling-integration/candidate`） | **通过**（TypeScript 5.8.3 严格类型检查与依赖图闸门通过，`index.html` `1,052,299 bytes`，SHA-256 `4302bbd17b428cd6796713ad9350c950e68bdb27f82dc73900053bec979da387`，`806` 源文件；日志：`reorg-final-retest-V3x4t4XB/build.log`） |
| 合约、真实 VM 与核心差分测试（`tests/contracts/*.test.mjs`） | **58/58 通过**（含 `core-diff.test.mjs` 68 项导出与字节级一致性、真实 `kaswin-rolling-vm` 门控、归档、HTTP、索引与服务测试；日志：`reorg-retest-43a5R4sT/contracts.log`） |
| 单元测试套件（`tests/unit/*.test.mjs`，含真实 VM） | **105/105 通过**（含 `page`、`controller`、`catchup`、`views`、`round`、`budget`、`indexer-client`、`sidecar`、`extension-wallet`、`wallet`、`protocol`、`store`；日志：`reorg-retest-43a5R4sT/unit.log` 与 `reorg-final-retest-V3x4t4XB/unit.log`） |
| 浏览器/证据离线测试（4 项 `tests/web/*.test.mjs`） | **14/14 通过**（`evidence.test.mjs`、`submission-barrier.test.mjs`、`interaction.test.mjs`、`external-wallet-browser.test.mjs`；日志：`reorg-web-retest-wYFdylnl/web.log`） |
| 新的实链交易、远端公共节点/索引在线探测、SilverScript 重编译 | **NOT_RUN** |
| 部署、发布、服务 / 网关切换及现有 `dist/` 页面 | **NOT_RUN**（`dist/` 保留未改） |
| Profile 批准 | 保持 **UNVALIDATED**，无晋级 |

## 旧源码与历史证据

重组前源码归档为 [`tracked-source.tar`](../../references/kaswin-before-layout-20261117-171234/tracked-source.tar)，绝对路径 `<references-dir>/kaswin-before-layout-20261117-171234/tracked-source.tar`；原 Git 提交为 `9904597`。归档与提交分别提供迁移前源码和历史版本定位，不声称归档逐字节等于该提交，也不声称它包含全部被忽略的运行产物。本轮未解包、重建或验证该归档。

历史库 `<legacy-v202-archive>` 保持只读、未修改。V2.0.2 的三模板、KW21 布局、旧主应用与双网络说明属于旧版本，不应把它们的 Profile 或批准状态移植给 Rolling。

[Rolling 历史目录](rolling/README.md)保存原实验文档与账本；[集成交接](ROLLING-INTEGRATION-HANDOFF.md)保存此前集成、测试及发布记录。文中的日期、通过数、票数、交易数、金额、txid、哈希、服务状态及未覆盖项保留原样，均限于各自记录时点。历史段落中的“当前”“本次”“已上线”不表示本轮重组已完成相同操作。

| 历史引用 | 阅读方式 |
|---|---|
| `experiments/rolling/VALIDATION.md`、`TN10-EVIDENCE.md`、其他 `.md` 与 TSV | 当前在 `docs/rolling/`；同目录链接继续指向原记录 |
| `toolchain.json`、`vm/Cargo.lock` 等可点击源码链接 | 分别转向 `contracts/` 或 `tests/contracts/` 的迁移后文件；不表示重跑 |
| `experiments/rolling/artifacts/vm/`、`artifacts/tn10/`、`artifacts/tn10-index/` | 历史被忽略的 VM 报告、回执及回放输出；整体移至 `tests/contracts/artifacts/`，不等于 `contracts/artifacts/` 固定合约产物 |
| `tests/output/rolling-integration/`、`tests/output/rolling-runs/` | 历史运行输出引用，保持原路径文字；本轮未检查是否仍存在或内容是否一致 |
| `dist/rolling-tn10.html`、旧 manifest、`dist/archive/` | 原构建或发布证据，不改写为新的 `dist/index.html` |
| 旧源码行号、旧执行命令、服务端绝对路径 | 按原版本与原部署理解；需查旧源码时使用归档或历史提交 |

被忽略的 `experiments/rolling/artifacts/`（除提拔到 `contracts/artifacts/` 的五份固定编译产物与 `template-pins.json` 外）已原样移至 `tests/contracts/artifacts/`，未修改任何已记录的运行回执或签名文件。历史文档中的旧路径保持原时点表述，可点击源码链接只在有明确迁移目标时改向新路径。
