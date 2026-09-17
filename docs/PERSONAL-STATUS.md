# 个人服务状态：只观察单元，不代替业务健康检查

验收必须绑定固定最终提交、独立代理审核和该提交的 Linux CI；本文定义行为和验收范围，不预填任何候选的通过结论。它在既有个人服务计划上增加 `personal-status`，不修改生成器、旧数据库单元、模型配置或数据表。

## 使用范围

在运行 Ultrabrain 的同一普通 Linux 账号下执行：

```bash
python3 -I -B scripts/personal-status.py
# 已计划启用整理 Worker 时，把它也列为本次检查的必需项：
python3 -I -B scripts/personal-status.py --expect-worker
# 已有 Bun 时，同一入口也可通过项目 CLI 调用：
bun src/cli.mjs personal-status --expect-worker
```

固定检查四个用户单元：`ultrabrain-postgres.service`、`ultrabrain-personal.target`、`ultrabrain-personal-console.service`、`ultrabrain-personal-worker.service`。不查询其他单位、不读取单元正文或日志，不接受任意命令、URL、凭据、主机和服务名。`--expect-worker` 仅改变本次诊断的必需项，不授权采集或模型调用，也不启用 Worker。

使用 `/usr/bin/systemctl` 和当前实际用户 `/run/user/<uid>/bus`，不沿用环境中指定的其他 DBus 地址。没有默认用户管理器、工具不可执行、超时或返回不完整时，输出 `unavailable`，而不是猜测服务已停止或全部正常。只有完整四单元属性、成功退出，或完整属性中有 inactive/not-found 证据且退出码为5时，才继续判断单元状态。通用失败、权限错误、空响应和不完整响应不被当作单元缺失；该规则与现有服务集成夹具一致。此版本不支持自定义总线、别名单位、system级服务或原生 Windows 服务管理。不要为查询状态使用 root，也不要求 Windows 安装 WSL；Windows 客户端连接测试仍走既有客户端工具。

## 输出与退出码

| 退出码 | 含义 |
|---|---|
| 0 | 本次指定的必需单元均呈现生成器预期的活动状态。不是应用就绪证明。 |
| 1 | 管理器可读，但至少一个必需单元不存在于管理器视图、未活动、类型不符或处于未知状态。 |
| 2 | 参数不受支持。只返回安全错误，不回显原参数。 |
| 3 | 不能可靠观察默认用户管理器，或平台/账号条件不满足。 |

默认不把 Worker 列为必需：未运行它不会使只读管理台检查失败，但实际存在的失败或未知 Worker 会列入 `warnings`。启用 `--expect-worker` 后，同样情形会导致退出1。`unit_not_found` 只表示本次管理器查询未找到，不能证明磁盘上完全没有同名配置文件。

每个单元包含白名单化的加载状态、活动状态、子状态、服务类型、结果以及退出码和重启计数。未知枚举以 `unknown` 代替，不回显任意字符串。`restarts` 是管理器的当前计数，不是永久审计历史。对生成器的 Worker，明确的进程退出码2给出检查模型配置的提示；提示并不证明唯一原因是模型未配置，更不是自动重试许可。

始终明确返回：

```json
{
  "application_ready": "not_checked",
  "installation_binding_verified": false,
  "database_connected": false,
  "console_http_checked": false,
  "mcp_checked": false,
  "model_called": false,
  "configuration_changed": false,
  "services_started": false,
  "services_stopped": false
}
```

数据库单元是原有 oneshot+RemainAfterExit 形式；`active/exited` 可能只代表启动命令此前成功，并不代表数据库现在接受连接。管理台/Worker 的 `active/running` 也不是模型、HTTP或MCP可用性证明。仍须按部署文档执行 `health`、实际管理台登录和客户端 `probe`。检查不读取 ExecStart、环境或 FragmentPath，所以**同名单元不能证明它绑定当前目录、当前 ULTRABRAIN_HOME 或正确版本**；这些由计划校验与实际部署验收确认。

管理器属性按顺序读取，不是原子快照，状态可能在查询期间或之后改变。状态命令不会启动/停止/重载单元或改变持久配置；systemctl的查询可能在管理器内载入单元元数据，不把这一点称作完全无内部影响。该工具的 `model_called:false` 仅指本次诊断没有调用模型，不代表已有后台 Worker 没有同时工作。

## 隐私与资源边界

只请求固定的九个属性，绝不使用会附带日志的 `systemctl status`。stdout和stderr合计最多16KiB，stderr只计数、不保留；子进程最长五秒，异常只清理本次创建且尚未回收的进程组。命令不继承提供商凭据、远程总线和动态加载注入变量。项目CLI用 Python `-I -B` 防止 ambient Python模块注入和写入字节码。可信操作系统、解释器、systemctl以及同账号进程仍属于信任边界，不宣称独立沙箱。

## 验收状态

纯契约和子进程测试用合成状态，不冒充真实服务运行。Node测试执行实际CLI；没有用户管理器的工作容器只能验证真实的不可访问分支。现有 `Personal user services` CI 的测试增加六个状态断言：不存在、只读服务运行、缺模型Worker失败、Worker恢复、管理台异常重启、停止个人目标而保留数据库。测试继续核对本次查询没有额外调用模型或改变任务；六个新增状态检查必须随最终提交在实际一次性用户systemd环境跑通。初始保全包未执行这些检查；发布验收以最终提交的CI和PR记录为准，不沿用旧版本结果。

官方接口依据：systemd v255 的 `man/systemctl.xml`（show、property、all）和 `man/systemd.service.xml`（oneshot、RemainAfterExit）：https://github.com/systemd/systemd/tree/v255/man 。文档依据不是本候选实际CI的替代品。
