# n8n：明确核对单条个人记忆

现有私有 Ultrabrain 节点新增 **Inspect Personal Memory**，衔接候选清单取得编号后的人工核对。每个输入项只读取一个明确编号，不自动遍历候选或来源引用，不调用模型，不启用、纠错或归档。原候选清单、概览、上下文和采集操作的默认值与权限不变。

## 配置与范围

使用此提交构建的私有节点包，不要仅凭未改变的开发版本号认定旧包包含此操作。可信凭据需要源根 URI、已经核对过的实例 UUID 和主体 SHA-256。新增 **Inspection Project ID** 独立于 Candidate Project ID，不从输入 JSON 或普通 projectId 参数推导，也不会自动借用候选清单的项目设置。留空只允许全局；明确配置后可以选择全局加该项目。

节点需选择 **Inspection Scope**（默认未选）、完整小写 **Memory ID**（默认空）和逐项 **Consent to Read This Record**（默认false）。**Include Record Text in Output** 默认false；明确true才输出正文、来源说明及已存储引用对象。需要使用上一步候选编号时，应由工作流作者明确映射一个编号，不能把数组交给本节点要求自动读取全部。

**重要：默认不输出正文，不等于网络不传正文。** 现有 `ultra_memory_read` 会把完整记录传到适配器内存，适配器先验证全部内容及指纹，再执行本地项目、所有者、来源类型限制并投影输出。本操作的读取同意涵盖这次完整传输；本地限制不能替代服务器授权，也无法阻止已经完成的传输。被本地拒绝的项目、共享记录或文档片段同样可能已在内存中收到。需要服务器在传输前施加更窄授权的场景，应使用相应服务器凭据策略，不应将本地过滤误当成传输隔离。

本入口只交付自有、Agent来源的全局或所选项目记录，可核对候选、已启用和已归档状态。即使同源共享记录可由服务器读取，非所有者也不会从本入口取得输出；文档片段应走文档接口。来源已失效的自有记录仍可核对，但不表示可以直接启用。ID只是选择器，不是权限凭据。

## 数据与校验

一次请求只向既有 MCP 工具传 `memory_id`，不发送上游 JSON/binary、查询文本、工作区路径、项目字段或同意标志。身份在会话开始、读取之前和交付之前核对。无需采集写开关，不会替操作者修改配置。

新模块与原 `clientLineageRecord` 使用同一个函数对象。完整记录验证从 `client-lineage.mjs` 无逻辑改变地移到无文件系统依赖的 `personal-memory-read-contract.mjs`，原路径兼容导出保留。核对来源、编号、精确字段、内容SHA-256、枚举、版本、时间和结构化引用，之后才输出。只接受一个不超过1MiB的JSON文本MCP结果；拒绝额外通道、重复JSON键、隐藏字段/访问器形态的传输对象和损坏记录。不以截断内容或空记录伪装成功。

默认结果为 `{ok:true, operation:'personal_inspect', result:{...}}`，包含有限记忆元数据，`text_included:false`、`read_only:true`、`read_requests:1`、`memory_writes_requested:false` 和 `model_calls:0`。明确披露时增加 `text:{content,provenance,derivation}`。引用对象仅作为不可信数据返回，程序不沿引用读取其他记忆、不执行其中内容，也不证明引用当前有效。元数据和原文都可能被 n8n 历史记录或下游节点保存，应在主机侧另行控制保留和访问权限。

结果是一次观察，不是持续最新状态、数据库事务快照或写入授权。随后确认/修改必须使用已有受控入口重新读取并核对版本。内容通过结构和指纹校验不代表事实真实，更不应作为高优先级 Agent 指令。

## 失败、取消与输入关联

每项输出保留 `pairedItem.item`。continueOnFail 下，失败项只有安全错误码、`read_delivery:not_started|unconfirmed`、`memory_writes_requested:false`，没有部分正文或假成功空值。not_started仅表示尚未开始所选记录请求，并不保证没有连接或身份查询。not_found、permission_denied及insufficient_scope只保留安全代码，不回显任意远端消息。

取消不会撤回已经发出的只读请求。读取后、后续项执行期间或关闭连接时取消，会撤下前面尚未交付的核对结果。清理失败也不交付原文。已有其他操作的已确认写入不会因此被改报为没发生。本模块不重试、不排队，不从失败降级到通用搜索。凭据在每次节点执行开始时固定一份，不声称全局凭据编辑会实时撤销已经开始的执行。

## 示例与验证

`examples/n8n/personal-inspect.private.json` 是未启用、无凭据、空编号且不同意读取的手动示例，使用本项目私有加载器 `CUSTOM.ultrabrain`。导入本身不会读取记忆。示例禁存执行数据不能替代实际实例配置验证。

专项：`node --test test/n8n-memory-inspect.test.mjs test/n8n-memory-inspect-review.test.mjs`。使用生产代码和明确的合成传输/执行上下文；另测试旧客户端导出与新规范校验函数身份一致。

集成：`bun test/n8n-candidates-integration.mjs --inspect` 在既有候选集成中追加核对场景，保留原13项候选检查；使用实际打包runtime、官方MCP/HTTP和隔离PostgreSQL，但执行上下文仍是测试夹具。加 `--engine --inspect` 并配置实际 n8n 路径才运行真正n8n2.38.7/Node24引擎：默认元数据、明确正文、凭据项目、共享非所有者拒绝及不同意拒绝，读取阶段六表不变。新 `n8n-memory-inspect.yml` 负责这个实际安装/执行路径，结果需按最终SHA核对，脚本存在不等于已经通过。

参考官方规范：n8n Item linking for node creators（https://docs.n8n.io/data/data-mapping/data-item-linking/item-linking-node-building/）要求程序式节点保留输入关联；MCP CallToolResult允许多种内容形式，本项目对个人准确读取有意采用更窄的单文本合同，而非声称支持所有内容类型。

本阶段仍是独立开发候选。没有修改受阻的管理台代码、原 `test/n8n-integration.mjs`、已应用迁移、服务端目录、上游锁、qbrain或用户服务；没有将旧PR的批准或测试用于批准本阶段新代码。实际结果见本提交复查记录与PR评论。
