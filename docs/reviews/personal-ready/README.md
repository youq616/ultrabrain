# personal-ready 阶段验收与独立审核

记录日期：2026-09-18。只读管理台就绪检查已通过 [PR #12](https://github.com/youq616/ultrabrain/pull/12) 合入。它验证受管安装、实际 console 运行实例、新鲜认证响应及该实例查询的托管 PostgreSQL；命令与限制见 [PERSONAL-READY.md](../../PERSONAL-READY.md)。自动激活、运行中切换和激活失败恢复仍是后续独立阶段。

| 验收对象 | 精确值 |
|---|---|
| 开发起点 | `d2d8c30b939000b26fe41fc0e5bcab618232ca28` |
| 最终应用候选 | `715314236183ff75f97bc96fcfef57bd6b421192` |
| 最终应用代码树 | `38dece61288c8f7e9eb2b3726e6343b5595b1ef5` |
| PR 实际测试的 merge | `8e053f13e7b2374f26ef79a202a43bb41dcb2936`，代码树与候选相同 |
| 实际 main 应用合并 | `d72ee27cafe9b309253ebd382fd752932fbe9e38`，代码树与候选相同 |
| 独立实现审核 | 两个未参与实现的 reviewer 对最终完整候选 SHA 明确 PASS |
| 最终候选 PR CI | 六个工作流、23 个作业全部成功 |
| 最终候选 push CI | 七个工作流全部成功 |
| 应用合并后的 main CI | 七个工作流、24 个作业全部成功 |

## 独立审核

下列六份报告由实际独立 reviewer 会话给出，按收到的最终文本逐字归档。实现代理 `/root` 负责修正与验收汇总，不把自己的调查结论当成独立审核。CI 审计代理 `/root/ready_ci_audit` 只核对实际运行证据，不替代代码审核。

| Reviewer | 第一轮 | 第二轮 | 最终轮 |
|---|---|---|---|
| `/root/ready_protocol_review` | [BLOCK](protocol-initial.md) | [BLOCK；保留已撤回的早期 PASS](protocol-round2.md) | [PASS：715314236183ff75f97bc96fcfef57bd6b421192](protocol-final.md) |
| `/root/ready_binding_review` | [BLOCK](binding-initial.md) | [BLOCK](binding-round2.md) | [PASS：715314236183ff75f97bc96fcfef57bd6b421192](binding-final.md) |

协议 reviewer 最终自行执行 71 项 Python、53 项 Node、50 项独立分帧/实际 loopback socket 检查及 7 项 SQL 地址边界夹具，全部通过。绑定 reviewer 最终自行执行 71 项 Python、53 项 Node、7 项独立绑定/实际 socket 检查和 6 项独立分帧检查，全部通过。这些本地执行不包括本容器中的活 PostgreSQL 或 user-systemd。报告中的文件行号对应各自精确候选；报告记录的 CI pending 状态保留其当时观察时间，不随后来的成功改写。

## 首次失败与修正

| 候选 | 实际失败与处理 | 验收结论 |
|---|---|---|
| `fde82fa97843d22b3f1a92fb83926cc99d53dcaa` | push 与 PR 真实服务 CI 均在首个 `owned_live_console` 返回 `readiness_timeout`，新增检查完成数为 0。两个 reviewer 独立复现：完整 Content-Length 响应已到达，客户端仍等待对端 EOF。修正为严格分帧完成后关闭本端连接。 | BLOCK，未合并 |
| `7ffbe5c14c5cf31e90510c6f62ed752a6552b5c3` | 分帧修正通过，但 push 与 PR 真实服务 CI 均在首个案例返回 `readiness_unverified`。实现调查发现 PostgreSQL `inet::text` 返回含 `/32` 的值，与严格纯地址比较不符；两个 reviewer 随后独立核对官方文档与代码。协议 reviewer 撤回此前完整提交 PASS。绑定 reviewer 还复现最大长度 header 的分隔符跨包误拒绝。 | BLOCK，未合并；PR Validate 后被取消，不能记成全部通过 |
| `715314236183ff75f97bc96fcfef57bd6b421192` | 查询改用 `pg_catalog.host(pg_catalog.inet_server_addr())`，保留严格 `127.0.0.1` 比较；真实数据库测试同时验证两种转换。为最大 header 的未完整分隔符保留至多 3 字节空间，实际 header 与总字节限制不变。全部要求的 CI 与两份最终独立审核通过。 | PASS，按上述相同代码树合并 |

第二轮 SQL 原因来自实现调查及独立代码/官方源码核对，安全 CI 日志只证明 `readiness_unverified`，没有暴露实际 SQL 行。最终真实数据库断言与端到端成功另行验证修正。历史独立报告、首次本地回归失败、reviewer 自建夹具错误与修正均保留，不把先前失败改写成成功。

## 实际 CI 验收

| 最终 PR 工作流 | 结果 |
|---|---|
| [Validate 35292739710](https://github.com/youq616/ultrabrain/actions/runs/35292739710) | 17/17 作业成功；557 Node 测试通过、0 失败、0 跳过；438 Python 测试 OK；15 条历史升级路径及 n8n 引擎成功 |
| [个人用户服务 35292739684](https://github.com/youq616/ultrabrain/actions/runs/35292739684) | 12 项新就绪检查、15 项原有部署检查、18 项既有服务检查成功 |
| [恢复 35292739669](https://github.com/youq616/ultrabrain/actions/runs/35292739669) | 成功 |
| [客户端跨平台 35292739720](https://github.com/youq616/ultrabrain/actions/runs/35292739720) | Ubuntu、Windows 两个作业成功 |
| [任务召回 35292739703](https://github.com/youq616/ultrabrain/actions/runs/35292739703) | 成功 |
| [原生接入 35292739690](https://github.com/youq616/ultrabrain/actions/runs/35292739690) | 成功 |

[最终候选 push 服务运行 35292736874](https://github.com/youq616/ultrabrain/actions/runs/35292736874) 同样成功。12 项新增检查使用一次性普通账号的真实 user-systemd、托管 PostgreSQL 和认证 HTTP：覆盖正确预期、错误身份预期、令牌轮换、运行中 source 缺失、真实表锁、恢复后的同一 console invocation 和最终状态快照不变。这里的快照比较涵盖配置/文件、服务身份和记录数量，并不声称逐字节比较了数据库全部行。

新增就绪与原有部署夹具均为 0 次模型调用；原有 18 项服务检查使用 2 次本地合成 provider 响应。本地环境为 UID 0，未放宽生产普通账号门槛，也未将本地夹具当成普通账号活服务验收。没有部署或修改用户生产服务，不据此宣布个人 V1、完整客户端或真实模型质量全部完成。

合并后对实际 main 应用提交 `d72ee27cafe9b309253ebd382fd752932fbe9e38` 再次核对自动 CI：[全量](https://github.com/youq616/ultrabrain/actions/runs/35293471243)、[用户服务](https://github.com/youq616/ultrabrain/actions/runs/35293471223)、[恢复](https://github.com/youq616/ultrabrain/actions/runs/35293471219)、[客户端跨平台](https://github.com/youq616/ultrabrain/actions/runs/35293471229)、[任务召回](https://github.com/youq616/ultrabrain/actions/runs/35293471211)、[原生接入](https://github.com/youq616/ultrabrain/actions/runs/35293471217) 和 [源码快照](https://github.com/youq616/ultrabrain/actions/runs/35293471234) 七组全部成功，共 24 个作业。unit 与 services 的实际 checkout 均为该合并 SHA；日志再次确认 557 Node / 438 Python，以及 12 项就绪、15 项部署和 18 项既有服务检查通过。合并后 CI 审计、日志哈希与摘要保存在机器验收记录中，结果仅归属于该应用合并提交。

## 证据归属

[evidence.json](evidence.json) 保存三个候选及实际应用合并后的完整 CI 审计快照、精确 SHA/tree/父提交、实际 job/run URL、日志字节数与 SHA-256、允许公开的原文摘要行、六份 reviewer 报告哈希及本地测试失败历史。原始完整日志没有提交仓库；文件名指当时核验的日志流，完整日志仍受 GitHub 保留期限约束。首轮和最终轮 CI 审计中的 open/draft 或 in-progress 状态是合并前的历史快照，不是当前 PR 状态。

应用候选审核与 CI、实际应用合并后的 CI、后续文档归档是不同记录。此目录和同批状态文档在应用合并后单独提交；不能声称应用测试在该后续文档提交上重跑。后续任何应用改动必须另行验证并审核其精确提交。
