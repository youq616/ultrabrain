# 个人后台服务与显式定时整理

本功能扩展 `scripts/install-service.py`。默认调用仍生成原来的数据库 + HTTP MCP 单元；只有明确 `--personal` 才选择新的个人组合。服务运行在已经完成 bootstrap/migrate 的同一个普通 Linux 账号下，复用其托管 PostgreSQL。脚本不安装软件、配置模型、不开放防火墙、不替换 Agent 配置，也不为原文自动授予保存或确认权限。

## 先审阅，再安装并启动

先执行已有的离线 `preflight --mode runtime` 和实际 `health`，确认目标安装与账号正确。用同一个账号生成可审阅文件：

```bash
python3 -B scripts/install-service.py --personal --source default \
  --output "$HOME/ultrabrain-personal-units-review"
```

`source` 必须是本安装中已有的数据源；启动时管理台再次核对存在性。生成时不连接数据库，不验证该源已经存在。不要把单元生成成功当成服务健康。默认个人组合只有 `ultrabrain-postgres.service`、`ultrabrain-personal-console.service` 和 `ultrabrain-personal.target`，**没有定时器、没有模型调用、没有常驻 HTTP MCP**。各 Agent 仍可通过 SSH/本机 stdio 使用同一数据库。

审阅后，省略 `--output` 安装到当前账号的 `~/.config/systemd/user`，加上 `--enable` 才明确执行用户级 reload/enable/start：

```bash
python3 -B scripts/install-service.py --personal --source default --enable
systemctl --user status ultrabrain-personal.target ultrabrain-personal-console.service ultrabrain-postgres.service
```

默认管理台只在 `127.0.0.1:3132`。远程访问仍用同端口 SSH 转发及管理台独立令牌，见 PERSONAL-CONSOLE.md。令牌保存在私有数据目录中，不写入 unit；服务崩溃后重启继续使用它。首次生成令牌不是向外公开凭据的许可。目标 active 不等于每个组件健康，须检查具体 service 和实际认证请求。

只明确需要常驻 HTTP MCP 时，额外给 `--with-http-mcp --port 3131`，生成独立的 `ultrabrain-personal-mcp.service`，仍绑定 loopback、抑制引导令牌输出并保留原有认证。该服务的 HTTP 认证身份**不等于**管理台/本机 stdio 的所有者。脚本不会停掉原先的 `ultrabrain-mcp.service`，也不改其凭据；迁移旧部署前应自己核对端口和运行归属。

## 定期整理要额外明确授权

先按 PERSONAL-CONSOLIDATION.md 明确配置并验证模型供应商。**单元生成不会创建模型配置、提供 API Key 或验证模型效果。**授权后的服务可处理当前主机所有者、指定源内已有的获准队列；不会遍历其他 HTTP 主体或自行读取历史聊天。

```bash
python3 -B scripts/install-service.py --personal --source default \
  --consolidation-interval 300 --allow-model-call --batch-limit 1 \
  --output "$HOME/ultrabrain-worker-units-review"
```

只有 interval 和 `--allow-model-call` 同时存在才生成 worker/timer；缺少任何一个都拒绝。源、间隔和每批上限来自可信部署参数，不能由记忆正文修改。间隔 30..86400 秒，每批 1..4 个任务；默认每批 1 个。排队原文与模型调用是不同许可，启用该计时器表示持续允许按现有模型配置处理该源内的获准原文，可能持续产生模型费用；关闭它需停止 timer/worker，不应只删除启动命令里的参数。

定时器首次激活后等待一个间隔，再于每批退出后等待同样间隔。使用 `OnActiveSec` 与 `OnUnitInactiveSec`，不是补跑所有关机期间的日历任务；同一个 worker 已在运行时不会另起一个实例。worker 是 oneshot，不使用 `--loop` 或 `--retry`，不无限重试已失败任务。需要重试失败记录时走现有人工明确重试流程。输出只有计数和安全状态，不打印原文、模型回复或凭据；用户应关注 failed/needs_model，不把已完成整理等同于真实事实或自动审核通过。

首次部署确认后可用同样参数去掉 output，加 `--enable`。**已经启用 personal.target 时先停止，再审查替换**，不要一边编辑配置一边假设旧进程已停止。

## 停止、更新和回退

```bash
systemctl --user stop ultrabrain-personal.target
```

