# 延后整理：先可靠保存，再调用模型（0.4.0-alpha.1）

## 接入

默认仍同步执行；需要明确开启。保留原来的 MCP client、source、稳定主体及 outbox 配置，增加：

```js
const memory = new AgentMemory({
  client, rootUri: 'ultra://development/', sessionId: 'session-1',
  principalId, serverId, outbox,
  capture: true, deferExtraction: true,
  visibility: 'private',
  captureFilter: redactBeforePersistence,
});
await memory.afterTurn({eventId: 'turn-1', transcript: consentedTranscript});
// 在另一执行路径触发整理，不在回复前强制调用。
await memory.processPending({limit: 1});
const status = await memory.sessionStatus('turn-1');
```

`private` 仍为 GBrain 的 host-private，不是远程主体本人可检索的私有空间。提交者可在当前授权下整理原始事件，但私有页面不能通过普通远程 ultra_read 读取。共享检索需要独立授权 source 与明确的 world 可见性；world 不绕过 source 授权。

MCP：ultra_commit_session 增加 defer_extraction:true；新增 ultra_process_sessions 与 ultra_session_status。处理请求的 expected_source 必须等于认证授权的 source，它不能选择或扩大授权。

## 三个独立状态

1. storage:journaled、state:queued：原始事件和回执已在同一 PostgreSQL 事务中持久化，没有调用模型，也没有发布到页面检索。
2. canonical_state:stored：已通过原生受控操作发布页面；发布和提取不在同一事务。
3. extraction_state:completed / needs_model / failed：提取调用完成、模型未配置/禁用、处理失败。completed 不保证提取内容真实或正确。

queued 返回的 URI 只是预留目标地址，不能据此认定已经可检索。completed 后清除队列原始 payload，保留内容 hash 与状态；canonical 页面继续保留。needs_model 和失败事件保留原始数据。

outbox 收到结构有效的 journaled 回执后可删除本地 transcript。ACK 证明交付，不是实时提取状态；后续应查询 status。相同 session/event 不允许更换内容、可见性或 inline/deferred 模式。新 deferred URI 使用完整标识对的 hash，避免大小写不同的事件落到同一个小写 slug。

## 独立整理客户端

先按 DEPLOYMENT.md 配置受认证的 HTTP MCP。客户端必须使用采集者**同一稳定主体**的凭据；不同主体即便有相同 source 权限，也不会领取其任务。新建不同 static token 可能改变身份，不能假定自动继承旧主体队列。

```bash
bun scripts/consolidate.mjs \
  --url https://memory.example.com/mcp \
  --token-file /home/agent/.config/ultrabrain/producer-token \
  --source development
```

默认只运行一批；明确加 --loop --interval 60 才持续轮询。未启动客户端时没有隐形任务。本版不会自动安装、启动 worker 服务或配置付费模型。

模型恢复后可显式单次 --retry，或 memory.processPending({retry:true})。不允许 --loop 与 --retry 合用，避免反复消耗缺模型事件的次数；重试须满足 5 秒间隔。

令牌文件必须由本用户拥有且为 0600 普通文件。每次请求重读，不输出令牌；远程要求 HTTPS，HTTP 仅允许 loopback。凭据不会发送到其他 origin，也不跟随重定向。服务端对每个新请求鉴权，撤销或降权后新处理请求被拒绝；已经接受的请求不承诺立即取消。

## 授权、并发与限额

队列不保存令牌、数据库 URL、任意命令或完整 operation context。处理只领取当前 source + 当前认证 actor 的事件，使用该请求的权限调用原生 put_page 和 extract_facts，不提升为主机权限。目录绑定、delegated、降级授权不开放此能力。

原子领取使用 FOR UPDATE SKIP LOCKED，模型调用期间不持有行锁。租约 15 分钟，崩溃后可在当前授权下重新领取。过期租约或丢失 ACK 可能重复原生调用，这是至少一次而非 exactly-once。数据库队列机制参考 PostgreSQL 官方 SELECT 文档：https://www.postgresql.org/docs/18/sql-select.html 。

每 source 最多保留 1000 个含原始 payload 的延后任务，满额拒绝新入队而不丢旧数据。每事件最多处理 5 次，failed/needs_model 不自动热重试。达到上限仍保留数据，需可信管理员核查；本版没有远程重置次数或强制删除接口，不是无限磁盘配额或完整生命周期管理。

## 尚未包含

未证明模型准确率；没有多主体共享的管理员自动调度、完整删除传播、自动清理历史备份、静态加密密钥管理。队列仍在同一 PostgreSQL 内，不是第二套事实或向量数据库。旧同步模式继续可用，不静默切换。
