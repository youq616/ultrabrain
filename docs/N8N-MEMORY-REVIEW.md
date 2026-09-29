# n8n：显式单条记忆确认与归档

此模块在现有私有 Ultrabrain 节点中增加 **Review Personal Memory**，衔接候选清单、单条核对与人工确认。提供完整的启用、归档和原事件回执恢复；不新建服务器状态、身份或审批表。服务端仍使用 `ultra_personal_review` 的所有者检查、原子修订号检查和 `personal_events` 事件记录。

本模块没有引入前期设想中的 reviewer_identity、reason、独立 review/archive 服务器权限或另一个 decision journal。调用者提交的身份字符串不能证明人工审核，不能据此授权。服务器认证令牌决定实际主体，`agent_id` 不是审核身份。本节点表达明确调用者授权，但不能证明操作者是真人或完成了充分审核；高要求场景仍需可信人工审批系统。`human_identity_verified` 始终 false。

## 操作与默认值

在可信凭据中，**Allow Memory Activation**、**Allow Memory Archive** 和 **Allow Source-Shared Activation** 分别控制客户端是否允许启用、归档、同源共享启用，默认全部关闭。Allow Conversation Capture 不会授予这三项权限。服务器仍须授予同一认证主体原有 write scope；客户端开关不能扩大服务器权限。

**Review Project ID** 是独立可信项目配置，不借用 Candidate Project ID、Inspection Project ID 或普通节点的 projectId。选择 `global-only` 只处理全局记录；`global-and-project` 处理全局或凭据指定的一个项目。输入项的旧项目字段仅是对已观察记录的前置条件，不能扩大范围。源根 URI、已核对的完整实例 UUID 和主体摘要必填，不能自动采纳陌生服务器的身份。

每次执行只允许**一个输入项**。多个输入项在请求审阅前被拒绝，避免把一份同意广播为批量修改。空输入仍是无操作。操作、范围、启用/归档选择及各项同意需明确填写；节点默认没有有效编号、旧版本、事件编号或同意。默认修订号 0 故意无效。没有计划任务、自动重试或 Agent tool 暴露。

## 从核对到提交

先使用 Inspect Personal Memory 明确读取并审阅当前完整记录，再把以下观测值填入审阅节点：Memory ID、Reviewed Revision、Reviewed Content SHA-256、Reviewed Status、Reviewed Visibility、Reviewed Project ID。项目字段为空明确代表全局，而不是继承其他节点的项目。字段须原样匹配重新读取的记录；不修剪、补造或按“最新”自动改写期望版本。

选择 Review Mode=`apply`，Decision=`active`（启用）或 `archived`（归档），提供稳定的 Review Event ID，并明确勾选调用者同意和效果确认。记录原本为 source 可见且目标为 active 时，还需要凭据允许共享启用以及单独的 Confirm Source-Shared Activation；启用后同源其他主体可能有权读取它。归档不是物理删除，归档候选可以用于拒绝其进入召回，但系统不会伪造独立的 rejected 状态。

新模块先重新读取完整记录，使用原有规范验证函数核对正文指纹和结构，然后限制为自有、Agent 来源、全局或选定项目。共享可见不等于可写，文档片段须走文档接口。修改前再次核对身份。发送给服务器的字段严格只有 memory_id、expected_revision、event_id、status；凭据、旧正文摘要、项目和同意标志不作为新增工具参数发送。

服务器在事务中检查所有者和修订号，并写入原事件日志。读取后发生正常并发修改会使 CAS 拒绝旧请求，不覆盖新版本。正常更新和生命周期操作必须保持现有单调修订号语义。直接来源已失效的记忆不能启用；服务器还会在写事务中再次检查直接来源。归档失效记录允许；原状态已等于目标状态时，客户端拒绝无意义的修订号递增。

**读取同意包含完整记录传输到适配器内存。** 本地范围限制在传输后执行，不是服务器传输隔离。输出仅包含事件编号、观测修订号和有限回执，不输出正文、来源说明或引用。无模型调用、正文修改、恢复数据库或自动纠错；纠错继续使用现有明确纠错入口并重新确认。

