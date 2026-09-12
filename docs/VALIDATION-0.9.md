# 0.9.0-alpha.1 验收范围

这是测试定义，不预填通过结果。以绑定提交的运行、源码快照和产物核验记录为准。

新增单元测试覆盖固定工具表、错误 profile、完整单源身份、source/actor 并发、主机配置参数、精确 native 源码适配、负载选项和统计分母。新增真实数据库测试覆盖源登记、CAS、policy 在线切换、两服务进程共享固定窗口限流、actor 公平性、handler 并发屏障、审计追加约束、admission/terminal 故障注入和实际 benchmark CLI。

response-metadata-integration 用原生事实及原生 hot cache 复现退役来源仍可能出现在附加 metadata 的场景，并核对 ultra_identity/ultra_recall/目录检索的完整响应。适配器不得修改 vendor 字节。

保留原有测试，并将 0.8.0 固定提交加入旧应用升级矩阵（共 8 条路径）。只新增 0009，已有迁移和上游锁保持不变。数据库恢复增加 enterprise policy/audit/rate counters 指纹，检查总共 20 类数据。

小型 benchmark 只运行 50 次、并发 2、同一测试页的热读，认证、准入及审计均启用；它验证压测工具可运行，并不构成企业规模性能验收。上下文中声明的模型 fixture 仍不是实际 LLM 质量测试。没有执行用户服务器部署、主备切换、完整附件恢复或企业身份提供商接入。
