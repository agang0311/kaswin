# 展示层

- `index.template.html`：页面骨架、CSP 和内嵌脚本/样式占位。
- `styles.css`：布局与响应式样式。
- `views.ts`、`ui.ts`、`interaction.ts`、`format.mjs`：纯展示视图、DOM 渲染、交互绑定与格式化辅助。
- `locales/`（`schema.ts`、`zh-cn.ts`、`en.ts`、`index.ts`）与 `messages.ts`：强类型语言包抽象接口与注册表（对标 `scripts/chain/network-schema.mjs`），编译期保证多语言同构、零 DOM 正则替换。
- `icons.mjs`：图标数据。

展示层不直接连接节点或签名交易，也不独立判定 transaction acceptance。倒计时是估计，不能代替节点核验条件。
