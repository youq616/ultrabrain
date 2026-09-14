# 审核记录：development/personal-documents

按 AGENTS.md 记录两轮真实独立子代理审核。审核者为本地宿主子代理机制产生的独立会话，与实现代理不同实例，未参与实现。本文件为纯文档记录，不属于受审实现差异。

## 第一轮：commit 8fc75aa4949baffc5c3c4c5f4c1df6376d28ba8c

- Reviewer 身份：ZCode subagent（general-purpose，独立新会话），run id `7f3149b1`（uuid 7f3149b1-1afe-4586-868e-2458c57210b1），会话 agent_ad7f902a-d076-42de-b19c-17a179ddfa8c
- 受审 SHA：8fc75aa4949baffc5c3c4c5f4c1df6376d28ba8c（基线 09a4c8fe95242d5939e28cc3957d4605a6823a81；20 文件，+891/−20）
- 12 项边界检查：1–10、12 PASS（含文件行号核对）；11（测试诚实性）FAIL
- 发现：
  - **P1** test/personal-documents-integration.mjs:101-106、:127-130 fixture 使用 `md5()`（32 位 hex）填充 `content_hash`/`input_hash`，违反 0012/0013 的 `^[a-f0-9]{64}$` CHECK——集成测试在真实 PostgreSQL 上会在容量段中断，其后所有断言从未执行，CI 将红。
  - **P2** 超大 payload 报 `invalid_params` 而非文档承诺的 `file_too_large`（src/personal-documents.mjs:38）。
  - **P2** `derived_entries_invalidated` 只统计 active 派生行（src/personal-documents.mjs:218-220）。
  - **P2** `readLocalDocument`/`deliverDocumentImport` 尚无测试之外的调用方（打包客户端未接线，文档如实描述）。
- 实测：node --test documents 10/10、core 9/9、console 18+2 既有 getuid 环境失败；py_compile/bash -n/node --check 全过
- 结论：**reject**（服务层边界全部合格，但集成路径未验证即合入违反 AGENTS.md）

## 第二轮（修正后复审）：commit 2e10b9c88920d0b49f73cf71f2033e45272683ff

- Reviewer 身份：同一独立会话的续审（非实现者），re-review run id `600fd568`（uuid 600fd568-365a-4f9b-bde7-d51492fe129b）
- 受审 SHA：2e10b9c88920d0b49f73cf71f2033e45272683ff（父 8fc75aa；修正差异 3 文件 +10/−5，其余与已审 8fc75aa 字节一致）
- 修复核验：
  - P1 已修：:103、:129 改为 `md5(x)||md5(salt||x)` 双拼 64-hex；全文件无残留 32-hex fixture；对 0001–0014 全部约束逐条复查无其他违规（含租约 CHECK、UNIQUE、FK 删除顺序）
  - P2 已修：错误码顺序为 非法输入→`invalid_params`、编码超长/字节超限→`file_too_large`；新增单测钉住
  - P2 已修：失效计数覆盖 active+candidate
  - 未引入新问题；无删除断言/夹带改动
- 实测：documents 10/10、core 9/9、capture-outbox 23/23（一次 %TEMP% EPERM rename 瞬态复跑即 42/42，相关文件与基线字节一致）
- CANNOT-VERIFY-WINDOWS：真实 PostgreSQL 集成、stdio MCP、bootstrap（本机无 Linux 环境）
- 结论：**approve-with-nonblocking**，**显式条件**：合并 main 前必须在 Linux CI 对 2e10b9c 实际跑绿 `bun test/personal-documents-integration.mjs`（.github/workflows/ci.yml 个人测试步骤）；该步骤若红，本批准作废并重新送审

## 当前状态（2026-09-14）

- 分支仅存在于本地：推送被阻断（无 GitHub 写入凭据，非交互环境无法认证），CI 未运行，draft PR 未创建——批准条件未满足，**未合入 main**。
- 剩余非阻断项：客户端边界库待接入打包 client kit；Linux CI 集成执行；真实用户部署验收。
