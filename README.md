# Kaswin

任何人可创建、规则与资金流向可由链上证据核验的 Kaspa 抽奖协议与单网页应用。

> **2026-10-09：VM预算校准已运行**：2,549例全部可执行、无超预算；但CLOSE等小目录实测超出候选公式，预算门未通过，见[VM-BUDGET-20261009.md](docs/kaswin-v2/VM-BUDGET-20261009.md)。
>
> **2026-10-09：修复Indexer/缓存`state`显示注入并重建候选**（`bc5eeff1…`，未部署），见[INJECTION-FIX-20261009.md](docs/kaswin-v2/INJECTION-FIX-20261009.md)。
>
> **2026-10-08：新增TN10可交易验收候选。** 当前 `releases/kaswin-v2/index.html` 允许交易，仅用于测试资金验收，`publicLaunchApproved:false`；377笔历史接受回执已离线绑定。真实KasWare/新Profile登记发现仍待验收，256目录退款与超时未全证，不是VM预算校准。使用 `npm --prefix apps/kaswin-v2 run build:tn10-candidate`，默认build的VM门保持阻断。详见[本轮实施与验收](docs/kaswin-v2/TN10-RELEASE-20261008.md)。

> **历史2026-10-07：合约收紧，新Profile与单文件只读候选。** 所有动作fee绑定真实输入输出差且0<fee≤0.5 TKAS；退款末输出绑定执行者；超时改为432000 DAA。Profile `7aaf76fe5e2180070290ff984bebaef54e41093e6a77eef24f2b48fb64c159c8`；228B、8/6 ABI保持，SIL/artifacts/lib/HTML均已更新。固定编译器重编一致，但未测试／VM／链上验证。`budgetProfileId:null`，**当前HTML禁用交易计划、签名和提交，不是可交易或主网版本**。旧HTML归档，新Profile不升级旧UTXO。见[合约Preflight与结果](docs/kaswin-v2/CONTRACT-HARDENING-20261007.md)。

---

## 目录分层架构

本项目已按**链上合约**、**链外核心库**、**网页脚本**与**页面视觉**完成严格物理分层，各模块边界清晰、责任独立：

```text
├── contracts/f3.2/             # [链上合约] SilverScript 源码、固定 linked 产物与 Profile
│   ├── src/                    # open.sil, sealed.sil, refunding.sil
│   ├── artifacts/              # 原始编译器 linked JSON、构造参数与编译报告
│   ├── profile.json            # 新 Profile (7aaf76fe...) 与模板哈希
│   ├── pins.json               # 源码与产物完整 SHA256 校验锚
│   └── tools/check-compile.mjs # 可选编译器离线重放工具
│
├── packages/f3.2-core/         # [链外核心库] 14 模块：状态、构建、已接受交易解释、PASS-A
│   ├── src/                    # TypeScript 源码（纯逻辑，无 DOM，无 SDK 依赖）
│   ├── lib/                    # 固定 TypeScript 5.8.3 生成的 JS、类型与 SourceMap
│   └── tsconfig.json           # 严格模式编译配置（strict: true）
│
├── apps/kaswin-v2/             # [网页应用] V2 单文件网页源码与自动化测试套件
│   ├── scripts/                # [行为层] 控制器、业务引擎、RPC 节点连接、钱包适配与 REST 备用
│   │   ├── app.mjs             # 页面主控制器（交互绑定与流程编排）
│   │   ├── engine2.mjs         # V2 离链游标恢复、严格输入占用与对账引擎
│   │   ├── endpoints.mjs       # LA 默认端点配置、版本迁移与无证书提示
│   │   ├── rest.mjs            # 仅含 txid 的无凭据只读 REST 备用查询
│   │   └── shared/             # 复用的固定引擎、RPC 通信、BIP-340 与交易质量计算
│   ├── visual/                 # [呈现层] 纯视觉表现，严禁参与交易授权与资金决策
│   │   ├── index.template.html # 页面基础骨架与结构
│   │   ├── styles.css          # 响应式样式与深浅主题
│   │   ├── icons.mjs           # 静态 SVG 图标集合
│   │   ├── view.mjs            # 状态、费用与动作只读展示格式化
│   │   ├── i18n.mjs            # 双语翻译管道与本地时区显示
│   │   └── messages-en.mjs     # 审阅过的英文词条目录
│   ├── test/                   # 50 项单测、UI 浏览器测试、E2E 模拟与公开测试 Fixture
│   └── tools/                  # 构建工具（build.mjs）与核心库检查工具（check-core.mjs）
│
├── releases/kaswin-v2/         # [发布产物] 最终单文件交付物与清单
│   ├── index.html              # 新Profile只读候选，签名/提交禁用；hash见manifest
│   ├── deployed-20261005.html  # 历史部署快照 (316,069 B, sha256: 335fbf04...)；非本轮线上核验
│   └── build-manifest.json     # 构建输入SHA256、只读模式及验证边界
│
└── docs/kaswin-v2/             # [项目文档] 架构说明、固定来源、验证记录与源码映射
    ├── ARCHITECTURE.md         # 架构规范：25 问、14 项材料与 8 项反模式审查
    ├── PUBLICATION.md          # 资料整理与分层边界约定
    ├── SOURCES.md              # 外部来源固定版本表与哈希
    ├── VALIDATION.md           # 完整验证记录与不可逾越的边界
    └── source-map.json         # 迁移源码逐文件 SHA256 映射与变更说明
```

