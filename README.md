# ultrabrain

Linux-first agent memory, built around GBrain's PostgreSQL-native business engine and OpenViking-inspired hierarchical context retrieval.

## 开发状态

本仓库正在建设。首次交付的目标是可验证的集成版本，**不是宣称已经完成两个上游的全部功能等价**。功能保留、已实现扩展、待移植功能和验收证据将分别记录在 `docs/FEATURES.md` 和 `docs/VALIDATION.md`。

## 架构决定

- 以 GBrain 的业务引擎为基础，保留来源、版本、纠正/撤回、混合检索、知识图谱、技能和后台任务体系，不重新发明第二套记忆数据库。
- 新建 ultrabrain 产品层，吸收 OpenViking 的统一上下文 URI、L0/L1/L2、目录式探索、分层召回和可观测检索。
- PostgreSQL 随项目在本机安装并由项目管理，不要求外部数据库服务；不是 SQLite，也不是把 PGLite 冒充原生 PostgreSQL。数据库不直接暴露公网。
- 对外提供经过授权的 MCP 读写接口，不开放任意 SQL、数据库超级用户或无约束远程命令执行。
- 三个上游按完整提交 SHA 锁定。更新检查与生产升级分离，保留差异审查、兼容性测试、数据库备份与恢复路径；不自动合并任意上游变更。
- 不修改 `youq616/qbrain`：它是独立的 Windows 项目。

## 上游

- GBrain: https://github.com/youq616/gbrain — upstream https://github.com/garrytan/gbrain
- OpenViking: https://github.com/youq616/OpenViking — upstream https://github.com/volcengine/OpenViking
- PostgreSQL: https://github.com/postgres/postgres

上游保留各自许可证与署名。OpenViking 当前主项目使用 AGPLv3，GBrain 使用 MIT，PostgreSQL 使用 PostgreSQL License。合并或分发时必须保留对应许可证与完整来源记录。

## 0.3.0-alpha.1 可靠性增量

新增客户端持久化 outbox、带乐观并发控制的项目检查点、换会话项目续接、主机执行证据与检索回归评测。修复 JSONB 回执双编码及 PostgreSQL 同名 schema 搜索路径问题。

详见 [可靠性接入](docs/RELIABILITY.md)、[完整产品计划](docs/ROADMAP.md) 和 [本版验收方法](docs/VALIDATION-P0.md)。版本仍是 alpha；真实语义摘要、多模态、完整上游兼容与目标服务器部署不因这些增量而被宣布完成。