这会停止管理台、可选个人 HTTP MCP、该 target 管理的 timer 和 worker；正在进行的 worker 会收到停止信号，不能承诺撤回已经发给供应商的请求。**数据库保持运行**，方便维护与备份；它是共享的既有数据库服务，不由个人 target 停止动作连带终止。确实需要停止时另行：

```bash
systemctl --user stop ultrabrain-postgres.service
```

不要混用 systemd 与手动 db start/stop 控制未知进程。个人管理台使用 on-failure 重启，不把 PostgreSQL oneshot 管理单元宣传成数据库高可用或崩溃自动恢复监控。

已有同名单元内容不同默认拒绝，预检完所有目标后才写入。明确 `--replace` 前，旧的完整字节会写进相邻的 `.ultrabrain-before-*` 私有目录，包含前后 SHA 的清单；新文件逐个同步并原子替换，**不是多文件事务**。失败会保留备份和已完成的部分文件，不自动启动服务或假装回滚完成。写入使用不跟随链接的目录描述符、有界普通文件读取及合作锁，拒绝可疑硬链接/可写文件，检测可观察的目录/文件替换；不声称能抵御服务账号完全被控制。

替换真正安装位置时要求 personal.target 及其各个个人组件均已停止；即使是单独手动启动的 worker 也不能在运行中替换。数据库单元需要改动时，还要求数据库管理单元已停止；原数据库单元不变则可继续维护。获取用户 manager 状态失败或结果含糊时拒绝。输出目录模式不会联系 manager。停掉 target 后可重新执行带 `--replace --enable` 的完整参数组；若删除定时器配置，新 target 不再启动该 timer，但遗留单元文件不会被自动删除。不要另行 enable worker.timer，否则它会有不受本命令管理的额外启动关系。回退时先停服务，再核对 manifest 与当前文件，恢复已保存的旧 unit 字节，daemon-reload 后按需要启动；备份不包含业务数据库，也不自动撤销外部手动的 enable/drop-in。

`service.env` 是操作者明确控制的私有环境配置。新的个人服务启动命令在加载该文件后再次固定 ULTRABRAIN_HOME、compatibility 模式和关闭 sweep，避免配置失误把服务指向另一个数据目录。它不是恶意程序的沙箱：供应商/环境仍须可信。新用户服务不依赖 root-only 文件系统命名空间隔离，使用普通账号权限、0077、NoNewPrivileges 和进程组停止；不能把这些措施说成已隔离同账号任意恶意代码。原数据库单元保留既有设置。

新个人模式要求绝对路径，不接受反斜杠、双引号、控制字符及边缘空白的系统路径，以免不同 systemd 指令的解析规则改变实际位置；空格、美元与百分号由固定转义处理。应用源码、Bun/Python 与数据库目录应在启动后持续保持可信。

无登录情况下的开机运行需要管理员批准该账号的 lingering。安装脚本不调用 `sudo`、不更改 lingering 或主机安全策略。服务测试中的临时 CI runner 启用 lingering，仅用于实际验证，不代表已经部署到用户服务器或实际重启了用户机器。

## 验收范围

`test/test_personal_services.py` 覆盖单元生成、授权、参数、默认行为、旧数据库单元兼容、安全写入、备份、并发变化与合作锁。`test/personal-services-integration.mjs` 仅允许明确授权的非 root GitHub Actions 环境，使用真正 user-systemd、托管 PostgreSQL、管理台、计时器及本地合成模型供应商，核对启动/认证、崩溃重启、源保持、仅授权时整理、同一 worker 不重复启动和停止后数据库仍运行。未实际运行的 CI 不得写成通过；单元语法检查也不能替代真实服务执行。

接口依据为 systemd 原始手册（man7 镜像）：https://man7.org/linux/man-pages/man5/systemd.timer.5.html （单调计时器和活动单元不重复启动）、https://man7.org/linux/man-pages/man5/systemd.unit.5.html （PartOf 传播停止/重启）、https://man7.org/linux/man-pages/man5/systemd.service.5.html （ExecStart 转义、oneshot 与重启行为）。本阶段仍不代表 Personal V1 全部完成。

这些启动/停止检查是合作式部署预检，不锁住所有其他操作者；检查后仍须避免同时手动启动服务。已有 drop-in、其他 target 的依赖和自行 enable 的旧单元不会被本工具清除，需操作者审阅实际 systemd 配置后使用。
