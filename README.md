# ultrabrain

Linux-first agent memory, built around GBrain's PostgreSQL-native business engine and OpenViking-inspired hierarchical context retrieval.

## 架构与状态

以锁定的 GBrain 业务引擎为基础，保留页面、事实、版本、纠正、检索、图谱、技能与任务，新增 Ultrabrain 产品层，不复制第二套记忆数据库。OpenViking 是按功能逐项吸收的参考上游，**尚未完成双方全部功能等价**。

PostgreSQL 随项目在本机安装和管理，不要求外部数据库，不是 SQLite 或 PGLite。外部通过受认证的 MCP 访问，不开放数据库超级用户或新增任意 SQL/远程命令执行接口。不依赖 Docker Hub。

上游完整 SHA 锁定，更新检查、候选验证与生产升级分离。不自动合并上游变更，不修改独立 Windows 项目 youq616/qbrain。

## 历史增量：0.4.0-alpha.1

新增可选的代码版本绑定任务、只读执行回执查询、会话原始持久化与模型整理分离，以及使用当前 MCP 身份的独立整理客户端。旧回执不会自动成为代码认证，旧同步采集行为不默认改变。

参阅 [部署](docs/DEPLOYMENT.md)、[可靠性接入](docs/RELIABILITY.md)、[版本证据](docs/REVISION-EVIDENCE.md)、[延后整理](docs/DEFERRED-SESSIONS.md) 与 [本版验收](docs/VALIDATION-0.4.md)。本版上游锁定版本未改变，语义摘要、多模态完整移植和用户服务器部署没有因此被宣布完成。

0.3.0 的持久化 outbox、项目 CAS/历史/续接与 0.3.1 的接口合同、迁移账本、旧数据升级演练和候选 PR 流程继续保留，详见 [升级工程](docs/UPGRADE-ENGINEERING.md)、[功能覆盖](docs/FEATURES.md) 与 [产品计划](docs/ROADMAP.md)。

## 上游与许可证

- GBrain: https://github.com/youq616/gbrain — upstream https://github.com/garrytan/gbrain
- OpenViking: https://github.com/youq616/OpenViking — upstream https://github.com/volcengine/OpenViking
- PostgreSQL: https://github.com/postgres/postgres
- pgvector: https://github.com/pgvector/pgvector

各上游保留自身许可证及署名。锁定的 OpenViking 主项目为 AGPLv3、GBrain 为 MIT、PostgreSQL/pgvector 使用各自 PostgreSQL License 文件。引入具体代码或分发时需保留完整来源并审查相应许可证，参考源码指针不代表已完成代码移植。

## 历史增量：0.5.0-alpha.1

新增需明确模型授权的全文分层摘要、精确原文引用、按主体/视图/模型配置隔离的缓存及原文修改/删除失效。普通读取不触发摘要生成；无缓存时提供查询相关原文片段，可选择目录前置补查。新增出处展开工具与通用 JSON/MCP 客户端。

真实模型质量未在本版认证；摘要与检索边界见 [语义记忆](docs/SEMANTIC-MEMORY.md)。本版还修复了历史 native config 路径问题，并保留既有数据库 embedding 身份，升级必读 [配置路径迁移](docs/CONFIG-PATH-MIGRATION.md) 与 [验收范围](docs/VALIDATION-0.5.md)。

## 历史增量：0.6.0-alpha.1

新增资源级审核、撤回、显式替代、有效期和原文变化后重审；默认当前检索排除过期/被替代资源，并按授权和 hash 跟随有界替代关系。新增服务端身份绑定的 JSON 生命周期事件桥，保留单机托管 PostgreSQL 默认与原生事实引擎。

参阅 [资源记忆治理](docs/MEMORY-GOVERNANCE.md)、[生命周期接入桥](docs/LIFECYCLE-BRIDGE.md) 与 [本版验收](docs/VALIDATION-0.6.md)。资源策略不会替代原生事实撤回；直接原生接口保留旧语义。真实客户端自动 Hooks、完整多模态与语义质量认证尚未完成，版本仍为 alpha。

## 历史增量：0.6.1-alpha.1

引用来源变化/撤回后可沿依赖链自动转为待重审，当前读取还检查引用链有效期；旧 source_quote 审核通过追加迁移保守重新审核。新增本地主机的 pgvector SQL 版本计划、维护升级与中断恢复，升级前生成新备份，不强制终止客户端。

详见 [引用治理](docs/MEMORY-GOVERNANCE.md)、[pgvector SQL 升级](docs/VECTOR-UPGRADES.md) 和 [验收范围](docs/VALIDATION-0.6.1.md)。本版没有改变上游锁定提交，不宣称语义质量认证或 PostgreSQL 跨主版本自动迁移。

## 历史增量：0.7.0-alpha.1

