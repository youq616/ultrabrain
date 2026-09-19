# 首次激活准备：可信身份与既有审批计划组合

`personal-activate prepare` 在一个只读准备步骤中，把已运行的本机托管数据库身份与已部署控制台的激活计划绑定。它复用 `personal-identity` 和既有激活状态机，不增加自动安装器或第二套启动协议。

## 使用边界与顺序

先以安装所属的普通 Linux 账号，明确完成 bootstrap、`personal-init create-token`、个人服务导出及部署。托管 PostgreSQL 必须已经通过显式 bootstrap 或 `db start` 运行；控制台和其他个人单元必须处于原有激活合同允许的停止状态。取得并核对最近一次 `personal-deploy apply` 的 `current_sha256`，不得用任意字符串代替回执。

```bash
# CURRENT 是已核对的部署回执，BUN 是该部署所使用的规范绝对可执行文件路径。
# SOURCE/PORT 必须与已部署服务计划完全一致。
node src/cli.mjs personal-activate prepare --home "$ULTRABRAIN_HOME" \
  --bun "$BUN" --source "$SOURCE" --port "$PORT" --expected-current "$CURRENT"
```

成功输出 `ok:true`、`result.arguments.expected_instance` 及 `result.activation_plan_sha256`，并包含与原 `plan` 完全相同的待审批观察和作用范围。它是计划，不是启动回执，也不是 `application_ready:true`。只读取安装身份、源/schema 元数据和部署/进程绑定，不读取记忆或用户文件正文。

操作者审核计划后，只有另一次明确 `apply` 才会请求启动控制台：

```bash
# INSTANCE 与 PLAN 来自本次已审核的 prepare 结果，而不是猜测或以前失败的输出。
node src/cli.mjs personal-activate apply --home "$ULTRABRAIN_HOME" \
  --bun "$BUN" --source "$SOURCE" --port "$PORT" --expected-current "$CURRENT" \
  --expected-instance "$INSTANCE" --expected-plan "$PLAN"
```

`prepare` 不接受 `--expected-instance`、`--expected-plan`、`--expected-pending`、令牌、模型开关或服务动作。已有可信实例 pin 的日常操作仍使用原来的 `plan --expected-instance`，不应以重新发现的值自动覆盖原 pin；发现不一致必须调查。它不修改任何客户端配置。`apply` 仍重新核对完整计划哈希、部署回执、实例以及后续认证就绪证明；失效计划拒绝，不静默重新准备或重试写操作。

## 同一操作内的检查

在已有部署共享锁上持读锁，先观察停止状态和既有部署代际，再通过固定私有 Unix socket、安装账号 peer 和 SCRAM-SHA-256 读取可信逻辑实例 UUID。随后重做激活观察并逐项比较部署、管理器身份及依赖图、数据库进程、来源 pins 和控制台令牌指纹；有变动就拒绝。已有 pending 事务、缺失令牌、错误回执、外部单元或运行中的控制台不能跳过这些检查。失败不会创建凭据、补建激活目录、迁移、部署或启动服务。

准备使用既有 30 秒操作预算。内部身份查询的期限为“自身最多 10 秒”和外层剩余时间中较短者，不因嵌套调用重新取得额外预算；清理只回收本次创建的 psql，沿用既有至多 1 秒回收等待。普通文件/内核调度阻塞不被误称为硬实时保证。身份查询沿用有界输出、固定 SQL、只读事务、backend/postmaster 核对和干净退出规则。

只读查询仍可能产生数据库自身统计或日志。共享锁只约束遵守本项目协议的部署/激活器，不阻止恶意同 UID 操作者。逻辑 UUID 随恢复保留，不是物理主机克隆检测。成功准备不能证明真实模型质量、外部客户端接入或生产 SLA。

## 本阶段集成范围

本分支基于 PR #17 固定提交 `57c6c98712020e51f5ff276cf9bff3909bad8d01`（包含 PR #16 的离线初始化），并复用 PR #15 提交 `b18ca811ed699c5c0fc56c6b2742cf508512da19` 的九个应用/测试文件，使准备/部署能力与保留已有 Agent 登记的采集修复处于同一个候选树。没有修改三个原开发分支或 main，不把这些未合并 PR 当作正式发布。

本轮新增公开 prepare 路径、激活 CLI 的惰性默认 home 修复、嵌套期限传递和回归测试。`personal-services` CI 在凭据尚不存在时先跑实际数据库身份检查，再跑离线初始化及部署/激活测试；实际激活测试通过公开 prepare 取得计划，验证与手工固定身份计划相同，确认没有启动/写入，再显式 apply。测试只操作 CI 专用安装和受校验的 disposable 用户服务，不操作用户生产服务。

实现助手自审与首败证据见 [本阶段记录](reviews/personal-prepare/README.md)。实际候选提交、CI run 和独立审查状态以本 PR 补记为准。自审和测试通过不是独立 reviewer 批准，未满足仓库门槛前保持草稿，不宣告个人 V1 整体完成。
