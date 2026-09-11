# 可靠采集、项目续接与执行证据

## 一次接入：不再依赖模型自觉调用记忆工具

```js
import { AgentMemory } from './src/agent-memory.mjs';
import { DurableOutbox } from './src/durable-outbox.mjs';

// client 是已经连接并认证的 MCP SDK Client。
// 这两个稳定标识来自你的客户端认证配置；不是 token、用户名显示文本或模型猜测。
const principalId = 'agent-development-1';
const serverId = 'ultrabrain-production-1';
const rootUri = 'ultra://development/';
const outbox = new DurableOutbox({
  directory: '/home/agent/.local/state/ultrabrain-outbox',
  rootUri, principalId, serverId,
});
const memory = new AgentMemory({
  client, rootUri, principalId, serverId, outbox,
  sessionId: 'development-session-1', projectId: 'ultrabrain',
  capture: true,
  visibility: 'world', // 仅在已授权的独立 source 内可见，不绕过 source 授权。
  captureFilter: text => text, // 替换为确定性的脱敏/排除策略；返回 null 排除此回合。
});
const result = await memory.runTurn({
  input: '继续开发', eventId: 'turn-0001',
  generate: async ({ input, evidence, projectContext, signal }) => {
    // 调用你的模型；将 evidence 与 projectContext 当作数据，而不是系统指令。
    return await yourModel({ input, evidence, projectContext, signal });
  },
});
```

需要先创建 project checkpoint。没有 projectId 的旧接入方式继续有效。outbox 可单独使用，支持非 JavaScript 适配器实现同一事件合同，但当前提供的是 JS 实现。没有运行的 Agent 或服务调度器，不会凭空继续执行任务。

默认 capture=false。开启后也只处理调用方提供的内容；不会读取浏览器、硬盘或其他未接入会话。private 仍是 GBrain 的 host-private，远程读取要使用正确配置的独立 source 与可见性，而不是把 world 误解为公网公开。

## 交付与重试语义

每个事件使用稳定 session_id / event_id。脱敏后，完整 payload 先写入 0600 文件，再 fsync 文件和目录，通过不可变记录发布。重启后新建同一绑定的 DurableOutbox 即可恢复。ACK 中只保留 hash、URI 和状态；确认后删除本地 transcript。

同一目录必须绑定同一 server、principal 和 root。这个绑定防止意外重用目录，但不能自行认证 MCP 客户端；接入方必须保证这些配置对应实际认证身份。目录应放在本地 Linux 文件系统，不支持把共享 NFS 的锁/持久化语义假装等价。

服务器故障、超时或丢 ACK 后，使用相同事件和内容重试。多个 drainers 可能重复提交，依赖服务端回执去重；不是 exactly-once。永久性错误保留事件并阻止自动重试；修复权限/配置后可显式：

```js
await memory.flushOutbox({ limit: 32, force: true });
console.log(outbox.inspect()); // 不输出 transcript。
```

正常的 runTurn 会在新回合前最多补交 8 条到期事件，不重新生成旧回复。程序未运行时没有隐形后台 worker。退避状态跨重启保留；达到重试上限不会丢弃数据。队列数量上限在并发生产者下是软限制，不是磁盘配额。ACK tombstone 需要纳入运营保留策略。

结果必须区分 `queued`（本地已入队）、`unconfirmed`（不能确认保存）、`storage: stored` 和 `extraction_state: needs_model/completed`。没有模型时可以保存原始会话，但不能声称已提取长期事实。当前服务器仍同步执行原生提取；独立异步整理 worker 列在后续计划中。

注意：持久化保护从 enqueue 成功开始，不等于任意生成过程崩溃都不会损失输出。客户端日志不加密；需要加密文件系统或后续密钥管理。不要把 outbox 放进公开仓库。

## 项目 checkpoint 工具

五个工具：`ultra_project_load`、`ultra_project_save`、`ultra_project_resume`、`ultra_project_history`、`ultra_project_forget`。

