# 个人管理台的认证就绪检查

`personal-ready` 在普通 Linux 服务账号下，对已安装、正在运行的管理台进行一次只读验收。它同时核对受管部署回执、用户管理器、实际 Bun 进程、认证 HTTP 响应和当前托管 PostgreSQL 后端。检查不会启动、停止、重载或启用服务，不创建令牌，不迁移数据，也不请求模型或读取记忆正文。

本能力是后续自动激活的前置步骤。自动激活、运行中切换和激活失败恢复需要独立的启动意图、运行实例和依赖传播合同，本阶段未提供这些操作。此文档随实现候选提交；是否已验收以 [项目状态](PROJECT-STATUS.md) 的精确提交、独立审核和实际 CI 为准。

## 使用

仅支持由 [personal-deploy](PERSONAL-DEPLOY.md) 安装的 **console-only** 配置。含 Worker 的代际、旧手工链接或自定义单元不会被自动认领。管理台需已经由操作者明确启动；此命令本身没有激活动作。

```bash
bun src/cli.mjs personal-ready \
  --home /absolute/ultrabrain-home \
  --bun /absolute/path/to/bun \
  --source personal \
  --port 3132 \
  --expected-current RECEIPT_SHA256 \
  --expected-instance DATABASE_INSTANCE_UUID
```

也可直接使用 `python3 -I -B scripts/personal-ready.py` 加同组参数。`--home` 默认取 `ULTRABRAIN_HOME`，否则为服务账号的 `~/.local/share/ultrabrain`；source 默认 `default`，port 默认 `3132`。Bun 必须是已安装计划使用的真实绝对可执行文件路径，不能改用软链接别名。重复、未知或缩写参数被拒绝。

`RECEIPT_SHA256` 是已接受安装的 `personal-deploy status` 所给 `current_sha256`。数据库 UUID 应来自此前可信的 `ultra_identity` 结果或已经核对的客户端连接绑定；不要把陌生服务本次自报的 UUID 当作可信预期值。此命令要求调用方明确提供 UUID，不会自动接受新身份。`ultra_identity` 的实例 UUID 是逻辑身份，恢复备份会保留它，不是物理主机或克隆检测标识。

成功退出码为 0，返回 `ok:true` 和 `result.application_ready:true`。结果包含当前回执、source、逻辑实例 UUID、console PID 和 InvocationID，以及以下明确结论：

| 字段 | 含义 |
|---|---|
| `unit_binding_verified:true` | 本次前后观察到的安装代际、固定单元元数据和实际 console 参数/运行实例一致；未逐项认证所有缓存的 systemd 设置 |
| `authenticated_console_ready:true` | 预期 console 运行实例完成了新鲜认证响应，实际数据库查询通过 |
| `database_process_binding_verified:true` | 返回的 PostgreSQL 后端属于当前托管安装中的活动 postmaster |
| `expected_instance_verified:true` | 认证查询的逻辑实例 UUID 与调用方预期相同 |
| `worker_readiness:"not_checked"` | 没有验收 Worker 或模型质量 |
| `socket_owner_verified:false` | HMAC 认证不等于直接接收 TCP 连接的内核 socket 归属认证 |

失败退出码为 1，顶层返回 `ok:false`、`application_ready:false` 和安全错误码。失败表示**本次未完成证明**，也可能是并发改变、管理器不可访问、权限限制或探测超时；不能仅据此判定数据库损坏。无论成功或失败，输出的服务、配置、enablement 和 model 动作标志仅描述本检查器本身。

## 核验边界

检查器在整个操作期间持有现有账号全局部署共享锁。其他安装目录使用相同固定服务名称时，也必须遵守这把锁。发现任意部署 pending、未知链接、额外单元/依赖目录、别名、drop-in、未重载缓存或正在排队的任务即拒绝，不自行修复或重载。

它用当前 ROOT、home、Bun、source 和 port 重新生成完整计划，与安装回执逐字匹配，并校验代际、目录和链接身份。管理器 FragmentPath 可为已核对的安装链接或代际目标；不能仅凭路径和 `NeedDaemonReload=no` 认证配置。检查器还读取实际 `/proc/PID/cmdline`，精确验证 Bun、CLI 路径、source 和 port，核对 PID、启动 tick、四个 UID、可执行文件 inode、统一 cgroup 和 PID/net namespace。检查前后出现重启或替换均拒绝。

数据库配置、state、runtime、build marker、PG_VERSION、令牌及 postmaster.pid 通过受限文件描述符读取，拒绝符号链接、非私有配置和不安全可执行文件。查询返回的 backend PID 必须是同 UID、同 runtime 可执行文件的实际 postmaster 子进程，二者 cwd 必须绑定当前私有 PGDATA 的路径和目录 inode。检查前后重验这些身份。该证明不声称数据库由某个 oneshot systemd 单元最初启动；bootstrap 或操作者先启动同一个托管集群也可通过。

