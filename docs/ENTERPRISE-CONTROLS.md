# 0.9.0-alpha.1：受治理服务、配额与审计

本版本是企业化基础增量，不是已经通过大型公司生产验收的最终版本。默认仍为 compatibility，避免破坏已有原生工具调用。企业部署必须对**所有对外 MCP 服务进程**启用 governed，关闭或隔离共享同一数据库的 compatibility 入口；只保护其中一个进程不能代表整个数据库都受此配置保护。

## 两项独立变化

所有模式下，Ultrabrain 自有 `ultra_*` 响应不再被附加原生 `_meta.brain_hot_memory`。已有事实召回和页面证据已经执行来源、目录和预算检查；再附带原生全源 hot facts 会形成未经过这些检查的第二条证据通道。修复在 native 模块加载前安装，经完整 SHA-256 核对的内存适配，不写入 vendor 工作树、不改动上游锁。上游相关源码字节改变后拒绝启动，必须重新审查该适配。

显式 governed 模式另外限制服务端公开工具表为 `compat/governed-tools-v1.json` 的 26 个操作。原生 recall/get_page/query/context_pack/delta/request_tools 不公开，猜工具名也不能调用；新增上游或自有工具不自动加入白名单。Ultrabrain 内部仍委托原生受控操作并保留原始认证上下文，不创建第二套存储。

## 主机配置

在已按 DEPLOYMENT.md 完成安装、源创建、凭据配置后，使用原服务账号执行；不要在根本没有备份的生产实例上直接试验：

```bash
# 首次登记，默认只读；SOURCE 换成已存在的数据源。
bun src/cli.mjs enterprise configure --source SOURCE --expected-revision 0
bun src/cli.mjs enterprise status --source SOURCE

# 根据 status 返回的 revision 调整，不盲用下面的示例 1。
bun src/cli.mjs enterprise configure --source SOURCE --expected-revision 1 \
  --mode read-write --requests-per-minute 300 --actor-requests-per-minute 120 \
  --max-inflight 8 --actor-max-inflight 4 --allow-history false

# 接入前核对所有公开入口；本命令不自动开启 TLS 或配置反向代理。
bun src/cli.mjs mcp --profile governed --http --port 3131 --suppress-bootstrap-token
```

governed 只支持具有明确完整单源 grant 的认证 HTTP，不接收无认证 stdio、目录限定、退化授权或 delegated/federated grant。未登记数据源拒绝业务调用。主机配置支持 CAS；配置默认是完整替换而非字段补丁，未指定字段回到安全默认值。修改 source policy 影响下一次准入，**不会取消已经获准的在途操作**。

`mode` 为 read-only/read-write/disabled。默认不允许 history 选择，也不允许项目/资源修订历史工具；精确内容检查和普通状态工具仍依原本权限工作。这里并非完整的“所有历史元数据保密模式”，例如当前状态检查可能说明页面已被撤回。主机管理员维护入口不受该远程数据面角色限制。

启动时只允许 loopback HTTP，关闭本进程的原生自动 sweep，拒绝 `--log-full-params` 与不安全动态注册。对外必须由 TLS 反向代理暴露已审查的 MCP/OAuth 路径；不要把原生 `/admin`、管理 API、文件路径和其他 HTTP 路由全部公开。此模式不是一次完整原生 HTTP 管理面的安全审计。

原有 systemd 生成器新增显式选项：

```bash
python3 scripts/install-service.py --profile governed --output /tmp/ultrabrain-units
```

这只生成文件，不启动或替换当前服务。保留原 `--replace`/`--enable` 的人工配置边界。必须先升级数据库迁移，再部署服务；不提供秘密令牌默认值。

## 限流与并发

请求计数在同一个 PostgreSQL 中按 source 和认证 principal 记录，UTC 分钟窗口；短事务持有 source 行锁，在运行真正的 handler/模型前释放。多个 governed 进程共享配额，换连接不会刷新额度，分钟翻转时重置。固定窗口的边界可以出现相邻两分钟的双倍瞬时突发；它不是滑动窗口、带宽限额、用户数容量或模型费用额度。

