# 0.6.1：pgvector SQL 扩展的显式升级

PostgreSQL 可执行文件、pgvector C 动态库和数据库内的扩展对象是不同层次。构建新动态库并不等于执行了数据库内的 `ALTER EXTENSION`。本版新增托管主库的主机管理命令，不开放 MCP SQL 或数据库管理员凭据。

## 查看计划

```bash
bun src/cli.mjs db vector-plan
```

计划只读：核对本地托管集群、活动运行目录、锁定版本、已安装 SQL 扩展版本、发行脚本默认版本和 PostgreSQL 声明的升级路径。目标来自 `upstreams.lock.json`，不能传任意扩展、SQL、远程数据库或目标版本。降级、脚本不匹配、无升级路径均拒绝。

## 停止客户端并升级

先停 MCP、整理客户端及其他使用此数据库的程序。新二进制的构建/停库/激活继续按 UPGRADES.md 处理；在新运行目录启动后，先检查 vector-plan，再做需要的 SQL 扩展升级，最后执行应用 migrate/health。

```bash
# --from-version 填 vector-plan 实际返回的 installed 值，不能照抄不匹配的版本。
bun src/cli.mjs db vector-upgrade \
  --from-version 0.8.5 \
  --confirm-maintenance
bun src/cli.mjs migrate
bun src/cli.mjs health
```

操作仅限本地服务账号，不用 root。升级命令验证预期旧版本，临时把应用角色 `ultrabrain` 设为 NOLOGIN，拒绝新的应用连接；检测到现有连接便失败并恢复登录，**不会强制终止客户端**。可信数据库管理员仍然可以绕过这个维护栅栏，不能在维护期间另行写入。

随后使用管理端凭据生成新的数据库专用备份和 checksum，再在事务中执行锁定目标的 `ALTER EXTENSION vector UPDATE`。命令不会复用已有备份目录，也不会通过 DROP/CREATE 扩展冒充升级。失败的 SQL 回滚；正常结束或可捕获异常后恢复应用角色原来的登录许可。原本被操作员禁用的角色不会被自动启用。

输出包含实际备份目录；也可显式指定 `--backup-destination /私有新目录`。备份使用现有格式 2，可通过 db restore-new 在不同数据库里演练数据恢复。它依然不包含外部附件、密钥或数据库二进制，恢复数据不代表把扩展/应用降级回旧版本。

## 中断后的恢复

若进程被强制杀死或主机断电，维护标记与 NOLOGIN 可能保留。先检查 vector-plan 和私有 `postgres/vector-maintenance.json`，确认集群和维护阶段，再运行：

```bash
bun src/cli.mjs db vector-recover --confirm-maintenance
```

恢复核对托管集群指纹、数据库 OID、原来的登录状态和扩展版本；只恢复登录并移除标记，不修改扩展对象，不声称数据库回滚。标记不匹配、出现第三个意外版本或连接不可用时拒绝猜测处理。

## 验收范围

`test/vector-upgrade-integration.py` 创建独立一次性 PostgreSQL 集群，使用真实 0.8.5 扩展 SQL 定义，再执行官方声明的 0.8.5→0.8.6 更新脚本。旧 SQL 文件的 Git blob 为 `7fc36712b31dc3b58d6c0c5caa8fa6097f30471d`，已与 pgvector 官方 v0.8.5 的 sql/vector.sql 核对；它与当前安装脚本内容相同，测试在复制前校验 blob，而不是篡改 pg_extension 版本号。

测试保留向量数据和 HNSW 索引，检查没有确认时拒绝、旧版本冲突、现有连接拒绝、强制进程退出后的恢复、注入错误的升级事务回滚、真实 SQL 升级和备份还原。所有操作发生在测试私有运行目录，不修改原安装的共享文件。

**两个 SQL 版本都使用当前锁定的 C 动态库。**这证明 SQL 管理流程，不证明所有历史版本、旧动态库到新动态库的 ABI 迁移或 PostgreSQL 跨主版本升级。改变目标版本时必须审查 fixture 和相应发行说明，不能把本例推广成任意版本的自动验收。

官方依据：
- https://www.postgresql.org/docs/18/sql-alterextension.html
- https://www.postgresql.org/docs/18/extend-extensions.html
- https://github.com/pgvector/pgvector/blob/v0.8.5/sql/vector.sql
