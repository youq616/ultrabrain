# 个人文本文件导入（开发候选）

本文描述 `development/personal-documents` 分支新增的**个人文本文件导入、原文追溯与恢复验证**能力。它是 [PERSONAL-V1-CHECKLIST.md](PERSONAL-V1-CHECKLIST.md) 中“文件/多模态”方向的第一步：**只支持 UTF-8 纯文本**（`.txt` / `.md` / `.json` / `.csv` / `.log`），**不支持 PDF、图片、OCR 或其他多模态格式**；不宣称等价。本能力未获独立子代理审核批准前不合入 main。

## 范围与边界

- 单文件、显式导入：客户端只读取用户明确选择的一个普通文件。不自动扫描目录、不读取聊天记录路径、拒绝符号链接或 Windows junction；通过有界文件描述符读取，在读取之前核对所选 inode，读取之后核对文件和父目录没有变化。Linux 使用 `O_NOFOLLOW`；Windows 依赖普通文件与 inode 检查，不声称隔离同账号恶意进程。
- 文件是**显式提交的字节**：服务端只接受 base64 文件内容、文件名标签、SHA-256 指纹、稳定 `event_id`、Agent 标签和可选项目参数。不接受服务器本地路径、URL 或命令；文件名只是标签，不是路径或身份。
- 首批扩展名 `.txt` `.md` `.json` `.csv` `.log`；JSON/CSV **只作为不可信文本保存**，其中的任何内容都不会被执行、解析或当作指令。
- 单文件上限 **128 KiB（131072 字节）**：超过即整条拒绝，**绝不静默截断**。
- 严格 UTF-8 校验：过长编码、代理对、截断序列、UTF-16 BOM 全部整体拒绝。原始字节（含 BOM、CRLF/LF、否定词）原样保存；不把重新编码后的文本冒充原文件。
- 指纹核对：客户端提交的 SHA-256 与服务端实测不一致即拒绝（`fingerprint_mismatch`）。
- 原文与元数据保存在**现有托管 PostgreSQL**（迁移 `0014-personal-documents`）：`ultrabrain.personal_documents`（原始字节、指纹、状态）与 `ultrabrain.personal_document_fragments`（片段区间绑定）。无外部附件目录，随现有数据库一起备份恢复。
- 身份与来源始终来自真实认证上下文（与个人记忆一致的 `personalPrincipal`）；`agent_id` 只是已登记标签。文件默认仅所有者可读（`private`）。

## 导入与整理分离

- **默认只保存文件**。导入不调用模型、不产生记忆。
- 只有**明确排队**（`ultra_personal_document_queue`）时，才创建任务。调用方可给出显式区间（`byte_start` + `byte_length`，UTF-8 字节，单段 ≤32 KiB，1..16 段，不重叠、不切分码点）；省略 `fragments` 则由服务器按原始快照规划覆盖全文的 UTF-8 对齐片段，避免中文/emoji 跨界截断。每段创建：
  - `personal_memories` 片段行（`origin_kind='document_fragment'`，`candidate` 状态）；
  - `personal_consolidations` 整理任务（复用现有 PersonalConsolidator，含队列容量检查 `MAX_PERSONAL_JOBS`）；
  - `personal_document_fragments` 绑定行（记录原文 SHA、文件标识与字节区间）。
  三者在**同一事务**内原子提交，稳定 `event_id` 重放防止重复写入。同范围已有任务时，新事件返回 `conflict`，应查询原任务或重放原事件，而不是生成新编号。队列满额不删除已有数据。
- 原文件允许保留含 NUL 的合法 UTF-8；但 PostgreSQL text/模型片段不能含 NUL 或全部为空白，排队时整次返回 `fragment_not_processable`，不更改原文件、不丢弃字符。
- 模型处理沿用现有整理语义：需要另行明确 `allow_model_call:true` 运行；未配置模型时返回 `needs_model`，不会伪造结果。片段与模型输出都只是 `candidate`，**不会自动成为已确认记忆**。

## 归档语义

`ultra_personal_document_archive` 归档文档时，在同一事务内：

1. 文档转为 `archived`（`revision+1`）；
2. 片段记忆行转为 `archived`，退出当前使用范围；
3. 相关未完成任务（含持有租约的 in-flight 任务）被围栏为 `stale`（`source_archived`），旧 worker 无法再写回；
4. 派生记忆通过现有 `PERSONAL_DERIVATION_CURRENT` 失效：不再出现在个人上下文，但行保留并可查（`derivation_current=false`）。

**原始文件字节与元数据保留**，可继续下载核对；归档不是物理擦除。已归档文档不能再排队。

## 快照不可变

