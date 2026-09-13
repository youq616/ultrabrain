# Personal Core 0.10.0-alpha.1

本轮修复个人开发分支的数据层和 MCP 接线，不是个人 V1 全部功能或所有客户端自动 Hooks 的完成声明。企业扩展暂停；现有企业模式及其固定工具白名单保持不变。

## 已接通的工具

| MCP 工具 | 实际行为 |
|---|---|
| ultra_agent_register / ultra_agent_list | 持久化和列出当前身份自己的 Agent 标签、类型、能力及可选工作目录描述。 |
| ultra_memory_commit | consent:true + 稳定 event_id，原子保存 1..16 条类型化候选记忆；也可只提供 summary，作为 experience 候选。 |
| ultra_memory_search | 查询自己可见的 personal entries，默认 active；candidate/archived 只能看到自己的。 |
| ultra_personal_context / ultra_memory_profile | 读取已明确激活的个人上下文/偏好，按项目与预算过滤。 |
| ultra_personal_review | 按当前 revision 显式设为 active 或 archived；不会自动提升 confidence。 |
| ultra_personal_update | 按当前 revision 整体替换自有记录，修改后回到 candidate，旧确认时间清空。 |

这些工具在 compatibility MCP 的 stdio/HTTP 上注册。governed 企业白名单未自动扩张，不通过企业模式暴露新个人工具。不要为了个人功能盲目放开企业公网入口。

## 身份与共享

agent_id 是客户端自述的标签，不是用户身份。HTTP 的 source 与 actor 来自认证上下文；完整单源授权之外的目录绑定、委托/联合或退化授权会被拒绝。需要 read/write 的操作仍检查实际 scope。没有 HTTP 身份时拒绝访问。

stdio 使用本机服务进程账号代表的主机所有者身份，多个从同一账号启动的客户端可共享此所有者的私有记录；不能把 stdio 的本机信任边界当成跨用户隔离。HTTP 的独立令牌可能属于不同 actor，不能假定与 stdio 所有者相同。

默认 visibility:private，仅当前认证主体可读；显式 visibility:source 且激活后，同 source 的其他具备完整读授权的 Agent 才能读取。其他主体不能修改、激活或归档这条记录。source 共享必须使用专门的个人数据源；不要误共享给企业部门源。个人记录没有被自动复制到原生 pages/facts/vector 表，存储仍在同一托管 PostgreSQL 内。

## 最小调用顺序

先由已认证的 MCP client 调用 ultra_agent_register：

```json
{"agent_id":"codex","agent_type":"coding_agent","capabilities":["code"]}
```

再调用 ultra_memory_commit：

```json
{"agent_id":"codex","event_id":"preference-001","consent":true,"memories":[{"type":"preference","content":"使用完整命令行，不打开编辑器修改配置","importance":"high","visibility":"private","provenance":"用户明确提交的偏好"}]}
```

返回 entries 中的 id/revision 后，使用实际值调用 ultra_personal_review，status:active，另给稳定 event_id。不提供示例 UUID 冒充实际返回值。随后 ultra_memory_profile 或 ultra_personal_context 才会返回该条记录。

同一源和主体的 event_id 表示不可变的整次操作。相同事件和内容重试返回原回执，不重复写入；不同内容、不同操作重用事件会报 conflict。回执记录的是当时结果，不代表记录后续未被修改。修改/审核需传最新 expected_revision，冲突后重新读取再协调，不能静默覆盖。

## 迁移修复

0010-personal-memory-core 已进入历史迁移链，保持原文件字节和 checksum 不变。原 0011-agent-registry 从未注册，并且重复 CREATE TABLE、字段与 0010 冲突，现移至 docs/legacy-drafts/0011-agent-registry.unregistered.json，仅保留为诊断材料，不执行它。

新增 0012-personal-core-wiring 对实际 0010 表追加认证归属、可见性、revision、确认时间、事件账本及作用域约束；保留 id/type/text importance 等原始字段，Store 使用这套实际字段。注册列表明确跳过废弃的 0011，没有伪造其已执行记录。单元测试校验 migrations 目录与执行列表一致，避免再出现死迁移文件。

旧 0010 记录没有可证明的认证归属。原有正文、ID 和元数据保留，但 source_id/actor_key 为 NULL，所有个人 MCP 路径均不能读取或接管它们。不从 source 自由文本、agent_id 或 identity_hash 猜测所有者。历史手工改表/执行过其他 schema 的安装需在副本单独检查；没有静默支持任意私改 schema 的承诺。

## 能力边界

confidence 默认为 null（未知），只接收明确的数值估计；不凭“重复出现”“用户声明”造出 0.95/0.98，不用分数把推断认证为事实。分类函数只是可测试的关键词提示，不调用模型、不删除数据、不自动确认。

个人 context 是有限窗口内的文字匹配和重要性选择，不是完整语义搜索。上下文默认排除 candidate、archived 和其他项目记录；profile 只取全局的 identity/preference/environment/goal。预算覆盖返回 JSON，放不下的整条跳过，不截断否定词。归档不是物理擦除；完整历史内容版本、自动整理、到期删除、Web UI、所有客户端安装适配及真实长期模型效果仍待后续开发。

## 验收命令

只使用全新隔离 ULTRABRAIN_HOME，按 DEPLOYMENT.md 初始化，禁止运行在唯一的重要记忆库上：

```bash
node --test test/personal-core.test.mjs test/personal-memory-store.test.mjs test/migrations.test.mjs
ULTRABRAIN_TEST_ALLOW_WRITE=1 bun test/personal-integration.mjs
```

实际 PostgreSQL 测试检查 schema/Store 一致性、原子批量写入/回滚、事件重放、CAS、来源/主体隔离、显式共享和实时令牌撤销；同时启动真实 stdio/HTTP MCP 并核对 tools/list 和 tools/call。升级矩阵另外从旧 personal-core 提交 f8cc5b980c260cd61e66e032ebce94a5cdc065e3 建立旧结构与无归属数据，验证升级后保留且不暴露。

一次验证成功不等于所有 Agent 已经自动使用新工具。自研 Agent 可按上述 MCP 合同接入；Codex/Claude Code/ZCode/OpenCode 等本机配置和 Hooks 需最终用户环境验收。本轮不要求 Windows 安装 WSL 或自行编译 PostgreSQL；仓库端可完成的测试由仓库端完成，协作规则见根目录 AGENTS.md。
