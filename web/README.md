# 网页

- `app/`：应用交互、网络选择、轮次目录与操作编排。
- `ui/`：HTML模板、样式、翻译、图标与展示辅助。

入口为 `app/app.mjs`，使用 `scripts/` 中的运行时模块。执行根目录的 `npm run build` 将HTML、CSS、JavaScript和固定合约数据打包到 `dist/index.html`，浏览器无需下载运行时SDK。

构建模式、测试与部署说明见[开发说明](../docs/DEVELOPMENT.md)。
