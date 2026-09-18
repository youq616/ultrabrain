# 个人常驻服务：管理台与明确授权的整理 Worker

本阶段提供 `personal-services` 配置计划、独占导出和逐字节校验。生成器不安装、不启用、不启动、不停止服务，不连接数据库、不调用模型，也不修改其他客户端或原有 systemd 单元。实际启用是操作者另行执行的操作。Linux 普通服务账号、已初始化且完成 migrate 的同一安装，以及可用的 systemd 用户管理器是运行前提；先执行 DEPLOYMENT-PREFLIGHT.md 和现有 health 检查。

新增的 `personal-deploy` 可将这份导出安装为独立副本，并在个人服务停止时更新、回滚和恢复中断事务，详见 [个人服务部署](PERSONAL-DEPLOY.md)。下文手工 link 流程保留作为旧安装说明；新工具拒绝自动认领已有手工链接，不能把两种流程混用为同一受管安装。

受管 console-only 安装另有 [personal-ready](PERSONAL-READY.md) 只读认证就绪检查，要求预期部署回执和逻辑实例 UUID，并核对实际控制台与托管数据库进程。它不适用于下文未经受管部署认领的手工链接，也不会自动激活服务。

## 生成内容与身份

默认只生成 `ultrabrain-personal.target` 和 `ultrabrain-personal-console.service`。管理台使用原有 `personal-ui`，只能监听 127.0.0.1，仍需私有令牌；该令牌不写入单元文件。它代表当前 Linux 服务账号的本机所有者，不会接管独立 HTTP 主体的私有记忆。

只有同时提供 `--worker --allow-model-call` 才生成 `ultrabrain-personal-worker.service`。它复用原 Worker 的 `--local --loop --limit 1`，默认间隔 300 秒，允许 30..86400 秒。仍需既有私有模型配置明确开启整理；没有模型配置时退出码 2 不自动重启。没有加入 `--retry`，失败/租约过期任务仍需明确处理，不无限重试模型。新结果仍是候选，不自动确认事实。

所有新服务依赖**已经配置好的** `ultrabrain-postgres.service`，必须对应同一代码安装和 ULTRABRAIN_HOME。生成器不会重写该数据库服务或生成另一个数据库管理器，也不生成公网 HTTP MCP 服务。需要 HTTP MCP 时继续使用原部署流程，不能把管理台当作公网登录系统。

## 先看计划，再导出，不覆盖既有文件

下面所有命令在实际普通服务账号和正确代码目录执行。`--bun` 可指定已有 Bun 的绝对路径；省略时固定本次 PATH 找到的路径。计划允许尚未安装的路径，它不是运行时可用性认证。

```bash
install -d -m 0700 "$HOME/ultrabrain-unit-plans"
python3 -B scripts/personal-services.py --source default \
  > "$HOME/ultrabrain-unit-plans/personal-plan.json"
PLAN_SHA="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["result"]["plan_sha256"])' \
  "$HOME/ultrabrain-unit-plans/personal-plan.json")"
python3 -B scripts/personal-services.py --source default \
  --output "$HOME/ultrabrain-unit-plans/personal-001" --expected-plan "$PLAN_SHA"
python3 -B scripts/personal-services.py --source default \
  --verify "$HOME/ultrabrain-unit-plans/personal-001" --expected-plan "$PLAN_SHA"
```

也可用 `bun src/cli.mjs personal-services` 调用同一个 Python 入口。导出时其余参数必须与计划一致；source、端口、路径、Worker 许可或间隔改变会导致校验不符。**需要 Worker 时，三个命令都明确加上 `--worker --allow-model-call`，不是修改 JSON 中的一个字段绕过授权。**stdout 计划包含可审查的单元文本和本机路径，没有密码或令牌；不要把目录中的私人路径当作公共日志上传。

输出必须是新的目录，其直接父目录须为当前账号拥有的 0700 目录。文件 0600，写入及目录 fsync；遇到已有目录直接拒绝，不支持 --replace。中断保留 INCOMPLETE，verify 拒绝残缺、多余、变更或链接文件；它核对同一组实际单元字节，不能证明代码来源可信或服务已运行。校验后文件仍可能被其他进程修改，应保护导出目录。只在信任导出来源时安装。

## 明确启用和停止

首次尚未配置数据库用户单元时，可以先用旧工具导出，再只链接数据库单元；它必须对应同一安装。已经存在同名单元时先检查，不覆盖其自定义设置，不重复链接。下面的 link/enable 会改变本机服务配置，不能在只是审查计划时执行。

```bash
python3 scripts/install-service.py --output "$HOME/ultrabrain-unit-plans/database-001"
systemctl --user link "$HOME/ultrabrain-unit-plans/database-001/ultrabrain-postgres.service"
systemctl --user link "$HOME/ultrabrain-unit-plans/personal-001/ultrabrain-personal.target" \
  "$HOME/ultrabrain-unit-plans/personal-001/ultrabrain-personal-console.service"
# 只有导出时明确授权 Worker 且确认模型/费用/隐私后，才另行 link 它的 service。
systemctl --user daemon-reload
systemctl --user enable --now ultrabrain-personal.target
```

