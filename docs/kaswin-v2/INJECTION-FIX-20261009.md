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
