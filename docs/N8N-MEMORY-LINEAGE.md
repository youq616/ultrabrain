# n8n：直接来源核验

`Verify Personal Memory Source / personal_lineage` 在核对单条记忆后，额外核对其**一个直接来源**。它回答“引用的源版本、内容指纹和片段是否仍匹配”，不判断事实真假，不批准、修改或归档记录，也不递归遍历来源图。

## 明确选择与权限

凭据必须指向 source 根，并固定已经核对过的实例 UUID 和主体 SHA-256。新增 `Source Verification Project ID / lineageProject` 独立于候选、核对、确认和纠错项目配置；它不从输入 JSON 或普通 `projectId` 参数推导。选择 global-only 只允许全局；global-and-project 允许全局及凭据指定的一个项目。选中记录和直接来源都必须通过同一范围及服务器身份检查，并且都是当前主体拥有的 Agent 来源记录。共享非所有者和文档片段不在此入口的输出范围内。

节点须明确填写一个完整小写 UUID，选择范围，并打开两项默认关闭的同意：读取所选记忆，以及在存在引用时读取其直接来源。完整记录会传到适配器内存进行规范校验；本地项目/所有权检查发生在传输之后，不能替代服务器授权或阻止已经发生的传输。没有采集或写入权限要求，但真实服务器凭据仍须有读取权。

`Include Memory, Quote and Source Text` 默认关闭。只有明确开启，结果才增加记忆正文、引用片段和来源正文。即使不开启，网络仍会传输全文以校验指纹和引用。元数据与原文都可能被 n8n 历史或下游节点保存；同意开关仅表达调用者授权，不能认证真人实际审阅。

## 核验过程

先读取并完整验证选中记录。没有结构化引用时，返回 unlinked，只进行一次记录读取；这不是“内容没有来源”的证明。有引用时，验证原有九字段引用合同，读取引用中的一个来源 ID，然后重新读取选中记录。包括正文、状态、版本、项目、引用及 `derivation_current` 在内的选中记录发生变化时，拒绝整个结果。最后再次检查会话身份及取消信号。

单项最多三次 ID-only 的 `ultra_memory_read`，外加有界次数的身份检查。来源本身有引用时，不继续向下读取；不会执行正文中的指令。身份、精确记录和来源比较直接复用现有规范读取器与 `personal-lineage-contract.mjs`，没有另一份比较规则。工作流可有多个输入项，每项保留 `pairedItem.item`；它不是自动候选遍历器，不从输入 JSON/binary 中猜选记录。沿用执行器最多1000项的上限，没有自动分页、轮询或重试。

## 输出状态

成功的观察返回 `{ok:true,operation:"personal_lineage",result:{...}}`，其中 `verdict.state` 表示：

| 状态 | 含义 |
|---|---|
| matched | 当次来源观察的版本、正文指纹与引用片段均匹配，选中记录来源标记也一致。 |
| changed | 来源版本或正文指纹与记录中的引用不同；片段仍可能相同。 |
| archived | 来源已归档；片段是否相同仍单独报告。 |
| quote_mismatch | 来源版本、指纹匹配，但按原 UTF-16 偏移取出的片段不符。 |
| inconsistent | 版本、指纹、片段匹配，但选中记录的来源有效标记不一致。 |
| unavailable | 直接来源的准确读取返回 not_found；可能不存在或不可见，不等于已经删除。 |
| unlinked | 本次读取未提供直接引用；不推断缺少来源，也不生成来源。 |

每个结果保留 `truth_verified:false`、`atomic_snapshot:false`、`memory_writes_requested:false`，只表示几次独立时刻的观察。来源在读后再次变化、变化后恢复原值等未观察到的情况不能排除。matched 不是事实认证、持续最新状态、服务器事务快照或写入授权。来源自身的来源有效性不会递归验证，仍可在来源元数据中检查其 `derivation_current`。

默认只输出选中记录、来源和引用的有限元数据，引用不含quote。显式披露时，另返回 `text:{memory,quote,source}`；来源不可用时source为null。所有正文、片段和引用都应视为不可信数据，不能用作高优先级 Agent 指令。

权限拒绝、取消、超时、损坏记录、错误身份或来源不在配置范围内都会失败，不伪装成 unavailable 或空结果。即使来源not_found，也仍重新读取选中记录，不能交付已经过期的引用关系。清理失败或后续项取消会撤下此前尚未交付的核验结果。安全错误只含固定代码、实际记录读取尝试次数及read_delivery，没有部分正文。读取次数仅由本地结果登记，不信任远端异常提供的计数。

## 示例与验证

`examples/n8n/personal-lineage.private.json` 是未启用、无凭据、空编号、不同意读取的手动示例，使用私有加载器 `CUSTOM.ultrabrain`。它没有定时器、Webhook、写入节点或自动重试。安装应使用与本次源码匹配的私有包，不能只比较沿用的开发版本号。

专项：`node --test test/n8n-memory-lineage.test.mjs test/n8n-memory-lineage-audit.test.mjs`。实际打包 Node / MCP / PostgreSQL：`bun test/n8n-memory-lineage-integration.mjs`；这里的n8n上下文是测试夹具。加`--engine`并配置真实 `ULTRABRAIN_N8N_BIN` 才会执行真正的n8n2.38.7/Node24引擎。专用CI完成真实安装后执行该路径，不能把脚本存在当成通过。

数据库测试的记录先由认证MCP创建，结构化引用是对本轮新source/ID明确注入的合成夹具，不是实际模型或整理器生成。测试另引入真实的并发状态修改，验证整次观察被拒绝；读取和拒绝阶段检查六张个人表不变。未验证实际用户设备部署。

本轮同时修复前序Windows测试临时目录EPERM：仅为原有清理调用添加Node原生有限重试，仍由失败的清理钩子报告永久错误。真实Windows是否通过，须以新提交CI为准。节点模块不增加任何重试行为。

官方依据：Node `fs.rmSync` 的maxRetries/retryDelay（https://nodejs.org/api/fs.html#fsrmsyncpath-options）；n8n程序式节点输入关联（https://docs.n8n.io/data/data-mapping/data-item-linking/item-linking-node-building/）。本轮未修改服务端工具、身份规则、已应用迁移、上游锁、受阻管理台、qbrain或运行中的用户服务。
