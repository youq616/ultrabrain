# 个人记忆召回排序（开发候选）

本文描述 `development/personal-ranking` 分支对**个人上下文召回排序**的修正。未获独立子代理审核批准且 Linux CI 未在最终提交上跑绿前，不合入 main。

## 修复的两个缺陷（均先在基线 `5f175cb` 上复现）

1. **窗口截断**：`ultra_personal_context` / `ultra_memory_profile` 原先先按 `updated_at DESC LIMIT 100` 取最近 100 条、再在 JavaScript 里排名。1 条较早的 high 偏好叠加 110 条更新的 normal 记录时，旧偏好根本进不了候选窗口（基线复现：旧偏好缺失）。
2. **时间平局比较错误**：纯上下文组装器用 `String(Date).localeCompare` 比较时间。`String(Date)` 形如 `"Wed Jan 03 2024…"`，localeCompare 实际按星期名字母序比较，导致 2024-01-03 的 Date 对象排在 2024-01-04 之前（基线复现确认）。

## 修正后的规则（SQL 与 JavaScript 共用同一套）

- **候选先排名、后有界**：context/profile 的排名在数据库内完成后才施加 100 条候选上限；search 保持原来的时间序分页不变。所有授权过滤（source、认证主体、显式共享、active 状态、派生来源有效性、project、type、agent、query 子串）与原先完全一致。
- **排名分**：importance `high/normal/low` = 3/2/1，加每个**不同任务词**在正文中出现贡献的 1 分。
- **任务词规则**：task ≤4096 UTF-8 字节；按 Unicode 空白（含全角空格 U+3000、NBSP 等 `\p{White_Space}`）分词；去重；最多 32 个不同词；**只折叠 ASCII A–Z**，其他文字按原样匹配。SQL 侧用 `translate(content,'ABC…Z','abc…z')` 折叠内容、以绑定 `text[]` 参数传入词表，从不拼接用户输入。
- **平局**：真实时间值降序（毫秒精度；JS 用数值毫秒而非字符串），完整 UUID 升序（PG uuid 字节序与规范文本序一致）。
- **组装器**：排除 `derivation_current:false`；保留整条记忆的预算裁剪（不截断否定词）；`exhaustive:false`；排名顺序不代表事实置信度。
- **数据库执行边界**：context 排名在只读事务内执行（`SET LOCAL transaction_read_only=on`、`SET LOCAL statement_timeout='5s'`），均为事务级设置，不改变连接级配置；超时或数据库错误照常抛错，绝不返回"成功空结果"。事务结束后连接可继续正常读写。

## 兼容性变化（不声称原有大小写行为完全不变）

相对旧实现，以下行为**发生了变化**，属于有意修正：

| 方面 | 旧行为 | 新行为 |
|---|---|---|
| 大小写折叠 | 全字符串 `toLowerCase()`（含非 ASCII，如西里尔、带点 İ） | 仅折叠 ASCII A–Z；非 ASCII 文字按原样字面匹配 |
| 分词空白 | `/\s+/`（本来已包含 NBSP、全角空格等；包含 BOM、不包含 NEL） | `\p{White_Space}+`（包含 NEL U+0085、不包含 BOM U+FEFF） |
| 重复词 | 重复任务词各计 1 分（可重复加分） | 不同词各计 1 分，重复只算一次 |
| 词数上限 | 前 32 个 token（重复占位） | 前 32 个**不同**词 |
| 时间平局 | `String(Date).localeCompare`（星期名字母序，错误） | 数值毫秒降序 + 完整 UUID 升序 |
| 召回窗口 | 先按时间取 100 再排名（丢旧的高分项） | 先排名再取前 100 |
| context 的 offset | 被静默应用在排名前的时间窗口内（语义无意义） | 非零 offset 直接拒绝（invalid_params）；排名窗口用 limit 控制 |

## 有界召回的诚实边界

context/profile 仍是**有界召回**：授权过滤后按排名取前 100 条候选，不是语义搜索，也不保证"所有重要记忆必然出现"——同分且排在窗口之外的记忆会缺席。结果中的 `exhaustive:false` 与 `recall` 字段保留该声明。排名分不是事实置信度。

## 测试

- 纯契约单测（Windows 可跑，`node --test test/personal-ranking.test.mjs`）：分词/折叠/去重/上限、排名值、平局（Date 对象与 ISO 字符串）、组装器排除与预算、注入字面值、窗口排序修正。
- 真实 PostgreSQL 集成（Linux CI，`npm run test:ranking`）：窗口缺陷的真实复现回归、重复词/中英文/emoji、项目与主体隔离、显式共享、candidate/archived/失效派生排除、只读身份、SQL 注入字面值、search 分页、字节预算、连接不被只读/超时设置污染、日期与 UUID 平局钉住，以及 **450 条合成记录 × 20 组查询的 SQL 与 JavaScript 排序完全一致**校验。早期本地复审只模拟了部分语料，未运行 PostgreSQL，接收端真实执行随后发现了其他夹具缺陷；修复与首证见 `reviews/PERSONAL-RANKING-RECEIVER.md`。最终验收以 PR 中对应完整提交的实际测试和独立复审为准。

## 接收端追加验收

`test:ranking` 同时执行排序集成和安全集成。后者验证 1005 条新 normal 偏好不会挤掉旧 high 偏好、严格的完整响应字节预算、不同源与非 ASCII 字面词边界；单连接原生适配器记录 PostgreSQL backend PID，在另一事务持有测试表锁时运行真实 context 查询，验证 PostgreSQL `57014` 超时经 MCP 返回 `personal_storage_error`，而不是成功空结果。解除锁后核对同一 backend 的超时和只读设置恢复，写入仍可执行。只允许在隔离合成数据库使用该测试，绝不能对生产记忆库运行。

此排序窗口不是分页快照；`dropped` 只统计已取得候选窗口内未纳入结果的记录，不统计数据库中窗口之外的所有记忆。词匹配是字面优先级，不是 embedding 或真实模型质量指标。agent_id 是登记标签/筛选条件，不是独立用户认证；私有性由服务器认证主体与 source 限制。
