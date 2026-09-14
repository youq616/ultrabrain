# Personal Client Kit：基础接入（始于 0.12）

下方安装命令使用当前 `0.14.0-alpha.1` 候选包；本页的基础能力与验证表保留 0.12 的范围。后续原生适配和授权自动采集分别见 `NATIVE-AGENT-ADAPTERS.md`、`AUTOMATIC-CAPTURE.md`，不能把历史验证表当作当前所有客户端的验收结论。

这一版提供可安装的 Node 客户端、限定个人工具的 MCP stdio 转发器、配置预检/合并/回滚，以及 Claude Code 的工作前只读 Hook。服务端仍在 Linux 上运行项目托管 PostgreSQL；Windows 客户端不需要本地 PostgreSQL、Bun 或 WSL。这里的“不需要 WSL”仅指客户端通过已配置 SSH/HTTP 连接 Linux 服务，不是服务端支持原生 Windows。

## 实际支持层次

| 客户端 | 已提供 | 本轮验证的边界 |
|---|---|---|
| 自研 Agent / 标准 MCP 客户端 | stdio 转发、身份预检、上下文、显式原文入队 | 真实 Node + 官方 MCP SDK + Linux PostgreSQL，stdio 与认证 HTTP；不是只测 JSON 对象。 |
| Codex | TOML 中新增 `mcp_servers.ultrabrain`，保留已有正文和注释 | 按当前官方配置合同生成；未在用户安装的 Codex 中调用实际模型。连接本身不保证模型自动调用记忆。 |
| Claude Code | 项目 `.mcp.json`；可选 SessionStart、UserPromptSubmit 只读 Hook | 官方 Hook 事件合同 + 实际 MCP 读取，未声称已安装到用户电脑。Hook 不保存聊天。 |
| OpenCode | `mcp.ultrabrain` local/command 配置 | 官方配置合同及合并测试；不覆盖 JSONC，含注释配置会拒绝并保持原文件。 |
| ZCode Desktop | `mcp.servers.ultrabrain` stdio 配置 | 根据用户本机验收报告中的产品和配置结构；没有独立的桌面启动认证。 |
| Grok CLI / Hermes Agent / OpenClaw | 可复用普通 stdio MCP 连接基元 | 本轮没有专用安装器或实际客户端验收，不能标为完整接入。Grok CLI 需先确定具体实现。 |

## 构建和安装

在已准备运行依赖的 Linux 仓库里执行：

```bash
bash scripts/package-client.sh
```

输出 `dist/client/ultrabrain-client-0.14.0-alpha.1.tgz` 和 SHA-256 文件。CI 也会为同一提交生成 `personal-client-<完整SHA>` 产物；产物保留期有限，仓库里的构建脚本是长期可重建入口。此私有包**没有发布到 npm**，不要安装注册表里的同名软件替代它。

在实际使用 Agent 的机器上，将这个确定版本的 tgz 安装到独立的当前用户目录：

```bash
npm install --prefix /你的独立客户端安装目录 --omit=dev --ignore-scripts /实际路径/ultrabrain-client-0.14.0-alpha.1.tgz
```

Windows PowerShell 同样使用 npm，并将路径替换为真实 Windows 路径。安装后的入口为 `<安装目录>/node_modules/ultrabrain-client/dist/cli.cjs`；配置工具 `client-profile.py` 和 `client-config.py` 也包含在该 dist 目录。执行配置工具需要 Python 3.11+。客户端运行需要 Node.js 22.16+。包不含 node_modules，安装仍需获取固定直接版本的 MCP SDK 1.29.0 及它的传递依赖；不是完整离线环境。脚本不会启用服务、安装其他 Agent 或导入真实聊天。

## 创建连接 Profile

先准备一个只有当前用户可写的目录。Windows 请使用自己的用户目录及合适的 NTFS 权限，不要放在所有用户可写的共享文件夹。Linux 用 0700 目录，profile 0600。profile 可以启动一个进程，因此是可信配置，不能由聊天内容、下载文档或模型动态覆盖。

