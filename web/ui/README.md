# 展示层

- `index.template.html`：页面骨架、CSP和内嵌脚本/样式占位。
- `styles.css`：布局与响应式样式。
- `i18n.mjs`、`messages-en.mjs`：语言切换与英文翻译。
- `icons.mjs`：图标。
- `view.mjs`：纯展示辅助。
- `draw-readiness.mjs`：开奖等待进度显示。

展示层不连接钱包或节点、不生成交易、不判定acceptance。倒计时是估计，不能代替节点核验条件。构建会限制此层导入交易执行模块。
