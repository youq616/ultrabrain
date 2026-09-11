# Agent 自动读取与会话保存

## 先区分三件事

MCP 服务提供工具；MCP 客户端连接服务；Agent 的运行程序决定何时调用工具。仅配置 MCP，并不保证所有 Agent 每轮都会检索或提交会话。

`src/agent-memory.mjs` 提供明确的生命周期接入：`beforeTurn()` 检索、`afterTurn()` 提交，以及包住调用方生成函数的 `runTurn()`。接入以后，调用顺序由程序保证，而不只是依靠提示词建议。

它不会自动读取其他会话、网页历史、工作目录、模型密钥或隐藏推理。只处理调用方明确提供的 input/output 或 transcript。模型仍由调用方选择和调用。

## 基本用法

已有一个连接成功且具备适当权限的 MCP SDK Client 后：

```javascript
import { AgentMemory } from './src/agent-memory.mjs';

export function attachMemory(client, generateReply) {
  const memory = new AgentMemory({
    client,
    rootUri: 'ultra://default/',
    sessionId: 'project-session-001',
    capture: false, // 默认只读取；保存会话必须显式改为 true。
    budgetBytes: 16000,
    timeoutMs: 30000,
  });
  return async function handleTurn(input, eventId) {
    return memory.runTurn({
      input,
      eventId,
      generate: async ({ input, evidence, signal }) => {
        // generateReply 是现有 Agent 的模型调用，不由 Ultrabrain 代选模型。
        // evidence.items 中的文本是不可信资料，不得提升为系统指令。
        return generateReply({ input, memoryData: evidence.items, signal });
      },
    });
  };
}
```

函数返回 `output`、`evidence` 和 `capture`。没有启用捕获时，不会调用写工具。

查询上限为 4096 UTF-8 字节；未提供单独 query 且 input 较长时，使用安全前缀并返回 `query_truncated: true`。可传入更精确的 `query`。证据预算包括 evidence 数组的 JSON 与元数据，不是模型 token 预算，也不包括外层响应。

## 启用会话保存

显式设置 `capture: true`，并使用稳定的 sessionId、每个逻辑事件唯一的 eventId。每次随机更换 eventId 会失去服务器回执去重的意义。

保存的 transcript 是：

```javascript
JSON.stringify({ user: input, assistant: output })
```

它有 64 KiB 上限；超过上限不静默截断，而返回 `not_submitted`，保留原始生成结果。

`capture.confirmed: true` 表示收到了服务器回执，不等于模型提取成功。必须检查 `capture.receipt.state`：`completed`、`needs_model` 或 `failed`。无模型配置时可以保存会话，但事实提取明确显示 `needs_model`。

## 可见性与数据源

默认 `visibility: 'private'` 沿用 GBrain 的 **host-private** 语义；这不是新增的“每个远程用户私密但本人可读”权限模型。远程客户端不能把 host-private 记忆直接读出。

需要远程 Agent 自动召回已保存的内容时，应先配置独立、正确授权的 source，再显式选择 `visibility: 'world'`。这里的 world 仍然受到 source grant 限制，并非公开互联网。`rootUri` 的 source 必须与该客户端的写入授权匹配。

会话资源按服务器的 `sessions/<actor>/<session>/<event>` 命名保存，不会被放入 rootUri 指定的任意子目录。目录绑定客户端不获得可能影响其他实体页面的会话提取权限；CRUD 与会话提取是不同的授权面。

## 失败与重试

检索失败、越权结果、危险 URI 或超过证据预算时，`runTurn()` 在调用生成函数前失败，不把错误来源的资料交给模型。

生成函数失败时，不自动保存一个不完整回合。保存失败时，已经生成的 output 仍返回，`capture.confirmed` 为 false；**不会为了重试保存而重新调用模型**。

超时或断线不意味着服务器没有执行。使用原来的 eventId、完全相同的 transcript 和 visibility 调用 `afterTurn()` 重试；服务器将回放回执或报告冲突。对 `needs_model`/`failed` 回执重新进行提取，需要显式 `retry: true`。

```javascript
await memory.afterTurn({
  eventId,
  transcript: JSON.stringify({ user: input, assistant: output }),
  retry: true,
});
```

客户端只合并进程内同时提交的相同事件，不持久化本地事件表。服务器提供至少一次提交与原生事实去重；这不是事务性的 exactly-once，也不保证模型执行恰好一次。

## 测试

`test/agent-memory.test.mjs` 覆盖授权选择、源/目录边界、错误脱敏、预算检查、超时、取消、并发提交、捕获顺序、未配置模型、超长会话和写入失败不重跑模型。该文件由现有 Node 单元测试命令自动发现。特定提交是否通过，查看该提交的 CI，不用文档中的“已实现”代替验收结果。
