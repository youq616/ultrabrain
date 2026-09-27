# n8n：明确读取一页候选记忆元数据

本模块为现有 Ultrabrain n8n 节点增加 **List Personal Candidates**，使用已存在的 `ultra_personal_candidates`。它补齐“工作流获得待审编号 → 另外安排人工核对”的入口，不自动读取全文、纠错、启用或归档。服务端及共享候选页合同保持原样，没有数据库迁移或权限扩张。

## 配置和运行

使用此提交构建的私有 `n8n-nodes-ultrabrain` 包，不将相同版本号的旧包当成本轮产物。安装属于操作者的自托管 n8n 管理操作，本模块的构建和测试不会改动已运行的服务。凭据的源根 URI 必须匹配服务器认证来源；目录根不可用于个人候选。按原有 Check Connection 流程核对实例和主体后，填入可信 Expected Instance UUID 与 Expected Actor SHA-256。候选操作不会自动采纳未知响应里的身份。

凭据新增 **Candidate Project ID**，默认空。它是可信配置，不由输入项 JSON 或普通节点参数决定。空值只允许 `global-only`；非空允许操作者明确选择 `global-and-project`，读取全局加凭据中指定的一个项目。项目是原样 ASCII 标识，不修剪、归一化或从编辑草稿推导。选择 `global-only` 时不会查询凭据项目。客户端范围是附加约束，不能替代服务器认证和所有权隔离。

在节点选择 List Personal Candidates 后，范围默认未选择，同意默认关闭。每个输入项必须单独获得明确同意；填写页大小（1–50，默认20）和可选 After Candidate ID。空游标从头读取；后续页由工作流作者明确使用同一主体和范围上一页的 `page.next_after`。更换主体或范围应清空游标。不得为了模拟翻页把同一页复制为多项输入；每项是一个新请求，不是自动分页或缓存。一个执行最多沿用既有1000输入项上限。

示例 `examples/n8n/personal-candidates.private.json` 是未启用、无凭据、无预填同意的手动工作流。没有定时器、Webhook或重试设置；导入示例不会自行启动任务。示例设置禁存成功/失败/手动执行数据，但实际实例的权限、版本、日志和工作流设置仍需管理员核对，不能据此承诺 n8n 永不保存元数据。

## 输出和隐私范围

每个成功输入对应一个输出项，保留 `pairedItem.item`，JSON 为 `{ok:true, operation:'personal_candidates', result:{page, memory_writes_requested:false}}`。不会把每条记忆展开成缺少原输入关联的输出。`page` 是原有共享候选合同：只含当前主体拥有、Agent 来源、candidate 状态、全局及明确项目范围内的有限元数据。原文采集输入也可能是候选，不应自动当成已提炼事实。已启用/归档条目、其他主体、其他项目和文档片段不进入清单。

本操作不读取上游输入的 `json`/`binary` 内容，也不求值无关的 query/transcript/context 参数。网络请求仅携带内部新建 request_id、页大小、选定的凭据项目和可选游标，不传工作流输入正文、秘密、scope 或 consent 字段。认证凭据仍正常通过已有 MCP 认证传输发送给固定服务器。

完整 MCP 响应只接受一个有界 JSON 文本，不接受图片、资源、附加元数据/结构化内容通道、重复 JSON 键、隐藏属性或访问器。再使用**同一份**候选页合同校验来源、请求、项目、游标、行数、状态和排序；任意异常拒绝整页，不回退到会读取正文的 memory search，也不将失败当作空库。

这些字段本身仍可能私密。数据库所存指纹不是正文再校验或真实性证明。多页是实时观察，不是快照或总数；记录在当前游标之前重新成为候选时，需要从头刷新。元数据不能作为写入授权；人工纠错/启用仍必须另行重新读取完整当前记录及版本并明确同意。本操作不自动连接到写入节点。

## 失败和取消

错误是固定安全代码及 `read_delivery: not_started | unconfirmed`，始终 `memory_writes_requested:false`。不回显 SDK/数据库/凭据异常的原始文本。未开始表示尚未尝试候选请求，不表示完全没有身份或连接请求。已进入候选传输后采用保守的未确认状态；取消不能撤回已经送达服务器的只读查询。

continueOnFail 保留错误项的输入关联，且不伪造 `result.page`。取消后停止后续项，并撤下尚未交付的前面候选结果。关闭连接失败时，同样不交付候选页；既有操作已确认的写入不会被改报为没有发生。没有自动重试或下一页预取。连接、请求前和响应后均检查实例/主体绑定；凭据在每次节点执行开始时固定一份，运行中的全局凭据编辑并不等于本次执行的实时撤销。服务器令牌撤销和 n8n 的执行取消仍各自生效。

## 验证入口及边界

`node --test test/n8n-candidates.test.mjs test/n8n-candidates-review.test.mjs`：生产 executor/session、合成 MCP/执行上下文，另用真实节点定义检查默认值、参数和输入关联。这不是实际 n8n 引擎证明。

`ULTRABRAIN_N8N_INSTALLED=/absolute/unpacked/package bun test/n8n-candidates-integration.mjs`：实际编译包、官方 MCP/HTTP、隔离 PostgreSQL；执行上下文仍是夹具。使用真实认证主体准备合成数据，随后将令牌降到只读，再验证分页、身份隔离、项目、长正文、原文输入和文档片段排除。读取/拒绝阶段六表指纹不变；生成器/外部模型0。

同一命令加 `--engine`，并设置实际 `ULTRABRAIN_N8N_BIN`，才会运行仓库已锁定的 n8n 2.38.7 / Node24 引擎：私有凭据导入、节点加载、手动首/次页、凭据项目范围和不同意拒绝。新增只读权限 CI 工作流执行这一路径；工作流存在不是执行成功声明，结果须按最终SHA核对。原 n8n-integration.mjs 以及上轮未发布控制台文件未改动；此前概览操作的专门引擎验收缺口不因候选操作的结果自动关闭。

官方参考：n8n 的 Item linking for node creators 与 Programmatic-style execute method。本模块显式保留输入输出配对，不使用不受限制的 Agent tool 暴露。
