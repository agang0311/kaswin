# Rolling TN10 实验页：生产交接

交付对象：把 rolling 网页放到面向用户的环境里的部署方。**这不是主网上线，也不是“已验证”发布**：Profile 仍是 `UNVALIDATED`，只在 Testnet 10 使用，TKAS 无真实价值。

按 [TN10-DEPLOYMENT.md](TN10-DEPLOYMENT.md) 的约定，本机（`cd311.cn:888/www/rolling-tn10/`）上的页面、节点代理和预算服务只供测试；交付物是网页，它依赖的服务由生产方单独部署。本文件不改变本机任何对外配置。终端用户说明见 [TN10-USER-GUIDE.md](TN10-USER-GUIDE.md)。

## 1. 交付物

| 项 | 值 |
|---|---|
| 页面 | `dist/rolling-tn10.html`（单文件，1,054,160 字节；“更多”改为普通按钮打开操作弹窗，分享与导出使用大触摸按钮） |
| sha256 | `3f2dda834ce509d010f33f557911370ee886fa63cd2d27dc88a9ac17b72d87e0` |
| 清单 | `dist/rolling-tn10.manifest.json`：网络、创世、Profile ID、引擎哈希、esbuild 与 TypeScript 版本、813 个模块图文件及模板/样式/tsconfig 等构建输入的 sha256 |
| 网络 / 配置创世 | `testnet-10`，预设创世 `f896a3034873be1739fc4359236899fd3d65d2bc94f9780df0d0da3eb1cc4370`；来源配置与RPC身份核对分开记录，当前节点不能直接回读该历史header |
| Profile | `b56bcd9cb654610b238a32bae25c41128ebd2837cc7a91b3ea835f8a102fc4e5`，`UNVALIDATED` |
| 预算引擎 | `kaspa-txscript 2.1.0` 运行器，二进制 sha256 `e773577d46c755c291726ebe80d3b1f94615a20f604d8f681636559f3ba2d5b8`（`engine-pin.json`） |

本次“更多”显示修复：构建（含内置类型与依赖图门）通过，公开 HTTPS 页面回读与上表哈希一致。旧页面与清单归档为 `dist/archive/rolling-tn10-2f4f1fb8.*`。用户报告上一版安卓显示异常；现复用页面操作弹窗，尚未在安卓实机复测。按用户要求，单元、浏览器、VM 与链上测试均 **NOT_RUN**。此前只读回读 `/www/rolling-tn10/api/info` 返回 HTTP 404，详情见 [VALIDATION.md](VALIDATION.md) §10；本次仅回读页面。

2026-11-15 核对（历史快照）：当时 `dist/` 页面哈希等于清单和本机线上字节。重新构建前须核对清单里的构建输入（`scripts/core/lib` 是生成物，不在版本库里）。用户可自行验证：`curl -s <页面地址> | sha256sum` 应等于上表。

主网页 `dist/index.html`（V2.0.2）与本交付无关，不要改它。

## 2. 需要的三个部分

页面是纯前端；私钥只在浏览器内存里。它依赖：

1. **预算/引擎服务**（`experiments/rolling/tn10-service.mjs`）：同时负责提供页面。接口：`GET /`、`GET /api/info`、`POST /api/measure`、`POST /api/verify`。只读：不持有密钥、不签名、不广播、不碰节点。
2. **TN10 节点 wRPC（JSON）**：页面通过 WebSocket 连接。
3. **引擎二进制** `kaswin-rolling-vm`：服务每次执行都会校验它的 sha256 是否等于 `engine-pin.json`，不符则 503（`ENGINE_BINARY_PIN`）。

### 地址布局

页面按所在位置推导默认地址，最省事的做法是沿用本机布局：

```
https://<域名>/www/rolling-tn10/            页面与 /api/*（反代到服务 127.0.0.1:8792）
wss://<域名>/www/rolling-tn10/node          节点 wRPC JSON（反代到节点回环端口）
```

默认值的推导（`web/rolling-tn10/app.ts`）：页面是 https 时，节点默认总是 `wss://<origin>/www/rolling-tn10/node`（与页面放在哪个路径无关）；页面是 http 时默认 `ws://127.0.0.1:18210`。服务地址只有在页面路径以 `/www/rolling-tn10/` 开头时才默认 `<origin>/www/rolling-tn10`，否则默认 `<origin>`。布局不同时，用户要手动改这两个字段。

### 反代参考（本机 Caddy，已在运行）

```
handle /www/rolling-tn10/node { rewrite * /; reverse_proxy 127.0.0.1:<节点 json wRPC 端口> }
redir /www/rolling-tn10 /www/rolling-tn10/ 308
handle_path /www/rolling-tn10/* { reverse_proxy 127.0.0.1:8792 { header_up Host 127.0.0.1:8792 } }
```

