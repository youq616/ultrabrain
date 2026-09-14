# 个人文本文件导入（开发候选）

本文描述 `development/personal-documents` 分支新增的**个人文本文件导入、原文追溯与恢复验证**能力。它是 [PERSONAL-V1-CHECKLIST.md](PERSONAL-V1-CHECKLIST.md) 中“文件/多模态”方向的第一步：**只支持 UTF-8 纯文本**（`.txt` / `.md` / `.json` / `.csv` / `.log`），**不支持 PDF、图片、OCR 或其他多模态格式**；不宣称等价。本能力未获独立子代理审核批准前不合入 main。

## 范围与边界

- 单文件、显式导入：客户端只读取用户明确选择的一个普通文件。不自动扫描目录、不读取聊天记录路径、不跟随符号链接或 Windows junction（`lstat` 拒绝）。
- 文件是**显式提交的字节**：服务端只接受 base64 文件内容、文件名标签、SHA-256 指纹、稳定 `event_id`、Agent 标签和可选项目参数。不接受服务器本地路径、URL 或命令；文件名只是标签，不是路径或身份。
- 首批扩展名 `.txt` `.md` `.json` `.csv` `.log`；JSON/CSV **只作为不可信文本保存**，其中的任何内容都不会被执行、解析或当作指令。
- 单文件上限 **128 KiB（131072 字节）**：超过即整条拒绝，**绝不静默截断**。
- 严格 UTF-8 校验：过长编码、代理对、截断序列、UTF-16 BOM 全部整体拒绝。原始字节（含 BOM、CRLF/LF、否定词）原样保存；不把重新编码后的文本冒充原文件。
- 指纹核对：客户端提交的 SHA-256 与服务端实测不一致即拒绝（`fingerprint_mismatch`）。
- 原文与元数据保存在**现有托管 PostgreSQL**（迁移 `0014-personal-documents`）：`ultrabrain.personal_documents`（原始字节、指纹、状态）与 `ultrabrain.personal_document_fragments`（片段区间绑定）。无外部附件目录，随现有数据库一起备份恢复。
- 身份与来源始终来自真实认证上下文（与个人记忆一致的 `personalPrincipal`）；`agent_id` 只是已登记标签。文件默认仅所有者可读（`private`）。

## 导入与整理分离

- **默认只保存文件**。导入不调用模型、不产生记忆。
- 只有**明确排队**（`ultra_personal_document_queue`）时，才按调用方给出的显式区间（`byte_start` + `byte_length`，以 UTF-8 字节为单位，单段 ≤32 KiB，1..16 段，不重叠、不切分码点）创建：
  - `personal_memories` 片段行（`origin_kind='document_fragment'`，`candidate` 状态）；
  - `personal_consolidations` 整理任务（复用现有 PersonalConsolidator，含队列容量检查 `MAX_PERSONAL_JOBS`）；
  - `personal_document_fragments` 绑定行（记录原文 SHA、文件标识与字节区间）。
  三者在**同一事务**内原子提交，稳定 `event_id` 重放防止重复写入。
- 模型处理沿用现有整理语义：需要另行明确 `allow_model_call:true` 运行；未配置模型时返回 `needs_model`，不会伪造结果。片段与模型输出都只是 `candidate`，**不会自动成为已确认记忆**。

## 归档语义

`ultra_personal_document_archive` 归档文档时，在同一事务内：

1. 文档转为 `archived`（`revision+1`）；
2. 片段记忆行转为 `archived`，退出当前使用范围；
3. 相关未完成任务（含持有租约的 in-flight 任务）被围栏为 `stale`（`source_archived`），旧 worker 无法再写回；
4. 派生记忆通过现有 `PERSONAL_DERIVATION_CURRENT` 失效：不再出现在个人上下文，但行保留并可查（`derivation_current=false`）。

**原始文件字节与元数据保留**，可继续下载核对；归档不是物理擦除。已归档文档不能再排队。

## 快照不可变

文档片段行受 `origin_kind` 围栏：`ultra_personal_update` 与 `ultra_personal_review` 对其返回 `document_bound`。修改文件的正确方式是**导入新快照**（同标签不同内容会生成新的 `document_id`），而不是改写已有片段。

## MCP 接口（compatibility 模式）

| 工具 | 写 | 说明 |
|---|---|---|
| `ultra_personal_document_import` | 是 | 显式导入一个文件（`event_id`、`agent_id`、`consent:true`、`label`、`content_base64`、`content_sha256`、可选 `project_id`） |
| `ultra_personal_document_list` | 否 | 元数据列表（含片段计数），不返回内容 |
| `ultra_personal_document_read` | 否 | 返回原始字节（base64）+ 元数据 + 完整性自检（`document_corrupt` 拒绝被篡改行） |
| `ultra_personal_document_queue` | 是 | 按显式区间原子排队片段与任务 |
| `ultra_personal_document_archive` | 是 | 归档并围栏，保留原文 |

## 个人管理台

管理台新增“导入文档”视图：选择文件 → 明确勾选同意 → 导入；列表只显示元数据；查看原文为**纯文本展示**（`textContent`，不内联执行）；**下载只由明确点击“下载原文”触发**，下载后应本地核对 SHA-256；排队整理需确认（自动规划 ≤32 KiB 顺序片段）；归档需确认并明确“不是物理擦除”。

## 客户端

`src/client-document.mjs` 提供与 `deliverCapture` 相同的边界：**选择即冻结**（字节与同意先快照），每个 await 步骤后、发送前重新执行**同步**授权断言；项目只能来自受信配置，不能被请求覆盖。`readLocalDocument` 拒绝符号链接/junction、非常规文件、超限与非 UTF-8。该机制防止等待文件读取期间发生的配置替换把内容送往另一个服务器、项目或队列。

## 测试与恢复

- 纯契约单测：`test/personal-documents.test.mjs`（node --test，可在 Windows 跑）。
- 真实 PostgreSQL + 实际 stdio MCP 集成：`test/personal-documents-integration.mjs`（Linux CI；`npm run test:documents`）。
- 管理台 API 全链路：`test/personal-console-integration.mjs` 已含文档生命周期。
- 备份恢复：`test/restore-verify.py` 对 `personal_documents` 做**字节级**（`encode(content,'hex')`）指纹比对，`personal_document_fragments` 同样全列指纹；不是只数行数。
