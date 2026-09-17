# Ultrabrain 当前项目状态与接手记录

记录日期：2026-09-17。本记录以 GitHub 实际提交、已执行 CI 和独立代理审核为依据。历史会话、候选 README、接收报告中的 pending/frozen 字样描述的是当时状态；继续开发前应复查远程 main 和开放 PR。

## 已完成阶段：停止状态下的个人服务部署

从文档主线 `6f2c60fd2d27e4bcbb9046fe298fa6bebc6278d6` 新增 `personal-deploy`，已通过 [PR #11](https://github.com/youq616/ultrabrain/pull/11) 合并：审核计划绑定、独立单元副本、同账号跨安装串行化、持久化事务回执、停止后更新、逐代回滚和中断恢复。调用只重载用户管理器；自动启停、启用和应用激活失败回滚留在后续范围。实现与命令见 [个人服务部署](PERSONAL-DEPLOY.md)。

| 验收对象 | 精确值 |
|---|---|
| 最终审核候选 | `8c519f23a359691a24e9780766c5baed54c58c40` |
| 候选代码树 | `9fa4b6574c7b1e9278eeb11dc5de9b3b6ec76789` |
| PR CI 实际 merge | `fdaee37934db8d449598a57f8cc13e0b7ae13fb7`，代码树与候选相同 |
| 实际 main 合并提交 | `50718455448b90c1eb70e3df70c96700b67bc867`，代码树与候选相同 |
| 六组 PR CI | 全部成功，共 23 个 jobs；普通用户下 524 Node / 367 Python 全通过、无跳过 |
| 新部署真实集成 | push 与 PR 均通过 15 项；实际 user-systemd、PostgreSQL、认证 HTTP、进程中断和重复恢复缓存重载 |

两个未参与实现的独立 reviewer 分别检查完整阶段并复审每次修正后的精确提交，最终均明确 PASS：[/root/deploy_transaction_review](reviews/PERSONAL-DEPLOY-TRANSACTION-REVIEW.md) 审查事务、持久化和恢复；[/root/deploy_boundary_review](reviews/PERSONAL-DEPLOY-BOUNDARY-REVIEW.md) 审查服务边界、系统路径、公开 CLI 和测试子进程。最终提交新增夹具分别有 16 个独立绑定/总线场景，以及 7 个助手和 9 个父进程协议场景通过。应用源码最后一次变更为 `ed65c0f073b334075e4f2482b140fd8dd0a769df`；其 87 项部署 Python 测试、4 项公开 CLI 测试及 43 个独立事务/协调/恢复场景在报告中保留原提交归属，未假称在后续仅测试/文档提交重复运行。

本阶段 CI：[全量验证](https://github.com/youq616/ultrabrain/actions/runs/35242391344)、[真实用户服务](https://github.com/youq616/ultrabrain/actions/runs/35242391510)、[恢复](https://github.com/youq616/ultrabrain/actions/runs/35242391295)、[客户端跨平台](https://github.com/youq616/ultrabrain/actions/runs/35242391422)、[任务召回](https://github.com/youq616/ultrabrain/actions/runs/35242391401)、[原生接入](https://github.com/youq616/ultrabrain/actions/runs/35242391258)。全量包括 15 条历史升级路径和 n8n 引擎。服务工作流还通过原有 18 项检查，使用 2 次本地合成供应商响应；新的部署夹具不调用模型。实际部署测试只观察到安装链接形式的 FragmentPath，代际目标形式另有单元测试。

首次审核曾阻断共享 pending 发布顺序、额外 `.upholds` 依赖与别名三个问题；修复后重新审核。真实 CI 又依次暴露系统目录兼容、托管镜像可写权限、安装链接 FragmentPath、停止任务时序和无引用缓存假设。独立审核还在未提交的兼容草案上复现了恢复再次中断后跳过重载的漏洞，最终代码改为每次有效 pending 恢复都成功重载后才清除记录。原始 BLOCK 报告保存在 [首次审核档案](reviews/PERSONAL-DEPLOY-INITIAL-REVIEWS.md)；每个失败候选的完整 SHA、运行链接、日志哈希及修正原因见 [机器验收记录](reviews/PERSONAL-DEPLOY-EVIDENCE.json)。初次未提交实现的 54 项本地测试曾出现 2 failures / 33 errors，同样保留为失败，不计入通过结果。

本地环境是 UID 0；部署事务/CLI 和隔离代理探测在此完成，普通用户活 systemd、实际数据库与 HTTP 的验收来自上述真实 CI。没有放宽生产普通账号限制，没有部署用户主机，也没有把配置回滚说成源码/Bun/数据库回滚。当前文档及审核归档属于合并后的文档提交；上表 CI 针对精确候选/相同应用代码树，不能表述为在后续文档提交重新执行。

合并后再次核对 main 应用提交 `50718455448b90c1eb70e3df70c96700b67bc867` 的自动 CI：[全量](https://github.com/youq616/ultrabrain/actions/runs/35243374174)、[用户服务](https://github.com/youq616/ultrabrain/actions/runs/35243374021)、[恢复](https://github.com/youq616/ultrabrain/actions/runs/35243374096)、[跨平台](https://github.com/youq616/ultrabrain/actions/runs/35243374041)、[任务召回](https://github.com/youq616/ultrabrain/actions/runs/35243374348)、[原生接入](https://github.com/youq616/ultrabrain/actions/runs/35243374015) 和 [源码快照](https://github.com/youq616/ultrabrain/actions/runs/35243374044) 七组均成功，共 24 个 jobs。合并后日志再次确认 524 Node / 367 Python，以及 15 项新部署和 18 项既有服务检查全部通过。完整运行记录保存在机器验收文件，仅归属于上述合并提交。

## 已完成的任务召回接手

接手时 main 为 `a5e76f7ab2af4dddb1f72d8a95ab02d2f32593f6`。任务上下文候选已完成实现和 CI，但 PR #10 仍为草稿。本轮重新检查代码和远程证据，由两个新的独立代理审查同一候选，更新 PR 验收说明并完成合并。

| 记录 | 精确值 |
|---|---|
| 已合并 PR | [#10：任务相关个人记忆召回](https://github.com/youq616/ultrabrain/pull/10) |
| 审核的应用提交 | `5359c113b28b8a3e54ca67f0c6d3a1d1d28aad4c` |
| 候选代码树 | `74e4222eaa3ec9281ea3aca572e543e3da9298a1` |
| CI 实际测试的 PR merge | `8fc7a2825a92774196cfce5bbe472a042f7b25c0`，代码树与候选完全相同 |
| 实际 main 合并提交 | `6c1c6becb1ae898d37d6bdcd2782c750481b27de`，代码树与候选完全相同 |
| 本轮应用代码改动 | 没有追加应用改动；接受已实现的精确候选，并补齐本交接文档 |

新 `task-context` 将明确任务正文传给既有个人召回工具，使较早但相关的偏好能排在较新的无关条目前。`claude-task-hook` 只处理获准的主会话 `UserPromptSubmit`；需要单独开启任务查询和自动范围，默认关闭。工作区、服务实例、主体及配置绑定继续生效。任务最大 4096 UTF-8 字节，整条拒绝超限输入，不静默截断。查询不请求记忆写入或模型调用。使用方式见 [TASK-CONTEXT.md](TASK-CONTEXT.md)。

先前发现的旧任务 Hook 仍留在配置中、可能把新提示词发送到旧目标的问题，已在候选中修复；配置冲突在写入前拒绝。查询响应丢失后也不再声称正文肯定未发送，而是报告交付不确定。相关复审见 [原始 P1](https://github.com/youq616/ultrabrain/pull/10#discussion_r4033742038) 和 [GitHub 独立复审](https://github.com/youq616/ultrabrain/pull/10#issuecomment-5711294136)。

## 任务召回接手的独立审核与验证

以下是实际不同 reviewer agent 的书面结果，均针对上述完整应用提交；不是实现代理自审，也不是以 CI 代替审查。

| 审核代理 | 范围 | 自行执行的验证 | 结论 |
|---|---|---|---|
| `/root/task_context_review` | 查询、授权、身份、撤销、错误及响应边界 | 71 个 Node 测试、16 个 Python 配置测试，以及额外边界断言 | PASS，见 [代码审核](reviews/TASK-CONTEXT-TAKEOVER-CODE-REVIEW.md) |
| `/root/task_config_review` | 配置、profile、Hook 轮换、文档与打包/工作流 | 48 个 Python 测试，以及无效配置、真实 Bash 引号和生成器断言 | PASS，见 [配置审核](reviews/TASK-CONTEXT-TAKEOVER-CONFIG-REVIEW.md) |

同一候选的六组 PR CI、合计 23 个 jobs 均已完成并成功。本轮直接读取了运行状态、步骤和关键日志，核对 CI merge 与候选代码树相同。

| CI | 具体证据 |
|---|---|
| [全量验证 35199054104](https://github.com/youq616/ultrabrain/actions/runs/35199054104) | 520 Node / 280 Python 全通过；15 条历史升级路径；真实 Chromium 管理台及 n8n 引擎 |
| [任务召回 35199054077](https://github.com/youq616/ultrabrain/actions/runs/35199054077) | 构建并通过 npm 安装当前 tgz；21 项真实打包 Node、stdio/只读 HTTP、PostgreSQL 检查；Claude 事件为合成输入 |
| [恢复 35199054071](https://github.com/youq616/ultrabrain/actions/runs/35199054071) | 隔离安装、恢复与真实数据库验证 |
| [个人用户服务 35199054044](https://github.com/youq616/ultrabrain/actions/runs/35199054044) | 一次性 runner 上的真实用户 systemd、服务重启和获准周期任务；供应商输出为测试数据 |
| [客户端跨平台 35199054021](https://github.com/youq616/ultrabrain/actions/runs/35199054021) | Ubuntu 与 Windows 配置及客户端合同 |
| [原生接入 35199054005](https://github.com/youq616/ultrabrain/actions/runs/35199054005) | 现有原生接入工作流；各宿主完整度按 NATIVE-AGENT-ADAPTERS.md 区分 |

**本轮接收环境的全量本地测试没有全部通过。** Node v24.19.0 执行 520 项，通过 515 项，5 项在既有个人服务/预检的普通用户门槛失败；Python 3.12.14 执行 280 个方法，预检相关用例出现 18 failures、26 errors。该容器当前 UID 为 0，直接探测分别返回 `ordinary_linux_account_required` 与 `use_ordinary_service_account`。尝试降低为普通 UID 被运行环境拒绝，错误为 `setresuid: Invalid argument`。未修改保护逻辑、跳过断言或把失败算作通过；普通用户下的全量成功证据来自上表精确候选的 GitHub CI。首次日志哈希和计数保存在 [机器可读验收记录](reviews/TASK-CONTEXT-TAKEOVER-EVIDENCE.json)。本地没有另装 Bun/数据库依赖，也没有冒称重复完成原生集成。

本文件及同批 README/检查表/审核记录属于后续文档提交。上表 CI 对应应用候选及其相同代码树，不能冒称这些运行是在后续文档提交上重新执行。应用实现若再次改变，必须重新审核和验证。

合并后又核对了 main 应用提交 `6c1c6becb1ae898d37d6bdcd2782c750481b27de` 的自动 CI：[全量](https://github.com/youq616/ultrabrain/actions/runs/35226757833)、[任务召回](https://github.com/youq616/ultrabrain/actions/runs/35226757850)、[恢复](https://github.com/youq616/ultrabrain/actions/runs/35226757656)、[用户服务](https://github.com/youq616/ultrabrain/actions/runs/35226757664)、[跨平台](https://github.com/youq616/ultrabrain/actions/runs/35226757679)、[原生接入](https://github.com/youq616/ultrabrain/actions/runs/35226757813) 及 [源码快照](https://github.com/youq616/ultrabrain/actions/runs/35226757965) 七组均已完成并成功。运行 ID 与实际 head SHA 同样存入机器记录。

## 历史任务的真实状态

| 事项 | 当前状态与后续处理 |
|---|---|
| personal-documents | 已通过 [PR #3](https://github.com/youq616/ultrabrain/pull/3) 合入，首批显式 UTF-8 文本文件导入。不要重复导入旧交接包。 |
| personal-ranking | `aa5a5828f1dbfd5024ae376f5f6cca00ab4e1cf5` 已通过 [PR #5](https://github.com/youq616/ultrabrain/pull/5) 合入 `76fa32b7aa866490b7cdcbf5fc9d2e1f17b2ec86`。历史会话里“尚未 CI/合并”的描述已过时。 |
| 服务计划与状态 | [PR #7](https://github.com/youq616/ultrabrain/pull/7) / [PR #9](https://github.com/youq616/ultrabrain/pull/9) 已合入；已有固定用户单元的计划/导出/校验、周期循环 Worker 和只读状态诊断。 |
| personal-service-bundles | [PR #8](https://github.com/youq616/ultrabrain/pull/8) 保留草稿，头为 `1d02a629c8093cfdc50a09ea9cb2720d9d02fea6`，与 main 冲突；此前服务 CI 失败和审核意见仍未闭环。不能直接把该旧生成器合并到主线。 |
| OpenViking 上游候选 | [Issue #2](https://github.com/youq616/ultrabrain/issues/2) 仍为待审更新；本轮没有改变上游锁。 |

PR #8 的基本导出/校验与周期处理能力已由主线覆盖；剩余差异主要是 oneshot + timer、可选批次/服务名、自动预检和 manifest 设置。其单元类型/名称与现有 personal-status 也不直接兼容。独立的代码比较、旧分支问题和实施建议见 [服务分支分析](reviews/SERVICE-BUNDLES-TAKEOVER-TRIAGE.md)。旧分支的 `enable-linger` 审核意见不等于 main 已消除该行为；当前一次性 CI 仍使用它。

## 已完成部署阶段的范围与后续边界

本阶段在已接受的固定个人服务合同上实现**绑定审核计划的部署与回滚流程**。此前个人服务工具只生成/校验待安装文件，使用者仍需手工链接和启动；旧 `install-service.py --enable` 只管理数据库/MCP。

1. 为待部署的个人单元绑定计划 hash、完整导出清单和明确的安装目标；只读检查现有 links、drop-ins 与单位状态，产出可核查变更计划。
2. 拒绝不明归属和冲突，保留用户自定义配置及现有数据库/MCP 单元；默认只处理管理台，Worker/模型许可独立。
3. 增加明确调用的安装/更新动作和持久化回滚回执，覆盖部分写入、重载失败及进程中断。本次只处理已经停止的个人单元；激活与激活失败回滚另行开发。开发该能力不等于获准改动用户正在运行的服务。
4. 在一次性真实 user-systemd CI 中验证安装、故障恢复和回滚，并与 personal-status 区分管理器活动、安装绑定及应用实际就绪。
5. 完成后对最终应用提交开展新的独立子代理审核；本轮对任务召回的 PASS 不覆盖新的部署实现。

本阶段已按上述停止状态范围验收并合入 PR #11；自动激活切换与激活失败回滚可作为后续独立阶段。Timer 可在后续设计，现有 Worker 已具备周期处理，不需要为此恢复整个旧分支。能在仓库/Linux/CI 执行的工作继续在仓库侧完成。

## 持续约束与未完成边界

目标继续是个人 Linux 长期记忆中枢，优先通用 MCP/HTTP/CLI，服务多个 Agent；保持项目托管 PostgreSQL、现有上游 pin 和独立 Windows qbrain 项目。沿用 [AGENTS.md](../AGENTS.md)：持续推进并实际提交 GitHub；每个实现阶段由真实独立代理审查；不得把未执行、未推送或未通过的事项宣布完成。只有确实依赖用户设备/凭据/实际部署的工作才交给本地 agent，且脚本先提交 GitHub、提示词为一个完整连续段落。

个人 V1 仍未全部完成：真实用户主机部署、完整客户端/模型回合验收、全部客户端自动采集、Grok CLI、PDF/图片/OCR、多模态、真实模型长期记忆质量和完整多主机/外部存储恢复仍有缺口。已支持功能及发布门槛见 [个人 V1 检查表](PERSONAL-V1-CHECKLIST.md)。当前阶段不扩大企业功能，不把 OpenViking/GBrain 全功能等价当成已完成。

任务查询会到达选定服务器，日志策略可能保留参数；已经发送的查询不能撤回。Hook 冲突检查仅覆盖选定 settings 文件与可识别命令，workspace 沿用实时 realpath 比较而非目录 inode 固定。这些限制均保留，不将本阶段验证扩展成同账号文件系统隔离或真实模型质量保证。
