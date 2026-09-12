# 0.5.0 原生配置路径修复

锁定的 GBrain configDir() 会在 GBRAIN_HOME 后追加 .gbrain。旧版 Ultrabrain 设置 GBRAIN_HOME=$ULTRABRAIN_HOME/gbrain，却将安装配置写在 $ULTRABRAIN_HOME/gbrain/config.json；原生实际读取的是其下 .gbrain/config.json。数据库连接因为 GBRAIN_DATABASE_URL 环境绑定仍能工作，但放在上一层的模型配置没有按预期被原生加载。

0.5.0 不搬迁 native 数据根目录，而是由 db init 对齐配置：

- 已有实际 native config 时保持其配置，检查其数据库绑定不能指向别处。
- 仅有旧位置配置时保留旧文件，再创建实际路径中的配置。
- 旧数据库已有 embedding_model / embedding_dimensions 元数据时，采用数据库记录的身份，避免把曾被忽略的旧配置突然应用到已有向量。不会在本次修复中重新嵌入或变更数据库向量维数。
- 全新数据库没有旧元数据时使用新安装的明确配置。
- .gbrain 目录保持同一位置并收紧为服务用户独占；文件为 0600。目标是符号链接、由他人拥有、数据库目标冲突或 embedding 元数据不完整时停止，不静默覆盖。

正式升级前先停 MCP 与写入，并做好配置及数据备份；由原服务账号执行 db init、migrate、health。配置修复后，服务启动会验证原生库的 configPath() 与管理器使用的路径一致。

这是安装配置修复，不是自动选择新模型、数据库跨版本迁移或完整回退器。用户通过环境变量明确指定的原生模型覆盖仍按上游规则生效。需要变更实际 embedding 模型或维数时，必须单独使用相应迁移流程，不用改文件冒充数据迁移。
