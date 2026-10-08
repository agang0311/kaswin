# Kaswin V2 网页

独立单文件 Testnet 10 界面：浏览轮次、创建、活动记录、规则说明；中英切换、明暗主题、本地时区，逐笔报价和钱包批准。源码只支持本地固定的V2 Profile；其他Profile不能操作。

**2026-10-07合约收紧：新Profile `7aaf76fe…`，仅编译与只读候选。** fee绑定、退款末输出约束、432000 DAA超时已同步，SIL/artifacts/lib/HTML均更新。先读[设计与结果](../../docs/kaswin-v2/CONTRACT-HARDENING-20261007.md)。预算证据未闭合，可交易build仍阻断；当前HTML永久禁用计划/签名/提交，无UI开关，未部署。旧Profile轮次不能由新版操作。

## 源码分工

- [scripts/](scripts/README.md)：控制器、业务流程与网络/钱包适配。
- [visual/](visual/README.md)：HTML壳、CSS、图标、中英文和只读展示。
- [链外核心库](../../packages/f3.2-core/README.md)：交易与状态编码。
- [链上合约](../../contracts/f3.2/README.md)：SilverScript，不能以UI逻辑替代。
- [使用/构建与限制](../../docs/kaswin-v2/README.md)、[整理范围](../../docs/kaswin-v2/PUBLICATION.md)。

## 构建

Node.js 22+。从仓库根目录：

```bash
npm --prefix apps/kaswin-v2 ci --ignore-scripts
npm --prefix apps/kaswin-v2 run check:core
npm --prefix apps/kaswin-v2 run check:bundle  # 只在内存编译，不写HTML
npm --prefix apps/kaswin-v2 run build:candidate # 写只读候选，禁用交易；同步dist
# npm --prefix apps/kaswin-v2 run build      # 当前预算门槛BLOCKED
```

输出 `releases/kaswin-v2/index.html` 和构建manifest。构建仅需锁定开发依赖和仓库内合约产物；不下载SDK/WASM、不访问节点、不运行上游setup、不签名提交。

## 测试（本轮没有执行，以下仅供后续获准使用）

模拟钱包单测/E2E需要**单独取得的官方SDK2.0.1**。按[固定来源](../../docs/kaswin-v2/SOURCES.md)验证release资产，不安装猜测的npm包。默认SDK路径为仓库下被忽略的 `references/kaspa-wasm32-sdk/nodejs/kaspa/kaspa.js`；也可设 `KASPA_SDK_PATH=/absolute/path/to/kaspa.js`。SDK仅用于测试，不打包。

```bash
npm --prefix apps/kaswin-v2 test
# 显式安装与Playwright 1.63.0对应的浏览器，仅首次需要：
cd apps/kaswin-v2
npx --no-install playwright install chromium
npm run test:ui
npm run test:e2e
```

`test`包含源码层接口、引擎和记录保护回归；旧预算数据不再用于V2断言，V2 VM校准明确TODO。当前没有新通过数。交易流程`test:e2e`要求独立获批的交易build，当前只读候选明确拒绝运行；历史为英文7模拟提交/接受及REST生命周期；模拟KasWare使用公开测试标量1，禁止用于真实资金。`test:ui`里的明文测试会短暂监听本机/LAN测试服务，不是生产部署，HTTPS仅检查提示和保存，不承诺混合内容放行。全部测试输出写被忽略的 `test-results/`。

可选 `npm run test:live` 只读LA真实服务，不需钱包、不签名/广播；外部服务可用性、历史裁剪和访问权限可能导致失败。默认测试不访问真实节点。
