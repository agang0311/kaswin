# 2026-10-09 客户端显示注入修复（F5残留）与 Indexer TRACK 去重（F4）

状态：源码已修复、已重建 TN10 验收候选；**未部署**（公共页面、Indexer 服务与数据库均未改动）。依据：同日复审（HEAD `034f7c8c`）。用户指令“两个都改了，然后重新构建”。全程不运行 VM、不连接节点/Indexer、不读取钱包、不签名广播；本地测试在无外网的网络命名空间中执行。

固定 Profile `7aaf76fe…`、SilverScript、共识源码、SDK pin 与 TN10 证据门均不变；本次不涉及合约、核心库、builder、签名或资金路径。

## 架构增量（核心规范 §25 适用性）

本次只改链外展示层输入校验与 Indexer 本地缓存的写入幂等，不新增/修改任何链上状态、动作、授权、资金流或终局。25问与14项材料沿用 [CONTRACT-HARDENING-20261007.md](CONTRACT-HARDENING-20261007.md) 与 [TN10-RELEASE-20261008.md](TN10-RELEASE-20261008.md)，仅以下条目有增量：

- 11/21（Indexer 角色）：Indexer 仍只做发现提示；其返回的 `state` 现在与缓存视图同样按完整账本规则校验，不合规行丢弃。
- 13（后继验证）：不变；动作前仍由节点 live UTXO + selected-chain acceptance 复验（`liveRound`）。
- 16/18（争用/共享）：Indexer 同一 accepted txid 对同一轮只应用一次；仅为链外缓存一致性，不是共识锁。

8项 anti-pattern：均不涉及（无链上全局状态、无新签名/CID/bytes 信任；Indexer 不因此获得裁判权）。

## 1. 页面：Indexer/缓存 `state` 注入（F5 残留）

问题：`checkRow` 不校验 `state`/`config`；列表行与 IndexedDB 缓存视图在 `ledgerFromDetail` 之前即进入 `state.details` 并被插值到 `innerHTML`（`card()` 与轮次 KPI）。哈希 CSP 阻止脚本，但仍可注入任意 HTML/内联样式（钓鱼遮罩/伪按钮），并持久保存在缓存中。

修复（`apps/kaswin-v2/scripts/`）：

- `shared/rounds.mjs`：`checkRow` 若携带 `state`，按 `S.validateLedger`（带目录时）或 `S.validateConfig`＋整数/哈希范围（摘要行）完整校验；`purchases` 数量须等于 `purchaseCount`；`contract`/`updatedAt`/`liveSeenAt`/`nextCursor` 类型检查。`listRounds` 逐行校验，不合规行丢弃并返回 `rejected` 计数，避免单行恶意数据隐藏全部诚实轮次。
- `app.mjs`：IndexedDB 缓存视图经 `checkRow(view, {cached: true})` 后才参与合并/打开；无效缓存降级为仅 CID 占位。卡片、KPI、持票数、tip index、`data-tx` 插值统一 `escapeHtml`（第二层防护）。列表页显示被丢弃行数（中英双语）。

验证（L）：

| 项 | 结果 |
|---|---|
| 应用 Node 测试（新增 1 条：恶意/非规范 state 与缓存视图被拒） | 68 PASS，1 TODO（VM 校准），0 FAIL |
| `tests/audit/run-all.mjs --local`（10 套，VM 套未运行） | 全部 PASS |
| `check:core` | 14→42 生成文件逐字节一致 |
| 离线 Chromium 探针（所有外部请求拦截/WS 不连接） | 修复前 `6f790f0c…`：列表注入 **true**；修复后 `bc5eeff1…`：列表/恶意行详情/预置恶意缓存详情注入均 **false**，诚实轮次正常显示，0 页面错误，0 外泄请求 |
| 丢弃提示 | zh-CN/en 均正确显示 |

探针与结果：知识工作区 `references/v2-audit-20261006/probe-browser-markup-fix.mjs`、`head-034f7c8c/markup-*.json`（被忽略的研究目录，不入本仓库）。