文档片段行受 `origin_kind` 围栏：`ultra_personal_update` 与 `ultra_personal_review` 对其返回 `document_bound`。修改文件的正确方式是**导入新快照**（同标签不同内容会生成新的 `document_id`；相同字节、标签但不同 Agent 或项目同样是独立快照，避免错误复用旧目的地），而不是改写已有片段。

## MCP 接口（compatibility 模式）

| 工具 | 写 | 说明 |
|---|---|---|
| `ultra_personal_document_import` | 是 | 显式导入一个文件（`event_id`、`agent_id`、`consent:true`、`label`、`content_base64`、`content_sha256`、可选 `project_id`） |
| `ultra_personal_document_list` | 否 | 元数据列表（含片段计数），不返回内容 |
| `ultra_personal_document_read` | 否 | 返回原始字节（base64）+ 元数据 + 完整性自检（`document_corrupt` 拒绝被篡改行） |
| `ultra_personal_document_queue` | 是 | 显式排队：可指定区间或省略区间由服务器 UTF-8 对齐规划全文 |
| `ultra_personal_document_archive` | 是 | 归档并围栏，保留原文 |

## 个人管理台

管理台新增“导入文档”视图：选择文件 → 明确勾选同意 → 导入；列表只显示元数据；查看原文为**纯文本展示**（`textContent`，不内联执行）；**下载只由明确点击“下载原文”触发**，下载后应本地核对 SHA-256；排队整理需确认（服务器规划 ≤32 KiB 的 UTF-8 对齐片段）；归档需确认并明确“不是物理擦除”。读取文件、计算指纹和注册 Agent 的异步等待之后再次核对当前文件、项目、登录会话和同意状态；撤销同意不能被旧事件续传绕过。锁定管理台会清空原文预览和内存文件缓存，迟到的读取响应不能重新填入预览。

## 已接通的打包客户端

`ultrabrain-client` 的 CLI 已接入 `document-import`，受限 MCP 转发器已注册全部五个文档工具。文件写入使用独立的 profile 开关 `allow_documents:true`（生成器为 `--allow-documents`），默认关闭；不因开启 `allow_capture` 的聊天采集而开启文件写入，反之亦然。只读配置可列出/读取同身份已有文档，不能导入、排队或归档。

先按 CLIENT-KIT.md 构建并安装**同一候选提交**的包。当前私有包版本仍为 `0.14.0-alpha.1`，不能用同版本的旧构建代替本提交的包。配置中保留实际服务器、source 和项目；不填写示例 UUID 冒充实际身份。使用标准输入传入明确的单文件请求，不把正文或凭据放进命令行参数：

```bash
printf '%s\n' '{"path":"/your/selected/notes.md","agent_id":"personal-files","event_id":"file-event-001","consent":true}' | \
  node /installed/node_modules/ultrabrain-client/dist/cli.cjs document-import --profile /private/client-profile.json
```

示例路径须替换为用户明确选择的文件和实际安装位置；PowerShell 同样可以把 JSON 管道传入上述命令。输出仅含导入回执/元数据，不回显正文。配置级文件许可与**本次** `consent:true` 缺一不可；`readLocalDocument` 本身只产生选定内容，不代表批准传输。`deliverDocumentImport` 不制造同意，冻结请求并在每个异步身份/登记步骤后执行同步授权检查。CLI 绑定最初配置，等待 stdin 或连接期间改了服务器/项目/许可会拒绝继续导入。

这条文件命令不复用聊天 outbox。网络结果未确认时应保留同一文件字节与事件编号，不能把重新读取后已变化的文件冒充原请求；相同事件不同内容会冲突。已发出的请求无法撤回。用户选择的文本可能含秘密，本功能没有通用自动脱敏保证。

## 测试与恢复

- 纯契约与客户端边界：`test/personal-documents.test.mjs`、`test/client-document-boundaries.test.mjs`（Node 22.16+，Windows/Linux）。
- 实际打包 Node CLI、MCP 转发及 PostgreSQL：`test/document-client-integration.mjs`；不是只检查对象的单元测试。
- 真实 PostgreSQL + 实际 stdio MCP 集成：`test/personal-documents-integration.mjs`（Linux CI；`npm run test:documents`）。
- 管理台 API 全链路：`test/personal-console-integration.mjs` 已含文档生命周期。
- 备份恢复：`test/restore-verify.py` 对 `personal_documents` 完整行（包括 bytea 原文、来源、主体、项目与 Agent）做 SHA-256 指纹比对，`personal_document_fragments` 同样全列指纹；不是只数行数。

接收端修复与测试范围见 `docs/reviews/PERSONAL-DOCUMENTS-RECEIVER.md`。本地原审核记录保持原样，只证明它审查过当时的源码，不能代替当前候选的 Linux CI 或独立复审。
