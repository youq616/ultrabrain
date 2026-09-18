# 受管控制台启动与中断恢复

`personal-activate plan|apply|status|recover` 用于启动已经由 `personal-deploy` 安装、当前停止的 console-only 配置。它要求托管 PostgreSQL 已在运行，只向固定的控制台单元发送一次 `StartUnit(..., "fail")`。恢复通过读取同一管理器和认证应用状态完成，不重新发送启动请求。

本命令不启动个人 target、Worker、MCP 或数据库，不停止或重启任何服务，不修改单元配置、enablement、数据库结构或模型配置。它不是运行中更新、自动停止回滚或跨重启恢复工具。开发和验收状态以 [项目状态](PROJECT-STATUS.md) 为准；新增测试文件本身不代表真实集成已经通过。

## 前置条件与调用

使用安装所属的普通 Linux 账号。当前支持 systemd **255 系列**的同 UID 用户管理器、固定的 `/run/user/UID/bus` 和发行版 `/usr/bin/python3` 的 `dbus-python`。Ubuntu 24.04 对应依赖为 `python3-dbus`；命令不会自行安装依赖，也不会通过环境变量另行寻找模块。公开 CLI 使用 `/usr/bin/python3 -I -B` 隔离 Python 环境。

已有安装必须满足以下条件：

- `personal-deploy status` 给出已经接受的 `current_sha256`，没有待恢复部署或激活；安装内容与重新生成的 console-only 计划一致。
- 调用账号能够通过 `/proc` 核验用户管理器的当前可执行文件、UID、PID、启动时间及 PID/net namespace。内核还会检查组凭据、能力和访问策略；相同 UID 本身不足以保证这些读取权限。读取被拒时，激活与恢复保留身份验证失败的结果。
- console、target 与 Worker 都停止；Worker 不在已安装代际中；不存在需要认领的手工单元、别名或 drop-in。
- `ultrabrain-postgres.service` 已处于 `active/exited`，实际 postmaster 通过既有私有状态、可执行文件、目录、PID 和启动时间核验。
- 私有 `personal-console-token` 已存在且有效。缺失时拒绝，不通过首次启动创建令牌。
- 调用方已有可信的数据库逻辑实例 UUID；source、端口、Bun 真实绝对路径与安装计划一致。UUID 的含义及取得边界见 [就绪检查](PERSONAL-READY.md)。

先生成计划，核对 JSON 中的固定启动对象、安装、管理器、依赖和数据库绑定，再把返回的 `activation_plan_sha256` 传给 apply。两次调用之间的相关状态改变会使计划失效，需要重新检查并生成计划。plan 核验物理托管数据库进程，并将调用方的预期 UUID 写入计划；逻辑实例 UUID 与 source 的认证查询要在控制台运行后完成。如果预期值错误，启动后 readiness 会失败并保留 pending。

```bash
COMMON=(--home "$ULTRABRAIN_HOME" --bun /absolute/path/to/bun
        --source default --port 3132
        --expected-current RECEIPT_SHA256
        --expected-instance INSTANCE_UUID)

bun src/cli.mjs personal-activate plan "${COMMON[@]}"
bun src/cli.mjs personal-activate apply "${COMMON[@]}" \
  --expected-plan ACTIVATION_PLAN_SHA256
bun src/cli.mjs personal-activate status --home "$ULTRABRAIN_HOME"
```

也可使用 `/usr/bin/python3 -I -B scripts/personal-activate.py` 加同组参数。home 默认取 `ULTRABRAIN_HOME`，否则为服务账号的 `~/.local/share/ultrabrain`；source 默认 `default`，port 默认 `3132`。未知、重复、缩写以及不适用于当前动作的参数会被拒绝。plan/status 不创建激活记录；错误计划在 apply 创建记录或发送启动请求前被拒绝。

## 有效依赖与执行边界

`StartUnit` 的 `fail` 模式只拒绝冲突任务，不会取消依赖传播。本实现读取 systemd 的有效缓存，检查固定控制台命令、选定执行属性、依赖和运行状态。生成器的用户服务隐含依赖还包括 `basic.target` 和 `app.slice`，因此仅检查磁盘中的 `Requires=ultrabrain-postgres.service` 不够。

检查从 console 的 start 依赖递归展开 Requires、Wants、BindsTo 和 Upholds，并处理 Requisite 验证及 Conflicts 的停止传播。所有其他 start 依赖必须已经 active；停止传播成员必须已经 inactive；相关单元必须没有待执行任务、重载或自动重启状态。device/swap 的同组 following 关系未纳入本阶段合同，因此图中出现这些节点就拒绝。检查有节点、边、返回值和时间上限。控制台的额外命令、触发器、失败/成功后启动动作和停止传播被拒绝。检查前后还要保持图、已安装配置、数据库进程和管理器身份一致。

这证明的是当前实现明确检查的缓存属性和受管配置，不是所有 systemd 属性的完整认证。服务账号需要处于协作维护窗口；同 UID 的其他操作者仍能改文件、发 D-Bus 请求或手工启动服务，账户内并不存在额外隔离。本命令不冻结仓库源代码，也不把单元归属检查描述为监听 socket 的所有者证明。

## 持久化与恢复

激活与部署复用账号全局的部署 flock 及 `.config/ultrabrain-personal-deployment/pending.json` 预留位置。激活使用 format 2 的小型指针；旧部署器会因不认识该格式而拒绝继续，避免两个版本分别使用不同 pending 文件。apply/recover 持有独占锁，plan/status 持有共享锁。正常退出先关闭私有 D-Bus 连接，再释放锁；进程被终止时两个描述符一并关闭。