Linux 必须允许本服务账号读取相关 `/proc` 元数据，并使用可核对的统一 cgroup。hidepid、namespace 不一致、被替换/删除的可执行文件、半写 PID 文件或探测期间退出的后端均返回失败。数据库单元使用 PrivateTmp，因此检查不会错误地要求 mount namespace 相同。

所有观察仍以可信服务账号和维护窗口为前提。共享锁不能隔离不合作的同 UID 编辑器、调试器或直接 systemctl 操作；安装回执冻结的是单元配置，并未冻结整棵 Git 源码、Bun 或所有依赖内容。检查没有逐项认证所有缓存的 systemd 设置，例如任意外部改写再还原的 Restart/UMask；这次成功也不能保证将来的可用性、外部客户端已接通、备份可恢复或模型效果。

## 专用认证协议

探测器只连接固定 IPv4 `127.0.0.1:PORT` 的 `POST /api/readiness`，使用精确 Host/Origin，不读取代理设置、不跟随重定向、不重试其他地址，也不回退到 `/api/call`。整个 CLI 检查使用 10 秒 monotonic 期限；HTTP 阶段最多 4 秒，响应最多 8192 字节、JSON 正文最多 4096 字节。只接受明确 Content-Length 的非压缩响应，收到完整单条响应后立即关闭本端连接，不依赖对端及时关闭。

请求为规范 JSON 对象 `{format,nonce,origin,invocation_id,issued_at,proof}`，正文最多 1024 字节。nonce 每次使用新的 32 字节随机值。issued_at 必须在服务时钟的过去 10 秒至未来 2 秒之内；因此它是短时重放窗口，不是完全阻止合法请求重放。请求和响应以十六进制令牌解码后的 32 字节作为 HMAC-SHA256 密钥，使用不同域和固定 ASCII 数组编码。请求签名、响应签名均不能作为 `/api/call` 的 Bearer token。

请求签名输入为 `ultrabrain-personal-ready-request-v1\n` 后接 `[1,nonce,origin,invocation_id,issued_at]`。响应签名输入为 `ultrabrain-personal-ready-response-v1\n` 后接 `[1,request_sha256,nonce,origin,source_id,invocation_id,pid,instance_id,backend_pid,database_port,database_name,database_user,database_address,database_session_user,postmaster_started]`。数组使用无空格 JSON；request_sha256 是上述请求数组字节的 SHA-256。服务端 source、监听 origin、PID、InvocationID 和数据库字段均由实际服务取得，不照抄请求中的预期值。

服务器先鉴权，再在同一数据库连接的只读事务内执行固定 SQL：确认 source、逻辑实例、public schema、必要个人表和 actor_key 列，并取得实际 PostgreSQL 会话身份。事务使用 2 秒 statement timeout、1 秒 lock timeout；不会调用 migrate、health 或重新 connect。HTTP 等待 3 秒后结束，但未真正结束的数据库任务继续占用共享的四个并发名额，避免超时后无限积累查询。

非成功 HTTP 响应没有认证的诊断证明。客户端仅报告 `readiness_unverified` 等检查失败，不将陌生端口返回的错误文字当作真实数据库诊断。成功结果中的全部身份字段均先验证 HMAC，再与本地预期比较。

带签名的 `postmaster_started` 来自 SQL `pg_postmaster_start_time()`。它与 PID 文件第三行的早期 `MyStartTime` 来源不同，不做错误的精确相等比较；实际本机绑定依赖 PGDATA、PID/PPid、启动 tick 和可执行文件身份。依据见 [固定 PostgreSQL PID 文件定义](https://github.com/postgres/postgres/blob/724edf9bde9d356724ad384a2e196edc3c9f80f7/src/include/utils/pidfile.h)、[PID 文件写入](https://github.com/postgres/postgres/blob/724edf9bde9d356724ad384a2e196edc3c9f80f7/src/backend/utils/init/miscinit.c) 和 [postmaster 初始化](https://github.com/postgres/postgres/blob/724edf9bde9d356724ad384a2e196edc3c9f80f7/src/backend/postmaster/postmaster.c)。

## 验收层次

协议/CLI/进程夹具测试覆盖跨 Python/Node 固定向量、篡改、陌生监听者、重定向、慢速/过大响应、令牌和安装变化、实际文件锁、进程身份和 namespace 反例。进程模块另读本测试进程的真实 procfs；这些不能替代活 PostgreSQL 和 user-systemd。

现有个人部署 CI 增加独立的 12 项真实就绪检查：正确实例、四种错误预期、令牌轮换、运行中源记录缺失、实际源表独占锁阻塞、释放后的同一 console 运行实例恢复，以及文件/配置/服务身份/记录数量不变。原有 15 项部署检查继续单独计数。只有实际运行的候选 CI 与独立审核都通过后，本阶段才能验收；精确结果另记于项目状态。
