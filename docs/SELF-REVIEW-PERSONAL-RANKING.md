# 自审记录：personal-ranking 阶段（实现代理自己的记录，非独立审核）

按 AGENTS.md，本文件是实现侧自审与首证记录；独立子代理审核另行记录，两者不得混同。

## 基线首证（first-failure evidence，修改前采集）

在未修改的基线 `5f175cb4b4ba7f8d603ee9a61b59c414ab983e0d` 上运行两个复现（脚本保存在本阶段工作日志，非仓库文件）：

- REPRO-B（纯 JS，真实 `buildPersonalContext`）：两条同分记忆 `updated_at` 分别为 Date(2024-01-04) 与 Date(2024-01-03)，输出第一条为 2024-01-03 —— **失败复现**（`String(Date).localeCompare` 按星期名字母序）。
- REPRO-A（窗口逻辑模型 + 真实 `buildPersonalContext`；真实 PostgreSQL 版回归在集成测试第一条断言）：1 条 2023 年 high 偏好 + 110 条 2026 年 normal 记录，按 `#rows` 语义 `ORDER BY updated_at DESC LIMIT 100` 截断后，任务词命中的旧偏好**不在结果中** —— **失败复现**。真实 PostgreSQL 版回归已写入 Linux 集成测试（context 第一断言）。

## 实现差异摘要

- `src/personal-context-engine.mjs`：`foldAscii`（仅 A–Z）、`taskTerms`（Unicode 空白分词、去重、≤32 不同词）、`rankMemory`（3/2/1 + 不同词命中数）、数值毫秒 + UUID 平局、组装器新增 `derivation_current!==false` 过滤，selection 标记升为 `bounded-literal-and-importance-v2`。
- `src/personal-memory-store.mjs`：`#rows` 精简为 search 专用（语义与原先 search 分支逐条等价）；新增 `#contextRows`——同一套过滤 + SQL 端排名（`CASE importance` + `unnest($7::text[])`/`translate` 折叠），`ORDER BY rank_score DESC, date_trunc('milliseconds',updated_at) DESC, id LIMIT 100`，包在只读事务（`SET LOCAL transaction_read_only=on` + `statement_timeout='5s'`）中；`context()` 复用 `buildPersonalContext` 做同规则 JS 排名并剥除 SQL 专用列，附 `recall` 有界声明；`search()` 未变。
- 测试：`test/personal-ranking.test.mjs`（8 项契约）、`test/personal-ranking-integration.mjs`（真实 PG，含 450×20 一致性）；接入 ci.yml 个人测试步骤与 `npm run test:ranking`。
- 首轮独立审核（run id aad45f3b，受审 4fda603）发现本阶段自审未抓住的 P0：一致性测试的 JS 对照组未按 `agent_id` 预过滤（SQL 侧过滤），两组 agent 查询必然失败；另指出 context 的 offset 被静默忽略未记录（P2）与集成平局断言属"钉住修复后行为"而非"基线复现"（P2）。已修复：JS 对照组按 SQL 语义预过滤 agent/query；context 非零 offset 显式拒绝并记入兼容表；文档措辞改为 450×20 以 CI 运行为准。修复后需独立复审。
- 未触碰：历史迁移、上游锁、企业工具白名单、采集权限、模型配置、既有回归断言。

## 自审要点与残留风险（如实）

1. `#contextRows` 的 `projection` 常量内含 `(actor_key=$2)`，新查询参数序（$1 source/$2 actor/$3 types/$4 project/$5 agent/$6 query/$7 terms）与占位符一致，已逐个核对。
2. `date_trunc('milliseconds',…)` 与 JS `Date.parse`（毫秒）对齐；PG uuid 升序与 JS 规范文本升序一致性由 450×20 组对照验证而非仅靠推理。
3. `SET LOCAL` 在事务结束即失效；集成测试断言 `current_setting` 前后一致且事务后仍可写。
4. 兼容性变化已在上文与 `docs/PERSONAL-RANKING.md` 明示，未宣称"原有大小写行为不变"。
5. 残留：非 ASCII 大小写（如西里尔）现在**区分大小写**匹配，是有意为之但确属行为变化；100 条窗口仍在（有界召回），窗口外的同分记忆依然缺席——文档已声明，未宣称语义搜索或穷尽召回。
6. Windows 侧只跑了纯契约单测与本机可运行回归；真实 PostgreSQL/MCP 结论以 Linux CI 为准，本文不冒充。
