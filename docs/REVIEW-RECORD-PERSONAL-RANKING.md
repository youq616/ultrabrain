# 审核记录：development/personal-ranking

按 AGENTS.md 记录两轮真实独立子代理审核。审核者为本地宿主子代理机制的独立会话，与实现代理不同实例。**受审实现 SHA 为 `14e43fa8a727758ec93046e3a2d41ed0e1ea5205`；本文件本身是纯文档记录，不构成实现改动。**两轮记录中的措辞级遗留（下述 P2/P3）为已知非阻断项，留待下一次需要复审的变更一并处理。

## 第一轮：commit 4fda603bdcb0726d99b115e61796f85612d3c009

- Reviewer 身份：ZCode subagent（general-purpose，独立会话），run id `aad45f3b-0d30-4f2c-b77a-e0ad4a5c744e`，会话 agent_282dccb5-3f5b-4484-8f10-7219bafd46f3
- 10 项边界检查：1（过滤等价）、2（注入面）、4（事务安全）、5（有界召回诚实性）、6（基线缺陷回归）、7（兼容性文档）、8（边界未触碰）、9（测试诚实性-新增）、10（组装器）PASS；3（SQL/JS 一致性）FAIL
- 发现：
  - **P0** 450×20 一致性测试的 JS 对照组未按 `agent_id`（及 query 子串）预过滤，两组 agent 查询必然 100 vs 80 失败——CI 不可能绿，且文档预先宣称"已验证"违反 AGENTS.md 诚实规则（审核者用语料模拟证实了确定性失败）
  - **P2** context 的非零 offset 被静默忽略，未记入兼容性变化
  - **P2** 集成测试中的时间平局断言是"钉住修复后顺序"，基线失败复现实际由单测承担，文档措辞不精确
- 实测：ranking 8/8、core 9/9、client-boundaries 20/20；node --check 全过；diff 9 文件 +403/−16
- 结论：**reject**（生产代码各项合格；阻断点在测试构造与文档诚实性）

## 第二轮（修正后复审）：commit 14e43fa8a727758ec93046e3a2d41ed0e1ea5205

- Reviewer 身份：同一独立会话续审（非实现者），re-review run id `4a8917de-de5e-40ea-a4b0-c46784101a68`
- 修复核验（全部 VERIFIED，附文件行号）：
  - P0 已修：`baselineFor` 以 SQL 同义预过滤（agent 相等、query 子串）后送 `buildPersonalContext`；审核者重跑语料模拟，两组 agent 查询 80/80 完全一致，12/12 抽样组 id 序列相同；其余过滤维度（status/types/派生时效/project/共享）逐一审计无残留不对称
  - P2-1 已修：`context()` 在任何数据库访问前拒绝非零 offset（invalid_params），`offset:0`/缺省不受影响，search 分页不受影响；兼容表已记录；单测用假引擎证明数据库不可达
  - P2-2 已修：README/docs 改为 CI-gated 表述，不再预宣称 450×20 已通过；自审记录如实登记第一轮发现
  - 修复未引入新问题；累计差异 9 文件 +422/−16 与两轮算术吻合
- 遗留（非阻断）：P2 文档中"编写时已由独立审核模拟核对"应归因于修复后复审；P3 单测注释"profile forwards to context"不精确（实际在 profile 层被拒）+ 共享 schema 的 offset 描述未提 context 拒绝
- 实测：ranking 9/9、core 9/9、client-boundaries 20/20；CANNOT-VERIFY-WINDOWS：真实 PostgreSQL 执行与 Linux CI 状态（文件已接入 ci.yml 个人步骤与 npm run test:ranking）
- 结论：**approve-with-nonblocking**，显式条件：合并 main 前必须在 `14e43fa` 上看到 Linux CI 全绿；若 CI 红或其后出现任何新提交，本批准作废并需对新最终提交重新独立审核

## 当前状态（2026-09-14）

- 分支仅存在于本地：一次性凭据检查（GCM 无 GitHub 账户）与单次快速失败推送确认无写入认证——按任务约定不再循环尝试。PR 未创建、CI 未运行，**批准条件未满足，未合入 main，不允许合并**。
- 需要用户在其交互终端完成一次 GitHub 授权后推送 `development/personal-ranking`（HEAD=`14e43fa`，其上仅本文档尾巴提交），创建 Draft PR（base=main），待 CI 全绿且不追加实现改动时方可按上述批准条件合并。
