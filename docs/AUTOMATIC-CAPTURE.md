# Personal 0.14 开发候选：授权自动采集和交付队列

本候选尚待独立子代理审核，不能以 CI 通过替代批准。服务端仍使用原有托管 PostgreSQL 和个人整理任务，不改旧迁移或上游锁。

## 采集边界

默认不采集。只有可信 profile 同时指定 allow_capture、automatic_capture 范围、真实 workspace、观测得到的 expected_instance/expected_actor 和工作区外的 outbox_directory 才能启用。四个范围为 claude-user、claude-assistant、opencode-user、opencode-assistant；分别授权，不因开启只读 Hook 而启用写入。

Claude UserPromptSubmit 取本次 prompt，主 Stop 取 last_assistant_message，采用 session_id + prompt_id + 角色生成稳定事件。官方 prompt_id 字段要求 v2.1.196+；缺少时拒绝，不用时间或随机编号冒充稳定来源。子 Agent 与 Stop 续跑不进入采集，不读取 transcript_path。

OpenCode 1.18.30 在 chat.message 取非 synthetic、非 ignored 的普通文字部分，在 experimental.text.complete 取已完成的助手文字片段。通过 session.get 核对主会话和 workspace，不读取附件、工具结果或隐藏推理。记录的是 Hook 观察到的文字，不是完整回合证明；别的插件可能修改文本，用户提交之后也可能被其他 Hook 拒绝。

助手文字明确标记为未核实的助手观察，不代表用户确认。服务端原文是私有候选、整理任务为 queued；此采集链路不调用整理模型、不自动激活记忆。正文内的密码或秘密没有自动识别/脱敏保障，因此不要在已授权自动采集的会话输入不应保存的数据。

## 配置与安装

先按 CLIENT-KIT.md 创建只读连接并 probe，以实际结果取得身份 pin，再用 scripts/client-profile.py 创建一个新 profile。保留已核实的连接参数，加入 --workspace、--expected-instance、--expected-actor、--allow-capture、--outbox，以及逐项 --automatic-capture。目录放在 Agent 项目之外，Linux 0700/文件 0600；Windows 使用自己的私有 NTFS 目录并检查 ACL，本脚本不自动配置 ACL。不要放同步盘、NFS 或多机共享目录。

Claude 用 scripts/client-config.py --client claude-capture-hooks，目标为选定项目的 .claude/settings.local.json；先 plan，核对 before_sha256 再 --apply --expected-sha。可与原只读 claude-hooks 共存；不会覆盖 permissions，也不会绕过 disableAllHooks。OpenCode 继续用 scripts/native-adapter-config.py 生成 .opencode/plugins/ultrabrain.js；其 plan 显示 profile 是否允许采集。合并/回滚保持原有备份与哈希检查。

从本候选源码执行 `bash scripts/package-client.sh` 生成私有 `ultrabrain-client-0.14.0-alpha.1.tgz`。安装方式见 CLIENT-KIT.md，未发布 npm，不要用注册表同名软件替代。安装本包不会自动安装或启动其他 Agent。

## 队列操作

客户端入口为实际安装目录中的 `node_modules/ultrabrain-client/dist/cli.cjs`：

```sh
node /installed/ultrabrain-client/dist/cli.cjs queue-status --profile /private/capture-profile.json
node /installed/ultrabrain-client/dist/cli.cjs queue-flush --profile /private/capture-profile.json
node /installed/ultrabrain-client/dist/cli.cjs queue-flush --profile /private/capture-profile.json --retry-blocked
```

路径必须替换为实际路径。自研 Agent 可将 agent_id、event_id、transcript、consent:true 的 JSON 经 stdin 交给 queue-capture --profile PATH。直接 capture 命令仍是无本地队列的直接交付，不混淆保证。

原文先写客户端日志再发送；匹配实际 source/event/job 的服务端 journaled 回执且身份核对通过后才删除本地正文。每次 Hook 只尝试当前事件，旧积压用 queue-flush 处理；没有暗中安装常驻进程或调度器。上限 256 条/8 MiB，满额拒绝新事件不驱逐旧事件；最多八次自动尝试后转为受阻，显式重试保持原事件编号。超限整条拒绝，不截断否定词。Hook 出错不会阻止用户工作，须留意未确认提示。

队列绑定目的地配置、source、actor、instance、project 与 workspace。关闭采集可继续查队列但不能发送；更改目的地不能接管旧队列。采集器重新读取 profile，最后发送前再次检查，包括异步注册/身份检查之后；已发送的请求不能撤回。重新授权并显式 queue-flush 可交付旧的待提交记录。

Linux 使用文件与目录 fsync；Windows 只声明文件 fsync，不声明相同的断电目录持久性。队列存放明文获准输入，不是加密备份，也不能抵抗恶意同账号程序。未取得客户端持久化回执之前崩溃的输入不保证保存。

## 崩溃锁恢复

不按锁年龄自动偷取。先停止实际写入进程，使用 queue-lock --profile PATH --kind queue 或 delivery 查看 PID/哈希，再以 queue-recover-lock --profile PATH --kind KIND --expected-sha HASH --confirm-writer-stopped 恢复。活动或无法核实退出的 PID 会拒绝。恢复不删除正文；未知文件和中断临时文件保留诊断，不擅自清理。此操作只针对自己的本地队列，不替代服务端灾难恢复。

## 验收层次

单元测试检查同意、稳定事件、对象快照、撤销/取消、错误回执、身份变更、多进程锁、容量和重试。test/capture-integration.mjs 执行真实 Node/stdio MCP/PostgreSQL，包括服务端已提交后客户端退出再重放。Claude 使用合成事件；没有因此认证真实 Claude 模型回合。独立 native-client-engines workflow 安装 OpenCode 1.18.30 并检查模型请求中的记忆以及用户/助手文字落库，模型供应商仍是合成服务，不是提取准确率评测。

独立审核任务位于 reviews/PERSONAL-0.14-REVIEW-REQUEST.md；实施者自测报告不是独立子代理报告。完整个人 V1 仍未完成。

官方接口依据（2026-09-14 核对）：https://code.claude.com/docs/en/hooks 的 Common input fields/Stop；https://opencode.ai/docs/plugins/ 及 anomalyco/opencode v1.18.30 的 packages/plugin/src/index.ts。
