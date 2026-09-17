# 停止状态下的个人服务安装、更新与回滚

`personal-deploy` 把已有、经过审核的个人服务导出安装为独立配置副本，并用持久化事务记录处理更新失败和进程中断。它只处理固定的个人 target、console 和显式获准的 worker；修改链接后执行用户 `daemon-reload`，不执行 start、stop、restart、enable、disable 或 loginctl。数据库、MCP、记忆数据和模型配置由各自现有工具管理。

本工具要求 Linux 普通服务账号、可访问的本地 systemd 用户管理器和可信的源码/Bun 路径。安装目标固定为账号数据库中的真实 home 下的 `.config/systemd/user`，不由环境变量 `HOME`、XDG 或用户提供的总线地址重定向。`--home` 指定的是私有 `ULTRABRAIN_HOME` 数据安装目录。数据库单元必须已经正确配置到同一安装；本工具不认证数据库绑定或业务就绪，先按 [部署预检](DEPLOYMENT-PREFLIGHT.md)、[个人服务](PERSONAL-SERVICES.md) 完成现有安装检查。

## 维护前提

三个个人单元必须处于停止状态，没有排队任务。操作者先在已获准的维护窗口停止个人 target，并确认没有其他进程、自动化或管理员同时编辑/启动这些单元。失败状态、无法确定的管理器响应、陌生或手工安装的同名文件、drop-ins、额外 `.wants`/`.requires` 依赖目录以及不支持的加载路径均会拒绝变更。旧手工链接不会被自动“认领”，需要操作者单独检查和迁移。

共享锁串行化同一账号的所有本工具调用，包括不同 `ULTRABRAIN_HOME` 对固定名称的竞争；它不能锁住不遵守协议的编辑器或 `systemctl start`。文件身份与管理器状态会在关键步骤重新检查，但这不构成同账号进程隔离，也不是对任意并发外部编辑的原子条件写入。不要在事务期间手工编辑链接或私有状态文件。

## 审核两份计划后安装

先生成服务文本计划和独占导出，参数规则沿用 `personal-services`。下面使用 Bash；示例中的源码目录、数据目录、source 和端口应与实际安装一致。所有命令均在普通服务账号下执行。

```bash
export ULTRABRAIN_HOME="$HOME/ultrabrain-data"
BUN_BIN="$(command -v bun)"
PLAN_DIR="$HOME/ultrabrain-unit-plans"
install -d -m 0700 "$PLAN_DIR"
COMMON=(--home "$ULTRABRAIN_HOME" --bun "$BUN_BIN" --source default --port 3132)
python3 -I -B scripts/personal-services.py "${COMMON[@]}" > "$PLAN_DIR/service-plan.json"
```

检查 `service-plan.json` 的全部单元文本、ExecStart 路径、source、端口及 Worker 许可，然后取这份计划的哈希进行导出。导出目录必须尚不存在。

```bash
PLAN_SHA="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["result"]["plan_sha256"])' "$PLAN_DIR/service-plan.json")"
EXPORT_DIR="$PLAN_DIR/personal-001"
python3 -I -B scripts/personal-services.py "${COMMON[@]}" \
  --output "$EXPORT_DIR" --expected-plan "$PLAN_SHA"
DEPLOY_ARGS=(--export "$EXPORT_DIR" --expected-plan "$PLAN_SHA" "${COMMON[@]}")
python3 -I -B scripts/personal-deploy.py plan "${DEPLOY_ARGS[@]}" > "$PLAN_DIR/deployment-plan.json"
```

第二份计划绑定当前安装回执、目标链接状态以及这次待安装的服务计划。检查它的变更范围后，以 `deployment_sha256` 明确应用。状态改变或文件校验不符时，旧计划失效；应检查原因并重新生成计划，不要只替换一个哈希继续。

```bash
DEPLOY_SHA="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["result"]["deployment_sha256"])' "$PLAN_DIR/deployment-plan.json")"
python3 -I -B scripts/personal-deploy.py apply "${DEPLOY_ARGS[@]}" \
  --expected-deployment "$DEPLOY_SHA"
python3 -I -B scripts/personal-deploy.py status --home "$ULTRABRAIN_HOME"
```

也可通过 `bun src/cli.mjs personal-deploy ...` 调用同一隔离 Python 入口。默认只有管理台；需要 Worker 时，在第一次生成计划之前把 `--worker --allow-model-call --interval 300` 加入 `COMMON`，之后所有生成/安装命令保持同一组参数。Worker 还需要已有私有模型配置明确启用。安装成功只表示配置事务完成，不代表 Worker 已启动、模型调用获无限许可或应用已经可用。

