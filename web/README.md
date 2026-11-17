# 网页

- `app/`：应用入口（`app.ts`）、运行时桥接（`bridge.ts`）、类型定义、本地设置与分享辅助。
- `ui/`：HTML 模板、样式、视图渲染（`views.ts` / `ui.ts`）、交互、翻译与图标。

主入口为 `app/app.ts`，使用 `scripts/` 中的运行时模块。执行根目录的 `npm run build` 将 HTML、CSS、打包后的 JavaScript 和固定合约数据内嵌生成 `dist/index.html` 与 `dist/build-manifest.json`，浏览器无需下载运行时 SDK。

构建模式、测试与部署说明见[开发说明](../docs/DEVELOPMENT.md)。
