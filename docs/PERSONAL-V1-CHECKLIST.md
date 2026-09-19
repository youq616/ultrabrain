# 个人 V1 的完成检查表

当前仍是个人版迭代，不使用主观百分比或增加版本号宣布完成。原始两上游的全功能等价是独立范围；不能用个人 V1 的最小验收代替全量等价声明。

2026-09-19 接手修复已通过 [PR #14](https://github.com/youq616/ultrabrain/pull/14) 合入 `6aae8a01f0d5f27dedf64e0687af9cb3b02e29ea`：补齐客户端/队列、管理台表单及模型发送前授权复查，同时阻止租约已过期的任务进入模型调用。最终候选获两个独立审核 PASS，候选 47 个 CI jobs 全通过（612 Node / 542 Python，15 条升级路径、真实 PostgreSQL/MCP/Chromium/n8n）。[审核与证据](reviews/consent-takeover/README.md) 保留初审 BLOCK 和修复过程。[下一阶段计划](TAKEOVER-2026-09-19.md) 优先首次使用流程与已有 Agent 采集兼容；这些仍待完成，不能将本轮修复视为个人 V1 发布验收。

| 项目 | 当前范围 |
|---|---|
| 合并后验证 | PR #14 的 main 应用提交通过七组 24 jobs；612 Node / 542 Python 和真实 n8n CLI 再次成功，完整记录见上述审核档案。 |
| 托管 Linux 数据库和 MCP | 已有安装、迁移、健康、备份与协议回归；用户实际部署仍需验收。 |
| 个人结构化记忆 | 已接通登记、候选提交、审核、更新、查询和所有权隔离。 |
| 可操作的个人管理入口 | 0.10.1 增加本机所有者管理台，覆盖个人条目管理；不是 HTTP 各主体的统一管理器或完整文件管理器。 |
| 工作前个人上下文 | 0.10.1 接入 AgentMemory、通用桥、n8n 开关；默认兼容，需明确启用。 |
| 自动采集和类型化整理 | 已有授权会话采集/提取管线；0.11 已增加明确原文队列、周期 Worker 和带引用候选；不会自动扫描全部聊天，客户端自动采集与语义冲突核对仍待完成。 |
| 客户端接入 | 0.12 增加 Node 客户端/受限 MCP 转发、Codex/Claude/OpenCode/ZCode 配置工具和 Claude 只读 Hook；真实协议已测，用户安装的 Agent/模型验收未全部完成。0.13 增加 OpenCode 原生 Hook、Hermes 主 CLI provider 和 OpenClaw 限域 Hook；具体宿主完整验收分层说明见 NATIVE-AGENT-ADAPTERS.md。Grok CLI 和所有客户端自动采集仍待完成。 |
| 多模态、文件和完整恢复 | 原文来源和摘要引用已有基础；文件/PDF/图片等完整摄取、附件与数据库协调备份、恢复演练仍待完成。PR #3 已在 8d7cb953 合入首批 UTF-8 文本文件导入、原文追溯、片段排队与字节级恢复。恢复套件本阶段增加数据库 + 本地原生状态的完整性校验、隔离展开和新数据库恢复；不包含外部对象、环境专属密钥和自动业务切换。PDF/图片/OCR 仍未支持。 |
| 个人日常可用性 | 已有预检、固定服务计划/校验、获准 Worker 周期循环和只读状态。PR #11 已提供停止状态的受管安装/更新/回滚；PR #12 提供认证 personal-ready；PR #13 已提供停止控制台的显式 personal-activate 与同 manager 的观察式中断恢复，7 个真实崩溃点通过。最终候选获独立整阶段 PASS 和补充恢复 PASS，47 个候选 jobs 与 24 个 main jobs 成功。用法见 [部署](PERSONAL-DEPLOY.md)、[就绪](PERSONAL-READY.md)、[激活与恢复](PERSONAL-ACTIVATE.md)，证据见 [项目状态](PROJECT-STATUS.md)。运行中切换、自动停止回滚、跨 manager 恢复与用户主机实际部署仍待完成；单项就绪不代表 V1 全部验收。 |

个人 V1 的发布必须同时给出固定提交、接口与实际客户端验收、数据恢复结果和明确限制。现阶段不扩大企业功能；只有确实依赖用户环境的安装/凭据/桌面客户端工作才交给用户，按 AGENTS.md 使用一个连续段落提示词。

0.14 自动采集与客户端交付队列已通过 PR #1，文本文件阶段已通过 PR #3。其他客户端自动采集、PDF/图片、多主机与外部存储协调恢复及真实用户部署仍未完成。本阶段恢复范围见 RECOVERY-SETS.md，不能用单项校验成功代替完整个人 V1 发布验收。

个人服务计划已通过 PR #7 合入；`personal-status` 已通过 PR #9 合入 `a5e76f7ab2af4dddb1f72d8a95ab02d2f32593f6`，仅观察固定用户单元。已有真实 CI 用户 systemd 验证，仍不据此标记用户主机个人部署全部完成。详情见 PERSONAL-STATUS.md。

2026-09-18 的控制台激活阶段接受精确候选 `88e05f3f84d1cd1ac2e3fdf2f22237c84c6cb3c4`，应用合并提交为 `17bf51a2e998718665082a0245b5b49369ac6ec6`。独立主审核对完整阶段 PASS，另一实际 reviewer 补充审核 journal/recovery/CLI；两人分工执行 262 Python / 14 CLI，另有 58 项边界检查。候选 47 个 jobs、main 合并后 24 个 jobs 全部通过；563 Node / 542 Python，无跳过。真实服务每次通过 18 activation、15 deployment、12 readiness 和 18 旧 services；七个中断点无额外启动。新激活/就绪模型调用 0 次，旧 services 使用两次本地合成响应。完整证据与首次失败见 [激活验收](reviews/personal-activate/README.md)。本阶段限定停止配置、已有令牌及已运行数据库，不等于用户主机或完整 V1 已验收。

2026-09-18 的只读就绪阶段接受精确候选 `715314236183ff75f97bc96fcfef57bd6b421192`，应用合并提交为 `d72ee27cafe9b309253ebd382fd752932fbe9e38`。六组 PR CI 共 23 个 jobs 成功，557 Node / 438 Python 全通过、无跳过；真实服务 CI 中新增 12 项就绪、原有 15 项部署和 18 项服务检查分别通过。执行环境是一次性普通 Linux 账号，新就绪检查调用模型 0 次，既有服务检查使用 2 次本地合成响应。逐轮独立审核和首次失败见 [本阶段验收](reviews/personal-ready/README.md)；这些结果不代表用户主机、完整客户端/模型或 Worker 就绪已验收。

按当前任务召回已通过 PR #10 合入 `6c1c6becb1ae898d37d6bdcd2782c750481b27de`：显式 `task-context` 与独立 `claude-task-hook` 复用既有个人排序；仅在 profile/身份/workspace 和任务授权都满足时查询。精确候选 `5359c113b28b8a3e54ca67f0c6d3a1d1d28aad4c` 已获两个新的独立代理 PASS，六组 CI 成功；其中任务集成执行 21 项真实打包 Node/PostgreSQL/MCP 检查，Claude 输入仍为合成事件。见 TASK-CONTEXT.md 与 [当前项目状态](PROJECT-STATUS.md)。这不代表真实 Claude 客户端/模型或个人 V1 已全部验收。
