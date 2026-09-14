# 原生只读记忆接入：OpenCode、Hermes、OpenClaw（0.13.0-alpha.1）

本页描述 0.13 引入的默认只读能力；下方安装命令使用当前 `0.14.0-alpha.1` 候选包。0.14 可为 OpenCode 另外明确授权自动采集，授权范围、队列和验收见 `AUTOMATIC-CAPTURE.md`；不改变 Hermes/OpenClaw 的只读范围。

本轮把个人记忆接入三个实际宿主接口，复用 Node 客户端与同一个 Linux PostgreSQL。**默认只读配置下，这些适配器只读取已激活记忆，不自动保存提示词、聊天、工具输出，不接管原生记忆槽，也不会调用个人整理模型。**旧的 MCP 显式采集和 Claude Code Hook 保持可用。个人 V1 尚未全部完成。

## 版本和验证范围

接口基线固定在 `compat/native-adapters-v1.json`。OpenCode 为 1.18.30；Hermes 与 OpenClaw 使用文件中的完整 commit。后续宿主接口更新先复核合同和测试，不因为接口名称相似而自动宣称兼容。

| 适配 | 调用点 | 验证层次 |
|---|---|---|
| OpenCode | `experimental.chat.system.transform` 和 `experimental.session.compacting` | 真实 Node/SDK/MCP/PostgreSQL；独立 CI 另外安装实际 OpenCode 1.18.30，检查发送给本地合成模型供应商的请求确实含有激活记忆。实际结果以该提交 CI 为准。 |
| Hermes | 外部 `MemoryProvider` 的 initialize/prefetch/session switch/shutdown | 真实 Node/MCP/PostgreSQL及 provider 回调；CI 读取上游固定版本真实 ABC。**不是运行整个 Hermes CLI 或网关完成真实模型回合。** |
| OpenClaw | `before_prompt_build`，停止时关闭读取器 | 官方接口形状的回调 + 真实 Node/MCP/PostgreSQL；**不是完整 OpenClaw 网关运行认证**。仅匹配明确 Agent、session key 和工作目录。 |

模型供应商测试只返回合成文本，验证宿主是否装载插件、实际请求是否带记忆；不是大模型效果、提示注入免疫或真实用户机器验收。

## 安装文件

从同一固定提交构建客户端：

```bash
bash scripts/package-client.sh
```

得到 `dist/client/ultrabrain-client-0.14.0-alpha.1.tgz` 和校验文件。安装到使用 Agent 的机器的独立用户目录：

```bash
npm install --prefix /实际客户端安装目录 --omit=dev --ignore-scripts /实际路径/ultrabrain-client-0.14.0-alpha.1.tgz
```

Windows 同样可以运行 Node 客户端并通过已配置 SSH 访问 Linux，不要求本机 WSL/PostgreSQL。这里没有改为 Windows 服务端。包未发布 npm，不要安装注册表同名包替代本项目 tgz。

包内新增 `dist/native-adapters.cjs`、`dist/openclaw.cjs`、根目录 `openclaw.plugin.json`、`dist/native-adapter-config.py` 以及 `dist/hermes-ultrabrain/`。所有三个 JS 入口均在构建时检查没有混入服务端 SQL 实现，并记录文件 SHA-256。运行时需要已固定的 MCP SDK 1.29.0及其传递依赖；不是完全离线包。

## 必须先绑定身份和工作目录

先按 `CLIENT-KIT.md` 创建只读 profile 并执行 `probe`。原生自动读取要求配置 **workspace、expected_instance、expected_actor**，使用实际 probe 输出而不是自造 UUID/hash。profile、Node 程序和 CLI 都是可信本机配置，不得由模型、网页或收到的附件修改。

```bash
node /安装目录/node_modules/ultrabrain-client/dist/cli.cjs probe --profile /私有目录/brain.json
```

随后根据实际观测结果创建带 pin 的 profile。个人项目通过 profile 的 project_id 明确选择，不用会话文字猜测项目；目录必须精确匹配真实路径，不默认授权子目录或相邻工作树。Node 客户端继续检查来源、主体、条目状态、派生有效性、内容 hash 和证据预算。

自动读取把私人记忆发送给宿主所选模型，虽不上传聊天到 Ultrabrain，也仍属于一次记忆披露。只给你信任的模型和账号启用。字符串中的“不可信数据”标签不构成模型安全隔离证明。

## OpenCode：项目插件

仅在要接入的项目中创建 `.opencode/plugins/`，不要覆盖已有文件。插件入口使用 `.js`，不是 `.mjs`；加载目录和文件后缀遵循已核对的宿主约定。用下面脚本生成计划，替换所有路径为绝对路径：

```bash
python3 /安装目录/node_modules/ultrabrain-client/dist/native-adapter-config.py \
  --client opencode-native --target /项目/.opencode/plugins/ultrabrain.js \
  --profile /私有目录/brain.json \
  --library /安装目录/node_modules/ultrabrain-client/dist/native-adapters.cjs
```

默认不写文件。核对 plan 后，在同样参数中添加 `--apply --expected-sha absent`；已有完全相同的文件则使用 plan 返回的 before_sha256。不同的同名插件会被拒绝，不能直接覆盖。回滚用同一个工具的 `--target PATH --rollback RECEIPT`，沿用写前备份、哈希和锁保护。新目录由管理员或本地 Agent 在授权范围内建立，工具不会偷偷创建全局插件目录。

