# 应用层

- `app.ts`：单页面应用主入口、控制器事件流、视图与网络/钱包/设置状态协调。
- `bridge.ts`：面向纯展示视图的运行时协议模块类型桥接。
- `types.ts`：应用与视图层共享的纯类型定义。
- `settings.ts`、`share.ts`：本地设置持久化与轮次分享链接辅助。
- `globals.d.ts`、`tsconfig.json`：构建注入模块声明与严格 TypeScript 检查配置。

本目录代码通过 `scripts/` 操作轮次与节点，通过 `../ui/` 渲染界面。构建说明见[开发说明](../../docs/DEVELOPMENT.md)。