构建：`npm --prefix apps/kaswin-v2 run build:tn10-candidate` → `releases/kaswin-v2/index.html` 340122 bytes，SHA256 `bc5eeff13d76444021ecd501f856a4f0455486d80c1cff3f7133ca23feb6e133`，`dist/index.html` 相同。`releaseMode=TN10_ACCEPTANCE_CANDIDATE`、`publicLaunchApproved=false`、`budgetProfileId=null` 不变。旧 HTML 由构建脚本归档。

## 2. Indexer：TRACK 绕过队列导致重复 transition（F4）

Indexer 源码不在本仓库，位于知识工作区 `workers/kaswin-event-indexer/`（部署副本 `/opt/kaswin-event-indexer/`）。

修复：

- `indexer.mjs` `track` 分支：`discoverGenesis` 改为经 `engine.run('track:<txid>')` 与 `start()` 排入的 `retryPending()` 串行执行；失败仍以非零退出码结束。
- `src/engine.mjs` `commit()`：在写事务内检查同轮同 txid 的非回滚 transition，存在则返回 `KNOWN`（取消多余订阅、记 `DUPLICATE_SKIPPED`）；`seq` 改在同一事务内分配。
- `src/store.mjs`：新增部分唯一索引 `transitions_active_txid ON transitions(round_id, txid) WHERE status!='ROLLED_BACK'`。保留 reorg 重放产生的 `ROLLED_BACK + FINAL` 历史对；若既有数据库已有活跃重复，启动即 `ACTIVE_DUPLICATE_TRANSITION` 失败关闭，需人工处理，不自动删除。

验证（L）：

| 项 | 结果 |
|---|---|
| 原 F4 竞态探针 | 修复前 seq0+seq1 两条 GENESIS、2 条 relay；修复后 1 条、1 条 relay |
| 新增 2 条回归（并发发现只写一次且 DB 拒绝活跃重复；含活跃重复的旧库升级失败关闭） | PASS；对未修复副本运行同两条为 FAIL（证明测试有效） |
| 知识库 `examples` 全量（命名空间内仅开 loopback） | 109 PASS |
| 生产库只读副本检查 | 318 行，活跃重复 0（15 组重复均为 ROLLED_BACK+FINAL），新索引可直接建立 |

## 未做与剩余边界

- 未部署：`/root/www/kaswin-v2.html` 仍为 `6509ee14…`（旧 Profile、含原 F5 脚本注入），`/opt/kaswin-event-indexer` 仍为修复前代码。上线需单独授权：替换页面；同步 Indexer 三个文件并重启服务（启动时自动建索引）。
- 真实 KasWare E2E、新 Profile 轮次自动发现、256 目录退款资源与真实超时路径仍未验证，发布门槛不变。

## 部署记录（2026-10-09 11:35–11:40 CST，用户授权“先把你能做的做了”）

- **Indexer F4 修复**：本机 `/opt/kaswin-event-indexer` 与 VPS `la.cd311.cn`（公开 `https://tn10.kaspay.top/indexer`）均按停机冷备份 → 替换 `indexer.mjs`/`src/engine.mjs`/`src/store.mjs` → 重启。部署前先用新代码打开生产库副本，确认无活跃重复、唯一索引可建立（本机 318 行、VPS 347 行；重复组全部为 ROLLED_BACK 历史）。重启后服务 active、`integrity_check` ok、索引存在、API 轮次数与升级前一致（本机 9、VPS 13）。备份：两机均为 `/var/lib/kaswin-event-indexer/events-before-20261009-f4.sqlite` 与 `/opt/kaswin-event-indexer-before-20261009-f4.tgz`。
- **开源仓库** `agang0311/kaswin-indexer`：同步三文件（保留其 `./src/sdk.mjs` 导入与原分类逻辑差异），Docker 构建、容器内新 store 建索引与 `contracts` 列出 4 个插件均通过，推送 `00de43d`。
- **页面**：`https://cd311.cn:888/www/kaswin-v2.html` 已经是当前构建 `b627d6e2…`（`/root/www/kaswin-v2.html` 为指向 `dist/index.html` 的软链接）。