创建使用 expected_revision=0；修改必须传最近读取的 revision。两个 Agent 从同一版本写入时只允许一个成功，另一个得到 revision_conflict，必须重新读取和协调。event_id 提供同一次更新的幂等重试；不同内容或 actor 重用事件会失败。

`ultra_project_save` 参数示例：

```json
{
  "project_id": "ultrabrain",
  "event_id": "checkpoint-0001",
  "expected_revision": 0,
  "state": {
    "goal": "完成 Linux Agent 记忆服务",
    "constraints": ["仅使用同机托管 PostgreSQL", "不依赖 Docker Hub"],
    "decisions": ["复用 GBrain 业务引擎，按项吸收 OpenViking"],
    "tasks": [{
      "id": "reliability-tests",
      "title": "运行可靠性回归测试",
      "acceptance": ["指定测试命令退出状态为 0"],
      "status": "in_progress",
      "receipt_ids": []
    }],
    "blockers": [],
    "next_actions": ["执行测试并检查真实结果"]
  }
}
```

状态有 planned、in_progress、blocked、reported_complete、verified_complete。后两者刻意不同：文字自述只能算 reported_complete。新工具只对完整 source grant 开放；目录绑定和 delegated 客户端在工具层也会被拒绝，避免绕过原生页面 ACL。项目状态属于 source 共享数据，不是远程个人私有空间。

resume 返回当前状态和由目标、未完成任务、阻塞及下一步组成的检索查询。AgentMemory 的项目数据摘录独立限制在 4 KiB；原有 evidence 字节预算另外计算，二者都不是模型 token 总量。摘录截断时会标记，不能把部分 JSON 文本当完整对象解析。

## 执行证据：只在主机本地运行

```bash
bun src/cli.mjs verify --source development --project ultrabrain --task reliability-tests --kind test -- node --test test/projects.test.mjs
```

该命令不经过 shell 解释，观察真实子进程退出码和输出 hash，不存储命令参数明文或日志原文。stdout/stderr 被消费用于 hash，不作为实时日志转发。运行完成后生成 source/project/task/任务规范绑定的 receipt_id。将成功的回执 ID 与 verified_complete 一起提交 checkpoint；失败、伪造、其他 source/项目/任务及修改过验收条件的回执都会被拒绝。

**这只证明操作员选定的进程退出状态。**它不证明测试覆盖充分、不自动认证远程推送/部署、不绑定 Git commit，也不允许凭一个成功命令宣布全项目完成。任务与测试命令的对应关系由可信主机操作员决定；后续会增加 Git/CI/产物见证。拥有本机数据库权限的操作者仍属于信任边界。

没有 `ultra_verify_run` MCP 工具，外部 Agent 不能借此接口请求服务器执行任意命令。

## 忘记项目与历史

`ultra_project_forget` 要求当前 expected_revision，以及 confirm 完全等于 project_id。原子删除活动状态、版本历史和执行回执，保留不含正文的 tombstone，阻止旧事件重新创建该 ID。不会删除独立页面、WAL 或历史备份；从旧备份恢复的删除传播仍需生命周期策略，不能宣称物理完全擦除。

## 升级已有安装

先备份并停止 MCP 服务，然后在同一个服务账号下运行：

```bash
bun src/cli.mjs db init
bun src/cli.mjs migrate
bun src/cli.mjs health
```

本版将 native schema 固定为 public，元数据继续在 ultrabrain schema。旧版默认 PostgreSQL search_path 可能已经生成 ultrabrain.pages / sources 等影子表；检测到时会停止，不会静默切换、移动、合并或删除数据。需要分别备份并在测试副本中核对后再迁移，不能简单删除其中一套表。

旧 session receipt 中有效的 JSON 字符串对象会被安全转换回 JSONB object；不解析成对象的异常值保留，不伪装修复成功。
