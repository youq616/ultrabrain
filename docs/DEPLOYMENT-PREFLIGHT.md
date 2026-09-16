# 离线部署前检查（preflight）

`preflight` 是普通 Linux 服务账号运行的**只读离线检查**，用于在安装或启动前集中报告已知问题。它不是安装器，也不替代现有 `health`、认证 MCP 连接检查或真实 Agent 验收。没有修改既有迁移、数据库权限、上游锁、模型配置或用户服务。

## 两个入口与两种模式

尚未安装 Bun 时，先使用已有的 Python：

```bash
python3 -B scripts/preflight.py --mode install
```

已经具备 Bun 时，可以使用实际项目 CLI：

```bash
bun src/cli.mjs preflight --mode runtime
```

两者使用同一检查器。数据目录默认与项目一致，来自 `ULTRABRAIN_HOME`，未设置时为当前用户的 `.local/share/ultrabrain`。也可明确传入 `--home /absolute/planned-or-existing-directory`；不会创建该目录。必须从正确服务账号执行，不可用 root 代替普通账号检查；Windows 上会明确报告服务端需要 Linux，不会要求客户端因此安装数据库。

`install` 检查 Linux、普通账号、Python 3.11+、稳定版 Bun 1.3.11+、bootstrap 实际使用的构建命令和 OpenSSL/zlib 的 pkg-config 元数据，并检查计划数据目录的安全路径、当前访问权限及资源提示。不读取既有数据库密码或原生配置。上游源码下载、完整性和可构建性仍由 bootstrap 和现有上游验证流程检查。

`runtime` 不要求编译器，但检查已经安装的数据目录与指定私有文件：数据库状态和原生配置、应用连接串与本地状态是否一致、实际 runtime binding 是否与本次代码锁一致、构建标记、所需数据库可执行文件的类型/权限、PG_VERSION 主版本，以及原生入口和依赖目录是否存在。它**不会执行 PostgreSQL 二进制或连接数据库**，也不验证所有库、扩展与迁移。`service.env` 和管理台令牌只检查元数据，不读取内容、不证明令牌仍有效。

## 结果含义

JSON 包含每项的固定 `id`、`status`、`code`，不输出绝对路径、连接串、密码、令牌、配置正文、原文或原始子进程错误。

| 状态 | 含义 |
|---|---|
| `pass` | 本项离线检查通过。不是服务或生产可用性证明。 |
| `warn` | 非阻断提示，例如目标目录尚未安装，或资源低于提示阈值。 |
| `fail` | 本项失败，报告的 `ok` 为 false；检查器不自动修复。 |
| `not_checked` | 本次未验证，例如可选令牌不存在，或数据库/MCP在线状态。 |

退出码 0 表示没有失败项；1 表示存在失败项；2 表示参数错误或无法完成检查。`ok:true` 始终伴随 `live_service_verified:false`、`database_connected:false` 和 `model_called:false`，不能据此宣布数据库已经运行、所有客户端已接通或 Personal V1 完成。

## 常见问题的处理方向

| 代码 | 应检查的事项 |
|---|---|
| `use_ordinary_service_account` | 改用将实际运行服务的普通 Linux 账号。检查器不执行 sudo 或切换用户。 |
| `bun_not_found` / `bun_1_3_11_stable_required` | 核对受信任 PATH 中的 Bun 安装和版本；检查器不安装、不自动升级。 |
| `owner_only_permissions_required` | 检查所属账号和私有目录/文件权限；不要对未知目录递归 chmod。 |
| `not_installed_no_directory_created` | install 模式允许缺少计划目录；runtime 模式表示该安装尚不可检查。 |
| `planned_home_parent_not_writable` / `home_not_writable` | 当前有效账号没有相应访问权；工具不创建测试文件或改变 ACL。 |
| `managed_database_mismatch` | 配置与本地托管数据库状态不一致；不要手动覆盖密码或改用外部数据库绕过。 |
| `runtime_pin_mismatch` / `runtime_build_marker_mismatch` | 按现有受审构建、停服激活和迁移流程检查运行时，不在运行中的目录覆盖二进制。 |
| `cluster_major_mismatch` | PostgreSQL 主版本与锁不一致；本工具不做跨主版本转换。 |
| `config_too_large` / `invalid_json` / `duplicate_config_key` | 在本机审查相应配置格式，不把完整配置粘贴到公共日志。 |

缺少实际原生配置时，可额外报告历史 `gbrain/config.json` 的元数据；这不是自动迁移许可。先参考 `CONFIG-PATH-MIGRATION.md`，保护现有数据。

## 安全与能力边界

路径读取使用不跟随符号链接的逐级目录描述符；私有文件要求当前账号所属、无组/其他用户权限、普通文件且非硬链接。FIFO、设备或链接不能伪装成配置。配置读取有大小上限，读取中检测变化；固定源码入口也拒绝错误类型和符号链接。所有结果使用固定安全代码，不把解析异常原样返回。

仅会执行受信任 PATH 中的 `bun --version` 与 install 模式下固定参数的 `pkg-config --exists openssl zlib`。子进程输出有上限，超时/异常时清理本次创建且尚未回收的进程组；不向已回收的 PID 发清理信号。依赖命令在切换子进程工作目录前固定为绝对路径，避免相对 PATH 被错误地改为从根目录解析。子进程不继承数据库/供应商密钥、HOME 或运行时注入选项。**这不是对恶意 PATH 可执行文件的沙箱**；应由操作者维护可信依赖。正常依赖下不发起网络请求或模型调用，不会执行从配置或记忆中取得的命令。

检查器没有写入探针。权限检查只是此刻的可用性提示，不是后续读写的授权或保证；实际操作仍必须重新处理失败。配置、路径或权限在检查结束之后可以变化；远程文件系统/内核阻塞和进程创建时延也不受一个硬性总时限保证。读取可能更新文件系统访问时间，`changes_made:false` 表示检查器没有主动改写数据、配置或安装状态。

磁盘 5 GiB、可用内存 2 GiB 是提示阈值，不是已经测定的最低规格，不会保留资源。内存读取 `/proc/meminfo` 的主机估计，未认证容器 cgroup 限额。低于阈值只警告，不应把通过预检解释成性能或容量 SLA。

## 验收

```bash
python3 -B -m unittest discover -s test -p 'test_preflight*.py' -v
node --test test/preflight-cli.test.mjs
```

单测使用合成配置和明确的替代依赖，包含权限、错误文件类型、Bun版本、连接串、状态格式、原文/密钥不回显、并发文件替换、超限输出、进程超时和 CLI 路由。不是实际用户部署或完整数据库验收。

在已 bootstrapped 的隔离 Linux CI 中运行 `ULTRABRAIN_TEST_ALLOW_WRITE=1 python3 -B test/preflight-integration.py`，检查真实 Python/Bun CLI、实际托管安装状态、配置指纹、数据库停止后不会被预检启动，以及权限失败不会被自动修复。该测试短暂停止并恢复本次合成安装的数据库，禁止对重要记忆库运行。恢复专项工作流接入安装前检查和这项集成；远程结果必须绑定最终候选提交，未执行不能写成通过。

实现依据：Python 官方 os 文档 https://docs.python.org/3/library/os.html（dir_fd、O_NOFOLLOW、access 限制）以及 subprocess 文档 https://docs.python.org/3.11/library/subprocess.html（环境隔离、超时与进程回收）。