## 不确定结果与回执恢复

所有审阅失败保留安全代码和 `write_delivery`：`not_started` 表示尚未尝试写请求，`unconfirmed` 表示尝试过但没有可交付的已校验回执，`confirmed` 表示确实校验过回执，但后续身份变化、取消或清理失败使结果不能交付。`memory_writes_requested` 只反映本地尝试事实，不认证服务器最终状态。即使读令牌被拒绝，已经进入发送函数也保守记为 unconfirmed，不触发重试。

原事件编号必须由调用者保留，不能按 n8n 重试执行编号自动生成新值。没有客户端持久化队列或新的审批日志。n8n 的执行历史是否保存输入/输出取决于实例配置，应保护这类元数据和事件编号。

收到不确定结果后先重新核对记录。原修订号尚未推进时，可在重新授权后重发同一原 apply；已推进时，明确选择 `replay`，保持原事件编号、memory_id、expected_revision 和目标状态不变。回执恢复仍要求原动作权限、范围、所有者和非文档限制，以及当前修订号严格大于原期望修订号。依赖正常服务器的单调修订号，原 CAS 此时不能产生新修改：只能恢复既有同四字段事件，或拒绝。它不支持数据库被并发回滚到旧修订号等破坏此假设的操作。

例如记录版本 1 被启用成 2，后来归档成 3。恢复原启用事件仍返回版本 2/active，但当前记录保持版本 3/archived。`current_state_verified` 始终 false，不能把历史回执用作当前状态或再次启用证明。服务器事件没有绑定客户端额外的旧内容指纹、旧可见性或审批者描述；replay 不认证这些历史额外值。

## n8n 输出与使用边界

成功保持一项 `pairedItem:{item:0}`，返回 `{ok:true,operation:'personal_review',result:...}`。失败项在 continueOnFail 下不包含 result/receipt；必须显式检查 ok。取消在读取、发送、确认和关闭连接阶段分别核验；已确认写入不会被改报为“没有发生”，关闭连接失败也不会触发新事件或重复写入。

示例 `examples/n8n/personal-review.private.json` 使用私有加载器 `CUSTOM.ultrabrain`，只有手动触发器，未激活、无凭据、无有效决定、所有同意关闭、未启用自动重试。导入不执行审批，也不安装或修改用户服务。UI 的 noDataExpression 提示和关闭 Agent tool 暴露都不是对恶意 n8n 管理员的隔离；拥有凭据和工作流修改权的人仍必须可信。不得把自动生成的布尔 true 当作已经认证的人工审批。

## 验证

专项：`node --test test/n8n-memory-review.test.mjs test/n8n-memory-review-audit.test.mjs`。生产 executor/session/规范验证器，协议与 n8n 上下文为明确替身；它们不等同实际引擎。

集成：指定 `ULTRABRAIN_TEST_ALLOW_WRITE=1`、隔离 `ULTRABRAIN_HOME`、实际安装的 `ULTRABRAIN_N8N_INSTALLED`，运行 `bun test/n8n-memory-review-integration.mjs`。检查器启动真实 Node 子进程加载实际打包 runtime，通过官方 MCP/HTTP 与隔离 PostgreSQL 通信；包含真实并发编辑和真实提交后注入的丢失回执。原文和凭据不输出到报告，读取/拒绝/重放阶段对六张表进行指纹对照。

`--engine` 加上实际 `ULTRABRAIN_N8N_BIN` 才运行锁定的 n8n 2.38.7/Node24，引擎测试包括实际私有节点加载、启用、归档、历史回执和不同意拒绝。新工作流在安装本提交包后执行；源码中存在该步骤不表示已经通过。没有使用本轮未执行的 Windows、引擎或用户部署结果。执行记录、独立复审和 CI 分别在本轮报告/PR 中说明。

参考官方 n8n 程序式节点输入关联规范：https://docs.n8n.io/data/data-mapping/data-item-linking/item-linking-node-building/ 。本模块保留原输入关联，未改变既有读取、采集、共享合同、服务器迁移和权限范围。
