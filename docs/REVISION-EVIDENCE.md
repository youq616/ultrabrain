# 代码版本绑定的执行证据（0.4.0-alpha.1）

## 用法

原回执绑定 source、项目、任务描述和进程退出码。本版增加**可选、显式的代码版本约束**；不改变旧任务和回执的含义。

在 ultra_project_save 的任务对象中加入 code_revision，必须是 git rev-parse HEAD 返回的完整小写提交 ID（40 或 64 位），不能是 main、HEAD 或短 SHA。这个值纳入任务规范 hash，修改目标提交必须重新验证。

```js
const task = {
  id: 'regression', title: '运行选定提交的回归测试',
  acceptance: ['指定测试命令成功退出'],
  status: 'in_progress', code_revision: actualFullGitCommit,
  receipt_ids: [],
};
```

在被测试的 Git 仓库目录运行主机命令：

```bash
bun /path/to/ultrabrain/src/cli.mjs verify --source development --project ultrabrain --task regression --kind test -- node --test
```

CLI 不解释 shell，不向 MCP 增加执行命令能力。回执包含执行前后 Git 观测；进程退出为 0 但目标代码不匹配时，CLI 返回 2 并报告 code_revision_matched:false。回执保留用于诊断，不自动修改 checkpoint 状态。

将成功回执 ID、verified_complete 和最近读取的项目 revision 提交给 ultra_project_save。服务端检查来源/项目/任务/规范匹配、所有回执存在且退出成功、没有超时。带 code_revision 的任务还要求前后 Git 提交与目标相同、工作区干净、同一仓库根路径指纹、无隐藏变更的 index 标志。

只读工具 ultra_project_evidence 接受 project_id 和 receipt_id，返回该授权 source 内指定项目的回执；只读 source grant 可以查询，目录绑定、delegated 和退化授权拒绝。没有原始 stdout/stderr、命令参数、diff、仓库路径或文件名，只保留 hash。

## 拒绝与兼容

没有 workspace 数据的历史回执不能验证带 code_revision 的任务。错误提交、残留修改、暂存/未跟踪文件、assume-unchanged 或 skip-worktree 标志均不能满足干净版本检查。无 Git、未建立 HEAD、超时或超出输出限制时标记不可观测，不冒充干净仓库。

无 code_revision 的任务仍使用原 task hash，不自动获得版本认证。迁移新增 nullable JSONB 列，不重写旧回执或删除历史。升级前停写、备份，再执行 migrate；数据库二进制切换另按 UPGRADES.md 办理。

## 证据边界

这是可信主机在**两个时间点**读取的 Git 状态，不是签名 CI 见证、密封构建、逐字节源快照或供应链证明。ignored 文件、环境、外部依赖、远程服务及中途改变又恢复的文件不在范围内。稀疏 checkout 的 skip-worktree 被保守拒绝，应使用完整 checkout。

Git 观测清除继承的 GIT_* 重定向，禁用全局/系统配置及 fsmonitor，并限制单次时间和输出；主机 Git 程序、仓库本地配置、选定测试命令和数据库管理员仍为可信输入。Git 行为参考：https://git-scm.com/docs/git-status 与 https://git-scm.com/docs/git 。

某个目标提交的历史成功回执不表示当前部署已通过验证。项目写入者可以修改目标和验收要求，权限治理不能由 hash 替代。

## 验证

workspace-evidence.test.mjs 使用真实临时 Git 仓库；revision-evidence-integration.mjs 使用真实 PostgreSQL、MCP dispatcher 和主机 CLI，检查旧回执、错误提交、脏工作区、跨 source/project 拒绝以及正确回执通过。样本留在隔离库以供备份恢复核对 workspace 内容。必须使用隔离数据目录和 ULTRABRAIN_TEST_ALLOW_WRITE=1。
