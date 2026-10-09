# Kaswin V2 单文件交付

## 当前产物

当前 `index.html` 为 **TN10_ACCEPTANCE_CANDIDATE**：允许测试资金交易，`publicLaunchApproved=false`、`budgetProfileId=null`。固定 Profile `7aaf76fe5e2180070290ff984bebaef54e41093e6a77eef24f2b48fb64c159c8`。准确字节数、SHA256、构建输入与验证边界见 [build-manifest.json](build-manifest.json)。

当前不是只读版本，也不是全面安全认证。历史377笔回执、SCRIPT_VM预算实验、真实KasWare E2E各自独立；当前 Profile 的超时及256目录退款链上边界仍未完整验证。详见[根入口](../../README.md)、[VM记录](../../docs/kaswin-v2/VM-BUDGET-20261009.md)、[本轮修复/部署记录](../../docs/kaswin-v2/RELEASE-REVIEW-FIXES.md)。

## 发布与重建

```bash
npm run build:pages # 从仓库根执行，校验HTML大小/hash、精确CSP及全部inputSha256后写dist/index.html
```

Cloudflare Pages 应只发布 `dist/`，不要发布整个 `releases/` 或仓库。此步骤不需要SDK或原始回执，但只是暂存已构建产物，不等于源码重建或重新确认acceptance。

从源码重建：

- `npm --prefix apps/kaswin-v2 run build:tn10-candidate`：原始历史回执必须完整且哈希匹配，缺失拒绝；见[证据访问](../../docs/kaswin-v2/EVIDENCE-ACCESS.md)。
- `npm --prefix apps/kaswin-v2 run build:candidate`：生成禁用交易的只读候选，**会替换当前可交易产物**。
- 默认 `build`：要求独立评审的VM预算；当前仍阻断，不通过改pin绕过。

## 归档，不是部署入口

- `archive/`：旧HTML及manifest按内容哈希原样保留；有些旧版本含已知问题，不推荐打开或使用。
- `deployed-20261005.html`：历史F3.2快照，SHA256 `335fbf0485369c0b924401b7cfb0243c1deb1e2b0e049d288cdb3a89f3168003`，不作为当前版本复现或线上证据。
- 历史部署：2026-10-09 `b627d6e2…` 曾经部署至Cloudflare Pages及cd311，见[当时记录](../../docs/kaswin-v2/INJECTION-FIX-20261009.md)。新构建不能沿用该版本的线上回读结论。

旧Profile不迁移；不要清除IndexedDB或更换Origin后重发UNKNOWN。Indexer是发现层，节点复验与钱包逐笔批准不可省略。