`header_up Host 127.0.0.1:8792` 必须保留：服务只接受回环 Host（否则 `HOST_NOT_ALLOWED`），并要求浏览器 Origin 等于 `--public-origin`。

### 服务启动

```
KASWIN_VM_BIN=<二进制路径> node experiments/rolling/tn10-service.mjs \
  --port=8792 --host=127.0.0.1 --max-concurrent=2 --public-origin=https://<域名[:端口]>
```

- Node ≥ 22。服务只允许监听回环地址。`--public-origin` 必须是 `https://` 的精确 origin。
- 本机的 systemd 单元（`/etc/systemd/system/kaswin-rolling-tn10.service`）可直接当模板：`NoNewPrivileges`、`ProtectSystem=strict`、`PrivateTmp`、`MemoryMax=1G`、`TasksMax=64`、`UMask=0077`、`Restart=on-failure`。
- 服务已有的限制：请求体 1.5 MB；全局并发 2（超出回 429 `BUSY`）；引擎单次 40 s 超时并杀整个进程组；URL ≤256；Host/Origin 校验；响应带 `no-store`、`nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`；页面自带 CSP（脚本按哈希放行）。

### 节点要求

- Rusty Kaspa 2.1.0，`--testnet --netsuffix=10 --utxoindex`，已同步，JSON wRPC 监听在回环地址。
- **不要加 `--unsaferpc`**。本机节点没有加。
- 页面连接时会检查 testnet-10、同步状态和 UTXO 索引。
- 页面用到的 RPC（我从源码 grep 到的）：`getInfo`、`getServerInfo`、`getBlockDagInfo`、`getSink`、`getSinkBlueScore`、`getBlock`、`getVirtualChainFromBlock`、`getVirtualChainFromBlockV2`（Full接受与已花输入上下文）、`getUtxosByAddresses`、`getMempoolEntry`、`getMempoolEntriesByAddresses`、`getSeqCommitLaneProof`、`getFeeEstimate`、`getFeeEstimateExperimental`、`submitTransaction`。这个清单没有逐行对照所有调用点，不要据此做严格白名单而不先试用。

### 部署用的文件

整个工作树里这些目录一起带上，不要裁剪：`experiments/rolling/`（含已生成的 `artifacts/`、`generated/`）、`scripts/`（含已生成的 `scripts/core/lib/`）、`web/rolling-tn10/`、`contracts/pins.json`、`dist/rolling-tn10.html`。这些生成物在 `.gitignore` 里，**全新克隆里没有**，不能直接克隆部署。

引擎二进制请直接拷贝已固定哈希的那一份（本机路径 `references/toolchains/rolling-vm-target/release/kaswin-rolling-vm`）。`engine-pin.json` 自己声明它是身份固定，不是可复现构建证明，所以重新编译不保证得到同一个哈希。源码在 `experiments/rolling/vm/`（`Cargo.lock` 已固定，`rust-version = 1.94.0`）。

## 3. 对外暴露面与建议

| 暴露点 | 现状 | 建议 |
|---|---|---|
| `/node`（wRPC） | 本机是直通反代，无限流 | 在边缘做每 IP 的连接数/请求限流；节点自带 `--rpcmaxclients` 上限（默认 128）。节点未开 `--unsaferpc`，Shutdown/AddPeer/Ban 等不可用 |
| `/api/measure`、`/api/verify` | 全局并发 2，不分 IP | 同样在边缘按 IP 限流，否则单个客户端能占满两个槽，让其他人收到 429 |
| 页面 | 单文件，CSP 的 `connect-src` 为 `https: wss: http: ws:`（节点地址可由用户改） | 在边缘加 HSTS；放在独立 origin，不要与带登录态的页面同源 |
| 私钥 | 只在浏览器内存，读取后清空输入框，不写盘/不上传 | 用户仍是在你的页面里粘贴私钥：务必公布页面哈希，页面只用 TN10 一次性私钥的提示不要删 |

Caddy 核心没有限流功能，要用插件、nginx `limit_req`/`limit_conn` 或云 WAF。

## 4. 发布口径

**可以说**：Testnet 10 实验版；Profile `b56bcd9c…c4e5` 为 `UNVALIDATED`；已在 TN10 实链上跑通完整生命周期；可用于测试，TKAS 无真实价值。

**不能说**：已验证、主网就绪、并发已验证、可存放真实资金。

证据摘要（详见 [TN10-EVIDENCE.md](TN10-EVIDENCE.md)、[VALIDATION.md](VALIDATION.md)）：

