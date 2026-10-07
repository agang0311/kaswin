# Kaswin V2 链上源码候选（目录暂保留 f3.2）

**当前为固定V2 Profile `206d4ec7072727ae3291726f19c82293b38340a5a7de05d306cf105c4206a9c3`。** 2026-10-07审查曾隔离重编三模板并与pins一致；后续整改不改SIL/artifact/ABI。`budgetProfileId`恢复null，因为完整目录及退款游标预算证据未闭合；正式发布仍BLOCKED。本轮没有VM/链上测试，历史三流程不能覆盖全部资源边界。

| 文件 | 责任 |
|---|---|
| [src/open.sil](src/open.sil) | BUY/CLOSE；唯一链上规范零票初态CID认证；写死SEALED/REFUNDING模板哈希 |
| [src/sealed.sil](src/sealed.sil) | 原子开奖派奖或300 DAA超时转REFUNDING；只含REFUNDING前向哈希 |
| [src/refunding.sil](src/refunding.sil) | 分批退款/终局退押金；无foreign依赖 |
| [tools/linking.mjs](tools/linking.mjs) | 本地V2依赖/源码/artifact/ABI/Profile溯源加载，拒绝旧产物贴标签 |
| [tools/build-v2.mjs](tools/build-v2.mjs) | REFUNDING→SEALED→OPEN链接，只写新候选目录，不安装或发布 |
| [tools/check-compile.mjs](tools/check-compile.mjs) | 对已安装本地V2 bundle做逆拓扑重编比对，不支持旧部署 |

Header=228B、Magic=KW20、目录从228起；OPEN 8参数，SEALED/REFUNDING 6参数。零票初态使用PUSHDATA1 `4c e4`，首条记录264B使用PUSHDATA2。全零模板哈希仅为待注入占位；不能直接用silverc编译模板后发布。

固定SilverScript v1.0.0：`3ed973335b59269293564805cc2c58a14595ec03`，binary SHA256 `81de9aa4157dbde3633ebab629e86c5975770fc13ee2d2093e52d7f725616a00`。不升级工具链。

## 版本及发布顺序（执行验证须另获授权）

1. 固定TypeScript 5.8.3重新生成核心lib，不手改生成物。
2. `node contracts/f3.2/tools/build-v2.mjs /absolute/silverc /absolute/new-bundle-directory`。
3. 人工审查源码、依赖、ABI、产物与Profile，再安装候选bundle；脚本不自动安装。
4. V2真实VM正负例、mass/fee/预算校准；评审后才可设置对应的budgetProfileId及budgetEvidenceSha256。`tools/budget-gate.mjs`还核对编译器/共识pin、protocol/builders源码hash、日志hash、动作／目录／退款游标覆盖与实际默认预算；不接受只改Profile字符串放行。
5. 网页构建与最小回归。网络实验另行授权。

只有编译成功不代表VM、最大目录或TN10 acceptance通过。[源码状态与验证计划](../../docs/kaswin-v2/V2-SOURCE-STATUS.md)优先于旧整理文档中的历史结论。
