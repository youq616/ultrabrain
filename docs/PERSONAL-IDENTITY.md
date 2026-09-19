# 首次取得可信的本机数据库身份

`personal-identity` 查询已经运行的项目托管 PostgreSQL，取得可供后续 `personal-activate` / `personal-ready` 显式使用的逻辑实例 UUID。它不创建新 UUID，不连接陌生 HTTP 服务，不启用控制台或 Worker，也不自动完成部署和激活。

## 使用

在可信源码目录，以安装所属的普通 Linux 账号执行：

```bash
# 数据库必须已经由显式 bootstrap 或 db start 启动；查询不会自动启动它。
/usr/bin/python3 -I -B scripts/personal-identity.py --home "$ULTRABRAIN_HOME" --source default
# 同一实现的应用入口（Node 或 Bun 均可分派）：
node src/cli.mjs personal-identity --home "$ULTRABRAIN_HOME" --source default
```

省略 home 时使用 `ULTRABRAIN_HOME`，否则在通过平台和 UID 校验之后才求值账号默认 `~/.local/share/ultrabrain`。只允许 `--home` 和 `--source`；拒绝重复、缩写、equals-form、URL、任意 SQL、密码或服务动作。home 必须是规范绝对路径，且不能与源码目录重叠。source 与现有合同一致：1–32 个小写 ASCII 字母、数字或连字符。

退出码 0 且 `ok:true` 才有 `instance_id`。必须同时看到 `identity_verified:true` 和 `database_process_binding_verified:true`。这个值是本次已核对本机安装的逻辑身份，可作为后续显式激活参数 `--expected-instance`，不是可以无条件覆盖既有客户端身份 pin 的新配置。已有 pin 不符时应停止并调查，不自动重新绑定。

失败退出码 1，`identity_verified:false`，不返回实例 ID。不存在/停止的数据库、不支持的 schema、源记录缺失、进程或配置改变、查询超时都不能得到成功结果。失败不等于数据库损坏，不触发启动、修复、迁移、令牌创建或密码轮换。

建议首次使用顺序是：显式 bootstrap → 离线凭据准备 `personal-init create-token` → 本命令取得身份 → 服务计划/部署 → 持调用方已核对的回执和实例身份显式激活 → 就绪检查。这里没有新增一键安装器，也没有替代各阶段自己的审批、回执、全局锁和恢复流程。

## 可信边界

先复用 `personal_ready_process.py` 与 `preflight.py` 校验私有安装、配置与状态绑定、PostgreSQL/pgvector pins、build marker、PG_VERSION，以及实际同 UID、同 PID/net namespace、同可执行文件 inode、同 PGDATA 路径和目录 inode 的活动 postmaster。

只允许 `$ULTRABRAIN_HOME/postgres/socket/.s.PGSQL.PORT` 的现有 Unix 套接字。持有原始私有父目录描述符，核对套接字类型、UID、单链接与前后元数据。只启动对应 runtime 的 `bin/psql`，使用 `-X -w`、固定 SQL 和显式 `ON_ERROR_STOP=1`，没有 shell 或客户端启动脚本；子进程只得到固定最小环境、选定 runtime 的库路径，以及当前应用数据库密码，不得到管理员密码、控制台令牌或供应商环境变量。

连接强制 `requirepeer` 为安装账号，强制 `require_auth=scram-sha-256`；无 TCP、其他 host 或降级鉴权回退。目录路径中的逗号会触发 libpq host-list 解释，冒号/分号和美元符号会触发动态链接器的库路径解释，因此这些 home 路径明确拒绝，不猜测或降级到系统 libpq。套接字路径也受 Linux 长度界限约束。

固定 SQL 在只读事务中检查源是否存在、实例 UUID、schema 元数据和实际数据库会话身份；不读取记忆、文件正文或会话记录。保持这个 backend 存活时，前后核对它确实是已选 postmaster 的同 UID 子进程，并重新检查配置、pins、套接字及可执行文件。只有收到 rollback 标记、psql 正常退出且最后一轮本机检查通过，才返回成功。

SQL 使用 2 秒 statement timeout、1 秒 lock timeout；整个操作使用 10 秒单调时钟期限，异常清理只终止并回收本次 psql，另有最多 1 秒回收等待。stdout/stderr 分别最多 8192 字节，单个 JSON 行最多 4096 字节。stderr 仅计量并丢弃，不作为可信数据库诊断返回。不无限重试，不在查询失败后重新连接备用地址。

参考上游合同：[libpq requirepeer 与 require_auth](https://www.postgresql.org/docs/18/libpq-connect.html)、[psql -X/-w 与 ON_ERROR_STOP](https://www.postgresql.org/docs/18/app-psql.html)、[ld.so 库路径语义](https://man7.org/linux/man-pages/man8/ld.so.8.html)。

## 不能据此宣称的结果

成功仍为 `application_ready:false`。该命令未验证控制台端口、已部署 systemd 代际、远程客户端、模型质量、容量或恢复 SLA。数据库只读查询仍可能产生数据库自身的连接统计或日志；`database_write_requested:false` 只表示本命令不请求应用数据写入。

逻辑 UUID 随备份恢复保留，不是物理机器或克隆检测标识。观察依赖可信服务账号和协作维护窗口，不能隔离不合作的同 UID 操作者，亦不把 build marker 和文件 inode 当作二进制供应链证明。已有部署 pending、模型授权和客户端采集授权仍由各自入口检查；本命令不修改它们。源码中的进程夹具测试不等同于实际 PostgreSQL 验收，实际 CI 与独立审查状态记录在候选 PR。
