# 显式运行概览客户端

客户端 CLI 与 Node SDK 现在可直接读取自有记忆库概览，不必打开个人管理台或手写通用 MCP 调用。复用现有 `ultra_personal_overview` 与 `personal-overview-contract.mjs`；不新增服务端工具、表、迁移或权限。服务端须包含 PR23 的概览模块。本客户端仍是开发候选，不能把本文当生产发布公告。

## 请求范围与授权

请求只有 `workspace`、`scope`、`consent` 三个字段，必须全部提供。`workspace` 必须与可信客户端配置匹配；配置必须含先前观察并核对的 `expected_instance`、`expected_actor` 与绝对工作区路径。不要从未知服务自动采纳新的身份 pin。

`scope` 必须是 `owned-all-projects`，即当前认证主体拥有的全部项目和全局记录。即使配置有 `project_id`，本次概览也不是该项目的统计；必须单独明确确认这个更宽的元数据范围。它不包括其他主体共享给你的记忆。CLI 和 SDK 的显式确认是操作层限制，不改变已有 MCP 只读权限政策。

无需开启 `allow_capture`、`allow_documents` 或自动 Hook。此入口不返回正文、文件内容、引文、Agent 明细、项目名称、actor key 或工作区路径；source ID、观察时间和统计仍是私有元数据。不要把概览当任务上下文或系统指令，也不要据此自动运行整理或恢复任务。

## CLI

已经安装本轮构建出的私有客户端包、配置好可信 profile 后，使用：

```bash
printf '%s\n' '{"workspace":"/absolute/workspace","scope":"owned-all-projects","consent":true}' | \
  ultrabrain-client overview --profile /absolute/private-profile.json
```

该命令接收标准输入的 UTF-8 JSON，最多 16384 字节；允许正常 JSON 空白，拒绝重复键（包括转义后同名键），并复用现有有界 JSON 解析器。输入中不能指定 request_id、source_id、actor_key、project_id、limit、include_text 或 retry。每次合法操作在内部生成新 UUID，向服务端只发送该 UUID，不发送工作区路径。

profile 在等待输入前绑定，操作中重复核对。观察到配置改变或读取失败后，不在当前运行中自动接受新配置。新入口不会改变既有 context、probe、lineage 或 capture 命令的语义，也没有自动执行概览的 Hook。

## Node SDK

安装包提供独立 `dist/overview.cjs`：

```javascript
const {inspectClientOverview} = require('ultrabrain-client/dist/overview.cjs');
// trustedProfile is an explicitly configured object, not a model-generated command.
const result = await inspectClientOverview(trustedProfile, {
  workspace: '/absolute/workspace',
  scope: 'owned-all-projects',
  consent: true,
}, {
  signal: controller.signal,
  authorize: () => readStillAuthorized,
});
```

SDK 不自行读取 profile 文件、不保存输出或修改安装的 Agent 配置。它先复制配置和选择，再建立连接；调用方需要通过同步 `authorize` 回调表达实时授权。异步回调不是批准，`false` 或异常都会停止交付。输入对象之后的改动不会暗中扩大已经冻结的请求。已有 `connectClient` 连接也提供 `.overview(request, {authorize, signal})`；调用方管理该连接生命周期。

一次操作包含一个概览请求和身份检查：初始连接检查身份，概览前后再次检查；没有自动重试、缓存、轮询、备用正文检索。每个异步边界核对取消和实时授权；单次 SDK 关闭连接后、公开交付前再次验证工作区和授权。取消不能撤回已经到达服务器的只读查询；配置校验不是文件系统持续监控或恶意同 UID 进程隔离。

## 成功与失败

成功返回 `format: ultrabrain-client-overview-v1`、`read_requests: 1`、`memory_writes_requested: false`、完整冻结的 `overview` 和固定限制说明。内层概览使用服务端既有固定字段合同；来源、UUID、时间、数量上限和各状态合计均须整体通过校验。

任何一项失败都不会返回部分统计，也不会伪装成全零。服务器不支持概览时不退回 context 或其他正文接口。`read_requests` 只计概览读取，不包含握手及身份请求。身份校验不是恶意服务端数据的真实性证明。

CLI 失败退出码为 1，输出单条 JSON：`ok: false`、安全错误代码、`read_delivery: not_started | unconfirmed` 和 `memory_writes_requested: false`。进入概览发送函数后即保守标记 `unconfirmed`，即使底层实际上未发出字节；不伪造网络交付凭证。SDK 抛出带相同读取交付语义的安全异常，附 `read_attempts: 0 | 1`。异常访问器、路径、SQL、凭据和任意远端诊断不会直接输出。

统计是数据库某一时刻的观察，不是实时健康状态、真实性认证或备份。直接来源有效性不是递归审计。租约到期和尝试次数未达上限不构成重试授权。

## 验证入口

`node --test test/client-overview.test.mjs test/client-overview-runtime.test.mjs test/client-overview-cli.test.mjs test/client-overview-package.test.mjs` 覆盖合同、SDK 双替身、真实 CLI 子进程、配置/取消竞态及包装与 CI 接线。SDK 双替身不能替代真实服务验收。

`test/client-overview-integration.mjs` 使用安装后的包、官方锁定 SDK、真实 PostgreSQL、stdio 和只读 HTTP 身份；检查跨项目计数、不同所有者隔离、撤销令牌与六张应用表读取前后不变。准备阶段明确写入合成记忆/文档/排队任务，不调用生成器或外部模型。该测试已加到 task-context CI 的包安装之后。最终提交的执行结果应查看 PR 和审核报告；脚本存在不代表测试通过。