Worker 被写入 target 的 Wants 时也须链接导出的 worker service；遗漏会使它不运行，不应把 target 为 active 当作全部就绪。读取 `systemctl --user status ultrabrain-personal-console.service`，并实际打开 127.0.0.1 上的管理台验证。模型凭据继续来自受审的原生配置或受信任的用户管理器环境；**新单元不会自动读取 service.env 或仓库 .env**。不要因为某个环境变量未传递，就把秘密拼入 ExecStart。需要更复杂凭据供应时另行审查部署方案。

```bash
systemctl --user stop ultrabrain-personal.target
# 停止个人管理台与 Worker，不会自动停止共享的数据库服务。
# 需要完整停库维护时，先结束其他客户端，再明确停止：
systemctl --user stop ultrabrain-postgres.service
```

停止/重启数据库单元会通过 PartOf 传播到个人服务，After 确保停止时先退出客户端；直接通过 db stop 或其他命令停库不经过 systemd 依赖链，仍须操作者停好应用。异常退出按 30 秒重启、五分钟内最多三次启动限制；缺模型 Worker 的退出 2 除外。控制台重启需要实际 HTTP 就绪检查，Type=exec 只表示进程已执行，不是业务 ready。Worker 的既有 SIGTERM 处理取消后续活动，但已发出的模型请求不能承诺撤回、费用也可能已经产生；被强杀的租约需明确检查，不自动重跑。

退出登录后保持启动依赖该账号的 lingering 设置，由主机管理员明确决定；生成器不执行 loginctl、不修改防火墙或 sudo 配置。更新导出时先停止相关服务、保存旧计划，检查现有链接，再明确切换到新目录；不要原地覆盖旧文件。移除/回滚服务配置也不删除记忆或数据库。

## 运行边界与验收

新单元使用普通账号、UMask=0077、NoNewPrivileges、禁止 core dump 和完整进程组清理；不宣称文件系统沙箱或同账号进程隔离。固定 ExecStart 参数重新绑定 ULTRABRAIN_HOME/source/profile，清除特定外部数据库/运行时注入变量并禁用 Bun 自动 dotenv；剩余的用户管理器环境、可执行文件及源码本身仍须可信。依赖的旧数据库服务硬化策略保持原样。

纯单元/CLI 测试只写临时目录；systemd-analyze 的解析检查不是活服务验收。新增 GitHub Actions `Personal user services` 在一次性 runner 上明确启用用户管理器，实际启动原数据库服务、新管理台与 Worker，核对认证、默认不采集、不启用模型、缺模型不重启、合成供应商任务处理、周期下一批、控制台崩溃重启及目标停止。真实模型质量、用户主机断电/开机、网络与各 Agent 接入仍须单独验收。工作流未成功时不得写成通过。

官方接口依据：systemd 的 systemd.unit(PartOf/After)、systemd.service(RestartPreventExitStatus/Type)、systemd.exec(命令参数与环境展开)，https://github.com/systemd/systemd/tree/v255/man；Bun dotenv 禁用见 https://bun.com/docs/runtime/environment-variables 。

## 导出与验收补充防护

导出目录不能位于已知的 systemd 单元加载路径中，否则一次“仅导出”也可能使新单元可被用户管理器发现。生成器现在拒绝标准用户/系统单元目录、当前进程声明的 XDG 配置/数据/运行目录中的单元与生成器路径，以及 `SYSTEMD_UNIT_PATH` 指定路径及其子目录；拒绝发生在创建目录前。无效的相对搜索路径或过长环境参数会明确失败。此检查不连接用户管理器，无法发现仅在另一个管理器环境或非标准编译配置中存在的额外路径；操作者仍须选择不在任何实际加载路径中的独立私有导出目录，不可将它视为对同账号恶意进程的沙箱。

导出完成前逐字核对所有文件，保留 `INCOMPLETE` 直到核对结束；校验在读取后再次检查文件清单与目录修改时间，拒绝读取期间新增/移除的条目。全部读取结束时还会复查每个文件的身份、权限、链接数、大小和修改时间，避免较早读完的文件在后续读取期间被原地修改而漏报。校验不锁住目录，不能保证返回后文件永远不变。`installed:false` 表示本命令没有安装，不是通过 systemd 查询得到的当前安装状态。

CI 夹具检查缺失单元时只接受退出码 0 或 5 且命名属性完整满足 `LoadState=not-found`、`ActiveState=inactive`、`FragmentPath=`；不把其他非零退出、空输出或无法连接用户总线当作单元缺失。控制命令及其他属性查询继续要求成功退出。清理失败时不输出成功回执、不删除用于诊断的私有导出目录；其他安全关闭步骤仍会尝试。既有审核意见本身不是某一 systemd 版本已失败的证据，新版本必须由最终提交的真实用户管理器工作流验收。

## 单元状态诊断

`personal-status [--expect-worker]` 命令逐一观察数据库、个人目标、管理台与Worker，避免仅看 target 为 active 就认为全部正常。不启停服务、不读日志或密码；未验证的业务健康和安装绑定在输出中明确标注。使用及实际CI验收范围见 [PERSONAL-STATUS.md](PERSONAL-STATUS.md)。这段文档不代替最终候选的独立审核和合并记录。
