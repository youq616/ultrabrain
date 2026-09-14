# Personal 0.14：独立 Codex 审核记录

本文件是实施者对真实 GitHub 审核记录的归档，不是实施者冒充独立审核者。实时结果以 PR #1 中对应完整 HEAD 的 Codex 审核为准；下列是第一次审核及修复记录，不预填复审批准。

## 第一次独立审核

- 审核代理：`chatgpt-codex-connector`（GitHub Codex bot）。
- 完整被审核提交：`e44c4c74936157ffd9c77ceae5a594e25956eb7e`。
- 基线：`57852fed3d1839bab105c5b56632af1f65bb4b15`。
- 实际 review 标识：`PRR_kwDOUWWQ288AAAABNYQIHg`；提交时间：`2026-09-14T00:01:16Z`。
- 实际 GitHub review 状态：`COMMENTED`，返回一项 P2 建议；不是 APPROVED。
- 原始发现评论：`4001362003`，挂在 `packages/ultrabrain-client/package.json:3`。

独立代理指出：构建产物已经是 0.14，但 CLIENT-KIT/NATIVE-AGENT-ADAPTERS 的安装示例仍指向 0.12/0.13 tgz，照文档操作会找不到文件。原始记录位于 https://github.com/youq616/ultrabrain/pull/1#discussion_r4001362003 。

## 实施者修复及复现证据

已将两个被引用安装文档的包名与当前 manifest 对齐，同时明确历史能力表、默认只读模式、0.14 额外采集与直接 capture/queue-capture 的边界。新增 `test/client-release-docs.test.mjs`，检查三个当前安装文档中的 tgz 名称都与实际客户端版本一致。

将两个文档临时还原为修复前内容运行新检查，退出 1；恢复修复后，三项检查通过。全量 JavaScript 现为 430 项通过、0 失败、0 跳过。上述复现与测试由实施者执行，不归功于独立代理；独立审核回复未列出其执行过的测试命令，因此这里不编造。

本次修复没有改变任何运行时代码、迁移、权限或依赖。修改后的完整提交仍需独立复审与提交级 CI。第一次审核以及这份归档都不自动批准后续提交，也不是无漏洞或完整 Personal V1 证明。
