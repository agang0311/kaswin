# TN10 Rolling Sidecar Indexer

状态：`SOURCE_IMPLEMENTATION / NOT_RUN`（切换到 TS 核心入口后的版本尚未运行测试、尚未启动服务、未部署）。

[English](README.md)

本目录实现独立的 TN10 Rolling 只读索引 sidecar，使用独立持久化目录（默认 `var/rolling-indexer`），不改动现有 Rust V2.0.2 KCI 接口或 `/var/lib/kci*/events.*.sqlite`。

## 组成

- [config.mjs](config.mjs)：CLI 参数解析、回环绑定限制（`127.0.0.1:18212` / `ws://127.0.0.1:18210`）、限流与尺寸边界。
- [store.mjs](store.mjs)：单写入者进程锁（`writer.lock`）、`FileArchive` 封装、原子持久化游标/轮次索引/`txid -> cid`/区块接受索引与导出元数据（支持重组回滚）。
- [scanner.mjs](scanner.mjs)：只读连接 TN10 节点，通过 `getVirtualChainFromBlockV2`（Full）发现与追踪 Rolling 轮次，经 `RollingNodeAdapter` 强制 100 DAA 深度后再提交；遇到 `removedChainBlockHashes` 按后代优先顺序回滚。
- [service.mjs](service.mjs)：只读 HTTP 服务（仅 `GET`/`HEAD`/`OPTIONS`，无公网写入口、无密钥/签名/广播），支持限流、并发限制与安全错误码。
- [server.mjs](server.mjs)：CLI 启动入口；被 import 时不自动监听。

## 接口

根路径 `/tn10/rolling/v1/{profileId}`（同时提供 `/v1/rolling/{genesisHash}/{profileId}` 与 `/v1` 别名）：

- `GET /info`：返回 `schema`、`network`、`genesisHash`、`profileId`、`status`（`UNVALIDATED`）、`readOnly`、`cursor`、`revision`、`stale`、`lastPollAt`、`lastSuccessAt`、`lastError`、`roundsCount`。
- `GET /rounds?cursor=&limit=`：分页列出已索引轮次摘要（金额均为十进制字符串，同时返回 `next` 与 `nextCursor`）。
- `GET /rounds/{cid}`：轮次详情、当前 `manager` / `frozen` / `summary` 与 `head` 证据。
- `GET /rounds/{cid}/export`：返回 `{ schema, network, genesisHash, profileId, cid, status, revision, head, roundText, terminalProof }`，其中 `roundText` 可由 `web/rolling-tn10/round.mjs` 的 `roundFromText` 无损导入；`terminalProof` 供客户端结合节点 `acceptedAt` 与 `interpretAccepted` 独立验证终态。加 `?format=ndjson` 可输出 NDJSON 流。
- `GET /rounds/{cid}/history?cursor=&limit=`：分页读取轮次事件日志（同时返回 `next` 与 `nextCursor`）。
- `GET /txid/{txid}`：按 `txid` 查询所属 `cid` 与接受元数据。