导出内容经完整清单与逐字节校验后复制到 `$ULTRABRAIN_HOME/personal-deployment/` 的私有代际目录，固定单元链接指向这些副本。之后删除或修改原导出不会改变已安装配置。代际文件仍属于当前账号，工具会校验它们；不要手工更改或将“独立副本”理解为防同账号篡改的存储。每个账号还使用真实 home 下 `.config/ultrabrain-personal-deployment/` 保存协调锁与跨安装中断标记。

本阶段保留私有事务暂存目录和代际历史，包括用户单元目录中以 `.ultrabrain-personal-deploy-` 开头的专用目录，以及数据目录中的事务/未完成复制暂存。它们不属于服务单元或 enablement 链接。工具暂不提供垃圾清理；不要在存在 pending 时手工删除这些恢复材料。

## 启动验证与后续更新

启动是操作者另行执行的动作。确认数据库对应安装、端口可用以及当前 Worker/模型许可后，可以明确运行 `systemctl --user start ultrabrain-personal.target`。用 [personal-status](PERSONAL-STATUS.md) 检查全部相关单元，再实际验证管理台令牌认证和当前 source。是否启用开机/登录自动启动由操作者决定，本工具不更改 enablement。

更新时先安排维护并停止个人 target，生成一个新的导出目录，重新执行上述服务计划、部署计划与 apply。原回执成为上一代。更新仍可在明确授权后增加 Worker，或在停止 Worker 后用不含 Worker 的计划移除其受管链接。已有数据库/MCP 单元、配置和数据保持各自管理流程。

## 回滚与中断恢复

`status` 返回 `current_sha256` 和 `pending_sha256`。其中 `filesystem_binding_verified` 只验证私有回执、配置副本和可见链接；`manager_binding: not_checked` 与 `installation_binding_verified: false` 明确表示状态命令未认证管理器/数据库绑定或应用就绪。回滚明确绑定当前回执，恢复明确绑定待处理事务；不能把旧值重用于后续状态。命令错误只返回安全错误代码，不输出原始管理器 stderr、配置内容或秘密。

```bash
# 先读取 status 并检查当前回执，将其完整 current_sha256 填入参数。
python3 -I -B scripts/personal-deploy.py rollback --home "$ULTRABRAIN_HOME" \
  --expected-current '<当前回执的完整 SHA-256>'
# 进程中断留下 pending 时，检查后使用其完整 pending_sha256。
python3 -I -B scripts/personal-deploy.py recover --home "$ULTRABRAIN_HOME" \
  --expected-pending '<待恢复事务的完整 SHA-256>'
```

正常回滚沿回执父链退一代：A → B 后回滚 B 得到 A，再回滚 A 得到首次安装前的空状态。它恢复个人服务配置及链接，**不回滚 Git 源码、Bun 可执行文件、数据库结构或数据**；ExecStart 的路径内容仍需操作者保持可信、兼容。工具保留代际历史，不自动清理可能用于恢复的文件。

事务先持久化代际、回执、恢复用链接和 pending，再改变可见服务链接。可确定的普通失败会尝试恢复事务开始前状态并重载；进程崩溃、超时或补偿失败会留下恢复记录，新的写入被阻止。即使进程中断时新 current 已写入，`recover` 也恢复该事务开始前的回执。恢复前须保持个人服务停止；遇到外部修改或无法确认的状态时保留证据并拒绝继续，不删除 pending 强行解锁，也不手工拼凑链接。

## 验证范围

`test/test_personal_deploy.py` 使用临时文件系统和注入的管理器响应验证事务、冲突、崩溃及安全边界；这些单元测试不是活 systemd 验收。公开 CLI 测试覆盖参数、错误脱敏、普通账号限制与 Python 隔离。

`Personal user services` 工作流在明确获准的一次性普通用户 runner 上，先执行既有服务集成，再执行 `test/personal-deploy-integration.mjs`：实际安装、删除导出后启动、令牌认证、运行中拒绝变更、真实事务子进程中断及公开 CLI 恢复、停止后更新、增删 Worker 配置和逐级回滚。测试分别检查实际 FragmentPath、无排队任务及数据库配置保留；部署工具本身只重载，所有 start/stop 由测试夹具明确调用。新部署集成不调用模型，既有周期 Worker 集成仍使用合成供应商响应。

最终提交的测试运行与独立代理审核结果以 [项目状态](PROJECT-STATUS.md) 和审核记录为准。没有以这些 CI 代替用户实际主机、断电文件系统、真实客户端/模型或完整个人 V1 验收。
