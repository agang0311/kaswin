# TN10 Rolling Sidecar Indexer

Status: `SOURCE_IMPLEMENTATION / NOT_RUN` (the latest TS-core import migration has not been run/tested in this session; no live service started or deployed).

[中文文档](README.zh-CN.md)

This directory implements a standalone, read-only TN10 Rolling sidecar indexer using its own isolated data directory (default `var/rolling-indexer`). It does not modify the Rust V2.0.2 KCI endpoints or `/var/lib/kci*/events.*.sqlite`.

## Modules

- [config.mjs](config.mjs): CLI argument parsing, loopback binding restrictions (`127.0.0.1:18212` / `ws://127.0.0.1:18210`), rate limits, and size bounds.
- [store.mjs](store.mjs): Single-writer process lock (`writer.lock`), `FileArchive` wrapper, atomic persistence for scan cursor, rounds index, `txid -> cid` mapping, block-acceptance index, and export metadata (with reorg revert support).
- [scanner.mjs](scanner.mjs): Read-only TN10 node scanner discovering and tracking Rolling rounds via `getVirtualChainFromBlockV2` (`Full`), enforcing 100-DAA depth via `RollingNodeAdapter` before committing, and reverting `removedChainBlockHashes` in descendant-first order.
- [service.mjs](service.mjs): Read-only HTTP service (`GET`/`HEAD`/`OPTIONS` only; no public write endpoints, no keys, no signing, no broadcast) with rate limiting, concurrency bounds, and safe error codes.
- [server.mjs](server.mjs): CLI entrypoint; importing this module starts no listener or RPC connection.

## Endpoints

Base path `/tn10/rolling/v1/{profileId}` (with `/v1/rolling/{genesisHash}/{profileId}` and `/v1` aliases):

- `GET /info`: Returns `schema`, `network`, `genesisHash`, `profileId`, `status` (`UNVALIDATED`), `readOnly`, `cursor`, `revision`, `stale`, `lastPollAt`, `lastSuccessAt`, `lastError`, and `roundsCount`.
- `GET /rounds?cursor=&limit=`: Paginated list of indexed round summaries (all amounts as decimal strings; returns both `next` and `nextCursor`).
- `GET /rounds/{cid}`: Round detail, current `manager` / `frozen` / `summary`, and `head` evidence.
- `GET /rounds/{cid}/export`: Returns `{ schema, network, genesisHash, profileId, cid, status, revision, head, roundText, terminalProof }`, where `roundText` is derived from accepted state for `roundFromText` in `web/rolling-tn10/round.mjs` and `terminalProof` allows independent verification against `acceptedAt` + `interpretAccepted`. Supports `?format=ndjson`.
- `GET /rounds/{cid}/history?cursor=&limit=`: Paginated round event history (`next` and `nextCursor`).
- `GET /txid/{txid}`: Looks up `cid` and acceptance metadata by `txid`.
