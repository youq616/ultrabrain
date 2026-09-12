# 0.6.0-alpha.1 验收范围

验收结果必须对应候选 commit 的实际运行；本文件定义测试范围，不预写 CI success。

新增 memory-policy.test.mjs 与 memory-policy-integration.mjs：核对严格 UTC、当前/审核/历史模式、来源 hash、并发 CAS、事件冲突、审核失效、替代链、目录边界、原生删除恢复及物理 purge 后重新导入。依赖真实 PostgreSQL 和锁定的原生授权 dispatcher，不用一个内存字典冒充数据库。

semantic-integration.mjs：在已声明受控模型输出的基础上，核对策略撤回后的摘要失效、无模型调用及显式重新启用。精确引用与策略状态不是模型语义准确率。

lifecycle-bridge.test.mjs 和 HTTP integration：核对服务端主体/source/instance 身份绑定、事件字段隔离、显式 capture、同事件重放、固定凭据快照、授权失败及真实独立进程的 JSON/stdin 回合。

CI 新增从 0.5.0 提交 225fef02de4c3aa33d655c4b2dfde9f246571329 升级的路径，保留 0.3.0、0.3.1、0.4.0 基线。原有迁移 0001..0004 和四个上游指针保持不变；0005 记录资源策略，0006 记录逻辑实例身份。

备份恢复增加策略、策略历史和实例身份指纹。物理删除原始页但保留策略、审核元数据的行为只在隔离 fixture 中测试；不代表已经实现备份删除传播、全量事实撤回、隐私模型认证或任意历史版本兼容。

测试只使用合成资料、无外部模型密钥；生产 deployment、真实长会话模型效果、原生客户端自动接入和 PostgreSQL 跨主版本升级均是独立验收项。
