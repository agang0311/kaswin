# Kaswin V2 网页

自包含单文件 Testnet 10 应用。当前交付为 **可交易验收候选**（不是只读），`publicLaunchApproved=false`；准确模式、哈希、未验证边界见[发布入口](../../releases/kaswin-v2/README.md)与[根README](../../README.md)。只支持固定 Profile `7aaf76fe…`，不升级旧轮次。

## 源码分工

- [scripts/](scripts/README.md)：控制器、业务流程与网络/钱包适配。
- [visual/](visual/README.md)：HTML壳、CSS、图标、中英文和只读展示。
- [链外核心库](../../packages/f3.2-core/README.md)：状态与交易编码。
- [链上合约](../../contracts/f3.2/README.md)：SilverScript；UI不能替代链上约束。

广场将其他 Profile 放入默认收起的独立面板，搜索保留当前展开状态。创建默认总票数100,000；七项参数保存在当前 Origin 的 `kaswin-v2:createForm`。存储不可用时不保证跨会话记忆，不保存密钥。

## 构建（仓库根目录）

```bash
npm --prefix apps/kaswin-v2 ci --ignore-scripts
npm --prefix apps/kaswin-v2 run check:core
npm --prefix apps/kaswin-v2 run check:bundle
npm run build:pages # 只验证并暂存已提交产物，不重新构建
```

重建需显式选择 `build:candidate`（只读）或 `build:tn10-candidate`（原始回执门）。两者都会覆盖现行release/dist并归档旧版。默认 `build` 仍被未评审VM预算阻断。详见[证据访问](../../docs/kaswin-v2/EVIDENCE-ACCESS.md)。

## 测试

模拟钱包单测/E2E需要单独取得的官方SDK2.0.1，按[固定来源](../../docs/kaswin-v2/SOURCES.md)核对资产SHA256，解压至忽略目录 `references/kaspa-wasm32-sdk/`，或设置 `KASPA_SDK_PATH=/absolute/path/to/kaspa.js`。禁止安装猜测的同名npm包；SDK不进入网页。

```bash
npm --prefix apps/kaswin-v2 test
# 首次显式安装与锁定Playwright匹配的浏览器：
cd apps/kaswin-v2
npx --no-install playwright install chromium
npm run test:ui
npm run test:e2e
```

`test:ui` 含布局、参数持久化/折叠搜索、双语、明文和端点检查；明文测试仅短暂监听本机/LAN模拟服务。`test:e2e` 使用公开测试标量和模拟节点，不等于真实KasWare或TN10验收；只读构建会拒绝交易E2E。测试输出写忽略目录。可选 `test:live` 只读外部TN10服务，不签名广播。

当前测试结果及范围见[修复记录](../../docs/kaswin-v2/RELEASE-REVIEW-FIXES.md)，不把历史结果称为当前全验证。