**推荐 Windows → 自己的 Linux 服务使用已经确认的 SSH 别名。**先由管理员配置并核对主机密钥、SSH Key 和用户访问；本工具不会接受陌生主机密钥、要求输入密码、关闭主机验证或暴露公网 MCP 端口。`--ssh` 只接受 SSH config 中的简单别名，不接受任意 `-o` 参数。下面的路径仅示意，必须替换为服务器的实际绝对路径：

```bash
python3 scripts/client-profile.py --ssh my-brain-server \
  --repo /home/brain/ultrabrain --home /home/brain/.local/share/ultrabrain \
  --bun /home/brain/.bun/bin/bun --source default \
  --output /客户端私有目录/brain.json
```

在 Windows 中使用实际 Python 命令（例如 `py -3.12`）及 Windows 输出路径；`--repo`、`--home`、`--bun` 仍是远程 Linux 路径。SSH 远程命令逐项 shell 引号处理，固定 `BatchMode=yes`、`StrictHostKeyChecking=yes`、无伪终端以及连接/保活超时。SSH 别名自身的 ProxyCommand、密钥和目的主机属于用户管理的信任基础。

Linux 本机客户端也可以使用 `--local` 代替 `--ssh 别名`；同样填写本机真实绝对 repo/home/bun 路径。源名称必须匹配服务端 `[a-z0-9-]{1,32}`。

已经配置好认证 HTTP 的部署可用 `--url` 和 `--bearer-env`：

```bash
python3 scripts/client-profile.py --url https://你的受保护服务/mcp \
  --bearer-env ULTRABRAIN_MCP_TOKEN --source personal \
  --output /客户端私有目录/brain.json
```

profile 只存环境变量**名称**，不存 Token 值。由实际 Agent 进程的环境提供令牌，不能在公开命令日志、Git 或聊天里填写它。HTTPS 验证保持开启；仅显式 loopback 允许 HTTP，不跟随重定向转发凭据。独立 HTTP Token 对应的主体可能与本机管理台/stdio owner 不同；相同 source 不代表相同私有记忆归属。

profile 创建默认只读且仅创建新文件，不覆盖旧文件。`--allow-capture` 才会启用写工具，仍要求具体采集调用 `consent:true`。已经存在的 profile 变更应在用户批准后另建文件、检查配置差异并重新绑定，不能直接绕过脚本的覆盖保护。

## 验证真实连接

```bash
node /安装目录/node_modules/ultrabrain-client/dist/cli.cjs probe --profile /客户端私有目录/brain.json
```

它验证 source/instance/actor、当前允许的工具和实际个人上下文读取。输出数量和身份指纹，不输出记忆正文。只读凭据不要求写权限。需要更严格绑定时，以刚核对的实际值使用 `--expected-instance`、`--expected-actor` 生成新的 profile；不要凭空填写 UUID/哈希。指纹不是物理主机证书，SSH/TLS 仍是连接信任基础。

`context` 命令显式输出已激活记忆，可能含私人内容，不要把它的 stdout 当安全诊断日志上传。读取检查来源、active/派生有效性、内容指纹、项目和字节预算；既不激活候选，也不调用整理模型。

## 配置预检、应用与回滚

配置工具不自动猜测路径，不执行 Agent，不下载软件。明确选择目标文件：Codex 通常是自己的 `~/.codex/config.toml`；Claude 项目 `.mcp.json`；OpenCode 项目 `opencode.json`；ZCode 使用本机已核实的配置文件。已有目录和文件先备份保护，配置工具默认只是 plan：

```bash
python3 scripts/client-config.py --client codex --target /实际配置/config.toml \
  --cli /安装目录/node_modules/ultrabrain-client/dist/cli.cjs \
  --profile /客户端私有目录/brain.json
```

输出变更与 SHA，不打印原配置中的其他密钥。核对 plan 的 `before_sha256` 后，用**同样的参数**添加 `--apply --expected-sha <刚取得的值>`，原来不存在的文件用 `absent`。`--node` 可指定实际 Node 绝对路径，避免 Agent 启动时 PATH 不一致。

JSON 会保留无关字段和语义，但应用时可能重新格式化；Codex TOML 保留旧文本并追加独立块。不同的同名 `ultrabrain` 已存在时拒绝，不自动覆盖。JSON 重复键、JSONC、符号链接/目录连接、Linux 不可信 owner/写权限及并发 hash 变化会拒绝。路径检查和相邻锁不是抵抗恶意同账号进程的完整沙箱，也不是所有第三方编辑器都参与的 OS 全局 CAS。

