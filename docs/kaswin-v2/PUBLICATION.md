# F3.2 / V2 资料发布与分层约定

日期：2026-10-05。范围：整理现存 Testnet 10 F3.2 / V2 工作快照，移植为可独立构建的仓库目录；不是新 Covenant 功能、协议升级或生产安全审计。

## 发布前门槛

已重读工作空间 README、sources、兼容矩阵、核心架构规范及25问模板。逐项沿用 [ARCHITECTURE](ARCHITECTURE.md) 的25问、14项材料、8项anti-pattern与其既有证据；本次不改变合约身份、授权、状态转换、资金、随机性、退出、foreign或共识参数。仅源码文件位置、import路径、固定工具依赖解析与产物目录改变。图标数据从控制器原样提取；不拆改交易控制流程。源文件哈希映射见 `source-map.json`。

25问1–25：答案逐行仍为 ARCHITECTURE 原表，不因目录名/网页名变化重新派生 CID 或 Profile。14项1–14：原材料全部保留，新增的是文件责任图，不是UTXO拓扑。8项1–8：原结论与残余风险保留，整理不构成再次安全审计。原协议 DRAFT/BLOCKED、随机性/活性/生产发布限制不解除。此范围仅允许资料发布、构建迁移与离线回归；不授权新签名广播。

## 责任划分

| 目录 | 职责 | 不应做什么 |
|---|---|---|
| `contracts/f3.2/src/` | 三份原始 SilverScript，链上转换规则 | 不放 DOM、CSS、钱包配置 |
| `contracts/f3.2/artifacts/` | 固定 linked artifact、ABI、原编译报告 | 不把字节码输出等同 VM/网络通过 |
| `packages/f3.2-core/src/` | 状态编码、后继/资金规则的链外镜像、交易构建、PASS-A | 不是链上合约本体，不依赖 DOM |
| `packages/f3.2-core/lib/` | 固定 TypeScript 生成的可审查 JS | 不手工修改；不打包 SDK/WASM |
| `apps/kaswin-v2/scripts/` | 页面事件与流程、RPC、钱包、提交前核验、记录、对账 | 不用页面外观或 REST 证词裁决接受 |
| `apps/kaswin-v2/visual/` | HTML壳、CSS、SVG图标、文字呈现、中英文、本地时间 | 不提交、签名、释放输入或重建批准 |
| `releases/kaswin-v2/` | 最终单HTML和来源manifest | 产物不作为手改源码 |
| `docs/kaswin-v2/` | 用法、固定来源、架构及验证边界 | 不把历史状态当本次新验证 |

`app.mjs` 仍同时承接DOM事件与动态片段渲染，是现存UI控制器；本次不是完整MVC重写。视觉文件已物理分离，`view.mjs` 仅展示候选事实，`icons.mjs` 仅提供静态SVG。未来若继续拆组件必须另做行为回归，不为目录漂亮改动交易逻辑。

## 边界及兼容

- 本仓库旧根目录 `contracts/`、`src/`、`research/`、`tests/` 是旧 V1 审计快照。未删除、覆盖、混入F3.2构建；根 README 原内容归档保留。
- 核心包只搬运 V2 实际依赖闭包，不复制整个旧实现、节点源码、SDK、依赖目录或运行服务。
- V2原有存储名（含 `kaswin-opus-f32` 和提交锁）故意保持，重命名文件不重命名数据库。新网页origin不自动继承旧记录；UNKNOWN不应在新origin重复发送。
- `deployed-20261005.html` 是已部署文件的逐字节副本。`index.html` 是分层目录重建的产物；独立记录哈希，不能把前者的公网验收冒充后者的验收。本次上传不替换原公网网页，不配置 GitHub Pages。
- TypeScript/esbuild/Playwright/ws固定版本；合约编译器/SDK不升级。不自动下载或安装猜测同名Kaspa包。
- 不搬入真实钱包、私钥、助记词、凭证、浏览器用户数据、服务配置、数据库或批量广播runner。测试只保留公开固定测试标量1及最小公开交易/证明fixture，绝不能当真实钱包使用。
- 默认只执行离线/本地模拟测试。带 `--live` 的已有测试只读公共TN10服务；mock接受、历史索引、节点selected-chain接受、真实钱包验证分开记录。

## Git范围

基于远端 `audit/state-deposit-v1@617e3e80438df95cd2c8aed637ffb64c52f3a333` 独立干净克隆，按仓库既有约定增加一个commit并普通push；不合并main，不改写历史，不夹带本机实验分支的未提交文件。旧工作区不checkout/reset/clean。
