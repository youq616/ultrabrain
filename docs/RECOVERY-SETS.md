# 个人恢复套件：数据库、私有配置与本地原生文件

这是主机侧运维功能，不是 MCP 工具。它把现有受管理 PostgreSQL 的逻辑备份与本次明确授权的本地原生状态放进一个可校验的私有目录；不会上传文件、安装后台任务、自动替换配置或切换正在使用的数据库。

## 覆盖与限制

创建时纳入 `ULTRABRAIN_HOME/gbrain/` 内的全部普通文件和空目录（包括其本地原生附件、配置、凭据及日志），以及存在的 `postgres/state.json`、`postgres/runtime.json`、`service.env`、`personal-console-token`。最初三份核心状态中的数据库状态、运行时记录和 `gbrain/.gbrain/config.json` 必须存在。文件内容保持原字节；对象以固定编号保存，原始相对路径记录在 manifest，编号不是加密。

**恢复套件是明文敏感数据，包含数据库正文和可能的密码、令牌、模型密钥。**必须在私有目录保存，不得提交 Git、发到聊天或作为公开 CI 产物。`--include-private-state` 是明确的备份授权，不是脱敏开关。建议在主机或备份存储层另外配置加密及访问权限；本工具没有自制密码学协议，也不宣称已经实现加密备份。

不包含运行时二进制/OS 依赖、运行中的 PGDATA/WAL、仅存在于进程环境中的密钥、外部密钥库、S3 等外部对象、其他路径的代码仓库、Windows 客户端队列、systemd 单元和各 Agent 的配置。这些排除项写入 manifest 和 verify 的结果，不能把 `verified:true` 理解为所有外部依赖也已经备份。gbrain 下出现符号链接、硬链接、设备/FIFO/socket 或不可读取项会拒绝，不默默跟随外部路径或跳过。原生目录较大时也可能超过本版限额：20,000 个文件及目录、总内容 8 GiB、manifest 8 MiB。超过限额保留失败证据，不淘汰旧备份、不静默截断。

## 创建前：停止应用写入，数据库保持运行

先停止此安装的 MCP 服务、管理台、整理 Worker 和其他会写本地原生文件的客户端，保留托管 PostgreSQL 运行。工具不会替你执行 `systemctl stop` 或终止未知进程。`--writers-stopped` 是操作者的声明；工具还检查应用数据库当前没有客户端连接，并在复制和 pg_dump 后重新检查本地文件清单及指纹。

这**不是跨数据库/文件系统的原子快照**。检查不能阻止另一个不遵守维护窗口的进程在中间写入并退出；需要操作者真正暂停写入。PostgreSQL 内部一致性由 pg_dump 保证，不复制运行中的数据目录。官方依据：<https://www.postgresql.org/docs/18/app-pgdump.html> 与 <https://www.postgresql.org/docs/18/backup-file.html>。

使用普通 Linux 服务账号，在匹配此安装的仓库目录执行；不要使用 root。示例目录必须是新的、在 `ULTRABRAIN_HOME` 与代码工作区之外的目录：

```bash
install -d -m 0700 "$HOME/ultrabrain-recovery"
bun src/cli.mjs recovery create \
  --destination "$HOME/ultrabrain-recovery/set-001" \
  --include-private-state --writers-stopped
```

成功会返回 `manifest_sha256`，不打印密钥、配置正文或源文件名。把这个 SHA 保存在**套件以外的可信记录**中。任何失败都不能当作完成；目标已有时拒绝覆盖，复制或备份中途失败留下 `INCOMPLETE`，校验器会拒绝它。创建持有现有 PostgreSQL 管理锁，避免与本工具管理的 stop/restore 同时执行，但不声称该锁能控制外部原生进程。

## 校验与隔离展开

下例的 `TRUSTED_MANIFEST_SHA` 必须换成此前可信记录中的完整 SHA，不能临时从一个不可信下载包自己计算后就称为认证通过：

```bash
bun src/cli.mjs recovery verify \
  --directory "$HOME/ultrabrain-recovery/set-001" \
  --expected-sha TRUSTED_MANIFEST_SHA
bun src/cli.mjs recovery stage \
  --directory "$HOME/ultrabrain-recovery/set-001" \
  --expected-sha TRUSTED_MANIFEST_SHA \
  --destination "$HOME/ultrabrain-recovery/staged-001"
```

验证检查完整清单、数据库 manifest 与 dump 的关联、每个文件的字节数/SHA-256，以及多余、缺失、链接、路径穿越和不完整文件。SHA 校验提供的是完整性；来源认证仅与外部保存的 SHA 一样可信。

展开后的 `private-state/` 与 `database/` 都是**未激活的恢复材料**，不是新安装。`STAGED-NOT-ACTIVE` 明确提醒不要把该目录直接设为 `ULTRABRAIN_HOME`。原数据库密码、绝对路径、服务环境、公开访问配置可能不适合新主机；不得整目录覆盖当前安装。stage 不执行 SQL、不解密密钥、不启用服务；重复目标拒绝覆盖。

## 恢复到新的测试数据库，不切换业务

先在目标主机准备匹配的受管理 PostgreSQL 环境。此版本要求当前执行代码指纹、四个上游锁和 PostgreSQL/pgvector 运行时绑定与备份一致；它不自动执行跨版本迁移。应用指纹覆盖 src、scripts、migrations、web、compat、package.json 及上游锁，不依赖 Git 凭据或包含测试日志。更高版本的恢复应先使用对应备份的受审源码还原，再执行已有升级验证流程。

```bash
bun src/cli.mjs recovery restore-database \
  --directory "$HOME/ultrabrain-recovery/set-001" \
  --expected-sha TRUSTED_MANIFEST_SHA \
  --database ub_restore_rehearsal --trust-source
```

`--trust-source` 是明确确认信任备份来源：PostgreSQL 官方说明恢复 dump 会执行来自源数据库的代码；完整性校验不能把恶意备份变成安全备份。不要把陌生人的 dump 交给自己的服务账号执行。官方警告：<https://www.postgresql.org/docs/18/app-pgdump.html>。

数据库名必须符合 `ub_restore_*` 约束，不允许 `ultrabrain` 或任意 SQL。执行前复制并重新验证数据库文件到私有临时目录，再复用现有 `restore-new` 实现；不使用备份内的可执行文件或管理员脚本。已有数据库由 createdb 拒绝，不 DROP、不覆盖、不应用旧密码、不更改 `database_url`。失败可能留下一个**新的不完整恢复库**，工具不会自动删除它或宣称成功；应核查后再明确处理。

成功表示新数据库恢复命令完成，**不表示服务已经切换或旧数据可以删除**。应核对应用对象、原文及来源元数据，再按新主机环境审查配置和密钥并安排手工切换。当前服务、模型账号和客户端不由恢复命令自动激活。完整跨主机自动切换、外部对象存储与客户端队列协调恢复仍属未完成范围。

## 验证

`python3 -m unittest discover -s test -p test_recovery.py -v` 只使用合成文件与假 dump 验证拒绝路径；不称其为数据库测试。`ULTRABRAIN_TEST_ALLOW_WRITE=1 python3 test/recovery-integration.py` 在已初始化的隔离 Linux 测试安装中执行实际 CLI、pg_dump/pg_restore、文档原文字节检查、配置/附件隔离展开及全部 27 类恢复指纹。此集成测试不能在重要记忆库上运行；它会创建合成数据并清理仅属于本次随机命名的恢复数据库。CI 已纳入单独的真实恢复步骤。测试不会启动付费模型或把含凭据的恢复套件上传为产物。
