# Kaswin

任何人可创建、规则与资金流向可由链上证据核验的 Kaspa 抽奖协议与单网页应用。

> **2026-10-06：V2源码候选，未编译/测试/发布。** 当前源码已改为228B、8/6 ABI及固定前向模板哈希；旧lib/artifacts/pins/release尚未重建。不要运行下方历史命令或把历史通过数当作本轮结果。当前状态、架构差异和获准后的验证顺序见 [V2-SOURCE-STATUS](docs/kaswin-v2/V2-SOURCE-STATUS.md)。

---

## 目录分层架构

本项目已按**链上合约**、**链外核心库**、**网页脚本**与**页面视觉**完成严格物理分层，各模块边界清晰、责任独立：

```text
├── contracts/f3.2/             # [链上合约] SilverScript 源码、固定 linked 产物与 Profile
│   ├── src/                    # open.sil, sealed.sil, refunding.sil
│   ├── artifacts/              # 原始编译器 linked JSON、构造参数与编译报告
│   ├── profile.json            # 固定 Profile (7ca61d81...) 与模板哈希
│   ├── pins.json               # 源码与产物完整 SHA256 校验锚
│   └── tools/check-compile.mjs # 可选编译器离线重放工具
│
├── packages/f3.2-core/         # [链外核心库] 状态、交易构建与 PASS-A 证明的 13 模块闭包
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
│   ├── index.html              # 由分层源码脱机构建出的独立单文件 (310,605 B, sha256: 29a49a62...)
│   ├── deployed-20261005.html  # 线上部署版本快照 (310,601 B, sha256: ab90da23...)
│   └── build-manifest.json     # 包含 40 项构建输入 SHA256 的元数据清单
│
├── docs/kaswin-v2/             # [项目文档] 架构说明、固定来源、验证记录与源码映射
│   ├── ARCHITECTURE.md         # 架构规范：25 问、14 项材料与 8 项反模式审查
│   ├── PUBLICATION.md          # 资料整理与分层边界约定
│   ├── SOURCES.md              # 外部来源固定版本表与哈希
│   ├── VALIDATION.md           # 完整验证记录与不可逾越的边界
│   └── source-map.json         # 迁移源码逐文件 SHA256 映射与变更说明
│
└── docs/legacy-v1/             # [历史归档] 早期 V1 审计快照资料（隔离保留，非 F3.2/V2 状态）
```

---

## 历史构建流程（当前暂停，先阅读V2门槛）

本项目无需从网络下载任何运行时 SDK、字体或 CDN 库，构建与核心核验完全离线进行：

```bash
# 1. 安装开发工具依赖（esbuild 0.28.2, typescript 5.8.3, playwright 1.63.0, ws 8.21.3）
npm --prefix apps/kaswin-v2 ci --ignore-scripts

# 2. 验证核心库源码与提交产物 100% 逐字节一致
npm --prefix apps/kaswin-v2 run check:core

# 3. 构建发布单文件 HTML
npm --prefix apps/kaswin-v2 run build

# 4. 旧部署复现只属于历史源码版本；当前已移除 verify:deployed

# 5. 获准后运行单元测试；历史50项结果不是当前V2结果
npm --prefix apps/kaswin-v2 test
```

自动化浏览器与端到端模拟测试（需安装 Chromium）：
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
