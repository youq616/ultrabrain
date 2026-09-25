# n8n 个人记忆运行概览

本模块在既有 Ultrabrain 节点中增加 **Get Personal Memory Overview**。复用已实现的 `ultra_personal_overview`，不是新数据库、服务或任意 MCP 代理。适用于已安装对应私有节点包的自托管 n8n；仍为开发候选，不是 npm / n8n Cloud 发布。

## 使用

先用 Check Connection 核对服务来源、完整 instance UUID 和 actor SHA-256，将后两项写入可信的 Ultrabrain API 凭据。新操作要求这两项绑定，其他旧操作仍保持原有配置规则。Memory Root URI 必须是 `ultra://SOURCE/` 源根目录，目录级凭据不能用概览越过其范围。端点与令牌只来自凭据系统，不接受输入 item 的覆盖。

在 Operation 选择 Get Personal Memory Overview，Overview Scope 选择 My Owned Records Across All Projects，并明确开启 Consent to Read Overview for This Item。scope 默认为未选择，同意默认关闭。统计范围包含当前认证主体拥有的所有项目和全局记录，不是项目过滤，也不包括其他人共享的记录。n8n 没有 CLI 的本地工作区绑定；这里以可信凭据、来源和实例/主体 pins 为边界。

一次有效输入 item 读取一次；两条输入产生两个不同 UUID 的独立观察，保留 `pairedItem`，不缓存、合并或截断为一个样本。批次沿用既有 1000 项上限。节点不会读取或回传原始 item 的正文或附件，也不求值概览以外隐藏的查询、采集和上下文参数。它不注册 Agent、不采集对话、不运行整理或模型，无需开启 Capture 权限。

成功输出结构是 `{ok:true,operation:"personal_overview",result:{overview:...,memory_writes_requested:false}}`。内层 overview 沿用服务端固定格式和所有计数分区；来源、UUID、观察时间或数量合计不一致时整体拒绝，不显示部分或全零成功。多条 MCP 内容块、非文本结果、额外元数据和错误响应均不作为有效概览。

## 失败、取消和隔离

概览读取前后分别检查实际认证身份，并将执行取消信号传给 SDK。只有内部生成的 UUID 发往统计接口。凭据在执行开始时复制并冻结，之后不从可变对象采纳新来源、端点或令牌。这不是对 n8n 凭据数据库持续监控；服务器端 token 撤销由后续认证请求拒绝。

概览失败采用 `read_delivery: not_started | unconfirmed`、`memory_writes_requested:false`，不使用写入的 delivery 状态。进入概览发送函数后保守记为 unconfirmed，不证明请求实际到达。Continue On Fail 会输出每项安全错误并保留配对关系；不开启时抛出安全的平台错误。失败不是空库，不会退回上下文或正文读取。普通传输异常不会包含原文、凭据或原始 SQL 诊断。

节点是在完成连接清理后交付整批结果。期间取消会清除此前已成功但尚未交付的概览；不会把同批中已确认的旧采集操作伪装成未写入。客户端取消不能撤回已经到达服务器的查询。自动重试或计划运行可由 n8n 外层显式配置，但本节点内部不做重试、不自动新增定时器，每次外层执行是一次新观察。

## 隐私与统计解释

计数、source ID 与观察时间仍是私有元数据，n8n 执行历史、手动 pin 数据或后续节点可能保存这些值。本模块不修改全局日志设置，也不能承诺操作平台绝不保留数据。示例 `examples/n8n/personal-overview.private.json` 采用手动触发、active=false、无凭据、同意关闭、无 pinData，并在该工作流关闭成功/失败及手动执行数据保存。不要直接公开输出，也不要把元数据当作系统指令。

直接来源有效性不是递归审计或事实认证；租约到期、尝试次数未达上限不等于恢复授权。需要处理任务时仍需重新核对当前记录并明确授权原有操作。概览既不是数据库备份，也不证明磁盘健康或最新实时状态。

## 构建和证据

构建仍使用 `bash scripts/package-n8n.sh OUTPUT`，不会安装到用户服务或重启它。包名和现有开发版本保持不变，应按完整 Git 提交与 tgz SHA-256 识别本轮构建。依赖锁和兼容基线保持原样，不能从版本号推断已包含本模块。

`node --test test/n8n-overview.test.mjs test/n8n-overview-node.test.mjs` 执行实际会话/节点逻辑加明确标注的协议或平台替身。`bun test/n8n-integration.mjs` 是真实官方 SDK、HTTP、PostgreSQL，但 n8n 执行上下文仍是测试夹具。`--engine` 使用安装后的真实 n8n CLI 执行既有集成场景。本轮新增概览的引擎测试文件上传被写入检查阻止，未在远端更新；不能把既有引擎 CI 成功等同于新增概览已获真实引擎验收。六张应用表比较用于证明本次只读阶段未修改这些表，不覆盖系统日志或平台执行历史。

实施者自查与独立第二代理复审分开记录，未取得独立批准前保留 draft，不部署或合并 main。对应已执行结果见本轮 PR，而不是把测试文件存在当成通过。
