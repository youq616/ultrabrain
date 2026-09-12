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

## 当前增量：0.5.0-alpha.1

新增需明确模型授权的全文分层摘要、精确原文引用、按主体/视图/模型配置隔离的缓存及原文修改/删除失效。普通读取不触发摘要生成；无缓存时提供查询相关原文片段，可选择目录前置补查。新增出处展开工具与通用 JSON/MCP 客户端。

真实模型质量未在本版认证；摘要与检索边界见 [语义记忆](docs/SEMANTIC-MEMORY.md)。本版还修复了历史 native config 路径问题，并保留既有数据库 embedding 身份，升级必读 [配置路径迁移](docs/CONFIG-PATH-MIGRATION.md) 与 [验收范围](docs/VALIDATION-0.5.md)。
