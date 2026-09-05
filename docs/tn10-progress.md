# TN10 实测准备

2026-09-05 UTC。用户明确授权 TN10 专用钱包创建、水龙头 TKAS 与实际签名/广播测试；不包含主网、其他钱包或节点启动。

## 本轮实际结果

- 官方 SDK v2.0.1 资产 SHA256 重核为 7eaffac9cd920ef2fdf540c6e10f2a2b7761170ebc62ec57dfa0f71c64567a71，按固定 d.ts 的 PrivateKey/toAddress 接口创建独立测试密钥。
- 地址：`kaspatest:qrg05u38z50weug9f8lcws7p07fzzvfsx9ap82f0akk4gxcs0ew86qd384xyt`。测试网络前缀不区分所有测试网，后续仍须验证节点 networkId。
- 钱包位于忽略目录 wallets/，0700/0600 权限；git check-ignore 确认排除。无私钥输出或嵌入 HTML。
- https://faucet-tn10.kaspanet.io/ 普通 HTTPS 返回 403，响应 cf-mitigated: challenge；Chromium 正常打开仍为 Just a moment 验证页。未提交领取请求、未绕过验证，未获得 TKAS。
- 旧 wRPC ws://tn12-node.kaspa.com:18210 只读 getServerInfo 失败（WebSocket disconnected），不能认可为已连接 TN10。
- REST https://api-tn10.kaspa.org/info/blockdag 成功，报告 networkName kaspa-testnet-10，virtualDaaScore 562404446；这是单服务自报、瞬时观测，不是已核验广播端点或交易 acceptance 证据。
- 发现 Rust 实际安装在 /root/.cargo/bin，但当前 PATH 未包含；显式执行 cargo 1.98.0 / rustc 1.98.0 成功。修正过去笼统“Rust 缺失”结论：旧记录是 PATH 探测结果，不代表当前无法运行编译器。本轮尚未编译合约。

## 保存资料

research/tn10/ 保存公开钱包信息、REST 响应与浏览器验证页/日志。不将这些当成成功领取、合约部署、真实转账或完整生命周期证据。

## Resolver 与 5000 TKAS 入账确认

用户手动领取后，两次只读 wRPC 查询各返回 1 个 UTXO，余额 500000000000 sompi = 5000 TKAS。节点分别为 neutrino-10.kaspa.stream 与 vector-10.kaspa.green，均报告 serverVersion 2.0.1、networkId testnet-10、isSynced=true、hasUtxoIndex=true。这是两个端点的一致 UTXO 观测，不证明运营方独立、全局最终性或抽奖合约可用。公开原始结果保存 research/tn10/rpc-balance-*.json；没有读取密钥或花费测试币。

参考 aspectron/kaspa-resolver 固定提交 91d811b30d2fd18d1c5df51524a5a2e694ef9e38。实际 resolver URL 依据官方 rusty-kaspa cfafeb4… 的 rpc/wrpc/client/Resolvers.toml 与 src/resolver.rs（v2/kaspa/{network}/{tls}/wrpc/{encoding}）核对。官方 SDK Resolver.getUrl 在当前环境超时；通过系统 HTTPS 调用 eric.kaspa.stream 与 john.kaspa.red 的 TN10/tls/borsh 路径成功，再交官方 SDK 连接。tools/tn10-readonly.cjs 保留 SDK 自动解析与环境变量端点回退，节点身份仍强制核验，不把解析结果当成信任证明。

首次 RPC 余额适配误用了 e.utxoEntry.amount，报错后按固定 SDK UtxoEntryReference 的 e.amount 修正并复跑通过；没有将错误结果记录为余额验证。

## 尚未完成（更新）

固定合约工具链编译/VM、公平随机与恢复协议、全流程真实交易。资金与两条只读 wRPC 已确认；SDK 内置 resolver 的环境超时仍需在浏览器集成时处理。不能将 TKAS 转账冒充完整抽奖合约测试。
