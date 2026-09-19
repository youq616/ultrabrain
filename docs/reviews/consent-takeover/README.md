# 个人采集与模型授权撤回：验收档案

本档案保存 2026-09-19 接手审核、首次失败、独立复核与实际 CI 的逐提交归属。产品优化计划见 [接手计划](../../TAKEOVER-2026-09-19.md)。

| 对象 | 固定身份 |
| --- | --- |
| 接手 main | `77b4ecf649124fc169e4c838b5202d96211e933e` |
| 第一候选，独立审核 BLOCK | `de5ca16c04d6102da6fd92370d03ff6bf939c58b`；tree `9cc8ce0fea900e468e35d598b054ff5b6e8c9ad1` |
| 最终候选，两个独立审核 PASS | `a9678135d28c6f3094db4e2d42f4077206fcd49b`；tree `e51dca2cfad06fc906d0de8104158bb716deca83` |
| 最终本地测试副本 | `443d0b1e23c56a839513b0246e8eb386f77666da`，与最终远端 tree 完全一致 |
| PR CI 实测 merge | `ba4447768858b797793f0f01f7c619e98ef95cb6`，与最终候选 tree 完全一致 |
| main 应用合并 | `6aae8a01f0d5f27dedf64e0687af9cb3b02e29ea`，相同应用代码树 |
| PR | [#14](https://github.com/youq616/ultrabrain/pull/14) |

直接 Git push 因缺少 CLI 凭据失败后，使用已认证 GitHub 插件创建同内容代码树并提交。首次本地 `a327511d44e034e62e1802c42248354cb46e92fa` 与远端第一候选同 tree；最终本地与远端同理。两位独立 reviewer 都自行核对了最终 Git 对象及所有改动内容，差异仅在提交头部，不存在未经审核的应用文件差异。

## 实际独立审核

- [`/root/review_consent_client`](review-client-final.md)：最终完整 SHA 明确 PASS。独立执行 175 项仓库针对性检查及 13 项另写探针，共 188 项通过；范围包含客户端、队列、SDK、浏览器、模型修正和相关文档。
- [`/root/review_consent_server`](review-server-final.md)：最终完整 SHA 明确 PASS。独立执行 142 项 Node 检查及修正后的租约复现；深查模型/数据库准入和浏览器提交边界，并核对全部 21 个改动文件。

两者均未实现此次应用修改。独立 Node/SQL/DOM/供应商夹具不是实际数据库、客户端引擎或真实模型质量证明。CI 单独执行实际协议、浏览器和数据库检查；执行归属以 [机器记录](evidence.json) 为准。

## 首次失败与修正

1. 原 SDK/队列忽略显式 false 或异步拒绝。已有相关 135 项测试通过，新增回归在修复前 55 项中 21 项失败。保留 [客户端复现](first-failures/client-repro.log)、[新增回归首次失败](first-failures/client-regressions.log) 和 [实施审查](client-implementation-audit.md)。原生 CLI 的抛错授权方式不能被误说成以前同样失效。
2. 模型准入前配置变更：修复前 5 项针对性回归全部失败，见 [模型准入首次失败](first-failures/model-admission-baseline.tap)。[最初完整测试](first-failures/model-first-run.tap) 另有尚不支持测试加载器造成的上游文件缺失；这些环境/测试接口错误不计为已复现的产品问题。
3. 管理台取消授权后继续发送，见 [管理台复现](first-failures/console-repro.log)。修复后对表单/会话和编辑版本进行发送前复核；回执未知时保留原事件，撤回只停止重试。
4. 第一候选独立审核发现最终配置等待可跨越任务租约到期。保留 [服务初审 BLOCK](first-failures/review-server-initial.md)、[客户端初审 BLOCK](first-failures/review-client-initial.md)、[原复现](first-failures/server-lease-repro-output.json) 和 [修正前新增测试失败](first-failures/lease-correction-baseline.log)。最终加入配置等待后的数据库时钟复查，并在原生网关调用前保留同步授权检查；不得将早期 BLOCK 改写成 PASS。
5. 本地基线全量为 558/563 通过，5 项因 UID 0 不满足普通账号要求失败；[原日志](first-failures/local-baseline-node.log) 保留。没有放宽保护或跳过测试。最终普通 Linux 账号 CI 实际执行 612 Node / 542 Python，全通过、无跳过。

## 证据使用边界

最终候选共 13 个工作流、47 个 jobs 全成功（PR 六组 23 jobs，push 七组 24 jobs）。合并后的 main 应用提交 `6aae8a01f0d5f27dedf64e0687af9cb3b02e29ea` 又完成七组 24 jobs，均成功；[main 全量 CI](https://github.com/youq616/ultrabrain/actions/runs/35421538617) 实际执行 612 Node / 542 Python，且完成真实 n8n CLI 与 27 项适配检查。[main 服务 CI](https://github.com/youq616/ultrabrain/actions/runs/35421538616) 也已完成。所有工作流、逐 job 状态和执行步骤记录在 evidence.json 的 candidate_ci / main_ci；八份原始 CI 日志保存在 [ci-logs.zip](ci-logs.zip)，逐日志 SHA-256 见 [日志清单](ci-log-manifest.json)。归档文档提交本身未重新执行应用 CI。

原始报告、探针和日志按原字节归档，[files.json](files.json) 记录其 SHA-256。报告中的绝对路径、原文件名和当时 pending 措辞保留历史原样；档案探针可能引用原工作目录，不是面向用户的安装脚本。CI 运行 URL、执行步骤、应用 SHA、原日志哈希及最终状态另记在 evidence.json；压缩原日志另附供核对。

新模型测试使用本地合成供应商：实际原生配置文件、Bun/SDK/HTTP 和数据库时间均被验证，但不证明记忆内容的语义准确率。服务测试在一次性普通 Linux 账号下运行，不表示已部署到用户主机。已有 Agent 注册元数据兼容、首次使用入口、完整客户端/模型验收及 PDF/图片支持继续按接手计划推进。