## Cloudflare Pages 发布（2026-10-09 12:10 CST，用户授权）

`win.kaspay.top`、`kaswin.kaspay.top`、`kaswin.pages.dev` 均为 Pages 项目 `kaswin`（GitHub 集成，生产分支 `audit/state-deposit-v1`）。原先线上为 2026-10-06 的部署 `aac66cdf`（提交 `fdf8230`，含 F5 注入的旧页面 `6509ee14…`）。

- 原构建命令 `npm run build` 在 Pages 上失败（部署 `554e3d3b`、`edb38e91`）：默认构建被未审查的 VM 预算门正确拦截（`budgetProfileId` 为 null），而 TN10 候选构建需要不提交到仓库的原始回执，CI 也无法运行。没有绕过任何门。
- 新增 `tools/stage-release.mjs`（`npm run build:pages`）：只发布仓库中已提交的 `releases/kaswin-v2/index.html`，发布前核对 `build-manifest.json` 中的 SHA256 与字节数、releaseMode 白名单、`publicLaunchApproved=false`、脚本 CSP 必须为哈希；改动一个字节即失败（已测）。Pages 构建命令已改为 `npm run build:pages`。
- 部署 `3a3a4eef`（提交 `56f3571`）成功。三个域名与 cd311 均返回 `b627d6e2…`。
- 真实 Chromium 检查线上页面：读取公开 Indexer 显示 13 个轮次，0 页面错误；把公开 Indexer 的响应换成恶意行后，列表和轮次详情均未注入，页面提示“索引返回的 1 个轮次格式不合规，已忽略”。探针为 `/root/kaspa/references/v2-audit-20261006/probe-live-site.mjs`（无钱包、不签名、不提交）。
- `kaspay.top` 区域开着 Cloudflare Web Analytics（RUM），边缘会在 `win.kaspay.top` 的 HTML 末尾注入 `beacon.min.js`，所以浏览器收到的字节哈希是 `a6811955…`，不等于发布哈希（`kaswin.pages.dev` 不受影响，为 `b627d6e2…`）。该脚本被页面 CSP 拦截、不会执行，也不影响功能；未修改区域设置。
- **行为变化**：今后推送到 `audit/state-deposit-v1` 即会把仓库中提交的 `releases/kaswin-v2/index.html` 发布到生产，而不是在 CI 里重新构建。

## 分支调整（2026-10-09，用户要求）

GitHub 上原 `main`（`0633907c`，2026-09-06，是 `audit/state-deposit-v1` 的祖先，没有独有提交）已删除；`audit/state-deposit-v1` 改名为 `main` 并设为默认分支。Cloudflare Pages 项目 `kaswin` 的生产分支同步改为 `main`。历史文档中提到的 `audit/state-deposit-v1` 指的就是现在的 `main`。

## Pages 重新绑定仓库（2026-10-09）

原 Pages 项目 `kaswin` 一直绑定 GitHub 仓库 ID `1300696635`（现名 `agang0311/kaswin-archived`），而当前仓库 `agang0311/kaswin` 的 ID 是 `1357958794`（2026-09-05 新建），所以 8 月 19 日以后推送都不会自动构建，此前各次部署都是手动触发（`ad_hoc`）。API 无法修改已有项目的绑定仓库（PATCH 被静默忽略；断开后项目变成 Direct Upload，不允许再设置 source）。用户在 Cloudflare 后台重新绑定后，项目 `kaswin` 的来源为 `agang0311/kaswin`（`1357958794`），生产分支 `main`，构建命令 `npm run build:pages`，输出 `dist`，域名 `kaswin.pages.dev`、`win.kaspay.top`、`kaswin.kaspay.top` 保持不变。