并发限制则是**单服务进程**的在运行 handler 数，另有每主体上限。满额直接拒绝、不排无限队列；只有 handler 真正结束才释放，不因客户端断开而虚假腾出执行名额。数据库共享限流不等于分布式并发硬限制，多进程的并发容量会相加。跨进程执行调度和资源隔离仍需后续实现。

默认每源 300 请求/分钟、每主体 120；默认进程内每源 8 并发、每主体 4。这些是保守的接入保护默认值，**不是系统最大吞吐声明**。管理员须结合模型预算、连接池和实测容量调整。拒绝请求仍可能消耗认证、数据库和日志资源，不能将业务限流当作 DDoS 防护。

## 审计与中断语义

准入计数与 admission 审计同事务提交；不能记录准入时拒绝执行。handler 成功或异常后追加 result 事件，不修改旧事件。表触发器拒绝普通 UPDATE、DELETE、TRUNCATE。

只记录服务器生成的 request ID、source、认证主体 hash、受控 operation 名、阶段、结果码、策略版本、耗时和时间；不写请求正文、原始身份、令牌、查询、transcript 或模型错误文本。主机政策变更也记录版本事件。数据源名称仍是运维元数据，需要按企业规则命名和保护。

业务写入和最后 result 不是一个全局事务。如果进程在两者之间崩溃，可能只有 admitted 记录；`enterprise status` 将这类记录单独统计，**不认定它们已经成功或失败**。如果业务执行后最后审计失败，返回 enterprise_audit_unconfirmed，业务可能已执行，重试前需要核查；具备稳定 event_id 的写入可用原事件重试，不要重跑模型或重复非幂等操作。

succeeded 只表示 handler 正常返回，不等于模型整理完成、语义准确、备份成功或部署完成。入口鉴权、错误工具名、参数/令牌 scope 在原生 dispatcher 之前被拒绝的请求不属于新增表的覆盖范围；原生 HTTP 请求日志、网络边界和身份提供商日志需要另外汇集。没有将这张表宣称完整安全事件日志。

```bash
bun src/cli.mjs enterprise status --source SOURCE
bun src/cli.mjs enterprise audit --source SOURCE --after 0 --limit 100
```

audit 是主机只读分页查询，没有远程审计管理工具。ID 分页是 live view，不是完整冻结快照或可靠 CDC：并发事务的提交顺序可与 ID 分配顺序不同，长期连续采集需回看去重或使用独立快照/CDC。数据库备份包含 audit，但不是审计专用不可变归档。

**触发器不防数据库 owner、超级用户或主机管理员篡改。**当前应用角色仍是原生引擎需要的 BYPASSRLS；既非逐用户 PostgreSQL RLS，也非 WORM 证明。外部不可变归档、独立审计写入角色、保留期/分区轮换及审计磁盘容量告警尚未完成，生产上线前必须补齐。不会通过悄悄删除审计记录解决磁盘增长。

## 可复现的读压测

```bash
bun scripts/benchmark-mcp.mjs --url https://memory.example.com/mcp \
  --token-file /实际私有目录/token --uri ultra://SOURCE/已有测试页 \
  --requests 100 --concurrency 2 --allow-load
```

仅在获准的隔离测试源执行。脚本使用固定凭据与真实身份检查，工具操作只读取 current L2 页面，不调用摘要生成或向量搜索；仍消耗准入额度并产生审计。输出成功/失败计数、错误类别、成功延迟 p50/p95/p99 与吞吐，不包含地址、令牌或页面正文。任何失败或未完成请求都会使命令非零退出。

这是同一页面 4 KiB 上限的热路径测量，**不等于**大语料混合检索、冷缓存、长会话、多租户总容量、模型效果或可用性认证。企业容量验收需见 ENTERPRISE-READINESS.md。

## 上游升级

0009 是新增迁移，0001..0008 保持不变，四个上游 pins 不变。功能路由表新增 native metadata/dispatch/HTTP grant 变化的人工复核点。升级后先在原数据库副本核对治理侧通道、8 条旧应用路径、权限、两进程配额和备份恢复，再升级真实服务。原生 metadata 源哈希改变不是允许“直接改一下哈希即可上线”的指令。
