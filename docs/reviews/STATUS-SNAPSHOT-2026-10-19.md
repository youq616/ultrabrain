# 2026-10-19 项目状态快照的证据说明

## 精确归属

快照针对 PR #61 的 `c5829bacc9f2a1b57ac1e075d5a7084cfbbacc74`。核验时间为 2026-10-19 UTC，工作流执行时间为 2026-10-10，二者不能混写。候选树为 `6b458b975d7f918575b8aabf072b606daa5dc867`；PR 合成合并 `af53f2a58ac1a4f994c20da025322349d2efcd56` 具有同一树。

[机器快照](status-snapshot-20261019.json) 保存每个工作流的 run ID、event、head、attempt、时间和结论，保存所有开放 PR 的当前 head/base 与祖先关系，并保存以下产物的归档和内容哈希。它是一份观察记录，不是签名证明或独立代码审核。

## 工作流与产物

43/43 个工作流运行 completed/success：21 个 pull_request，22 个 push。不能把 43 写为 job 数、用例数或 43 项独立验收。PR 工作流的 checkout 目标须按各自定义读取：多数使用 GitHub 合成合并 ref，Candidate page contracts and source（run 38067530836，personal-candidates.yml）明确 checkout pull_request.head.sha；capture-locks 的 PR 产物绑定上述合成合并 SHA，push 产物绑定候选 head。两种测试提交的树相同已单独核验，不能将所有 PR 工作流一概写为测试 merge ref。

8 份 capture-locks 产物已通过 GitHub 下载端点取得，ZIP SHA-256 与 API digest 全部一致；直接解析 ZIP 内的 capture-contention.json 和 capture-lock-tests.tap，未重新执行其中代码。GitHub 原产物于 2026-10-24 到期，本次同时在 [capture-locks-20261010](capture-locks-20261010/) 保存 8 份逐字节一致的原始 ZIP，机器快照列出每份仓库路径、到期时间与哈希。归档成员仅为合成测试 capture-contention.json 与 capture-lock-tests.tap；检查未发现凭据、个人数据或私有路径。归档不含下载签名 URL，GitHub 到期不影响已入库的副本。

| Event | Run ID | Artifact ID | 平台 / 实际 Node | TAP pass/tests | 完整轮数 | busy_retries 总和 |
|---|---:|---:|---|---:|---:|---:|
| push | [38067527528](https://github.com/youq616/ultrabrain/actions/runs/38067527528) | 11674634941 | linux / v22.16.0 | 200/200 | 25/25 | 3 |
| pull_request | [38067530886](https://github.com/youq616/ultrabrain/actions/runs/38067530886) | 11675337869 | linux / v22.23.3 | 200/200 | 25/25 | 0 |
| push | [38067527528](https://github.com/youq616/ultrabrain/actions/runs/38067527528) | 11675357706 | win32 / v22.16.0 | 198/198 | 25/25 | 0 |
| pull_request | [38067530886](https://github.com/youq616/ultrabrain/actions/runs/38067530886) | 11675557741 | win32 / v22.23.3 | 198/198 | 25/25 | 0 |
| pull_request | [38067530886](https://github.com/youq616/ultrabrain/actions/runs/38067530886) | 11675991665 | win32 / v22.16.0 | 198/198 | 25/25 | 0 |
| pull_request | [38067530886](https://github.com/youq616/ultrabrain/actions/runs/38067530886) | 11676002525 | linux / v22.16.0 | 200/200 | 25/25 | 0 |
| push | [38067527528](https://github.com/youq616/ultrabrain/actions/runs/38067527528) | 11676115302 | win32 / v22.23.3 | 198/198 | 25/25 | 0 |
| push | [38067527528](https://github.com/youq616/ultrabrain/actions/runs/38067527528) | 11676360688 | linux / v22.23.3 | 200/200 | 25/25 | 0 |

四份 PR 产物均为 busy_retries=0。push Linux/Node 22.16.0 的产物 11674634941 记录 3 次 busy retry，其余三份 push 产物为 0。所有 Windows 产物均为 0，因此不能由这批成功运行证明 Windows 运行时实际进入了修改后的 busy-retry 路径，也不能宣称历史 Windows 调度问题在所有负载下消失。Linux 上观察到 retry 也不能外推 Windows。

## 历史测试与独立审核

[修复原记录](capture-contention-repair-20261007.md) 的 focused 126、supervisor/batch 161、regression 288、full Node 4476 均属于原阶段的已记录本地结果，本次没有重新运行。原记录明确保留 Python 683 项发现中的 13 个 UNIX-socket EPERM 以及 3 个 systemd/ownership 限制；本次没有将这些改写为本地通过。

PR #61 正文仍记录当时无法启动独立 reviewer，仅有实现者自审；读取正式 reviews 和 Conversation comments 均为空。没有定位到可绑定本精确候选的独立审核原文，因此当前状态是待核实，既不是凭空宣布失败，也不是独立 PASS。若存在另一个渠道的 PASS，须补齐实际 reviewer session/run 身份、完整 SHA、文件/行发现、执行证据和 verdict 后再采用；前序提交的审核不自动覆盖新提交。

## 分支和覆盖范围

远程 main 为 `491bf6fd702d8b88d30d65acb23b259a99242fcb`。GitHub Compare 返回候选领先 86 个提交、落后 0，完整提交列表为 86 项。41 个开放 PR 的 32 个 head 在该祖先列表中或等于候选，另 9 个 exact head 不在列表中；随后分别以这 9 个 head 为 base、候选为 head 调用 Compare，均为 diverged 且 behind_by > 0，确认它们不是候选祖先。这是精确提交归属，不能证明未列入 head 的所有改动都不在候选中，也不证明已列入的阶段获准合并。

PR #60 与当前候选均比共同祖先 `de280ffd7d0fd25374c9133d599eb92d814b2495` 多出 5 个提交，处于分叉。当前归档保留现有分支和历史，不执行跨分支集成。机器清单仅是本轮创建文档 PR 之前的仓库观察，之后新增文档 PR 不包含在 41 项中。

本次可访问的项目工作区中未定位到额外 Ultrabrain checkout 或未发布交接文件；没有可用的用户电脑或保存的编码环境。该范围不足以证明其他机器上的全部材料已同步。工作区私人文件、凭据、数据库、聊天和内部笔记不属于仓库归档内容。

## 本次文档验证

本次只更改 README 与 docs 下的状态、蓝图、交接和索引，保留原历史正文和原始修复报告。发布验证包括 UTF-8/JSON、修改文件内本地链接、只允许文档路径、树差异，以及远程提交/分支/PR 读回。新增文档提交的 CI 应单独读取，不能借用上述候选的 43 次成功运行。应用验收和合并仍遵循 [AGENTS.md](../../AGENTS.md)。
