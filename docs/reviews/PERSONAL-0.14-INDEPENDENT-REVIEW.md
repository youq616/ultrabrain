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

## 第二次独立审核（15c2201）

- 实际 review：`PRR_kwDOUWWQ288AAAABNYSLIQ`，被审核提交 `15c2201d66874d0fcd035a532753e2120abd7b2d`，时间 `2026-09-14T00:14:06Z`。状态 COMMENTED，不是批准。
- P1 评论 `4001393941`：Claude Hook 等待 stdin 时若 profile 被替换，事件使用旧配置授权、writer 却加载新配置，可能将旧事件转到新目的地/项目/队列。
- P2 评论 `4001393945`：队列命令示例缺少 npm prefix 下的 node_modules 目录。

实施者先加入回归：修复前十项针对性检查有六项失败；真实打包 Node/MCP/PostgreSQL 的同步测试也复现了 P1，旧程序返回 observation journaled by the server，而不是拒绝配置变化。测试用专用 preload 在读取 stdin 的准确边界通知父进程，再由父进程替换合成 profile；没有用不确定的 sleep 或增加产品后门。

修复：automaticCapture 必须接收最初授权的完整 profile 快照，初始化即比较，并继续在入队/发送前复核。CLI 与 OpenCode 调用点均传入相应原快照；相邻 queue-capture 路径也在 stdin 之后、落盘之前重新核对原配置。替换目标不会新建队列或发送原文。修正队列文档的 node_modules 路径，并增加回归。

修复后，437 项 JavaScript 单测通过，0 失败/跳过；Python 86 项通过；最终重建后的采集/崩溃/配置替换联调 20 项通过，Node/代理联调 19 项通过，原生回调联调 7 项通过。这些测试由实施者执行，不冒充审核代理执行；完整 OpenCode/Windows/浏览器/升级结果仍看同提交 CI。修正提交需要继续独立复审，不以本归档自我批准。