---

## 编译核对与正式发布门槛

本项目无需从网络下载任何运行时 SDK、字体或 CDN 库，构建与核心核验完全离线进行：

```bash
# 1. 安装开发工具依赖（esbuild 0.28.2, typescript 5.8.3, playwright 1.63.0, ws 8.21.3）
npm --prefix apps/kaswin-v2 ci --ignore-scripts

# 2. 验证核心库源码与提交产物 100% 逐字节一致
npm --prefix apps/kaswin-v2 run check:core

# 3. 仅在内存编译打包，不运行页面、不写发布文件、不解除预算门槛
npm --prefix apps/kaswin-v2 run check:bundle

# 4. 更新只读候选HTML/manifest及dist（交易被编译常量禁用）
npm --prefix apps/kaswin-v2 run build:candidate
# 可交易build仍被新Profile预算证据阻断，不通过改pin绕过
# npm --prefix apps/kaswin-v2 run build

# 5. 旧部署复现只属于历史源码版本；当前已移除 verify:deployed

# 6. 获准后运行单元测试；历史通过数不是整改后结果
npm --prefix apps/kaswin-v2 test
```

以下测试命令仅供后续获准使用；2026-10-07整改没有执行任何测试（需安装 Chromium）：
```bash
cd apps/kaswin-v2
npx --no-install playwright install chromium
npm run test:ui    # 4 项浏览器 UI、时区、明文与端点测试
npm run test:e2e   # 双语端到端模拟交易与 REST 生命周期测试
```

---

## 核心安全红线

1. **Testnet 10 专有**：页面与协议仅面向 Kaspa Testnet 10 / TKAS，单笔交易手续费上限 0.5 TKAS。
2. **严禁自动释放或重发**：处于 `UNKNOWN` 状态的交易不因超时、内存池未查到或剪枝而判定失败，已占用 UTXO 绝不释放，绝不自动重发。
3. **REST 仅作辅助定位**：公共 REST 接口仅供定位交易发生位置，只有经由全节点完成 selected-chain 接受集与交易内容完整复验，状态才可转为 `ACCEPTED`。
4. **视觉与业务严格解耦**：视觉呈现层（`visual/`）严禁引用交易构建、签名、网络提交或提交锁模块，界面翻译与语言切换不触发生命周期重置或表单数据丢失。
5. **凭证隔离**：本仓库不包含任何真实私钥、助记词或主网资产；测试用例仅使用公开测试标量 1 与 2。
