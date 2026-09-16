# 个人管理台常驻服务与授权定时整理

本功能生成可校验的 **systemd 用户服务文件包**，用于让个人管理台随用户服务管理器启动，以及在明确授权后周期处理本机所有者的个人整理队列。它不执行 systemctl、不链接/启用/重启服务，不改旧配置和权限，不安装模型，不采集新聊天。生成或校验成功不是实际服务验收。

## 默认只生成管理台

先按 DEPLOYMENT.md 完成普通 Linux 账号下的托管 PostgreSQL 安装、迁移及 `preflight --mode runtime`，并确认现有 `ultrabrain-postgres.service` 是该账号、该安装的数据库服务。工具不自动创建数据源，不证明数据库在线或所选 source 存在。

```bash
install -d -m 0700 "$HOME/ultrabrain-service-bundles"
bun src/cli.mjs personal-services render \
  --source default \
  --output "$HOME/ultrabrain-service-bundles/personal-001"
```

默认只输出 `ultrabrain-personal-console.service` 与 `manifest.json`。管理台仍绑定 `127.0.0.1:3132`，使用原有 owner-only 令牌文件；远程使用 SSH 隧道，不能当作公网多用户 Web 登录入口。stdout 返回清单 SHA 与单元名称，不含密码或模型密钥。

输出父目录必须已存在且为当前账号的 0700 私有目录。目标必须全新，且在源码仓库和 ULTRABRAIN_HOME 之外；原有目标即使相同也不覆盖。失败中途保留 `INCOMPLETE`，禁止加载这样的文件包。所有输出文件 0600、逐文件和目录同步。Linux 路径中的控制字符、反斜杠、冒号或尾部空白不受支持；普通内部空格、`%` 和 `$` 使用各自的 systemd 转义规则。

可选 `--name my-personal` 为所有新服务选择另一个名字前缀，`--console-port 4132` 更换本机管理台端口。`--database-unit other-managed-postgres.service` 仅绑定已有受信任数据库服务，不能指向自身或非 service 单元。生成器不检查该服务内容、端口是否占用或宿主内核的全部沙箱能力，实际启动仍必须验收。

## 定时整理需要另行授权

只有同时提供 `--with-consolidation --allow-model-call` 才生成 Worker 和 Timer；单独提供其中一个会拒绝。启用后会将已有、归属该本机所有者的获准原文送到已经配置的整理模型，可能产生费用。它不代表自动开启客户端采集或把私有记忆共享给其他身份。

```bash
bun src/cli.mjs personal-services render \
  --source default \
  --with-consolidation --allow-model-call \
  --interval 300 --limit 1 \
  --output "$HOME/ultrabrain-service-bundles/personal-002"
```

额外生成 `ultrabrain-personal-worker.service` 与 `.timer`。首次触发在 Timer 启动后约 30 秒；之后自前一批退出起按 interval 计时，范围 30..86400 秒，默认 300 秒；这不是墙上时钟的固定点调度。每批 limit 为 1..4，默认 1。Worker 为有界 oneshot，没有 `--loop`、`--retry` 或自动 Restart，不把失败、过期租约当作新任务反复重跑。Timer 不补跑关机期间错过的批次；原有数据库租约还会约束其他进程间的同所有者并发。

每次实际启动先执行离线 runtime preflight，再调用原有个人 Worker。配置中没有明确启用个人模型时，Worker 保留 `needs_model`／退出码 2，服务会显示失败而不是伪装成“整理完成”。模型设置由 `personal-model-config` 单独授权；生成器不会修改它。任务完成仍只生成候选记忆，必须审核后才进入当前上下文。

**身份范围：本机 Linux 服务账号所有者。**通过另一个 HTTP 认证主体保存的私有任务，不会由本机 Worker 擅自接管。要处理该主体，请使用现有 `scripts/personal-worker.mjs --url ... --token-file ...` 的认证模式另行部署；本版文件生成器没有替你调度所有主体的能力。

## 校验，再由操作者启用

将生成时返回的完整 SHA 存到文件包之外的可信记录中，下面 `ACTUAL_MANIFEST_SHA` 要替换为该值，不是对不可信下载临时重算的值：

```bash
BUNDLE="$HOME/ultrabrain-service-bundles/personal-002"
bun src/cli.mjs personal-services verify \
  --directory "$BUNDLE" --expected-sha ACTUAL_MANIFEST_SHA
systemd-analyze verify "$BUNDLE"/*.service "$BUNDLE"/*.timer
```

verify 会逐字重建预期的 unit 内容并核对清单、权限与 SHA；多余/缺失/修改过的文件、链接或不完整目录会拒绝。此命令**不启动程序**，也不等同于 `systemd-analyze verify` 的语法检查，更不替代后续模型和客户端测试。只生成管理台时没有 `.timer`，语法检查仅传 `"$BUNDLE"/*.service`。

