# 功能覆盖与完成标准

Ultrabrain 使用锁定的 GBrain 业务引擎与本机托管原生 PostgreSQL。OpenViking 当前为参考来源，不是第二个运行引擎。下列“实现”须结合**该提交的 CI**理解，不能由上一版测试推断新版通过。

| 能力 | 当前状态与边界 |
|---|---|
| 原生 PostgreSQL/pgvector | 锁定源码、本地私有目录、不可变运行目录；跨 PostgreSQL 主版本仍拒绝直接切换。 |
| 原生页面/事实/技能/图谱/任务 | 继承 GBrain。保留入口不等于每个配置组合完成端到端验收。 |
| MCP CRUD、版本及软删除 | 原生 operations 授权后调用；ultra_write 是整页替换而非条件更新。 |
| ultra URI、目录浏览 | 路径规范与边界校验；虚拟目录有扫描窗口，不是完整一致性快照。 |
| L0/L1/L2 | 0.5.0 可显式生成全文有引用的 L0/L1 摘要；按当前 ACL/原文/模型 profile 使用缓存。无缓存明确降级，真实模型质量未认证；L2 仍为原文。 |
| 层级检索与预算 | 原生候选上目录重排、证据预算含 JSON 开销；原生目录筛选仍在候选之后；0.5.0 可选目录前置补查，并返回查询相关原文片段。扫描和证据预算受限，字节非模型 token。 |
| 会话同步模式 | 保存页面后调用原生事实提取；无模型返回 needs_model，不伪造提取完成。 |
| 延后模式（0.4.0） | 显式开启，原始 payload/queued 回执同 PostgreSQL 事务保存，再由当前同主体请求发布页面与提取。journaled 不等于已可检索。 |
| 可靠采集 | 客户端私有文件 outbox、重启补交、事件冲突、隔离损坏记录；至少一次，不是 exactly-once，也不是无限配额。 |
| Agent 生命周期 | 接入回调后先召回再生成、授权后保存；不读取未接入的软件或会话。 |
| 项目工作状态 | source 共享的目标/决策/任务/阻塞/下一步，CAS、历史、事件幂等及项目遗忘标记。 |
| 执行证据 | 主机进程回执；可选 code_revision 要求前后 Git 观测匹配。未认证环境、构建产物、CI、远程部署。 |
| 延后整理客户端（0.4.0） | 普通认证 MCP，默认一批、显式 --loop 才轮询。同主体队列，不自动安装或启动服务。 |
| 传输与权限 | stdio/HTTP 真实联调、source/目录/grant 检查及新请求令牌撤销。应用角色 BYPASSRLS，非逐客户端 PostgreSQL RLS。 |
| schema 迁移与恢复 | 编号/checksum/事务账本，旧版升级演练，备份及独立数据库恢复指纹。备份仍不包含外部附件与模型密钥。 |
| 运行与上游迭代 | health、systemd 单元生成、四上游独立检查、clean-fetch 证明、候选 draft PR、接口合同及功能映射。没有自动生产升级。 |
| OpenViking 无损迁移、多模态 | 尚未完成全量接口/解析器/资源类型和数据迁移验收。 |

代码版本证据详见 REVISION-EVIDENCE.md；队列权限、限额与重试详见 DEFERRED-SESSIONS.md。无 code_revision 的旧任务仍保持旧语义；inline 与 deferred 不静默转换。

## 发布门槛

同一候选提交的单元、运维、真实数据库、stdio/HTTP、队列与项目并发、旧数据迁移、备份恢复及停启检查都须通过。语义质量另需模型和标注语料证据。包含双方全部功能必须逐项映射公共 CLI/API/MCP、数据类型、迁移及验收，当前尚未达到。

0.5.0 新增 ultra_summarize / ultra_summary_status / ultra_summary_forget / ultra_excerpt 与通用 JSON MCP 客户端。详见 SEMANTIC-MEMORY.md；专用 Agent/n8n 安装插件和多文档递归摘要树仍未全量完成。

## 0.6.0 补充

资源政策工具：ultra_memory_inspect / review / supersede / history；canonical hash 与政策 revision 联合检查，审核与更正原子写入元数据。不改写原生正文，也不自动撤回已提取事实。

读取、检索、目录和出处工具支持 current / reviewed / history；原文变化使审核失效。替代关系只在权限、请求范围及内容 hash 均满足时有界跟随。默认 current 仍允许未审核老资源，但明确标注 unreviewed。

ultra_identity 和通用生命周期桥用实际认证返回绑定 outbox；同进程凭据快照避免身份/交付间换主体。不读取未接入应用，不执行事件命令，不默认采集。多平台原生 Hooks 和完整事实时态治理依然在后续范围内。
