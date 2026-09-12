# 0.7.0-alpha.1：原生事实与来源治理统一召回

本版新增 `ultra_fact_inspect`、`ultra_fact_bind`、`ultra_recall`。原文、原子事实和向量仍在现有 GBrain/PostgreSQL 存储中；新表仅保存 ID、内容指纹、来源版本、关联方法和幂等事件，不保存第二份事实正文，也不替代原生事实更正/撤回操作。

## 为什么不能只依靠 provenance 字符串

原生 remember 的 provenance 是自由文本，不能把任意一句“来自某文件”自动解读成可核验的资源关联。原生 recall 的 query 主要作用于页面查询；本工具只调用其事实分支，用 entity、session_id、since、grep 或原生最近排序选择候选，不把它称为对任意问题的语义事实搜索。

## 三个工具

- ultra_fact_inspect：以原生字符串 fact_id 查询当前事实指纹、原生有效状态与关联 revision。要求当前完整单 source 权限。私有事实或不可读关联来源不通过本接口泄露。
- ultra_fact_bind：需要 fact_id、fact_sha256、evidence_uri、content_sha256、expected_revision、event_id。0 创建，其后必须用最近读取的关联版本。检查原生事实仍相同且未撤回，原文仍为指定版本，并在同一事务保存关联和事件记录；未知 ID、跨 source、错误 hash、并发版本冲突均拒绝。
- ultra_recall：参数 uri（source root 或目录）、memory_policy、entity/grep/since/session_id、limit、candidate_limit、budget_bytes。候选由原生 recall 给出，再以当前 source、原生可见性、事实指纹、原生撤回/过期状态和关联页面的当前权限/治理复核。最多 100 个候选，明确不穷尽。

来源关联只证明某个调用方关联了这一版事实与这一版原文。**不证明原文蕴含事实、不证明提取准确率，也不将模型输出升级成独立验证过的真相。**自动关联的 method 为 extraction，显式关联为 explicit。模型置信度也不作为独立真实性证明。

## 当前、已审核与历史

| 模式 | 本版事实召回语义 |
|---|---|
| current（默认） | 必须存在未失效的明确来源关联，原生事实有效，来源页面当前可读且符合当前资源治理。来源页可尚未审核，但会保留 unreviewed 标记。 |
| reviewed | 同上，且来源页面必须处于 active 审核状态。审核仍不是独立事实真伪判定。 |
| history | 显式返回已过期/失效记录的状态；已关联事实仍要通过来源读取权限。无关联事实仅可在 source 根目录查询，不能猜测其所属目录。 |

与页面的 current 模式不同，本工具不把无来源关联的旧事实纳入 current。迁移保留旧事实，不自动猜测关联。原生 recall/get_page/context_pack/delta 等保留自己的行为；直接使用那些工具不会自动获得本版的筛选保障。撤回事实本身仍应使用原生 forget/forget_fact；本版不是跨备份的物理删除系统。

原生 valid_from 可能表示事件发生时间（例如未来约定），不会简单因未来日期而删掉当前可用的事实。原生 expired_at、superseded_by、valid_until，以及来源自己的有效期分别检查。历史事实不会沿页面替代链接被改写成另一条事实，后续事实应有自己的原生 ID 和来源关联。

## 自动关联提取结果

通过 Ultrabrain 的同步/延后会话路径调用原生 extract_facts 时，会先保存可读取原文的版本快照，并检查实际提取输入完整出现在该原文中。提取后仅对返回的有限事实 ID 尝试关联：事实必须仍属于当前 source，其 context/source_session 必须准确对应这次来源和会话，来源版本也不能变化。

已经有关联的事实不会被自动覆盖；去重返回的另一来源或会话的旧 ID 不会被悄悄重新归属。原文不可读、私有视图不可用、输入不匹配、权限不支持或版本变化时，原生提取结果仍保留，并报告 evidence_binding 的 linked/skipped/status，不伪造来源完整性。

远程 private 会话仍遵循原生 host-private 规则，因此可能保存成功但无法自动建立供远程召回使用的来源关联。达到 completed 表示原生提取执行成功，不代表关联完整或语义正确。原生绕过 Ultrabrain 的提取路径和历史数据需要显式迁移/审核，不在本版自动覆盖范围。

## 修改与关联失效

新增迁移 0008，只追加，不修改既有 0001..0007。原文正文、标题、frontmatter、删除/恢复、改名等原生变化使当前绑定进入 review_required，并增加关联 revision。原生事实文本、归属、可见性或生命周期变化同样使绑定失效；修改后又恢复原文不会自动复活旧关联。

来源政策撤回、被替代、有效期或引用依赖失效按当前资源政策检查；没有直接改写事实正文。事实从原生库物理删除时，其关联和关联事件通过外键一起清理。后台重建分配了新的 fact_id 后，必须重新关联，不能按相同文字猜测身份。

## Agent 与事件桥接入

旧 AgentMemory 默认不增加事实调用。明确开启后，回调中的 evidence 同时包含 items（页面）和 facts（原生事实）：

```js
const memory = new AgentMemory({
  client, rootUri: 'ultra://development/', sessionId: 'work-1',
  factRecall: {entity: 'ultrabrain', limit: 8}, // {} 表示采用原生最近事实排序
  budgetBytes: 16000,
});
const result = await memory.runTurn({
  input: '继续开发',
  generate: ({input,evidence,signal}) => yourModel({input,evidence,signal}),
});
```

也可单独调用 `memory.recallFacts({grep:'明确的关键词'})`。beforeTurn 开启组合模式后，为事实预留约三分之一字节预算；序列化 `{items,facts}` 的总占用不得超过 budgetBytes。事实若放不下则整条跳过，不截断否定或条件使其变成不同意思。元数据响应、项目摘录、提示词和生成输出不在此计数中；这不是模型 token 预算。

通用事件桥使用 `--facts`，需要固定实体时再传 `--fact-entity ultrabrain`。实体与采集授权由进程配置确定，事件不能改 source 或注入命令。读取事实不自动执行模型提取，也不开启采集。

## 授权与限制

新工具仅支持完整单 source grant，不支持 delegated/目录授权凭据或多 source 联合授权；目录 uri 是已经授权 source 内的进一步缩小，而不是权限提升。每条事实的关联来源都通过当前原生 get_page 检查。

原生事实接口目前经过 JS 数字 ID 投影：若候选 ID 已超出安全整数范围，拒绝不精确的候选，而非将其舍入成另一个 ID。新的显式 fact_id 输入仍严格校验 PostgreSQL bigint 字符串。

模型调用和关联写入不是一个分布式事务；失败重试不会承诺 exactly-once。每次响应反映检查时的状态，不是生成回答期间的一致性快照。保存绑定与失效触发器采用 PostgreSQL 事务/行锁；并发冲突应重新读取，不盲目复用旧审核。

官方机制参考： https://www.postgresql.org/docs/18/explicit-locking.html 与 https://www.postgresql.org/docs/18/trigger-definition.html 。原生事实参数以固定版本 vendor/gbrain/src/core/ops/facts.ts 和 src/core/verbs.ts 为准。
