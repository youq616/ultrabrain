# 个人原文自动整理（0.11.0-alpha.1）

这是一条可执行的“获准原文 → 持久任务 → 模型分类 → 带引用的候选 → 明确审核”流程。没有另建记忆正文库，也不会自动扫描历史聊天、所有个人 experience 条目或未接入的软件。现有结构化 memory_commit、原生会话整理和企业白名单不变。

## 提交原文

已认证的 Agent 先登记自己的 agent_id，再调用新的 `ultra_personal_capture`。需 consent:true、稳定 event_id、至多 32 KiB 原文，可指定 project_id。原文作为私有 experience/candidate 存在原来的 personal_memories 表，任务引用其 ID、版本与内容 hash；两者与幂等回执在同一 PostgreSQL 事务提交。重试相同事件/内容不会新增任务，不同内容复用事件会报 conflict。默认不产生模型调用。

```json
{"agent_id":"custom-agent","event_id":"turn-001","consent":true,"transcript":"用户明确说：不要使用 Docker Hub。","project_id":"ultrabrain"}
```

新工具：`ultra_personal_capture` 入队；`ultra_personal_jobs` 查询当前主体的任务状态；`ultra_personal_consolidate` 处理指定任务或至多四条队列任务；`ultra_personal_cancel` 阻止未完成任务写入结果并保留原文。工具在 compatibility MCP 中注册，不自动扩展 governed 企业白名单。其他 HTTP 主体、目录限定或授权退化客户端不能接管这些任务。

自研 Agent 可用已有 AgentMemory 的 `queuePersonalTranscript({agentId,eventId,transcript,consent:true})`。同时要求实例 capture:true、source 根 URI，保持实际 session/event 归属。这个辅助方法没有新增 fsync outbox；在 journaled 确认前，原事件应由业务源保留。不要把旧会话 outbox 的保证直接套到新个人接口上。

## 单独启用整理模型

已有摘要配置不会自动授权个人整理。使用既有 Linux 普通服务账号，先配置原生 chat provider（凭据不进入 Git/对话），再显式启用专用个人 profile：

```bash
bun src/cli.mjs personal-model-config --from-chat-model --revision personal-model-1
# 或 --model provider:model --revision personal-model-1
bun src/cli.mjs personal-model-config --disable
```

配置脚本保存私有原配置备份，不改变向量模型身份、摘要开关或供应商凭据，也不调用模型。修改配置时停止其他配置写入器；变更原生 provider 设置后重启 MCP/Worker。profile revision 应随模型别名或供应商端点改变而更新。这里复用锁定的 GBrain 模型网关，不接受 MCP 请求提供任意模型端点/API Key。

模型默认关闭。处理还要求本次请求 allow_model_call:true；没有专用 profile 时返回 needs_model，队列保持不变，不消耗任务尝试次数。发送原文给模型可能产生费用；请事先脱敏并确认供应商的数据处理方式。

## 周期 Worker

在同一个本机所有者身份下，一次处理：

```bash
bun scripts/personal-worker.mjs --local --source default --allow-model-call --limit 1
```

持续处理需明确开启循环，例为每 300 秒处理一批；进程必须保持运行，不会自动安装为服务：

```bash
bun scripts/personal-worker.mjs --local --source default --allow-model-call --limit 1 --loop --interval 300
```

HTTP Agent 的 private 原文归于其 HTTP 身份，不属于本机 owner。要处理这些任务，使用同一 HTTP 主体的普通 MCP 凭据：

```bash
bun scripts/personal-worker.mjs --url https://your-memory-server.example/mcp --token-file /实际私有目录/mcp-token --source your-source --allow-model-call
```

地址和路径须替换成真实部署配置；HTTP 只接受 HTTPS 或明确 loopback 地址。凭据在 Worker 启动时固定，每批复核同一逻辑 instance/source/actor；令牌撤销由服务端处理，换令牌需要重新启动 Worker。不保存排队令牌，不将 HTTP 身份提升为主机身份。日志只有状态计数，不包含原文、候选或密钥。needs_model 的单次/循环 Worker 退出码为 2；一次运行有 failed/stale/lease_lost 时也为 2，不能当作全部成功。循环不会自动重试失败任务。

## 候选与证据规则

