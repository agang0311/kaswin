# 开发说明

## 工具链

- Node.js ≥22，使用 ESM。
- esbuild 0.28.2，打包浏览器程序。
- TypeScript 5.8.3，编译协议核心库。
- SilverScript 固定编译产物由 `contracts/pins.json` 标识，HTML 构建无需 SilverScript 二进制。

`npm ci` 按 lock 文件安装依赖，不使用浮动版本。

## 构建流程

1. 解析 `--mode=readonly`、`--mode=tn10` 或 `--mode=mainnet`；省略时为 readonly。
2. 核对账本布局投影，编译 `scripts/core/src/`，生成 `scripts/core/lib/`。
3. 加载固定合约模板与 Profile，核对来源一致性。
4. 打包 `web/app/app.mjs`，内嵌合约数据、CSS 和 JavaScript。
5. 将脚本哈希写入 HTML 的 CSP，输出 `dist/index.html` 和 `dist/build-manifest.json`。

构建输入仅为当前源码、固定合约产物、配置和工具链。构建过程不读取实验回执、测试报告、旧 HTML 或外部站点，不包含测试或部署步骤。

所有模式共用输出目录：需要保留多个模式时，将构建结果复制到各自的发布位置。不要把不同构建的 HTML 和 manifest 混用。

## 修改核心与合约

核心库生成文件不要手改：修改 TypeScript 后运行 `npm run build:core` 或完整构建。独立 `npm run check:core` 只比较生成文件一致性。

`contracts/ledger-layout.json` 是布局来源。修改布局、模板或合约字节会影响 Profile 身份，需要完成合约设计及对应编译/验证流程；HTML 构建不能批准新的 Profile，也不会改写固定合约产物。

## 测试与发布

先构建，随后针对对应产物运行所需测试，再独立部署。测试结果应记录源码版本、HTML 哈希、网络、操作范围和实际结果；不能把历史结果附到新的产物上。manifest 只记录构建事实，不记录测试通过或上线批准。

当前没有配置自动化测试脚本。浏览器行为、钱包集成和链上实验需要各自的测试环境；真实交易仍须限定网络、专用钱包、范围与费用。构建不签名、不广播。

将 `dist/index.html` 部署到 HTTPS 静态站点即可提供页面。节点与Indexer端点由网页配置；页面缓存及交易记录按网络隔离。项目不绑定特定站点、服务器目录、Git远端发布服务或本地推送钩子。

## 本地文件

`node_modules/`、`dist/`、生成的 `scripts/core/lib/`、环境文件、钱包、参考源码和测试输出列入 `.gitignore`。不要提交密钥、钱包或真实实验凭据。