`$ULTRABRAIN_HOME/personal-activation/operations/OPERATION_SHA256/` 保存不可覆盖的 intent、发送前 attempt、收到回复后的 ack 和最终 receipt。intent 先落盘并同步，再发布唯一的共享 pending 指针。未被指针引用的发布前目录没有启动权限。attempt 的存在表示请求**可能已发送**；ack 只表示收到了合法 job path，并不等于服务已经就绪。完成后先写 receipt、更新 `last.json`，最后移除 pending。历史和崩溃暂存保留，当前没有自动垃圾清理。

出现错误或调用中断后，先读取 status 所给 `pending_sha256`，再恢复该精确操作：

```bash
bun src/cli.mjs personal-activate status --home "$ULTRABRAIN_HOME"
bun src/cli.mjs personal-activate recover --home "$ULTRABRAIN_HOME" \
  --expected-pending OPERATION_SHA256
```

恢复必须先在独占锁内验证原 bus ID 和 manager unique owner，取得旧 sender 明确的 `NameHasNoOwner`，随后向保存的 manager owner 发送 Ping 并取得对应回复。之后只在同一管理器读取任务及单元，再检查身份未变。普通错误、超时、仍连接的 sender 或新的管理器都不能替代这一条件。

这个顺序依赖 systemd v255 对同 UID 请求的同步授权路径，不能推广为任意 D-Bus/异步 polkit 的通用完成屏障。屏障只证明旧请求已被拒绝或加入管理器任务队列，仍须继续排除待执行任务和过渡状态。相关实现依据是 systemd v255 的 [请求入口](https://github.com/systemd/systemd/blob/db11bab38ccf1ed257f310d29070843d4c58ea01/src/core/dbus-unit.c)、[授权分支](https://github.com/systemd/systemd/blob/db11bab38ccf1ed257f310d29070843d4c58ea01/src/shared/bus-polkit.c)、[同 UID 权限判断](https://github.com/systemd/systemd/blob/db11bab38ccf1ed257f310d29070843d4c58ea01/src/libsystemd/sd-bus/bus-convenience.c)，以及 [D-Bus unique name 生命周期](https://dbus.freedesktop.org/doc/dbus-specification.html#message-bus-names)。

| 恢复时可证明的状态 | 结果与记录 |
| --- | --- |
| 当前 console 已运行，安装、依赖、数据库与新鲜认证 readiness 全部匹配 | 写 ready 回执并清除 pending；返回 `application_ready: true`。不把当前运行实例的启动原因归因于本次请求。 |
| console 严格 inactive/dead 或 failed/failed，无 PID、control PID、job 或自动重启 | 写 not_running；若根本没有 attempt，则写 not_dispatched；清除 pending。not_running 不表示它从未运行过。 |
| receipt 已持久化，但历史指针或 pending 清理尚未完成 | 在原管理器屏障成功后完成历史记录更新，不重新核验当前安装或应用；所有历史结果均返回 `application_ready: "not_checked"`。 |
| 仍在过渡、已运行但 readiness 失败、绑定改变、sender 未消失，或 bus/manager/boot 改变 | 拒绝完成并保留 pending，不启停服务、不撤销配置。 |

生成服务仍保留 `Restart=on-failure`。恢复时可能观察到新的 InvocationID；只有该次检查前后相同并通过认证就绪的当前实例可被接受。这不赋予工具停止旧实例或新实例的权限。跨 manager 重启的 pending 需要后续明确的恢复合同，不能手工删除 pending 后把旧结果当作成功。

## 输出和验证层次

`dispatch_state` 区分 `not_attempted`、`outcome_unknown`、`acknowledged`；它不声称“本工具确定启动了这个进程”。`activation_outcome` 表示本次操作的已记录结果，`application_ready` 只在本次新鲜检查通过时为 true。status 的 `last_completed` 是历史记录，status 本身不接触 D-Bus 或执行 HTTP readiness。错误输出仅含固定错误码，不打印令牌、数据库 URI 或原始服务日志。

本地 Python 测试覆盖缓存依赖、真实私有文件事务与故障注入，进程/HTTP/manager 是受控夹具。`test/personal-activate-integration.mjs` 由既有 `Personal user services` 工作流调用，在明确授权的一次性普通 Linux 账号中检查实际 systemd、PostgreSQL、认证 HTTP、flock 和真实 coordinator 进程退出。只有 CI 夹具在各场景之间停止并清除自己控制台的启动限流计数；产品命令没有这些动作。夹具复用已有的单元引用助手，在 180 秒上限内保留控制台缓存，避免 inactive 单元被回收后无法执行 ResetFailedUnit；引用结束必须确认释放。新增激活集成不调用模型，既有服务集成的模型响应仍为合成夹具。用户主机部署、Windows 客户端和真实模型质量不属于这些检查的证明范围。

该一次性 CI 在运行合成服务之前，为测试账号的 `user@UID.service` 设置临时的空 `CapabilityBoundingSet` 和 `AmbientCapabilities`，并重新启动测试管理器；执行前检查 CI 进程位于该服务的 cgroup 之外。这样测试管理器以不附带额外 Linux 能力的配置运行，激活命令仍执行原有的完整 `/proc` 验证。此配置仅属于 CI 环境准备，不是产品命令的管理器权限调整或用户主机部署步骤。
