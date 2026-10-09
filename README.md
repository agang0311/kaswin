# Kaswin

任何人可创建、规则与资金流向可由链上证据核验的 Kaspa 抽奖协议与单网页应用。

## 当前发布状态

当前交付是 **Testnet 10 可交易验收候选**，不是只读版本，也不是公开上线安全批准：

- `releaseMode=TN10_ACCEPTANCE_CANDIDATE`、`tradingEnabled=true`、`publicLaunchApproved=false`。
- Profile：`7aaf76fe5e2180070290ff984bebaef54e41093e6a77eef24f2b48fb64c159c8`。
- 当前 HTML 的大小、SHA256 与构建输入以 [`build-manifest.json`](releases/kaswin-v2/build-manifest.json) 为准；线上部署观察另记于[发布修复记录](docs/kaswin-v2/RELEASE-REVIEW-FIXES.md)，不能从本机构建成功推断线上已更新。
- 377 笔历史 TN10 接受回执涵盖 5 个有限场景，不代表全参数域、真实 KasWare E2E 或当前网络重新确认。
- [2,549 例 SCRIPT_VM 预算实验](docs/kaswin-v2/VM-BUDGET-20261009.md)已有材料，独立评审仍待完成；`budgetProfileId=null`，默认 VM 发布门继续阻断。
- 新预算尚未新增链上提交验证；当前 Profile 的 432000 DAA 超时、256 目录退款网络路径及真实 KasWare E2E 仍未完整验收。

## 目录分层

| 目录 | 职责 |
|---|---|
| `contracts/f3.2/` | V2 SilverScript 三合约、linked 产物、Profile/pins 与编译工具；目录名不表示旧协议兼容 |
| `packages/f3.2-core/` | 14 个 TypeScript 核心模块及 42 个生成产物，不依赖 DOM 或运行时 SDK |
| `apps/kaswin-v2/scripts/` | 页面控制器、交易引擎、节点/钱包/Indexer 适配 |
| `apps/kaswin-v2/visual/` | HTML 骨架、CSS、图标、只读展示与中英文词条 |
| `tests/audit/` | 公共离线回归、显式历史回执门与显式 VM 工具 |
| `tests/tn10/` | 隔离 TN10 实验工具；真实执行需单独授权 |
| `releases/kaswin-v2/` | 当前自包含 HTML、manifest、明确标注的历史归档；不要整目录部署 |
| `dist/` | 仅暂存当前 HTML，Git 忽略；网站只发布此目录 |
| `docs/kaswin-v2/` | 架构、固定来源、验证边界和历史记录 |

V1 原型与文档已移出发布文件夹。历史 HTML 为追溯保留，不作推荐入口；不得发布 `wallets/`、`references/`、原始实验目录或整个仓库。

## 构建与发布

Node.js 22+，工具依赖锁定版本；不安装猜测同名的 Kaspa npm 包。

```bash
npm --prefix apps/kaswin-v2 ci --ignore-scripts
npm --prefix apps/kaswin-v2 run check:core
npm --prefix apps/kaswin-v2 run check:bundle # 内存编译，不写发布文件
npm run build:pages                       # 校验已提交HTML、CSP及所有记录的构建输入，再暂存到dist
```

`build:pages` 是发布已构建产物，**不是源码重建，也不重新核验链上回执**。源码漂移、文件缺失、HTML/CSP 不符均阻断。

需要更改交付 HTML 时显式选择模式，两个命令都会归档旧版并更新 release/dist：

```bash
npm --prefix apps/kaswin-v2 run build:candidate      # 只读候选，关闭计划/签名/提交
npm --prefix apps/kaswin-v2 run build:tn10-candidate # 可交易候选，必须具备原始历史回执并通过证据门
```

默认 `npm run build` 仍要求已评审 VM 预算证据，当前阻断，不改 pin 绕过。回执重建前置见[证据访问边界](docs/kaswin-v2/EVIDENCE-ACCESS.md)。

## 验证入口

```bash
# 先按固定来源取得官方 SDK 2.0.1；仅测试需要，网页不嵌入它
npm test                  # 应用离线回归，含1个明确的预算评审TODO
npm run test:audit        # 公共本地回归；不要求原始TN10回执，不执行VM
npm run test:receipts     # 独立核验377笔原始历史回执；缺材料硬失败，不SKIP
npm --prefix apps/kaswin-v2 run test:ui # Chromium本地UI/传输；无真实钱包广播
```

[SDK获取与SHA256](docs/kaswin-v2/SOURCES.md)、[审计入口](tests/audit/README.md)、[修复验证记录](docs/kaswin-v2/RELEASE-REVIEW-FIXES.md)。离线模拟不是 VM，VM 不是网络 acceptance；历史通过数不自动适用于新构建。

## 安全边界

- 仅 TN10/TKAS，金额用 bigint/十进制字符串，单笔手续费上限 0.5 TKAS。
- `UNKNOWN` 不因 TTL、未入内存池或历史裁剪而释放输入或自动重发。
- 区块包含不等于接受；Indexer 用于发现，REST 仅辅助定位，完整节点复验才转为 `ACCEPTED`。
- 视觉层不签名、提交或决定释放输入。切换语言不重置已批准交易。
- 换 Origin 会隔离浏览器记录与保护；不要清除站点数据后重发旧交易。
- 不读取真实密钥或广播，除非另获指定 TN10 实验授权；私钥、助记词、凭证不得进入提交或日志。

架构入口：[ARCHITECTURE](docs/kaswin-v2/ARCHITECTURE.md)；设计历史和当前发布状态分开阅读。