新增原生事实来源版本关联、受治理的事实召回及 Agent 页面/事实组合证据。旧原生事实保留，不猜测来源；current 事实需要可用关联，history 显式选择。会话提取可对可核验的返回 ID 建立关联，不覆盖旧关联，不将模型结果当作真值。

详见 [受治理事实](docs/GOVERNED-FACTS.md) 与 [本版验收](docs/VALIDATION-0.7.md)。原生直接 recall/context_pack 等保持兼容行为；完整事实迁移与语义质量仍需独立验收。

## 历史增量：0.8.0-alpha.1

提供可构建安装的自托管 n8n 私有节点，复用 AgentMemory 与官方 MCP SDK，支持上下文读取、显式采集、状态查询和项目续接。固定连接身份、双层采集许可、稳定事件重试及逐项错误边界见 [n8n 接入](docs/N8N-INTEGRATION.md)；测试范围见 [0.8 验收](docs/VALIDATION-0.8.md)。包未发布到 npm/Cloud，不自动修改用户工作流或部署服务。原有事实/资源存储和上游锁保持不变。

## 历史增量：0.9.0-alpha.1

修复自有 MCP 工具响应上的原生 hot-facts 旁路；增加可选 governed 服务模式、固定工具白名单、源级读写/停用控制、数据库共享的每源/主体请求额度、单进程并发限制及追加型审计。兼容模式仍保留，企业场景必须明确启用并隔离所有其他入口。

使用 [企业服务控制](docs/ENTERPRISE-CONTROLS.md)、[企业生产准入清单](docs/ENTERPRISE-READINESS.md) 和 [本版验收范围](docs/VALIDATION-0.9.md)。**当前仍为 alpha，不是已经具备大型公司生产资质的最终完成版。**高可用、容量、组织权限、不可变审计外送、完整恢复与真实语义质量还需独立证据。

## 历史增量：Personal Core 0.10.0-alpha.1

优先个人版本。修复开发分支迁移/Store 字段冲突，接通 8 个个人 MCP 工具、认证主体归属、显式共享、候选审核、事件幂等和版本冲突控制。旧无归属数据保留但不擅自绑定。企业扩展暂停，已有模式保持兼容。

实际调用与迁移边界见 [个人核心](docs/PERSONAL-CORE.md)，测试范围见 [0.10 验收](docs/VALIDATION-0.10.md)，协作规则见 [AGENTS.md](AGENTS.md)。这不是所有客户端自动记忆或完整个人 V1 的完成声明。

## 历史增量：0.10.1-alpha.1

新增令牌保护的本机个人管理台（候选、确认、编辑、归档、查询和当前页导出），并将已确认的个人上下文接入 AgentMemory、通用事件桥与 n8n 0.8.1 开关。迁移和上游锁不变。详见 [个人管理台](docs/PERSONAL-CONSOLE.md)、[实际验收范围](docs/VALIDATION-0.10.1.md) 和 [个人 V1 完成检查表](docs/PERSONAL-V1-CHECKLIST.md)。个人 V1 尚未全部完成；没有宣布所有客户端已自动记忆。

## 历史增量：0.11.0-alpha.1

新增获准原文的个人整理任务：复用原个人记忆表，显式模型开关，周期 Worker，精确引用的私有候选，原文变更失效、租约与原子结果提交。管理台可入队、查询和逐条处理；旧记录不自动发送模型。见 [个人自动整理](docs/PERSONAL-CONSOLIDATION.md) 和 [验收范围](docs/VALIDATION-0.11.md)。客户端自动 Hooks、完整多模态与个人 V1 仍未全部完成。

## 历史增量：0.12.0-alpha.1

新增客户端专用 Node 安装包、六工具只读/显式十二工具读写的个人 MCP 转发器、真实连接预检、Codex/Claude Code/OpenCode/ZCode 配置计划/合并/回滚，以及 Claude Code 工作前只读 Hook。Windows 可通过已有 SSH 连接 Linux 服务，不需要先安装 WSL 或本地数据库。具体客户端实际模型验收和全部自动采集仍未完成。

使用 [客户端安装与边界](docs/CLIENT-KIT.md)，查看 [分阶段独立复核与修复报告](docs/reviews/PERSONAL-0.12-REVIEW.md)。本轮还修复内部 HTTP 身份回退、不完整 Unicode 输入和只读凭据预检；既有迁移、上游 pins 与企业白名单不变。整体个人 V1 仍以完成检查表为准，不以连接配置代替最终验收。

## 当前增量：0.13.0-alpha.1

增加 OpenCode 原生工作前/压缩前只读 Hook、Hermes 主 CLI 外部 MemoryProvider 和 OpenClaw 精确 Agent/session/workspace 限定的附加插件；复用现有客户端与 PostgreSQL，不自动上传聊天或替换原生 memory slot。安装与测试层次见 [原生 Agent 接入](docs/NATIVE-AGENT-ADAPTERS.md)。Hermes/OpenClaw 全引擎、所有自动采集和完整个人 V1 尚未全部验收。
