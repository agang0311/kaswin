# 固定来源与兼容边界

日期 2026-09-05 UTC。研究底座在本机 /root/kaspa，完整来源记录在该工作空间 sources.md。新项目尚未选定兼容工具链。

| 来源 | 固定版本/提交 | 当前证据 |
|---|---|---|
| [旧 Kaswin](https://github.com/agang0311/kaswin-archived/tree/a69f08858ed3ceffdb7579a5a62aa2a293932de9) | a69f08858ed3ceffdb7579a5a62aa2a293932de9 | 局部源码/文档核对，未本机复现 VM |
| [原 Raffle](https://github.com/agang0311/kaspa-raffle-static-v0/tree/c68abf90c85989aeec514ac661bc4e056da07139) | c68abf90c85989aeec514ac661bc4e056da07139 | 完整核心合约与局部客户端阅读，未 VM |
| [rusty-kaspa](https://github.com/kaspanet/rusty-kaspa/tree/cfafeb4c093fa37a303f1b9f19c58f986b870ce3) | v2.0.1 / cfafeb4c093fa37a303f1b9f19c58f986b870ce3 | 研究底座来源；不证明目标节点激活或新协议兼容 |
| [SilverScript](https://github.com/kaspanet/silverscript/tree/c7d17a15ac88610d013ec9ffffa9520aeb69929b) | c7d17a15ac88610d013ec9ffffa9520aeb69929b | 实验快照，尚未选作本项目编译器 |

旧 Kaswin 依赖不同 SilverScript 提交及自有补丁，不能直接复用其产物。源码核对、基础离线测试、真实编译/VM、目标网络集成分别记录，不混称验证通过。新增 API/语法结论须带固定上游链接和验证范围。
