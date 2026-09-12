# 0.5.0-alpha.1 验收范围

发布结果绑定具体提交和 CI，不预写成功。

semantic-core.test.mjs 验证全文分块、Unicode、最后一块进入归纳、虚构/越界引用拒绝、严格 JSON、超时、模型拒绝、缓存内容校验和凭据元数据排除。这里的模型返回是明确受控的 fixture，不是任何真实模型准确率分数。

semantic-integration.mjs 使用真实 PostgreSQL 与 MCP dispatcher。覆盖显式模型配置/调用授权、同主体 cache、不同主体与 host-private 隔离、原文 hash、出处展开、并发 lease、TTL/profile 失效、模型错误清理、原文并发修改和软删除触发器。正向模型调用走锁定网关的测试 transport；缺配置路径为真实 keyless 拒绝。

retrieval-focus.test.mjs 验证长文末段、中文词法片段、目录补查、扫描预算、别名越界和过期引用；原有成对检索与五案例回归继续保留。没有用这些样本证明所有语义检索场景表现达标。

HTTP 测试新增独立 scripts/mcp-call.mjs 的 JSON stdin/stdout 调用。配置修复有实际旧/新路径、既有 embedding 身份保留和配置备份的 Python 测试。

CI 从 0.3.0、0.3.1、0.4.0 三个不可变应用基线执行旧数据升级，再完成 native/MCP、授权、项目、队列、执行证据、摘要、备份恢复和停启。0001..0003 迁移不改字节，新增 0004。摘要缓存 JSONB 和迁移账本加入恢复指纹。

当前没有部署用户服务器、没有提供所有平台离线二进制、没有实际升级上游数据库版本；也没有使用生产模型密钥或真实用户数据做质量评测。
