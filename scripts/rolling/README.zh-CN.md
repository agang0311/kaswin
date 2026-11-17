# Rolling 运行时

[English](README.md)

Rolling 使用独立 TypeScript 核心，固定 Profile `b56bcd9cb654610b238a32bae25c41128ebd2837cc7a91b3ea835f8a102fc4e5`，状态仍为 UNVALIDATED。当前集成范围是 Testnet 10，与 V2.0.2 主网页及其 Profile 分离。

## 核心与构建

`core/src/` 包含状态、Profile、交易、mass、接受交易解释与收款规则；`core/lib/` 是被忽略的生成物；`core.mjs` 注入 SHA-256/地址 codec，保留旧调用签名。页面及索引/节点/归档运行时接到这个入口。原六份实验 MJS 保留给 tester 做差分基线，浏览器依赖图禁止把它们混回产物。

```sh
npm run build:core
npm run build:rolling-core
npm run build:rolling
```

Rolling 网页构建会先生成独立核心，再做页面类型检查和打包；缺少基础核心声明时先生成基础核心。输出为 `dist/rolling-tn10.html` 与清单，主网 `dist/index.html` 不被替换。清单记录运行时及 TS 源码哈希。单独 import 核心入口不会自动构建；Node 工具/索引服务启动前需已有生成物。

兼容入口提供旧式 `parseFrame(module,text,trust)`、`loadCandidateProfile(texts,pins)`、`rewardReceiver(address,context)`。直接使用生成模块时仍需注入 hash/codec。运行时与基线的 ResourceLimit 是不同类，不能混用 instanceof 判断。

## 钱包

页面提供 KasWare、Kastle、测试内存私钥和公开收款地址模式。扩展需自行切到 Testnet 10，页面不自动切网。

扩展只签页面指定的普通P2PK输入，使用SIGHASH_ALL。页面核对返回交易的承诺字段、独立验签，只复制授权输入的签名，再走真实引擎、持久意图和节点提交门。扩展不负责广播。账户/网络变化撤销连接和未发送报价；已保存的未决意图仍保留原签名字节。

## 索引

`indexer/` 是 kci 会话负责的独立只读服务和数据目录，不与V2.0.2生产库共写。默认回环端口18212，见[索引说明](indexer/README.md)。网页在高级设置显式配置可访问的API；远端浏览器的127.0.0.1指向用户本机，不能当作服务器地址。

索引配置后可以发现轮次、按CID/交易ID加入，并同步其他参与者推进的状态。REST只提供候选：页面向自己的节点查询head的Full接受数据，从真实witness和已花输入重建上下文并解释交易，活动轮次另核对manager及全部frozen UTXO，终态由实际节点交易效果确认。不会覆盖本机intent/pending。索引网络读取放在单写队列外，发布前重新核对连接和本地revision，避免慢索引阻塞前台准备。

未配置索引时仍可用分享链接/文件导入。

## 验证分工

实现会话只负责实现和修复，tester负责差分、构建、VM、浏览器与回归。当前集成验证记录见[交接说明](../../docs/ROLLING-INTEGRATION-HANDOFF.md)。此前几千笔TN10实链证据保留其原产物/代码时点，不自动当作新TS接线、扩展和索引服务已经通过。TIMEOUT仍由用户手测，当前不包含主网实验。
