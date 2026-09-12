# 0.4.0-alpha.1 验收范围

结果必须对应实际提交的 CI，不在代码中预写 success。

workspace-evidence.test.mjs 使用真实临时 Git 仓库检查修改/暂存/未跟踪、隐藏索引标志、不同 HEAD、无 Git 和观测边界。revision-evidence-integration.mjs 使用真实 PostgreSQL、主机 CLI、MCP dispatcher 验证旧回执/脏工作区/错误版本拒绝和正确版本接受，以及 source/project 授权。

deferred-client.test.mjs 检查 opt-in、原始 journal ACK、outbox 重启与模式冲突、当前 source、worker 令牌文件和跨 origin 限制。

deferred-integration.mjs 在真实 PostgreSQL 上检查原子入队、事件冲突、跨主体拒绝、当前授权、并发领取、租约恢复、缺模型状态、重试次数、dry_run 和 payload 清理。清理完成路径使用**明确的受控提取结果**，不是模型准确率测试；没有提供模型密钥。

HTTP 测试使用实际 SDK、服务进程和独立 scripts/consolidate.mjs 执行 queued -> needs_model，并检查令牌撤销后新请求不会领取队列。

CI 分别从 38e0e6657561e17ba85c71d0783d604242a054e8 和 d7be484b445a893112d3a132c30f42282865a41a 开始真实旧应用升级演练。旧数据指纹、权限、回执重放、旧队列大记录、迁移校验和事务回滚继续验证。0001-baseline 保持原字节，新功能使用 0002/0003，不修改已应用的 checksum。

备份恢复新增 workspace JSONB 和 deferred 原始队列指纹，仅证明数据库中所列内容可恢复，不证明外部附件、模型准确率、密封构建或部署。所有集成测试只能在隔离数据目录执行。
