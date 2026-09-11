# 验收记录与证据规则

## 已确认的历史基线

修复基线 commit：`a1655224dc9d0372eb106d65ab217602a68891d0`。

GitHub Actions：
https://github.com/youq616/ultrabrain/actions/runs/34609757988

该运行已确认 `unit` 和 `native-integration` 两个作业均为 success。原生集成作业包含锁定源码构建、数据库初始化与迁移、真实 PostgreSQL 操作、MCP 协议调用、数据库备份、隔离恢复及恢复指纹检查。

这条记录只适用于该 commit，不自动证明后续提交通过。

## 后续增强候选

`e3cc7e2b2885ef4cddf0496d428fbf3f28faaa92` 增加 HTTP 鉴权、目录写权限、活动运行目录绑定、健康检查、systemd 单元生成和上游审查工作流。

对应运行：
https://github.com/youq616/ultrabrain/actions/runs/34612569356

此文档不把其结果预写为 success。发布时应读取该运行的最终状态以及候选最终 commit 的新运行。后续 Agent hooks、令牌管理与文档变更也必须绑定各自提交重新验证。

## 本地测试命令

无需模型 API 的纯代码测试：

```bash
node --test test/*.test.mjs
python3 -m unittest discover -s test -p 'test_*.py' -v
python3 -m py_compile scripts/*.py
bash -n scripts/*.sh
```

在**隔离测试数据目录**、已完成 bootstrap 的真实数据库上：

```bash
bun test/integration.mjs
bun test/bound-integration.mjs
bun test/http-integration.mjs
bun src/cli.mjs health
```

这些集成测试会写入测试页面、source 和会话。不要把 ULTRABRAIN_HOME 指向生产数据后直接运行。

备份恢复测试使用全新的目标目录和数据库名：

```bash
bun src/cli.mjs db backup --destination "$HOME/ultrabrain-ci-backup"
bun src/cli.mjs db restore-new "$HOME/ultrabrain-ci-backup" --database ub_restore_ci
python3 test/restore-verify.py ub_restore_ci
```

恢复指纹检查覆盖页面内容 hash、session receipt 内容 hash/状态以及 schema 版本；不是所有外部附件的校验，也不保证并发写入时两个库随时相等。

## 协议与权限的真实检查

stdio 测试启动真正的原生 MCP 服务进程，发送 initialize、initialized notification、tools/list 和 tools/call，而不是只直接调用 JavaScript handler。

HTTP 测试使用锁定的 MCP SDK Client 和 Streamable HTTP transport，检查缺失授权返回 401、工具目录的读写 scope、CRUD、跨 source 拒绝、host-private 可见性以及正在使用的令牌撤销。

目录绑定测试检查允许的 CRUD、目录之外拒绝、广域会话提取拒绝、空 allowedOperations 和降级授权拒绝。它们不等于对所有原生操作做了完整安全审计。

## 运维检查

CI 验证同主版本活动运行目录重新绑定、停启与 health；其目的不是宣称已经验证真实跨版本升级。systemd-analyze 只检查生成单元的语法，不代表在所有发行版上完成实际启动、重启、开机运行和用户 lingering 验收。

失败诊断产物只允许包含程序源码、依赖和运行二进制，不包含 PGDATA、配置、模型密钥、会话或令牌秘密文件。

## 尚未完成的验收

没有配置付费/本地模型时，不能声称已经验证真实 embedding、语义召回质量、事实提取准确率或所有 AI provider 组合。`needs_model` 是有效的状态测试，不是提取成功。

尚未把 OpenViking 的所有公共接口、解析器、资源类型、语义摘要与记忆策略做逐项等价验收；尚未完成无损数据迁移和 PostgreSQL 跨主版本自动迁移验收。

## 禁止混淆

源码归档成功 ≠ 测试通过。

测试文件存在 ≠ 已执行。

一次绿色 CI ≠ 后续所有提交绿色。

非超级用户数据库账号 ≠ 逐客户端 PostgreSQL RLS。当前客户端隔离主要在原生 operation 授权层执行，应用角色具备 BYPASSRLS。

代码推送成功 ≠ 已部署到用户的 Linux 服务器。