- 历史基线截至2026-11-14为13个run/1620笔、约36TKAS；当时两轮sales已在后续真实收尾，新增5笔单列。该历史表不代表本轮累计。
- 当前ea23092b六生命周期547笔/520票、12.16600100TKAS；另单笔BUY买3票的5笔PAID。每笔独立节点复核≥100DAA并保存实际fee/mass。
- 17片真实派奖4359笔PAID/76.47321264TKAS，实际PAY_OLD16+1再PAY_SELF；3片退款796笔REFUNDED/22.17109236TKAS。两轮5155笔另经独立实际节点适配器/索引器/归档回放全部通过，快照不构成终局性证明。
- 三买家、并发CLOSE、BUY对CLOSE及两个不同p2pId节点均接收冲突交易已有有限实测；所选本机链唯一赢家。当前页面管理输入竞争/重买/旧报价6笔、同钱包资金竞争/排除/旧报价14笔，均结清且逐笔≥100DAA。原失败、查询回滚补证及原签名恢复见TN10-EVIDENCE§16。
- 离线122/122、资金runner5/5、真实Chromium交互/故障回归11/11通过；多分片4项模拟控制器与3项固定真实VM版本、只读查询重试2项分别通过。模型节点接受不作为真实TN10证据。

**未覆盖**：TIMEOUT由用户手测；超出观测深度的重组恢复、其他并发/更高负载与所有参数组合、Rolling外部钱包（KasWare/Kastle）、主网及生产审批仍未完成。离线发现的33条本地尾批公共地址资源边界未在TN10按同形态重跑；已有显式资金辅助回退。多用户共享轮次依赖公开状态导出/导入，页面不能自动索引任意轮次的最新状态。

## 5. 上线前清单

| 项 | 状态 |
|---|---|
| 页面哈希 = 清单 = 本机线上字节 | 当前详情工具栏改动构建后已回读一致；旧版与清单先存档。本次行为测试 NOT_RUN |
| 当前构建的真实浏览器轮次与双买家恢复 | 六场景547笔、单次3票变体5笔、管理竞争6笔、资金竞争14笔和真实双节点竞争4笔均已结清/逐笔≥100DAA。三买家/其他动作及失败恢复另见[补测记录](REMAINING-COVERAGE-20261115.md)，历史§12不替代当前构建结果 |
| 在**另一台主机**按本文部署并冒烟（服务 `/api/info`、页面加载、节点连通、一次 GENESIS→终局） | **NOT_RUN** |
| 边缘按 IP 限流（`/node`、`/api/*`） | **未做**，需部署方决定 |
| 公开声明与支持渠道 | **未做**，需你确认口径 |
| 用户获取 TN10 测试币的途径 | **未覆盖**，本交付不提供水龙头 |
| 节点容量与监控（同步状态、磁盘、`/api/info`、服务日志） | **未做**；本机节点由 `kaspad-tn10.service` 托管，服务由 `kaswin-rolling-tn10.service` 托管 |

## 6. 运维与回滚

- 健康检查：`curl -s https://<域名>/www/rolling-tn10/api/info`（应含 `"readOnly":true`、`"engine":{"configured":true,…}`）；页面首页应显示节点“已连接”“服务就绪”。
- 日志：`journalctl -u kaswin-rolling-tn10`。服务不转发原始引擎/错误文本，只返回固定错误码。
- 回滚：停服务并删除反代规则即可；**链上没有需要回滚的东西**。用户的资金锁在 covenant 里，退款/派奖分支任何人都可以执行，所以页面下线后，换一个部署或用命令行执行器（`tn10-run.mjs`）仍能继续任何已导出的轮次。因此要提醒用户随时导出 round state：清除浏览器数据会丢失本地轮次记录。
- 本机回滚备份：`/etc/caddy/caddy_routes.inc.before-rolling-tn10`。
- 页面回滚：`dist/archive/rolling-tn10-b51c9895.html` 与同名 `.manifest.json` 是本次发布前的页面和清单（后台核对/按钮忙碌修复，已完成 1–6 网页场景）。回滚时把两者分别复制回 `dist/rolling-tn10.html` 与 `dist/rolling-tn10.manifest.json`，服务无需重启。更早的 `75c0ca4c`、`38d689ab` 等版本同样保留在 `dist/archive/`。

## 7. 变更前提

改动页面或服务后，必须重新构建（`node build/rolling-tn10.mjs`，自带浏览器依赖图闸门）、重跑页面与服务测试，并在真实浏览器里走一遍，再更新本文件的哈希。`scripts/rolling/core/` 的独立TypeScript核心已单独做过类型构建，尚未接入页面；行为等价性为NOT_RUN，不属于本次实链覆盖。
