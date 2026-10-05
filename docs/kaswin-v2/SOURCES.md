# 固定来源、版本与再分发边界

整理日：2026-10-05；此日是文件复核/发布整理日期，不是网络激活证明。原始来源获取日：SDK/rusty基线2026-09-05，SilverScript正式版补核2026-09-17，F3.2构建及实验2026-09-30，REST/V2增量2026-10-04至05。

| 对象 | 固定版本/提交 | 本次用途/等级 |
|---|---|---|
| SilverScript | [v1.0.0 / 3ed973335b59269293564805cc2c58a14595ec03](https://github.com/kaspanet/silverscript/tree/3ed973335b59269293564805cc2c58a14595ec03) | S：锁定三份既有linked编译产物；未重新编译/VM |
| rusty-kaspa基线 | [v2.0.1 / cfafeb4c093fa37a303f1b9f19c58f986b870ce3](https://github.com/kaspanet/rusty-kaspa/tree/cfafeb4c093fa37a303f1b9f19c58f986b870ce3) | S/L：交易、covenant、mass/SDK对照基线，不宣称当前节点全接口兼容 |
| SilverScript内部Rust依赖 | [a41a333b08848f41bf737b72592e463a6011b8ac](https://github.com/kaspanet/rusty-kaspa/tree/a41a333b08848f41bf737b72592e463a6011b8ac) | 与发行节点基线不同，不能混称 |
| 既有LA节点 | [v2.1.0 / 01b532e8b553523216471682649693af92f0fd16](https://github.com/kaspanet/rusty-kaspa/tree/01b532e8b553523216471682649693af92f0fd16) | 原V2只读服务报告版本；本次不升级/部署节点 |
| REST实现 | [c638eb5cceff30591cd9b35b241752878a2cfad0](https://github.com/kaspa-ng/kaspa-rest-server/tree/c638eb5cceff30591cd9b35b241752878a2cfad0) | GET transactions DTO参考；REST证词非共识证明 |
| Node.js | 22.23.2（要求22+） | L：构建/测试运行器 |
| TypeScript / esbuild | 5.8.3 / 0.28.2 | L：固定源码编译一致性及HTML打包 |
| Playwright / ws | 1.63.0 / 8.21.3 | L：Chromium/本地模拟传输，不是运行时依赖 |

## 可选测试SDK

[官方release资产 kaspa-wasm32-sdk-v2.0.1.zip](https://github.com/kaspanet/rusty-kaspa/releases/download/v2.0.1/kaspa-wasm32-sdk-v2.0.1.zip)。SHA256：

```text
7eaffac9cd920ef2fdf540c6e10f2a2b7761170ebc62ec57dfa0f71c64567a71
```

显式下载、核对SHA后，按压缩包结构解压到被忽略的 `references/kaspa-wasm32-sdk/`；目标是 `nodejs/kaspa/kaspa.js`，package.json必须是2.0.1。也可设置`KASPA_SDK_PATH`绝对路径。测试不得误装名称相似的npm包。本次不随Git分发SDK/WASM、完整上游源码或node_modules。

## 可追溯性

`source-map.json`记录从工作快照迁入的源/目标文件及两边SHA；合约和核心TS/JS不变，模块import/fixture路径与图标提取单独标注。`contracts/f3.2/pins.json`和`releases/kaswin-v2/build-manifest.json`绑定实际构建输入。网页视觉源与公共测试fixture仅按白名单复制，不从钱包或浏览器库导出。

本次没有给原项目新增/变更软件许可证，也不将上游ISC许可证自动套到全部原创代码。SilverScript与rusty-kaspa许可证以各固定提交的LICENSE为准；npm开发工具采用其包内许可证。发布资料不是独立法律/安全审计。
