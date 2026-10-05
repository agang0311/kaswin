# Kaswin F3.2 / V2 资料入口

本次整理的是 **Testnet 10 固定F3.2合约 + V2单文件网页**，不是旧V1与新F3.2的混合发布，也不是生产安全认证。

## 阅读顺序

1. [分层/发布边界](PUBLICATION.md)：为何分开合约、脚本与视觉，以及旧资料处理。
2. [合约](../../contracts/f3.2/README.md)：源码、linked产物、Profile与pins。
3. [链外核心](../../packages/f3.2-core/README.md)：状态/交易/证明的13模块闭包。
4. [网页](../../apps/kaswin-v2/README.md)：构建、测试、脚本/视觉目录。
5. [架构材料](ARCHITECTURE.md)：25问、14项材料、8项审查和REST/端点/本地化增量。
6. [固定来源](SOURCES.md)、[验证与未验证边界](VALIDATION.md)、[单文件交付](../../releases/kaswin-v2/README.md)。

## 网页使用

直接下载单HTML可离线打开界面；读取实时轮次/交易仍需节点、Indexer和相应浏览器权限。默认：

- 节点 `wss://la.cd311.cn/wrpc`（JSON wRPC）。
- Indexer `https://la.cd311.cn/indexer`。
- 设置允许自定义 `ws/wss`、`http/https`，有效地址可保存，不强改协议；“测试连接”不等于“保存”。
- 顶部齿轮为设置；太阳切浅色、月亮切深色；EN/中文保留手动语言选择。
- 真实时间戳按浏览器/设备时区显示GMT偏移，页脚给IANA时区；切语言不换时区。

如需本地静态服务，只在**仅放交付HTML的专用目录**运行：

```bash
python3 -m http.server 8000 --bind 127.0.0.1
```

这不是RPC代理，不能修复CORS或保证钱包注入。localhost/127.0.0.1指浏览器设备；手机访问电脑要用LAN地址并考虑明文篡改风险。file://可以进行某些HTTP/WS连接，不保证跨域/服务器Origin/扩展权限允许。

## 交易与存储边界

- 页面只提供TN10/TKAS操作，KasWare必须逐笔批准；金额bigint/十进制字符串，单笔费用上限0.5TKAS。
- Submitted ≠ Accepted，区块包含 ≠ selected-chain接受。Indexer是发现/候选/缓存，不是资金与接受裁判。
- REST在旧UNKNOWN且节点未查明时备查：完整节点复验通过才写ACCEPTED；裁剪等情况下最多标“已接受·REST”，底层UNKNOWN及输入占用不变，不授权后续动作。
- 历史裁剪/PASS-A材料缺失仍会阻断某些构建；换端点或英文UI不能解除。
- 同origin保留原journal/锁。换GitHub Pages或其他域名会隔离本机记录，不能因此重发旧UNKNOWN；不要清除站点数据。
- 发布源码并不等于已经部署GitHub Pages，本次没有创建新站点、节点或代理。
