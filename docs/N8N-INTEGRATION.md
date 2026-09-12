# 0.8.0-alpha.1：可安装的私有 n8n 节点

本版提供客户端 npm 安装包，不是新增数据库、HTTP 服务或通用命令执行器。复用现有 AgentMemory、来源治理和固定版本 MCP SDK，适用于自托管 n8n。它尚未发布到 npm 或通过 n8n Cloud 验证；不要把 npm 上的同名包当成本仓库发行物。

## 构建与安装

在已安装依赖的 Ultrabrain 仓库运行，构建需要 Bun 和 npm；安装后的 n8n 只需要 Node.js，不需要在 n8n 进程中运行 Bun。

```bash
bash scripts/package-n8n.sh
```

生成 `dist/n8n/n8n-nodes-ultrabrain-0.8.0-alpha.1.tgz` 和 SHA-256 文件。构建脚本不会安装到你的服务或重启服务，也不会覆盖已有同名包。安装包包含编译后的客户端、凭据/节点定义、manifest 和许可证，不包含 vendor、数据库、模型密钥或 node_modules。MCP SDK 的直接版本固定，npm 安装时解析其传递依赖，不将 tgz 称为完整离线环境。

将包传到 **n8n 所在主机**，使用运行 n8n 的账户安装到独立目录，例如：

```bash
INSTALL_ROOT="$HOME/.local/share/ultrabrain-n8n-adapter"
mkdir -p "$INSTALL_ROOT"
npm install --prefix "$INSTALL_ROOT" --omit=dev --ignore-scripts \
  /实际路径/n8n-nodes-ultrabrain-0.8.0-alpha.1.tgz
```

把下列路径加入 n8n 服务的 `N8N_CUSTOM_EXTENSIONS` 并重启该 n8n 服务：

```text
$HOME/.local/share/ultrabrain-n8n-adapter/node_modules/n8n-nodes-ultrabrain/dist
```

路径中的 HOME 应替换成服务账户的真实路径。已有自定义节点目录时保留原配置并追加，不能无意覆盖其他插件。单独启动的无其他扩展测试环境可以执行：

```bash
N8N_CUSTOM_EXTENSIONS="$INSTALL_ROOT/node_modules/n8n-nodes-ultrabrain/dist" n8n start
```

本流程使用官方 CustomDirectoryLoader，因此节点类型为 `CUSTOM.ultrabrain`。n8n 自动注入其自身的模块解析路径以提供 `n8n-workflow`。生产服务应在自己的 systemd/容器配置中持久设置环境；临时 shell 的 export 不会修改已经启动的服务。Docker 部署需将扩展与配置挂载到 n8n 容器，并对每个 worker 安装相同版本。本项目不要求 Docker Hub，也不会创建或启动用户的容器。

测试基线记录在 `compat/n8n-adapter.json`：n8n 2.38.7、n8n-workflow 2.38.1、Node.js 22。没有据此声明所有旧版、Cloud、分布式 runner 或代理组合都已支持。

## 配置凭据

在 n8n 中创建 **Ultrabrain API** 凭据，填写 MCP Endpoint、Bearer Token、Memory Root URI。Endpoint 是可信主机配置，不能由输入 item 或模型指定；仅允许 HTTPS 或显式 loopback HTTP。默认 `ultra://default/` 需与令牌的 source 权限一致。

先使用 **Check Connection**，核对实际 source、actor_key 和 instance_id。可以将返回的完整 actor hash 与 instance UUID 保存为 Expected Actor/Instance pin。逻辑 instance ID 在数据库备份中保留，不代表物理主机认证；HTTPS 和部署地址仍是信任基础。

默认 **Allow Conversation Capture** 与 **Allow Source-Shared Capture** 均关闭。只读集成不需要打开它们。需要采集时才开启前者；需要 source 内 world 共享时才额外开启后者。private 仍是服务端的 host-private，不是“当前远程用户本人可读的私有空间”。

令牌从 n8n 凭据系统取得，执行开始时固定一次，并在每个 item 前验证服务器身份。节点不将令牌放进 workflow JSON 或输出，不跳过 TLS 校验，不跟随跨来源跳转。这里使用官方 MCP SDK 与固定来源 fetch，不宣称兼容/继承 n8n 通用 HTTP 节点的所有代理、SSRF 或域白名单功能；端点必须由可信管理员管理。

