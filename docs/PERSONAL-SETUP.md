# 首次使用准备：先验证数据库，再创建凭据

`personal-setup check|prepare` 组合既有 `personal-identity` 和 `personal-init`，用于已经完成显式 bootstrap、托管 PostgreSQL 已运行的个人 Linux 安装。它不是安装器，不部署、启动、停止或重启服务，不修改配置、迁移、模型授权或客户端身份 pin。

## 两种操作

```bash
# 只检查，不创建令牌；没有令牌时退出码为 1。
node src/cli.mjs personal-setup check --home "$ULTRABRAIN_HOME" --source default

# 明确请求首次准备：校验本机数据库身份后，才创建缺失的控制台令牌。
node src/cli.mjs personal-setup prepare --home "$ULTRABRAIN_HOME" --source default

# 已有可信实例身份时必须继续使用原 pin，不因本次观察自动覆盖。
node src/cli.mjs personal-setup prepare --home "$ULTRABRAIN_HOME" --source default \
  --expected-instance "$EXPECTED_INSTANCE"
```

也可以直接调用同一实现：`/usr/bin/python3 -I -B scripts/personal-setup.py check --home "$ULTRABRAIN_HOME" --source default`。应用入口在 Linux 上使用固定系统 Python，不依赖工作区或 PATH 中的 Python 替代程序。要求普通安装账号、Linux、Python 3.11+；不存在的安装不会被隐式创建，停止的数据库不会被自动启动。

只接受 `check` 或 `prepare`，以及最多各一次的 `--home`、`--source`、`--expected-instance`；拒绝缩写、重复、equals-form、密码、URL、任意 SQL、服务动作。home 和 source 继承身份查询的严格路径及名称合同。省略 home 时先取 `ULTRABRAIN_HOME`，再取账号默认目录；明确指定 home 不依赖无关的默认账号目录查询。

## 准备顺序与结果

先在一个持续持有的安装目录视图中检查私有权限、托管配置、上游锁和活动数据库进程，再通过私有 Unix socket 与 SCRAM 校验逻辑实例 UUID、所选 source 和实际 backend/postmaster 绑定。存在 `--expected-instance` 时必须匹配，错误来源或实例不能授权创建令牌。

随后调用原来的只读状态检查或 create-only 初始化器。已有合法令牌保留原字节和 inode，不重新生成；缺失令牌的创建仍使用原有互斥锁、独占打开、0600 权限、文件和父目录 fsync。已有部署/激活历史却丢失令牌时拒绝，要求恢复原凭据，不把损坏或丢失的已部署令牌当成首次安装。

最后再次观察数据库逻辑身份、实例进程与配置，重验令牌和安装目录。组合从校验开始共享 20 秒单调时钟预算，两个身份观察均继承同一截止点，且仍受各自最多 10 秒、查询和输出限制约束；阶段切换、开始初始化前及返回结果前检查期限。期限耗尽后不启动新的阶段，不无限重试；已开始的文件读写/fsync、内核调度与至多一秒子进程回收不是可中断的硬实时操作，不能承诺绝对 20 秒内返回。所有步骤成功且凭据存在才输出退出码 0、`ok:true`、`prepared:true`、`state:"prepared"`。

`check` 检查到合法数据库但没有令牌时，退出码为 1、`state:"credentials_required"`、`prepared:false`，仍可返回本次已验证的 `instance_id` 和 `identity_verified:true`。这不是故障修复或就绪证书。

任一检查失败时退出码为 1、`state:"unverified"`、`identity_verified:false`，不返回部分验证的 UUID、原始错误、密码或令牌。令牌创建后最终检查仍可能失败：此时保留已写入的令牌，不自动删除、不重新生成、不回滚数据库，`token_creation:"not_proven"` 明确表示调用方不能从失败推断“没有发生创建”。调查并恢复正确配置后再次运行，只会复用已有合法凭据。

## 不扩大“准备完成”的含义

无论结果成功或失败，都返回 `application_readiness:"not_checked"`、`deployment_readiness:"not_checked"`。一个已经运行的控制台不会被本命令误报为“不就绪”，也不会仅因凭据存在就被宣称“已经就绪”。该命令没有查询服务管理器，不替代 deployment/activation 的全局锁、pending 事务和回执。

后续仍应按既有服务计划、部署、显式激活和 `personal-ready` 的合同完成验证。准备入口不自动将观察到的 UUID 写进客户端配置；原有 pin 不符时必须停止调查。真实客户端的使用效果、模型语义质量、容量、高可用与恢复 SLA 均不在此次准备的证据范围内。

数据库查询只读取身份/source/schema 元数据，不读取记忆或文件正文。`database_write_requested:false` 表示不请求应用数据写入，不表示 PostgreSQL 自身没有连接统计或日志。`configuration_changed:false` 不否认 `prepare` 可以新建控制台凭据，凭据结果由单独的 `token_creation` 字段说明。

观察依赖可信安装账号及协作维护窗口，不是跨进程原子快照或对恶意同 UID 的隔离。创建之后才发生的异常不能撤销已经完成的文件写入。原始失败证据、实际本地测试和待完成事项见 `docs/reviews/personal-setup/README.md`；源码存在或单元测试通过不等于远程 CI 或正式独立审查通过。

## 与已集成分支的关系

本轮以 PR #18 固定提交 `5dbbcd6e5744a803e30d2b1cd1e9ebcf1a1ba450` 为基线，保留其 #15 登记修复、#16 初始化、#17 身份观察和 `personal-activate prepare`。`personal-setup prepare` 是部署前的凭据准备；`personal-activate prepare` 是部署后的只读激活计划，两者不互相替代，不自动执行 apply。专用数据库 CI 从无令牌状态执行本命令；用户服务 CI 在离线初始化后检查 setup，再执行原有真实 systemd 部署及显式激活测试。
