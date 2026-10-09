# 网页脚本：行为与适配

- `app.mjs`：入口、DOM事件、当前表单/报价、动态页面片段和用户操作编排。不是链上合约；本次不以完整MVC重写为目标。
- `engine2.mjs`：V2有界离链游标恢复、严格输入占用/归档、REST定位后的节点复验。
- `rest.mjs`：仅txid的无凭据只读GET、字段比对、外部证据生命周期。REST显示接受不是底层ACCEPTED。
- `endpoints.mjs`：LA默认、一次性旧端点迁移、明文连接使用提示。
- `shared/progress.mjs`：显示哪个轮次视图（Indexer/节点核验/本机已接受/缓存）只按状态机单调进度判断，不比较不同机器的时间戳；不做信任判断。
- `shared/`：从Opus复用的固定引擎、节点、钱包、mass、PASS-A、replay、catalog与最小加密/JSON工具。保留旧数据库及锁名字是兼容要求，不代表本目录是Opus页面。

修改视觉请先看 [visual](../visual/README.md)。修改金额、动作、接受判断、签名/提交必须在脚本/核心层明确审查，不能通过翻译或CSS做出业务裁决。

安全底线：UNKNOWN不因超时/内存池不存在而重发或释放输入；只有节点selected-chain接受集合及批准交易字段完整复验才可ACCEPTED；REST外部证词只影响展示；钱包返回交易必须全字段核对和签名验证；普通费用上限0.5TKAS为项目策略。