审阅服务内容、确认模型费用及 source 后，在自己的 Linux 普通服务账号执行：

```bash
systemctl --user link "$BUNDLE"/*.service "$BUNDLE"/*.timer
systemctl --user daemon-reload
systemctl --user enable --now ultrabrain-personal-console.service
systemctl --user enable --now ultrabrain-personal-worker.timer
systemctl --user status ultrabrain-personal-console.service ultrabrain-personal-worker.timer
systemctl --user list-timers ultrabrain-personal-worker.timer
```

只生成管理台时不要执行不存在的 timer 命令；link 也只传 service 文件。启动会通过依赖启动预先配置的数据库服务，因此先核对该依赖确实属于本安装。默认 source 为命令中明确提供的值；没有“任意 HTTP 用户”继承本机权限。

既有同名单元、覆盖片段和管理员设置都不被生成器删除或覆盖。如果 link 报冲突，先用 `systemctl --user cat` 检查既有来源，不使用 force 覆盖。升级时先停止相关 Timer 和 Worker，核对旧链接，再将审核过的新文件包链接并重载；本工具不自动迁移活动配置或提供静默回滚。源码路径在磁盘上仍可改变，清单不冻结已安装的应用代码，升级须继续遵守固定提交和审核要求。

## 停止、撤销与运行限制

停止 Timer **不会取消正在执行的 Worker**，停用时两者都要处理：

```bash
systemctl --user disable --now ultrabrain-personal-worker.timer
systemctl --user stop ultrabrain-personal-worker.service
# 需要同时关闭管理台时：
systemctl --user disable --now ultrabrain-personal-console.service
```

还可以单独用 `personal-model-config --disable` 撤销后续整理模型调用。停止不能撤回已经发出的外部请求或费用，但已有租约/归档/取消规则仍阻止不再有效的结果提交。没有启用文件采集的客户端不会因这些服务而开始扫描文件。

个人单元与绑定的数据库 unit 有 BindsTo/After/PartOf 关系，显式停止该数据库 unit 会停掉相关管理台、Worker 和 Timer，避免遗留 Timer 立即又拉起数据库。现有数据库服务为 oneshot 管理器，其 active 状态不等同于实际 Postgres 进程持续健康；数据库进程的任意崩溃检测不由这些依赖关系保证。

用户服务管理器必须可用。需要退出登录后仍运行或开机启动时，由宿主管理员审查该账号的 lingering；生成器不执行管理员操作。单位使用 NoNewPrivileges、0077、PrivateUsers、PrivateTmp 和受限可写目录；需要宿主允许 systemd 用户服务使用相应命名空间。受限内核/AppArmor/容器环境可能拒绝启动，不会自动关闭安全策略绕过。已知运行基线和实际结果以当前提交 CI 为准。

没有自动读取 `service.env`。路由参数、source 和 PATH 来自明确生成设置；凭据沿用该安装的已有原生配置和管理员受信任服务环境，不复制进 unit/manifest。不要在 ExecStart 或聊天中粘贴密钥；服务日志只应包含原有安全计数/错误，宿主 journal 权限和保留策略仍由操作者管理。同账号恶意代码、恶意 PATH 和管理员覆盖文件不在本工具隔离范围。

## 验证范围

`python3 -B -m unittest discover -s test -p test_personal_services.py -v` 覆盖生成、授权、路径、清单、同步失败与实际 systemd 语法解析；不是启动验收。Node CLI 路由测试在 `test/personal-services-cli.test.mjs`。

`ULTRABRAIN_TEST_ALLOW_WRITE=1 ULTRABRAIN_TEST_SYSTEMD=1 bun test/personal-services-integration.mjs` 仅可在 CI 的一次性 Linux 安装使用；测试会链接/启动自己的随机命名单元、修改合成模型配置、停止自己的数据库并清理，严禁在重要记忆库执行。专项 CI 使用实际 systemd 用户管理器、Bun、PostgreSQL、管理台 HTTP 和本地模拟模型，检查启停、令牌持久化、模型未配置拒绝、Timer 驱动一次真实整理、候选状态与依赖停止。没有这项实际执行，不能把语法检查冒充宿主验收。

官方语义依据：systemd v255 的 `man/systemd.timer.xml`（已活动的 service 不另开实例、OnUnitInactiveSec）、`man/systemd.exec.xml`（Environment、ExecStart 转义、用户命名空间）与 `man/systemd.unit.xml`（BindsTo/After/PartOf），均在 https://github.com/systemd/systemd/tree/v255/man 。不宣称所有发行版、内核和主机策略已经通过。