模型只能输出允许的九种个人类型、内容和精确 quote。每条内容和 quote 各至多 2 KiB，一批至多 16 条，响应须为严格 JSON 且正常结束。所有引用必须在输入原文中逐字找到，记录 UTF-16 起止位置、原文 ID/版本/hash、任务/profile 标识。无长期内容可返回空数组，原文仍保留。

模型不能指定权限、状态、confidence、删除或覆盖操作。输出一律为 private/candidate、confidence:null；不是已确认记忆，不会自动进入当前上下文。模型系统提示要求保持否定、日期、说话者和不确定性，但字符串引用校验**不能证明语义蕴含或事实真实**。提示注入/错误归因仍需人工审核与真实语料评测。

同一模型响应内完全重复的类型+正文会折叠。同一主体以前已有的相同正文只返回最多三个重复 ID 提示，不能据此自动删除、合并或认定冲突；不同来源的候选仍保留。没有实现模型自动修正旧事实或自动激活。

管理台新增“将内容作为原文排队整理”和“整理任务”页。任务页可明确处理一条、查询失败原因或取消；模型未启用会显示 needs_model，而不是宣称整理成功。所有者可在候选记录旁查看原文引用。取消不能撤销已发出的供应商请求或费用。

原文在生成期间被编辑、审核导致版本变化或被归档时，旧输出不再落库。已经生成且未被手工改写的派生记忆，在原文版本/hash 变化或归档后不再进入个人 context/profile；所有者的管理搜索仍能看见它及失效标记，便于修正或归档。其他身份看不到私有引用。手工整体更新派生条目会清除旧引用并退回 candidate，这明确创建新的人工提供版本，不冒称新内容仍有旧原文证明。

## 重试、并发与边界

每源/主体最多 256 个 queued/processing/failed 任务；满额拒绝新采集，不驱逐旧原文。原文和完成任务仍会累积，这不是总数据库容量或保留期限制。一次最多四条；同源同主体在多个 Worker 进程间只允许一条未到期的 processing 租约，不是外部供应商的全局计算并发保证。

任务每次持久 claim 有独立 lease_id，生成期间不持有数据库事务或锁。候选输出和 completed 回执在一个事务内提交，晚到的旧 Worker 不能覆盖新租约或取消状态。模型调用超时，任务失败；实际进程崩溃可能留下 processing，三分钟租约过期后仍需显式一次性 --retry（或 UI/工具指定 retry:true），最多三次。禁止 --retry 与 --loop 同用。

```bash
bun scripts/personal-worker.mjs --local --source default --allow-model-call --retry
```

单次恢复可能处理最早的失败任务；需要指定任务时用 MCP 的 job_id 或管理台。profile hash 在首次 claim 固定，不能在重试时静默改模型；改 profile 后，应核对原任务、明确取消并按新事件重新提交所需原文。成功任务不会因重复 Worker 调用再次生成。

数据库终态提交失败时返回 personal_commit_unconfirmed，先查询 job 状态，不能仅凭客户端错误断言没有写入。外部模型网关/SDK 自身的重试与失去确认都可能重复计费；记录的是本功能的网关调用尝试，不是账单或“恰好调用一次”证明。客户端断开不保证正在运行的模型请求立即停止。

## 升级和验收

新增且仅新增 0013-personal-consolidation；之前迁移字节、上游指针及企业白名单不变。已有个人数据不会自动被加入整理队列。数据库备份包含原文、派生引用和任务，恢复测试新增相应指纹；仍不是完整附件/密钥灾备。

测试包括实际 PostgreSQL、原生插件、stdio/HTTP 工具调用、冲突和事务回滚、丢失租约/取消、真实 Worker 子进程通过原生 SDK 访问本地模拟供应商，以及真实 Chromium 的入队和任务操作。模型响应为受控合成 fixture，不宣称真实 LLM 准确率。个人 V1 尚缺具体客户端自动 Hooks、文件/多模态、完整恢复及实际用户环境验收。

事务依据：PostgreSQL 18 SELECT 的 SKIP LOCKED 队列语义与事务隔离说明，https://www.postgresql.org/docs/18/sql-select.html 、https://www.postgresql.org/docs/18/transaction-iso.html 。这些是实现依据，不是本产品已经获得数据库官方认证。