应用前先写私有原文备份及回滚回执，fsync 后再替换目标。回滚仍会检查当前文件与工具上次写入的完整哈希相同，用户后来修改过则拒绝，避免覆盖新配置：

```bash
python3 scripts/client-config.py --target /实际配置/config.toml --rollback /实际路径/配置名.ultrabrain-编号.receipt.json
```

只移除本工具新建的目标，或恢复旧文件原字节；不删除 Agent、数据库、其他配置或回执。若发现遗留 `.ultrabrain-config.lock`，先核对是否有写入器和回执，不自动删除不明锁文件。配置中可能存在秘密，备份和回执也应留在私有目录，不上传仓库。

## Claude Code 自动读取 Hook

profile 增加 `--workspace /客户端实际项目目录`，可另加 `--project <真实项目ID>`。Hook 要求事件 cwd 与可信 profile.workspace 的真实路径一致，不根据事件中的项目名称扩权。不配置 workspace 时不能启用自动读取 Hook。

为该项目的 `.claude/settings.json` 执行上面同一个配置工具，`--client claude-hooks`，先 plan 再 apply。它合并 SessionStart 与 UserPromptSubmit 两个 command Hook，不覆盖现有 permissions/其他 Hook，同样可回滚。Windows 命令按 Claude 的 POSIX/Git-Bash command Hook 方式引用路径；本机具体 Shell 和 Claude 版本仍需最终验收。

Hook 只读取事件类型与 cwd，不读取 `prompt`、`transcript_path` 或历史聊天文件。成功通过官方 `hookSpecificOutput.additionalContext` 注入已确认记忆，包含明确不可信数据说明；不可用时返回安全状态提示并允许 Agent 继续，不伪装成成功召回。严格路径绑定意味着子目录任务需对应 profile，不会静默跨工作区读取。

其他 Agent 当前通过 MCP 初始化 instructions 收到使用建议，但模型是否遵循、何时调用及是否支持原生 Hook，各自仍需验收。**不能将“tools/list 可连接”当作“所有软件会自动记住每次对话”。**

## 自研 Agent 显式提交

`capture --profile PATH` 从 stdin 读取完整 JSON：`agent_id`、稳定 `event_id`、`transcript`、`consent:true`。没有 profile 级授权即在联网前拒绝；有授权后登记当前身份自己的标签并调用现有 `ultra_personal_capture`。原文最多 32 KiB、拒绝 NUL 和不完整 Unicode；不得传入 source/模型端点/命令覆盖。

同一事件重试保持相同内容，回执表示原文和任务已持久化，不表示模型提取已完成。直接 `capture` 命令没有额外 fsync outbox，未确认之前事件必须由生产系统保留；0.14 的 `queue-capture` 是另一个明确选择的持久交付入口，见 `AUTOMATIC-CAPTURE.md`。禁止只为重试交付重新运行模型。`mcp` 转发器默认仅六个只读个人工具；明确开启写模式后最多增加六个写工具，仍不公开任意 SQL、shell、企业管理或模型整理执行。服务端原有采集与审核权限继续有效。

## 官方配置依据和验收

- Codex MCP：https://developers.openai.com/codex/mcp （当前重定向到官方 ChatGPT/Codex 文档）。
- Claude Code MCP：https://code.claude.com/docs/en/mcp 。
- Claude Code Hooks：https://code.claude.com/docs/en/hooks 。
- OpenCode MCP：https://opencode.ai/docs/mcp-servers/ 。
- MCP SDK 接口采用仓库锁定的 `@modelcontextprotocol/sdk` 1.29.0。

`test/client-kit-integration.mjs` 执行真实编译后的 Node 客户端、标准 SDK 客户端、原生 stdio/HTTP 与 PostgreSQL。Claude 事件输入为受控 fixture，不是启动用户已安装的 Claude。跨系统 workflow 只验证客户端合同和配置工具，不声称 Windows 服务端或所有桌面 Agent 已认证。独立复核范围与已修复问题见 `docs/reviews/PERSONAL-0.12-REVIEW.md`。
