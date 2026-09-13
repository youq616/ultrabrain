# 0.10 个人核心修复验收

依据本地 Agent 的报告检查 f8cc5b980c260cd61e66e032ebce94a5cdc065e3，随后在隔离 Linux 的真实 PostgreSQL 中重现：旧 Store create 返回 42703（列不存在）；尝试执行未注册 0011 返回 42P07（重复建表）并回滚。这不是用 Windows 环境差异解释产品缺陷。

测试执行范围：纯 JS 模型/身份检查；真实 PostgreSQL 注册、批量写入、查询、审核/修改、CAS、事件重放、故障回滚、私有与同源共享；真实 stdio 和认证 HTTP tools/list + tools/call；旧 0010 数据保留；原有数据库、权限、会话、事实、资源、摘要、企业门禁和 n8n 回归。

保留 0001..0010 迁移及四个上游指针，只有废弃的未执行 0011 移出迁移目录，并追加 0012。应用升级矩阵增加旧 personal-core 基线。备份恢复增加 personal_memories、agent_registry 和 personal_events 三类完整行指纹。

CI 结果必须绑定实际 commit；本文不预写成功状态。纯对象测试不能替代 SQL 测试，服务工具可调用不能替代 Codex/Claude Code 等实际客户端自动 Hooks 验收。原报告中的 Windows getuid/fcntl/进程组限制与个人数据层缺陷分别处理，不虚称原生 Windows 服务端已经支持。
