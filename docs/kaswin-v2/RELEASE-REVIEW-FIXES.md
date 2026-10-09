# 发布文件夹复审修复（2026-10-09）

范围：发布校验、测试可移植性、UI状态和文档；不改SIL、Profile、核心预算、SDK或共识pin，不签名广播、不重新运行VM。本次不是新的Covenant设计或安全上线批准。

## 五项修复

1. `tools/stage-release.mjs`：在写dist前验证manifest中全部构建输入SHA256，拒绝缺失、漂移、非法/越界路径；核对单个内联应用脚本与精确CSP哈希。新增13套CLI负例，失败保留旧dist。不是对恶意同时篡改源码/manifest的数字签名保证，也不重新建立acceptance。
2. 默认公共审计移除对原始历史回执的依赖，11由 `npm run test:receipts` 显式调用。缺材料仍硬失败，不SKIP；候选构建门完全不放宽。干净副本另发现09依赖仓库外PASS_A文件，改用已有公开fixture（仅合成JS向量）。SDK仍需按固定来源单独取得。详见[EVIDENCE-ACCESS](EVIDENCE-ACCESS.md)。
3. 根/应用/发布/文档/合约/核心入口统一当前可交易TN10候选口径。PUBLICATION及审计harness旧说明明确标历史。`VALIDATION`新增本轮导航，旧证据不删除、不贴成新验证。
4. 广场保存当前页面的其他Profile面板展开状态；搜索/重绘不意外关闭，初始仍收起。浏览器用模拟列表验证1360/390/320宽度，兼测100,000默认和七项参数刷新恢复，无真实钱包。
5. 中英文费用文案修正为377笔历史样本总计7.80619784 TKAS、平均约0.020706 TKAS；明确不预测未来费率、不代表完整覆盖。整数汇总回归绑定公开摘要。

## 当前交付

- HTML：343750字节。
- SHA256：`71f33c0f7510158c3e368561d702522096dece9d3aca4996c6805d411335427f`。
- release/dist一致，旧b627d6e2版本由构建器自动归档。
- `releaseMode=TN10_ACCEPTANCE_CANDIDATE`、`tradingEnabled=true`、`publicLaunchApproved=false`、`budgetProfileId=null`。
- 原始377回执、TN10摘要、SIL、核心库及预算pin未变；当前仍不批准公开安全上线。

## 实际验证（S/L）

| 项目 | 结果与限度 |
|---|---|
| 候选构建 / 发布暂存 | PASS；14个TS源码→42文件一致，构建时原始回执门通过；不新增网络或VM证据 |
| 应用单测 | 68 PASS、1 TODO、0 FAIL；TODO为预算评审，不写成69项全通过 |
| 公共审计 | 10套PASS；包含发布CLI负例与费用整数汇总 |
| 原始历史回执门 | 独立 `test:receipts` PASS，377笔本地历史材料一致；未重新查询链上接受 |
| 浏览器UI | 5个脚本PASS；布局/展开搜索/持久参数/双语/本地明文传输/端点配置，无真实广播 |
| 干净文件副本 | 无references或原始回执；显式提供已安装固定dev依赖和官方SDK路径。应用/公共audit/build:pages通过；test:receipts及可交易重建因缺材料按预期失败 |
| 知识库基础回归 | examples109 PASS；SDK2.0.1离线加载PASS，无节点连接 |
| 链接与差异检查 | 知识库check-links：108份Markdown、452本地链接、0错误；发布库85个内联本地链接目标存在（未核验全部锚点/外链）；git diff --check通过 |

本轮未执行合约重编、SCRIPT_VM、真实KasWare E2E、TN10广播或新acceptance复验。历史VM证据独立评审仍待完成，旧预算377回执不冒充新预算网络执行。

## 部署观察（HTTP文件，不是链上验收）

提交前回读：
- `https://cd311.cn:888/www/kaswin-v2.html`：HTTP200，343750字节，SHA为本轮71f33c0f…；既有软链接随dist更新。
- `https://win.kaspay.top/`：HTTP200，仍为历史b627d6e2…、343269字节。推送后的Pages部署须另回读，不以Git成功冒称已上线。
