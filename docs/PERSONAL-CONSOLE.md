# 个人管理台与 Agent 生命周期接入（0.10.1-alpha.1）

本版补上可操作的个人管理页面，并将个人上下文接入现有 AgentMemory、通用事件桥和自托管 n8n 节点。它不是全部个人 V1 的完成声明；自动分类整理、所有实际 Agent 的自动 Hooks 和完整个人灾备仍需独立验收。

## 启动管理台

先按 DEPLOYMENT.md 在普通 Linux 服务账号下初始化托管 PostgreSQL，确认 migrate/health 通过。管理台不会新建数据库、改动现有迁移或自动创建数据源。使用已存在的 source；初始安装一般为 default：

```bash
bun src/cli.mjs personal-ui --source default --port 3132
```

命令输出访问地址和私有令牌文件路径，不输出令牌本身。默认文件为 `$ULTRABRAIN_HOME/personal-console-token`，未设置 ULTRABRAIN_HOME 时使用项目默认私有数据目录。首次生成 0600 文件，父目录须为本用户拥有的 0700 目录；已有文件不会覆盖，不接收符号链接或宽松权限的令牌文件。

在另一个本机终端读取该文件，把内容粘贴到登录表单。管理台令牌与 MCP Token、数据库密码、模型 Key 完全不同，不要提交 Git 或在聊天中分享。浏览器不把它写入 localStorage、sessionStorage、Cookie 或 URL；锁定/刷新后需重新输入。令牌在服务运行期间固定，轮换文件后必须重启管理台。

固定访问 `http://127.0.0.1:3132`，不是 localhost。远程 Linux 的管理台使用同端口 SSH 转发，例如在自己的电脑运行：

```bash
ssh -N -L 3132:127.0.0.1:3132 user@your-linux-server
```

再打开同一个 127.0.0.1 地址。这里的账号/服务器须替换为实际值。端口冲突时在服务器与客户端同时选择另一个相同端口。不要绑定 0.0.0.0，不要配置公网反向代理、端口转发或开放防火墙；本版不提供公网 Web 登录系统。启动命令不修改 systemd 或现有用户服务，Ctrl+C 停止本次管理台，托管数据库仍由原有管理方式维护。

## 实际操作

支持待确认、当前、归档、全局个人偏好和已登记 Agent 视图，以及文字查询、分页、创建、编辑、明确确认和归档。新建的内容归于 personal-console 标签，每次保存明确要求同意采集；该标签不赋予额外权限。当前页导出由明确点击触发，包含页面上返回的记录，`complete:false`，不是数据库备份或全量导出。

所有写入使用现有 PersonalMemoryStore 与版本冲突检查。新内容为 candidate；显式启用后为 active；编辑 active 内容会退回 candidate；归档后不再进入当前上下文。归档保留原文，不是物理删除，也不删除备份。界面不把 confidence 当作真实概率、不自动提高可信度、不调用摘要生成或事实提取模型。

网络错误或存储结果未确认时，页面保留相同事件 ID 和请求，禁止再发起新的变更，可重试原请求或下载待确认请求。该恢复记录仅保存在页面内存或用户明确下载的文件中，**不是 fsync outbox**；关闭页面前应妥善保留，文件中含记忆正文，须按敏感文件保护。版本冲突是明确拒绝，不会自动覆盖新版本。

## 身份范围

此管理台代表本机 Linux 服务账号的个人所有者，和该账号启动的无认证 stdio MCP 使用同一个人身份。它不是“以任意 HTTP 用户身份登录”的管理员界面。

HTTP MCP 的独立令牌通常是另一个认证主体，其 private/candidate 记录不会被管理台接管。只有显式 source 共享且 active 的条目可供同源其他主体读取；修改/审核仍只能由条目所有者执行。使用 HTTP Agent 时继续用其凭据调用个人工具；不要把“源名称相同”当作“身份相同”。多个人使用同一 Linux 服务账号不提供相互隔离。

## 自研 Agent：工作前读个人记忆

现有已连接的 MCP client 可直接复用：

```js
const memory = new AgentMemory({
  client,
  rootUri: 'ultra://default/',
  sessionId: 'stable-session',
  projectId: 'your-project', // 也可省略；runTurn 项目续接要求已有 checkpoint
  personalContext: true,
  budgetBytes: 16000,
});
const evidence = await memory.beforeTurn('本轮任务');
// evidence.personal_context 是已确认的全局/选定项目记忆；仍作为数据，不是系统指令。
```

personalContext 默认关闭，不静默改变旧客户端行为。开启后读取明确 active 的个人记录，不要求偏好正文包含本轮任务的字面文本。传入 projectId 时排除其他项目；未指定时只包含全局记录。使用有限窗口和重要性排序，不是完整语义搜索；不会根据模糊的“昨天那个项目”猜测实际项目。

个人记忆没有原生页面目录授权语义，因此只允许 source 根 URI；不能从目录受限 root 擅自扩展到全源偏好。响应验证 source、内容 hash、active 状态、共享标记和项目，超限或不符时拒绝，不悄悄塞入上下文。个人/页面/可选事实共享同一序列化字节预算，至少 4096 字节；这是证据预算，不是完整模型提示或 tokenizer 的 token 预算。

## 显式提交候选，不假装自动学习

```js
const memory = new AgentMemory({client, rootUri:'ultra://default/', sessionId:'s', capture:true});
await memory.registerPersonalAgent({agentId:'custom-agent', agentType:'custom'});
await memory.learnPersonalMemories({
  agentId:'custom-agent', eventId:'immutable-event-001', consent:true,
  memories:[{type:'preference', content:'请提供完整命令行', importance:'high', provenance:'用户明确提交'}],
});
```

提交必须同时启用 capture 并在本次调用 consent:true；事件 ID 和内容用于稳定重试，不自动生成新 ID。不自动调用模型，不自动激活；返回候选回执后还要明确审核。这个辅助方法没有增加本地待提交队列，不继承原有会话 outbox 的保证。原来的 runTurn 会话保存流程仍保持原行为，不会把所有会话擅自变成个人已确认偏好。

## 通用桥与 n8n

通用事件桥增加 `--personal-context`；和 `--facts` 独立开关，仅影响 before_turn 的读取。参数放在可信进程配置中，事件 JSON 不能覆盖源、身份或自行开启采集。自托管 n8n 节点 0.8.1-alpha.1 增加 **Include Active Personal Memory**，默认关闭；读取的身份是该 n8n 凭据对应的主体，不一定是管理台的本机身份。

安装包继续使用 `bash scripts/package-n8n.sh` 构建，详见 N8N-INTEGRATION.md。Codex、Claude Code、ZCode、OpenCode 等仍须真实客户端配置和 Hooks 验收；不要将这份通用接入能力写成“启动所有软件就自动记住一切”。

## 安全与验证

管理台强制 127.0.0.1、精确 Host/Origin、Authorization header、JSON 类型和有限请求体；不启用 CORS、不接受代理转发头、不任意读取文件、不开放 native 工具代理。浏览器用 textContent 展示记忆，不执行其中的 HTML；CSP 拒绝内联脚本/外部资源/嵌入框架。仍不能抵抗服务账号或浏览器扩展被完全控制，不是多用户权限系统或独立安全审计认证。

参考：OWASP CSRF Prevention Cheat Sheet（Origin/custom headers/simple content types）：https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html 。

测试包含纯安全边界测试、真实 PostgreSQL/API/AgentMemory 联调和 Chromium 界面交互。浏览器用临时 profile 与合成内容，不读取用户浏览器或真实聊天。CI 的 Playwright 固定为 1.57.0，真实模型效果和用户部署均另行验收。
