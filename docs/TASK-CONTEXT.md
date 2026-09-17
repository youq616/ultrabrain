# 按当前任务召回：显式查询与 Claude 专用 Hook

本阶段把既有个人任务排序接入实际 Node 客户端，新增 `task-context` 和单独的 `claude-task-hook`。没有修改服务端表、排序算法或身份规则，不启动模型，不登记 Agent、不提交记忆、不创建整理任务。它不是语义搜索、自动摘要或事实验证；仍是已有重要性与不同任务词的字面匹配排序，最多 32 个词、100 条候选，结果默认最多 20 条并受客户端字节预算约束。

## 单独授权，默认行为不变

旧 profile 默认不授权这两个新入口。新 profile 的 `allow_task_context:true` 表示允许这两个入口把明确的任务正文发送给选定 Ultrabrain 服务端作为查询；并不开放 capture、documents 或模型权限。它要求通过既有 `probe` 取得并核实 expected_instance/expected_actor，并绑定绝对 workspace。任务文本不是凭据，但仍可能含私人资料；不应提交的内容不要用于查询。没有自动密钥脱敏器。

用 `scripts/client-profile.py` 的既有 SSH/local/HTTP 参数创建**新**配置时，另加 `--allow-task-context`、已观察到的两个身份 pin 和 `--workspace`。只需显式查询时不要加自动范围；希望 Claude 的新 Hook 读取当前主会话提示词时，才另加 `--automatic-task-context claude-user`。对应 JSON 为：

```json
{
  "allow_task_context": true,
  "automatic_task_context": ["claude-user"]
}
```

以上只是新增字段，不是完整连接配置。保留原有 format/source/server/project_id、workspace 与真实身份 pin；不要把示例标识或推测的 actor 填进去。任务正文不保存在 profile，也不放进命令参数或环境变量。配置工具不自动登录、安装客户端或改变现有文件。

**授权边界仅针对新 helper/Hook。**已有通用 MCP 转发器公开的 `ultra_personal_context` 本来就允许调用者显式提供 task，其合同与权限在本阶段保持不变，不能将 allow_task_context 当作限制所有 MCP 工具调用的全局策略。旧 `context`、`bound-context`、`claude-hook` 和其他原生适配器仍按原行为召回；不会因为设置了新字段就自动读取它们的提示词。

## 自研 Agent／显式查询

构建本源码的客户端包（`bash scripts/package-client.sh`）并按 CLIENT-KIT.md 安装；不是 npm 注册表发布。用已安装包的实际路径执行：

```bash
node /your/install/node_modules/ultrabrain-client/dist/cli.cjs task-context --profile /your/private/task-profile.json
```

该命令从 stdin 接收一个 JSON 对象，例如由自研 Agent 写入标准输入：

```json
{"task":"检查部署时不要删除现有配置","workspace":"/your/actual/workspace","consent":true}
```

只允许 task/workspace/consent 三个字段；不接受请求覆盖 source、project_id、budget、任意文件路径或 URL。项目、预算及服务器来自原授权配置。任务必须是 1..4096 UTF-8 字节、非空、编码完整、无 NUL；超限整条拒绝，**不静默截断，不悄悄退化为无任务查询**。较长任务由调用方在理解语义后明确提供较短查询；不能声称截断后的内容仍保留全部否定条件。

返回现有的个人上下文 JSON，只包含服务端批准的 active/current 条目及原有说明；客户端不主动回显请求正文。召回正文可能包含与任务相同的词句。查询失败以非零退出码和安全错误码返回，不把失败伪装成“成功但没有记忆”。

## Claude Code：只处理当前主会话提示词

先完成显式查询验证，再用 `scripts/client-config.py --client claude-task-hooks --target /actual/project/.claude/settings.local.json --profile /private/task-profile.json --cli /install/node_modules/ultrabrain-client/dist/cli.cjs` 预览计划；明确采用时，沿用原工具 `--apply --expected-sha` 与回滚回执机制。脚本只添加 UserPromptSubmit 的新命令，不覆盖 permissions、其他 Hook 或 MCP 配置；disableAllHooks 开启时拒绝。避免在同一个 UserPromptSubmit 同时安装旧 claude-hook 和新 claude-task-hook，否则会有两次召回和重复上下文；SessionStart 的旧只读 Hook 可以保留。

新 Hook 须有 `allow_task_context:true` 加 `automatic_task_context:["claude-user"]`。它仅检查 UserPromptSubmit/session_id/cwd 并读取 prompt；带 agent_id 的子代理事件拒绝，不从父会话继承授权。SessionStart、Stop、其他事件和不匹配的工作区拒绝。绝不打开 transcript_path 或任何事件提供的文件，不读取历史对话、工具输出、助手正文、附件或隐藏推理。匹配的 session_id 只是可信宿主事件的标识，不是对用户身份的新认证机制。

返回 `hookSpecificOutput.additionalContext` 中的记忆参考数据，不改写用户提示词、不设置权限或阻断决策。失败通过 systemMessage 标识未获得任务相关召回，并允许宿主继续；这不是成功召回。官方字段合同依据：https://code.claude.com/docs/en/hooks （UserPromptSubmit 与 additionalContext）。合成 Hook stdin 测试并非实际 Claude 模型回合验收。

## 撤销、数据处理与测试界限

配置在最初读取时绑定；等待 stdin 期间替换 project、server 或授权，不能把旧事件送到新目的地。发送前重新读取配置；每次身份检查后、请求开始前及结果交还 Agent 前，再检查授权、取消与工作区。已发出的请求无法撤回；撤销发生在响应途中时，不再向 Agent 返回这次旧响应。没有新增后台缓存、持久化队列或自动重试。

任务确实离开客户端到达选定服务端。此路径不写个人记忆、Agent 登记、文档或整理任务，也不调用供应商模型；**不等于服务器、反向代理或操作者配置的完整参数日志完全不留记录**。已有原生默认日志使用参数形状摘要；启用了原生 `--log-full-params` 等设置时可能保存正文，部署方须审查日志策略。仍须信任客户端主机、选定服务器及其管理员，不宣称同账号沙箱。

本阶段验证入口：`node --test test/client-task-context.test.mjs`、`python -m unittest discover -s test -p test_task_context_config.py -v`，以及隔离 Linux 安装中的 `ULTRABRAIN_TEST_ALLOW_WRITE=1 bun test/task-context-integration.mjs`。后者运行实际打包 Node 程序、stdio 与只读令牌 HTTP MCP、真实 PostgreSQL，检查旧相关条目召回、跨项目与主体隔离、错误输入、同步的 stdin 配置替换、预算和四类业务表指纹不变。不得对生产记忆库执行测试。最终验收仍需对应提交的 CI 和独立审核，本文件不预填成功结论。
