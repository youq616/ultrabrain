# Linux 部署

## 当前支持与前提

自动化验收环境是 Ubuntu 24.04 的 GitHub 托管 Linux runner，使用 Bun 1.3.13。其他发行版和 CPU 架构需要单独验证，不能由 Linux-first 推断全部已经测试。

程序从锁定源码构建自己的 PostgreSQL 与 pgvector，安装在服务用户的私有目录。数据库作为本机独立进程运行；“内置”不是进程内数据库，也不是外部托管数据库。

需要预先安装 Bun（不低于 1.3.11，CI 固定 1.3.13）、Python 3.11 或更新版本及构建工具。程序不自动安装模型，也不提供模型 API key。

## 安装依赖

Ubuntu 管理员安装系统构建依赖：

```bash
sudo apt-get update
sudo apt-get install -y git build-essential bison flex libssl-dev zlib1g-dev pkg-config python3
```

Bun 按其官方发行方式安装，并确认 `bun --version`。后续构建、数据库和 MCP 运行使用专用的普通 Linux 账号，**不要以 root 执行 bootstrap**。

## 获取候选并初始化

已验收的集成版本进入 `main`；开发分支不是发行通道。正式部署应核对具体提交的 CI 结果，并固定该提交，而不是盲目跟随分支最新位置。

```bash
umask 077
git clone --branch main --single-branch https://github.com/youq616/ultrabrain.git
cd ultrabrain
export ULTRABRAIN_HOME="$HOME/.local/share/ultrabrain"
install -d -m 700 "$ULTRABRAIN_HOME"
bash scripts/bootstrap-linux.sh
```

bootstrap 自动获取运行所需的 GBrain、PostgreSQL、pgvector 子模块，校验提交，按上游 lock 安装依赖，构建数据库，初始化本地账号和 schema。OpenViking 参考子模块不作为运行依赖安装。

默认 PostgreSQL 仅监听 `127.0.0.1:65432`，使用 SCRAM 密码；配置文件和数据目录保存在 ULTRABRAIN_HOME。已有不兼容配置不会被静默覆盖。完成 bootstrap 后数据库保持运行。

## 本机或 SSH stdio MCP

```bash
bun src/cli.mjs health
bun src/cli.mjs mcp
```

stdio 进程的 stdin/stdout 是 MCP 协议通道，不是交互命令行。由 MCP 客户端启动该命令，或通过授权的 SSH 会话运行；不要往协议 stdout 插入 shell 欢迎语或其他日志。

原生 CLI 保留在：

```bash
bun src/cli.mjs native --help
bun src/cli.mjs native serve --help
```

自升级、原生 init/PGLite 替换等会绕开锁定运行方式的入口被包装层阻止，使用 Ultrabrain 的安装和更新路径。

## HTTP MCP

```bash
bun src/cli.mjs mcp --http --bind 127.0.0.1 --port 3131 --suppress-bootstrap-token
```

对外访问需要上游服务支持的有效身份/令牌授权。只读客户端不应被发放 write scope；不同 Agent 的资源应使用正确授权的 source。不要把数据库账号当作 MCP 访问令牌。

该命令只绑定 loopback。跨机器访问可使用经过授权的 SSH 转发，或经过 TLS、Origin 与鉴权配置审核的反向代理。本文不把直接绑定 `0.0.0.0` 当作可投入生产的外网配置。

本地令牌管理辅助脚本 `scripts/mcp-tokens.py` 属于开发候选，必须先通过对应提交的集成验证，不能仅根据文件存在就用它替换已经可用的上游授权流程。

## user-systemd 单元

增强候选可先生成单元文件而不启用服务：

```bash
python3 scripts/install-service.py --output "$HOME/ultrabrain-units-review"
```

审阅后，省略 output 会写入当前账号的 systemd 用户配置目录；显式 enable 才启动：

```bash
python3 scripts/install-service.py --enable
systemctl --user status ultrabrain-postgres.service ultrabrain-mcp.service
```

已有不同内容的单元不会静默覆盖，需审查后使用 `--replace`。无登录情况下开机运行需要主机管理员为该账号启用 lingering；本项目不会擅自改变这项主机策略。

MCP 服务可从 `$ULTRABRAIN_HOME/service.env` 读取运维人员明确配置的环境项。文件应保持 0600，不能提交进仓库。环境变量配置不等于所有 provider 已通过测试。

## 停止与数据保护

手动运行时：

```bash
bun src/cli.mjs db status
bun src/cli.mjs db stop
bun src/cli.mjs db start
```

已交给 systemd 的服务用 systemctl 管理，不要在不知道当前进程归属的情况下同时由两个管理方式启停。

备份、运行目录切换和回退边界见 [UPGRADES.md](UPGRADES.md)。完整功能状态见 [FEATURES.md](FEATURES.md)，实际验收证据见 [VALIDATION.md](VALIDATION.md)。

## 安全边界

应用数据库账号不是超级用户，但具备上游迁移所需的 BYPASSRLS；客户端隔离在原生 operation 授权层，不是每个 MCP 客户端独立的 PostgreSQL 角色。

本地服务账号能够访问自己的数据库配置和管理员准备材料。因此“应用使用非超级用户数据库连接”不等于抵抗该 Linux 账号被完全控制。生产环境还需要主机账户隔离、文件权限、受控依赖和备份策略。

## 0.5.0 配置路径与摘要

实际原生配置文件为 `$ULTRABRAIN_HOME/gbrain/.gbrain/config.json`；旧位置文件由 `db init` 安全接纳，详见 CONFIG-PATH-MIGRATION.md。升级前停写并备份，不能直接移动 native 数据根目录。摘要默认关闭，显式配置和调用方式见 SEMANTIC-MEMORY.md。
