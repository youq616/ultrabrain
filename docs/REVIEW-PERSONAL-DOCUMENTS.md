# 审核任务书：development/personal-documents

本文件是给**未参与实现的独立审核代理**的任务说明。实现代理不得把自审、换目录重读或 CI 绿灯当作独立审核。审核必须记录：实际 reviewer 会话/运行标识、受审完整 commit SHA、具体文件与行号、执行过的测试证据和书面结论。旧 SHA 的批准不覆盖新提交。

## 受审范围

- 分支：`development/personal-documents`（基于 main `09a4c8fe95242d5939e28cc3957d4605a6823a81`）
- 入口：`git diff 09a4c8f..<branch-head>` 的全部差异，重点文件：
  - `migrations/0014-personal-documents.json`、`src/migrations.mjs`
  - `src/personal-documents.mjs`（核心服务层）
  - `src/personal-memory-store.mjs`（`#owned` 的 `document_bound` 围栏）
  - `src/personal-plugin.mjs`（5 个 `ultra_personal_document_*` 工具）
  - `src/personal-console.mjs`（METHODS/WRITES/SAFE_CODES/dispatch）
  - `web/personal/index.html`、`web/personal/app.js`（文档视图）
  - `src/client-document.mjs`（客户端显式读取与授权快照递送）
  - `test/personal-documents.test.mjs`、`test/personal-documents-integration.mjs`、`test/personal-console-integration.mjs`、`test/restore-verify.py`
  - `.github/workflows/ci.yml`、`package.json`、`docs/PERSONAL-DOCUMENTS.md`、检查表

## 必须逐项核实的边界（每项给出文件/行号与判定）

1. **迁移纪律**：0014 是纯追加（编号 0014，介于 0013 之后）；未改写任何既有迁移语句；`origin_kind` 新列对旧行默认 `agent`，不暴露历史无主行。
2. **显式提交**：服务端不接受服务器路径/URL/命令；`label` 不能构成路径（分隔符、盘符、控制字符、`.`/`..` 均拒绝）；首批准入扩展名外整体拒绝（`unsupported_format`）。
3. **大小与编码**：>131072 字节整条拒绝、无截断路径；严格 UTF-8（含 BOM 保留、CRLF/否定词原样、过长/代理/截断序列拒绝）；BOM 往返一致（`ignoreBOM` 语义正确）；提交指纹与服务端实测不一致拒绝。
4. **身份与隔离**：来源/所有者来自 `personalPrincipal` 认证上下文；`agent_id` 仅是已登记标签；第二主体 list/read/archive 均 `not_found`。
5. **导入与模型分离**：import/queue 均 `model_calls:0`；排队不自动调用模型；未配置模型时 `needs_model`，不伪造；候选永不自动 active。
6. **原子性与重放**：片段记忆行 + 任务 + 绑定行 + 事件回执同事务；稳定 `event_id` 重放幂等；同 id 不同请求 `conflict`；注入中途故障后零残留（含事件表）；队列容量超限整条拒绝且不删既有记录。
7. **归档语义**：片段 archived、未完成任务（含持租约 in-flight）围栏 `stale`/`source_archived`、派生记忆退出上下文但行保留、原始字节仍可 byte-exact 读取；归档非擦除的表述与实现一致；归档后不可再排队/再归档。
8. **快照不可变**：`ultra_personal_update`/`ultra_personal_review` 对 `document_fragment` 行返回 `document_bound`；不存在任何改写片段内容的路径。
9. **管理台安全**：文档操作沿用固定路由/令牌/CSP；列表不回内容；纯文本展示（无 innerHTML）；下载仅显式点击；`SAFE_CODES` 白名单未放行敏感错误。
10. **客户端边界**：`readLocalDocument` lstat 拒绝 symlink/junction 与非常规文件；不扫描目录；`deliverDocumentImport` 选择即冻结 + 每个 await 后同步授权断言；项目绑定只来自受信配置。
11. **测试诚实性**：测试没有删除断言、放宽边界或伪造成功；集成测试真的经过 PostgreSQL 与 stdio MCP；`restore-verify.py` 对文档做字节级比对；CI 步骤真实执行。
12. **文档一致性**：`docs/PERSONAL-DOCUMENTS.md` 与检查表更新不宣称 PDF/图片/OCR 支持或阶段完成。

## 执行建议（Linux/CI 侧）

```bash
git clone https://github.com/youq616/ultrabrain.git && cd ultrabrain
git checkout development/personal-documents && git rev-parse HEAD   # 记录受审 SHA
node --test test/personal-documents.test.mjs
bash scripts/bootstrap-linux.sh   # 隔离 ULTRABRAIN_HOME
npm run test:documents && npm run test:personal-console
bun src/cli.mjs db stop
```

（无模型 Key 时应看到 `needs_model`，这不是失败。）

## 结论格式

按 AGENTS.md：列出阻断（P0/P1）与非阻断（P2）问题，各附文件/行号与最小复现；给出明确 verdict（approve / approve-with-nonblocking / reject）。没有书面结论不得合入 main。
