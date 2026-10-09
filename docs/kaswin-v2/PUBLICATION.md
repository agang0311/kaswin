# F3.2 / V2 资料发布与分层约定

## 当前发布约定

当前为可交易TN10验收候选，源码/产物一致性由构建清单与发布脚本核对；准确状态见[根README](../../README.md)、[交付入口](../../releases/kaswin-v2/README.md)和[修复记录](RELEASE-REVIEW-FIXES.md)。`main`为发布分支。网站只发布`dist/index.html`，不发布整个仓库或历史归档。

`build:pages`核验已提交HTML和全部记录输入后暂存；原始回执不公开随Git分发，源码重建与回执门的前置条件见[证据访问](EVIDENCE-ACCESS.md)。构建、VM、历史网络回执与线上HTTP回读分别记录；publicLaunchApproved仍为false。

## 内部测试 → 公开发布流程（2026-10-09 起）

`main` 由 Cloudflare Pages 自动发布（推送即上线），所以先在内部测试站确认，再推送：

1. 本地构建，提交新的 `releases/kaswin-v2/index.html` 与 `build-manifest.json`（先不推送）。
2. 部署到内部测试站 `https://cd311.cn:888/www/kaswin-v2.html`：在本机 `/root/www/kaswin-v2.html` 软链接指向 `dist/index.html`，构建完成即生效。
3. 运行 `node tools/check-deployed.mjs https://cd311.cn:888/www/kaswin-v2.html`。它会核对线上返回的页面与要推送的发布文件、构建清单逐字节一致，执行与 Pages 相同的 `stage-release` 检查，再用真实 Chromium（桌面和手机宽度）读取公开 TN10 节点和 Indexer，确认列表、节点连接和轮次详情正常，且无页面错误、CSP 拦截或交易提交。结果写入 `apps/kaswin-v2/test-results/deployed/<sha256>.json`（不提交）。只读：不使用钱包、不签名、不提交交易。
4. 需要人工看的（真实 KasWare 操作等）在内部测试站上做。
5. 推送 `main`。本地 `pre-push` 钩子（`tools/pre-push-gate.mjs`）会检查：若这次推送改变了发布页面，该页面必须已在内部测试站通过第 3 步，且测试站此刻仍在返回同一页面，否则拒绝推送。只改文档、测试或源码而不改发布页面的推送直接放行。

钩子是本地的，每个克隆需要安装一次：

```sh
git config kaswin.internalUrl https://cd311.cn:888/www/kaswin-v2.html
printf '#!/bin/sh\nexec node tools/pre-push-gate.mjs "$@"\n' > .git/hooks/pre-push && chmod +x .git/hooks/pre-push
```

它只是防止误操作，`git push --no-verify` 或在别的克隆里推送都能绕过；Pages 端的 `stage-release` 检查仍然有效，但它不知道内部测试是否做过。

## 历史：2026-10-06 源码候选（已被后续版本取代）

当时已是V2协议源码变更，不再是仅文件搬迁。详见 [V2源码状态](V2-SOURCE-STATUS.md)。源码与旧lib/artifacts/pins/release尚未同步；构建应失败，不可发布。旧部署复现npm入口已移除，旧HTML和历史映射保留；本轮无编译、测试、提交、push或部署。Indexer候选位于另一工作空间，未启用，不应把本仓库提交当作服务部署。

以下是2026-10-05整理工作的历史范围，不适用于当前V2协议源码。

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