插件只追加一段当前个人参考数据，保持既有 system、压缩 prompt、权限、模型配置不变。没有 sessionID 的小模型辅助调用不读取记忆。每次调用重新请求受控上下文，不跨回合缓存旧内容。工作目录不匹配时拒绝注册；服务不可用时只附加无敏感正文的不可用提示，不复用上次记忆。上述只读回调本身不保存完整对话；0.14 的独立采集回调只有在 profile 另外明确授权时才会启用，见 `AUTOMATIC-CAPTURE.md`。

## OpenClaw：明确会话的附加插件

使用上述客户端包作为本地插件包。无需选择 `plugins.slots.memory`，已有 memory-core 或其他记忆提供者保持不变。对要使用的 `agentId` 和 **完整、精确 sessionKey** 建白名单，且 profile.workspace 须与 ctx.workspaceDir 精确匹配。

```bash
python3 /安装目录/node_modules/ultrabrain-client/dist/native-adapter-config.py \
  --client openclaw-native --target /实际目录/openclaw.json \
  --profile /私有目录/brain.json \
  --library /安装目录/node_modules/ultrabrain-client/dist/native-adapters.cjs \
  --agent-id 你的实际AgentID --session-key 你的实际私人SessionKey
```

先 plan 再添加 `--apply --expected-sha PLAN_HASH`。工具只合并本插件的 load path、必要 allow 条目和自己的 entries 配置，保留其他插件、memory slot、工具/频道权限。如果全部插件已关闭、本插件被 deny、或已有不同配置，拒绝而不是绕过操作者决定。JSONC、重复键和不可信路径也拒绝，不丢弃注释改写。

**完整 sessionKey 仍不等于这个会话只属于你。**不要把群聊、公共频道或多人共用 session 放入白名单；本版没有验证每位群成员的组织身份。未知 Agent/session/workspace 不读数据库；已标明 cron/heartbeat 等非用户触发时也不注入。宿主如未提供 trigger，就只依赖明确的三项范围，不宣称能识别所有子任务。超时/失效调用不会继续返回记忆。宿主全局 prompt-injection Hook 政策仍有效，本工具不替你放开它。

## Hermes：主 CLI 只读 MemoryProvider

Hermes 插件发现支持 `$HERMES_HOME/plugins/<name>/`，路径由实际 profile 的 HERMES_HOME 决定。先确认目录不存在再把包内 `dist/hermes-ultrabrain` **复制为该 profile 的 `plugins/ultrabrain`**。不得覆盖另一个实现，也不要直接改 Hermes 上游源码。

生成独立 provider 配置，不修改原 config.yaml：

```bash
python3 /安装目录/node_modules/ultrabrain-client/dist/native-adapter-config.py \
  --client hermes-native --target /实际HERMES_HOME/ultrabrain.json \
  --profile /私有目录/brain.json --node /实际Node可执行文件 \
  --cli /安装目录/node_modules/ultrabrain-client/dist/cli.cjs
```

同样先 plan 后显式 apply。再通过当前 Hermes 支持的配置方式选择 `memory.provider: ultrabrain`；Hermes 仅允许一个外部 MemoryProvider，若已有其他外部提供者，先决定保留还是切换，不能自动覆盖。MCP 方式接入不要求替换外部 provider，因此已有提供者需要保留时可继续使用先前 MCP 客户端。

只有 `platform:cli`、`agent_context:primary` 和对应工作目录可读取；网关、定时任务和子 Agent 不自动继承主账号的私人记忆。多 profile 不使用固定 `~/.hermes`，线程携带调用方 contextvars。没有用户/助手消息同步、原生 memory 写入镜像、session-end 抽取或新增写工具。

查询参数不传给服务；读取固定 profile 的全局/选定项目上下文。后台结果只允许两秒内消费一次，过期、失败或会话切换后不用旧结果；prefetch 最多等待一秒，因此冷启动或慢网络可能该轮无记忆。两秒刷新窗口并非零延迟撤销保证。CLI 子进程有输出大小限制和截止时间，会话切换与关闭按 generation 丢弃旧结果。摘要指示器只对应本次实际返回，不沿用上一轮计数。

`bound-context --profile PATH` 是给 provider 的受限 CLI 方法，stdin 只接受 `{ "workspace": "/实际工作目录" }`；不接收 query、transcript、source、命令或模型端点覆盖。

## 仍待后续完成

当前不是全量自动保存方案。Grok CLI 具体实现仍需确认，所有软件的稳定事件/采集许可/故障重试还需分别对接；Codex、Claude、ZCode 原有配置和 MCP 能力不因本轮“原生插件”自动升级为所有功能已验收。Hermes 网关参与者身份映射、完整 OpenClaw 引擎测试、文件/多模态、完整附件与密钥恢复仍未完成。不改动现有数据库迁移和四个服务器上游 pin。

官方接口依据：OpenCode `https://opencode.ai/docs/plugins/` 及固定版本 `packages/plugin/src/index.ts`；Hermes `agent/memory_provider.py` 与 `plugins/memory/__init__.py`；OpenClaw `src/plugins/hook-types.ts` 与 `hook-before-agent-start.types.ts`。完整 ref 见 `compat/native-adapters-v1.json`，实现/测试区别见同版审核报告。