## 节点操作

| 操作 | 用途与约束 |
|---|---|
| Check Connection | 验证实际认证身份；不读取正文、不写记忆。 |
| Get Context Before Turn | 先恢复可选项目检查点，再读取受治理的页面与可选事实。回调输出是数据，不是执行授权。 |
| Save Consented Turn | 源根目录凭据、凭据级采集许可与逐 item 的 `Consent to Save This Item` 都满足才允许保存。 |
| Get Session Status | 查询同一认证主体、session/event 的原始交付和整理状态，不返回 transcript。 |
| Resume Project | 读取已存在的项目检查点；不会执行下一步命令。 |

保存只走 deferred 路径，服务端原子保存后返回 journaled/queued。采集操作不会启动整理或生成摘要；单独 worker 的授权保持不变。读取摘要只使用现有缓存，没有缓存时依配置降级或明确失败。上下文检索仍按服务器配置运行，已配置的 embedding 等检索服务可能产生自身的模型调用与费用；不能把“不生成新摘要”解释为“整个检索绝不调用模型”。

会话 ID 与事件 ID 必须来自生产事件，使用相同内容重试时保持不变，不能用新的 n8n execution ID 代替。默认不自动生成 ID，避免重试生成重复事实。共享源有配额时拒绝新保存，不丢旧事件。

## 连接到你的 Agent 工作流

典型连接：输入事件 → Get Context Before Turn → 你的模型/Agent → Save Consented Turn。模型节点明确使用 `$json.result.context`（以及可选 project），把它作为不可信参考数据。保存节点从业务事件取得稳定 session/event 和已经过必要脱敏的 transcript。不同节点用具备正确权限的同一主体凭据；换主体会改变会话所有权。

`examples/n8n/context.private.json` 和 `capture.private.json` 可导入。模板不含凭据、不激活、关闭成功/失败执行保存，并默认不允许采集；导入后仍须选择凭据与数据映射。示例不是已连接你模型或生产 webhook 的完整自动化，不包含秘密占位令牌。原生社区包安装模式可能使用 `n8n-nodes-ultrabrain.ultrabrain`，不要与此处已测试的 CUSTOM 私有加载模式混用。

## 出错与隐私

每项结果保留 pairedItem 关系，不修改或默认回显输入。开启 continueOnFail 时输出 `ok:false`，必须在下游明确检查；不能把失败项目接入“已成功保存”分支。

`delivery:not_submitted` 表示尚未提交内容；`delivery:unconfirmed` 表示提交后未取得可靠确认，服务器可能已经保存。后者应使用原始 session/event/transcript 重试，不重新生成整轮回复。服务端拒绝内容冲突时不能换一个随机 ID 绕过审核。

此适配器 **没有本地文件 outbox**。在 journaled 确认之前，业务源或按需配置的 n8n 执行/重试机制须保留原事件；不承诺 worker 崩溃或断电前一定保存。需要独立 fsync 队列时继续使用原有 AgentMemory + DurableOutbox/事件桥，不能把两个机制的保证混淆。

n8n 自己可能保存输入、凭据、运行日志和输出；这是与 Ultrabrain 不同的持久化边界。请设置执行保留期、访问权限和加密密钥，避免向公开日志输出完整记忆。节点错误仅包含安全代码和交付状态，但无法替 n8n 删除其已经保存的输入。原文上限 64 KiB，每次最多1000项顺序处理，单次响应硬上限2 MiB。

## 官方依据

- n8n programmatic node 示例：https://github.com/n8n-io/n8n-nodes-starter/blob/master/nodes/Example/Example.node.ts
- n8n 私有目录加载器：https://github.com/n8n-io/n8n/blob/n8n%402.38.7/packages/core/src/nodes-loader/custom-directory-loader.ts
- n8n 模块解析配置：https://github.com/n8n-io/n8n/blob/n8n%402.38.7/packages/cli/src/load-nodes-and-credentials.ts
- n8n 版本基线：https://github.com/n8n-io/n8n/releases/tag/n8n%402.38.7

这些是接口依据，不是本节点已获官方认证的声明。实际测试记录应绑定本次 commit。
