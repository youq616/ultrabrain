# 0.8.0-alpha.1 验收范围

以实际提交和测试结果为准，本文不预填 success。

- automation-session 与 n8n-executor 单元测试：双层采集许可、私有/共享限制、禁止来源/命令覆盖、身份固定与再检查、内容大小、确认回执、取消、批量关联、错误脱敏。
- n8n-integration：真实 PostgreSQL + MCP SDK + HTTP，执行打包后的客户端。默认使用模拟 n8n execution context，明确不将其称为完整引擎。
- n8n-engine CI：安装明确版本的 n8n 与生成的 tgz，在私有 HOME 中导入合成凭据与工作流，再使用 execute --id 运行实际 Capture → Status 工作流；再运行相同事件和拒绝采集场景。该模式必须使用 --engine，依赖缺失即失败，不 silently skip。
- 包构建：只包含客户端代码，服务端 SQL、进程执行器、vendor、凭据和模型实现不得进入包；npm pack 后检查文件清单及校验值。
- 既有数据库、权限、事实/资源治理、队列、摘要和恢复回归继续执行；追加 0.7.0 的旧应用升级基线，但不修改数据库迁移或上游锁。

n8n fixture 的 SQLite（由实际 n8n 自己使用）只是一次性测试宿主状态，不是第二套 Ultrabrain 记忆数据库，不分发或迁移用户数据。测试不会连接用户的 n8n 或创建生产凭据。

本版没有 n8n UI 浏览器自动化、Cloud 官方验证、所有 n8n 历史版本兼容、所有 Agent 原生 Hook、多模态、完整离线运行包或实际付费模型效果的验收。

实际 n8n CLI 的 rawOutput 仍经 info logger 输出；验收进程只在执行阶段启用 info 并私有捕获 JSON，不向 CI 输出原始执行记录。检查最终 Status 节点数据、session/event 及数据库去重，拒绝路径必须包含明确的 capture_disabled，不能仅凭退出码判断。
