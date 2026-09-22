# Personal setup：集成、期限修正与自审

## 精确基线与继承关系

基线为 PR #18 `5dbbcd6e5744a803e30d2b1cd1e9ebcf1a1ba450`，完整 Git 树 `c450b8630cc07806e55bffe9ad067a26f0ee3c73` 已与 Source snapshot 工件 10583577298 的解包索引核对一致，包括执行位、原有证据文件及 vendor gitlinks。本轮保留 #18 已整合的 #15 Agent 登记修复、#16 初始化、#17 身份观察和 activation prepare；不修改它们的原分支，不将未验收的父栈视为已批准。

上轮本地候选 `f4842d6626ec51b9c082e1ee2d93134d76374bc3` 是历史本地标识，不是本次远程提交的父节点。本轮从会话候选包恢复 personal-setup 实现、30 个 Python 与 4 个 Node 测试、数据库集成及说明，移植到上述最新基线。CLI 仅增量修改，保留 #18 的 prepare 文案。之前的 622 Node / 657 Python 是旧基线的本地结果，不沿用为本候选证据。

## 开发与本次自审发现

新增公开 `personal-setup check|prepare`，在持续持有的安装目录视图内，先验证选定本机数据库/source/实例，再调用既有只读状态或 create-only 凭据初始化器，随后重验逻辑身份、进程、配置和令牌。该入口不执行 bootstrap、部署、服务动作、模型调用、记忆读取或客户端配置修改；prepared 不等于 application readiness。

对恢复的实现进行重新检查时，发现两个身份观察各自使用独立预算，组合缺少统一期限，且组件返回后即使整体已过期仍可能进入凭据阶段或报告成功。先执行 `test/test_personal_setup_deadline.py` 的六项边界回归，原实现六项均失败；这是同一个期限缺口的不同边界，并非六个独立安全漏洞。原始输出完整保存为 `deadline-first-failure.log.gz`。

修正位于 `scripts/personal-setup.py:58-61,79-108`：固定 20 秒单调时钟总预算，两个 observe 均继承同一个截止点；初始化前、等待/检查后、最后返回前复核。复用 #18 现有 identity 内部最多 10 秒的较短期限，不扩展公共参数。初始化后超时保留可能已创建的凭据，不再次查询、不重试写入、不宣称准备成功。期限限制阶段推进；已启动的本地文件系统调用、内核调度及子进程回收不是硬实时可中断操作。

自审还逐项检查了 `src/cli.mjs` 的固定 distro Python 分派、`personal-init.py` 的互斥/独占创建/权限/fsync、`preflight.py` 的持续目录与文件观察、identity 的只读协议及 procfs 绑定、组件回执白名单和错误脱敏。参数错误与身份错误不授权创建，已有凭据不被轮换；创建后的异常不伪装为“没有任何写入”。未发现本轮已检查范围内尚未处理的阻断项，但这不是穷尽性或零缺陷保证。

## 实际执行证据

本轮普通账号 Node v22.16.0、系统 Python 3.13.5：Node **656/656**，零失败、零跳过；Python **683/683**；setup 专项 **36/36**；`-OO` 专项 **36/36**。Node/Python/优化模式完整运行退出码均为 0。Node 语法、Python AST 和 `git diff --check` 通过。相对 #18 基线 652/647，本次接入 4 个 Node、30 个已实现 Python 测试，并新增 6 个期限测试；#15 的 32 项已在基线，不重复算作本轮新增。

上轮公开 CLI 实现前四项首败原文保留为 `first-cli-failure.log.gz`，解压 SHA256 `cb2d2555147f7f6beff7c84ec26374df4a5b4df4beeb008d3e03b7b281ee12aa`。旧轮环境干扰和未完成运行仍在原候选附件中，本轮没有将其改写为通过。当前完整本地日志哈希和逐文件 Git blob 见 `local-evidence.json`；完整日志为补充附件，不是唯一代码交接来源。

## 真实集成与审查门槛

本候选专用 identity CI 新增真实 PostgreSQL setup 测试，检查从无令牌开始的身份确认、首次创建、重放保持、错误实例/source 拒绝、真实 SQL 阻塞与恢复、已部署凭据丢失、格式损坏、无遗留身份查询子进程和显式独立启动控制台后的认证。另在既有 personal-services CI 的离线初始化之后加入公开 setup check，后续保留真实 systemd 部署、activation prepare/apply、就绪和崩溃恢复流程。文档与单测不能替代这些工作流的实际结果。

创建本记录时新 CI 尚未执行，精确候选 SHA、实际 CI checkout SHA/run/job 与结果应记入本候选 PR；不得使用父分支的绿灯代替组合测试。受控模型 fixture 不属于真实付费模型质量或用户生产部署验收。

本记录由实现助手撰写，是**自审**，不是另一个独立 Agent 的审查。独立审查 **PENDING**；必须取得最终精确提交的实际独立 reviewer 意见并处理阻断项，CI 或发出审查请求不算批准。本候选保持开发分支/草稿，main 与用户运行服务不变。没有修改已应用迁移、上游锁、数据库布局或 qbrain。
