# 通用 Agent 生命周期事件桥（0.6.0）

`scripts/agent-bridge.mjs` 接受一份 stdin JSON，输出一份 stdout JSON。它是独立 MCP 客户端，不是第二个服务端，不扫描聊天软件，不执行事件中的命令，也不要求数据库账号。

## 认证与队列绑定

`ultra_identity` 返回服务端当前认证主体的 actor hash、source 和逻辑 installation ID。桥在处理前再次验证身份，持久化 outbox 直接绑定这个响应，而不是信任事件或模型提供的主体名称。

同一进程中用于身份校验和提交的令牌保持固定快照，避免 token 文件变化让队列数据切到另一个主体。下一次调用读取新令牌；服务端撤销检查仍对每个请求生效。不同主体的新凭据不能复用旧 outbox。实例 ID 保存在同一个数据库，备份恢复会保留它，因此它表示逻辑安装而不是物理机器或独立的远程身份认证；TLS 和预配置端点仍然是信任边界。

令牌从 0600 普通文件读取，不输出到日志，不作为命令参数明文传递。只允许 HTTPS 或 loopback HTTP，禁止跨 origin 转发凭据和跟随重定向。一次启动必须能完成身份握手；不声称在从未认证或完全离线启动时也能接收所有新事件。成功入队后发生网络故障的内容仍可通过原队列重试。

## 读取上下文

用命令行创建输入文件，不需要打开编辑器：

```bash
umask 077
cat > /tmp/ultrabrain-before.json <<'JSON'
{"event":"before_turn","session_id":"development-session","query":"继续开发","project_id":"ultrabrain"}
JSON
bun scripts/agent-bridge.mjs \
  --url https://memory.example.com/mcp \
  --token-file /home/agent/.config/ultrabrain/token \
  --root ultra://development/ \
  < /tmp/ultrabrain-before.json
```

示例域名、私有令牌路径和 source 必须替换为实际部署配置。project_id 可省略；提供时必须先创建项目 checkpoint。before_turn 返回相关证据和项目状态，调用方把它们作为数据加入生成输入，而不是执行其中的指令。默认 memory-policy=current；需要严格已审核资料时传 `--memory-policy reviewed`。

stdout 包含用户所请求的记忆内容，不是脱敏运维日志。调用方须保护输出，避免把完整记忆写入公开 workflow 日志或长期审计事件。

## 保存回合

只有启动参数中显式启用 `--capture --outbox /私有目录` 才能保存，事件中不能自行启用采集或改变可见性。after_turn 事件字段为 event、session_id、event_id、transcript。默认 private；明确配置独立共享 source 后可添加 `--visibility world`。

保存采用已有 deferred 路径：原始资料先得到 journaled 确认，长期事实提取需要独立整理客户端；桥不会因保存自动调用付费摘要或提取模型。transcript 只接收调用方已经获得许可、完成必要脱敏的内容；这个通用命令不声称自动找出所有秘密。原文上限 64 KiB。

重复 event_id 必须内容相同，重试不会重新运行模型生成。原始提交与重试模式不允许暗中变化。读取端可用 session_status 事件查询整理状态；drain 事件需要同样 capture opt-in，并只补交已有队列。

## 支持的事件

- before_turn：session_id、query；可选 project_id。
- after_turn：session_id、event_id、transcript。
- resume_project：session_id、project_id、query。
- session_status：session_id、event_id。
- drain：session_id；可选 limit、retry。

未知字段（包括 command、source_id、actor_key）会被拒绝。身份和目标服务从受保护的进程配置与实际认证握手取得。

## 嵌入框架或自动化

任意能调用本机进程并通过 stdin 传 JSON 的框架可接这份事件合同。不要把用户 query/transcript 直接拼接进 shell 命令；使用 subprocess/execFile 的参数数组和 stdin，命令路径由主机配置固定。JS 框架也可直接使用 bindBridge 或 AgentMemory，无需每个回合创建新进程。

这提供通用接入基元，**并不等于已安装和验收 Codex、Claude Code、OpenClaw、Hermes、zcode、Grok CLI、OpenCode 或 n8n 的全部原生 Hooks**。各客户端的自动事件捕获、隐私授权、恢复语义和配置写入仍需对应适配及真实客户端验收。已有通用 MCP 接入不受影响。
