# Personal 0.14：实施者测试记录（不是独立审核）

本记录由实施者产生。独立子代理审核仍为 PENDING，reviewer 标识和结论均未填造。禁止据此或仅据 CI 成功合入 main。审核任务见 PERSONAL-0.14-REVIEW-REQUEST.md。

## 本次发现和修复

真实 MCP/PostgreSQL 测试复现：客户端在 `ultra_agent_register` 之后未重新执行本地授权检查，撤销发生在异步注册/身份检查期间时仍可能继续提交原文。修复前新增断言报 Missing expected rejection，保留首次失败日志指纹。现在 direct/queued capture 共用 `deliverCapture`，冻结请求，检查项目，异步步骤后分别核对授权与取消，发送前读取最新 profile。已经发出的请求仍不能撤回。

新增 8 项纯测试，加上真实数据库中的授权撤销案例；队列向真正的发送器传递授权断言，避免只在外层检查一次。异步授权断言不受支持，会安全拒绝，不将 Promise 当作批准。

## 本地实际结果

- JavaScript：427 项通过，0 失败、0 跳过；Python：86 项通过。
- 最终客户端重建后，采集/崩溃重放 18 项、Node/代理/MCP 客户端 19 项通过。
- 个人核心 43、原生适配器回调 7、管理台 API 13、个人整理 29、Worker/模拟供应商 5、HTTP 49 项通过。
- 新建数据库备份，恢复到独立目标，25 类指纹一致；health 通过。

以上使用全新普通用户数据目录和与现有 pin 一致的此前 CI 原生运行文件，没有声称本地重新编译所有上游。数据库、备份和日志只在隔离环境内，不涉及用户设备或真实记忆。

Claude Hook 是合成事件；模型输出为明确受控 fixture。本地没有安装实际 OpenCode、完整 Hermes/OpenClaw 或运行用户桌面 Agent。实际 OpenCode、Windows/Linux、浏览器、n8n、历史数据升级以最终提交的 GitHub Actions 为准，不沿用中间提交的绿色结果。

旁边 JSON 记录命令、范围和日志 SHA-256。原始日志可能含私有路径或配置细节，不放到公共仓库；哈希不是公众可以据以重建原日志的证明。完整个人 V1 仍未完成。
