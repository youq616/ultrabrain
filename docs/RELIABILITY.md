# 可靠采集、项目续接与执行证据

## 一次接入

```js
import {AgentMemory} from './src/agent-memory.mjs';
import {DurableOutbox} from './src/durable-outbox.mjs';
const principalId = 'agent-development-1'; // 来自实际认证配置，不是模型猜测
const serverId = 'ultrabrain-production-1';
const rootUri = 'ultra://development/';
const outbox = new DurableOutbox({
  directory: '/home/agent/.local/state/ultrabrain-outbox',
  rootUri, principalId, serverId,
});
const memory = new AgentMemory({
  client, rootUri, principalId, serverId, outbox,
  sessionId: 'development-session-1', projectId: 'ultrabrain',
  capture: true, visibility: 'world',
  captureFilter: text => text, // 替换为确定性的脱敏/排除规则；null 排除回合
  deferExtraction: false, // 需要延后整理时显式设为 true
});
const result = await memory.runTurn({
  input: '继续开发', eventId: 'turn-0001',
  generate: async ({input,evidence,projectContext,signal}) =>
    yourModel({input,evidence,projectContext,signal}),
});
```

client 是已连接、认证的 MCP Client。先创建项目 checkpoint；没有 projectId 的旧用法继续有效。检索和项目状态都是数据，不是系统指令或执行授权。未运行的 Agent 不会因为保存了检查点自动继续工作。

capture 默认关闭，只处理调用者提交的数据，不自动读取浏览器、磁盘或其他会话。private 为 host-private；远程共享检索需独立 source 和明确可见性，world 不绕过授权。

## 交付与重试

事件用稳定 session_id/event_id。脱敏后先写 0600 文件并 fsync 文件/目录。outbox 目录绑定 server、principal 和 root，不能自动认证远程主体，接入方须保证与凭据一致。用于本地 Linux 文件系统，不把共享 NFS 语义冒充等价。

入队后网络失败、超时或丢 ACK 可重试相同事件，不重新生成模型回复。多个 drainer 可能重复提交，依赖服务器回执去重，是至少一次而非 exactly-once。内存生成完成但尚未成功入队的进程崩溃仍可能丢失输出。

runTurn 开始前最多补交 8 个到期事件；程序未运行时没有隐形 worker。永久失败保留事件，修复配置后可 flushOutbox({limit:32,force:true})。损坏/不安全记录被隔离，force 不绕过；未确认内容不自动驱逐。队列数量是并发生产者下的软限制，不是文件系统硬配额；ACK 删除策略与静态加密仍需运营配置。

同步模式区分本地 queued、服务端 unconfirmed、storage:stored 和 extraction_state。延后模式另用 storage:journaled，回执只证明原始交付，canonical 发布和模型整理状态单独查询，详见 [延后整理](DEFERRED-SESSIONS.md)。

## 项目检查点

六个工具：ultra_project_load、ultra_project_save、ultra_project_resume、ultra_project_history、ultra_project_evidence、ultra_project_forget。

创建 expected_revision=0；修改要求最近读取的 revision，冲突时返回 revision_conflict，不静默覆盖。event_id 表示不可变的同一次更新，不同内容或 actor 重用会拒绝。

```json
{
  "project_id":"ultrabrain",
  "event_id":"checkpoint-0001",
  "expected_revision":0,
  "state":{
    "goal":"完成 Linux Agent 记忆服务",
    "constraints":["同机托管 PostgreSQL","不依赖 Docker Hub"],
    "decisions":["复用 GBrain 并按项吸收 OpenViking"],
    "tasks":[{"id":"regression","title":"运行回归测试","acceptance":["指定测试命令退出为 0"],"status":"in_progress","receipt_ids":[]}],
    "blockers":[],"next_actions":["执行并核对测试结果"]
  }
}
```

状态分 planned/in_progress/blocked/reported_complete/verified_complete。自述完成不能冒充有证据完成。项目属于 source 共享数据，新 metadata 工具只对完整 source grant 开放，不支持目录绑定或 delegated 绕过原生 ACL。

resume 提供目标、未完成任务、阻塞和下一步形成的检索查询。AgentMemory 项目摘录另限 4 KiB，证据另有预算，均非模型 token 总量。截断 JSON 文本不能被当完整 JSON 解析。

## 主机执行证据

```bash
bun src/cli.mjs verify --source development --project ultrabrain --task regression --kind test -- node --test test/projects.test.mjs
```

不通过 shell 解释，不开放 MCP 任意命令执行。记录进程退出码、输出 hash 和可用的前后 Git 观测，不记录参数/日志明文。回执绑定 source/project/task/规范；失败、伪造、跨项目或规范改变后的回执拒绝 verified_complete。

旧任务没有代码绑定，只证明选定进程的退出结果。0.4.0 可在任务显式设置完整 code_revision，让验证 additionally 要求同一干净 Git 提交，详见 [代码版本证据](REVISION-EVIDENCE.md)。这不证明测试充分、构建密封、CI 或远程部署成功。选定命令和可信主机仍在信任边界内。

## 项目遗忘与升级

forget 要求当前 expected_revision 和 confirm 精确等于项目 ID。删除活动状态、历史、回执，保留无正文 tombstone 防止旧事件重新创建。同名独立页面、WAL 和历史备份不在删除范围，不能声称物理彻底擦除。

升级前停 MCP/写入并备份。在原服务账号下执行 db init、migrate、health；涉及数据库二进制时按 UPGRADES.md 与 PORTABILITY.md 先构建、停库、显式激活。迁移账本保持既有编号/校验不变，不能只切回旧二进制就声称回滚成功。

native schema 固定 public，自有元数据在 ultrabrain。发现旧安装有 ultrabrain.pages/sources/config/facts 影子表时拒绝静默切换，需备份并在副本核查；不要直接删除其中一套。旧 JSON 字符串回执仅在可安全解析为对象时转换，不把异常值伪装成修复完成。
