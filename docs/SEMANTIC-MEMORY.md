# 有原文依据的分层摘要与检索（0.5.0-alpha.1）

## 本版解决的问题

L0/L1 不再只有“截取正文开头”这一种实现。显式生成时，系统分块读取完整的、当前用户有权读取的规范化页面；逐块提取陈述和原文引用，再汇总成 L0 摘要与 L1 概览。原文 L2 不被修改，摘要只存在同一 PostgreSQL 内的可重建缓存中。

这是一条实际可调用的模型处理流程，不是固定模板冒充语义摘要。但本次自动验收使用受控模型返回值，没有用真实服务商模型评估摘要质量。引用确实存在于原文，不代表模型对引用的解释必然正确，也不证明每个事实都被保留。

## 明确配置和调用，不在读取时偷偷调用模型

原生提供商配置、密钥和网关继续复用 GBrain。管理员使用已在配置文件中明确设定的 chat_model：

```bash
bun src/cli.mjs summary-config --from-chat-model --revision profile-1
# 或明确指定已经配置好的 provider:model：
# bun src/cli.mjs summary-config --model provider:model --revision profile-1
# 关闭生成与缓存使用：
bun src/cli.mjs summary-config --disable
```

以上操作不调用模型。配置变更前停止其他配置写入者；脚本保留 0600 私有备份，不输出密钥。调整模型提供商配置后重启 MCP 服务。没有现成 chat_model 时会拒绝自动猜测，不会选择一个付费模型或自动申请密钥。

模型配置字段是实际原生 config.json 中的 ultrabrain_semantics：enabled、model、revision、chunk_bytes、max_chunks、ttl_seconds、timeout_ms。默认关闭，启用后默认每块 8192 字节、最多 8 块、TTL 一天、整个生成流程 120 秒。管理员最高可设置 16 块；绝对输入上限 128 KiB。超过预算先拒绝，绝不截掉文末后谎称全文摘要。

每个块最多一次逻辑提取调用，再一次归纳调用；SDK 自身的 HTTP 重试可能增加实际请求数。输出最多每块 4 条陈述、6 段概览；这些是资源边界，不是信息完备保证。摘要生成可能产生模型费用，并将授权后的原文发送到管理员配置的提供商。

MCP 生成示例：

```json
{"name":"ultra_summarize","arguments":{"uri":"ultra://development/project/design","allow_model_call":true}}
```

只有完整 source 写授权的调用者可以生成/清理派生缓存；另需 allow_model_call:true。缓存已存在时只返回缓存，不需要重复模型调用。普通 ultra_read / ultra_retrieve 永不触发**摘要生成**，但原有混合检索仍可能使用其已配置的 embedding 等模型。

## 权限和原文版本

每次先调用原生 get_page，通过当前 source、可见性和隐私段落规则取得规范化内容。缓存按主体、local/remote 读取模式、原文视图 hash 和模型配置 hash 隔离，不把主机摘要直接复用给远程读者。目录绑定、delegated 或授权退化时不使用该缓存，新摘要管理工具也拒绝这些授权。

生成后重新读取原文；期间内容变化则不发布。公开页面发生正文、标题、前言、slug、source 或删除状态更新时，数据库触发器删除相关摘要，包括在建记录。读取仍重新检查内容 hash，覆盖标签等影响规范化原文但不在触发器列中的变化。过期缓存不被读取；新的生成事务会清理本 source 内过期、非在建的派生记录。

每次同页同主体生成只允许一个活动租约，生成期间不持有数据库行锁。忘记或原文更新后，旧生成者不能覆盖新状态。读操作没有跨越后续并发修改的永久快照保证；已接受的模型请求也不保证在权限撤销瞬间终止。

模型别名或服务端路由可能变化，修改这些配置必须提升 revision 并重启。缓存记录实际返回的模型标识（提供商有返回时）、逻辑调用数和可用 token 使用量，但不保留提供商异常、凭据或任意原始 metadata。

## 引用校验与原文展开

每条引用必须是输入块中的精确子串；汇总段落只能引用已经验证的证据 ID。程序记录规范化原文 SHA-256、UTF-16 偏移、行号。它不是原始 PDF 页码、文件字节偏移或多模态定位器。

```json
{"name":"ultra_excerpt","arguments":{"uri":"ultra://development/project/design","content_sha256":"完整的64位SHA256","start":100,"end":200}}
```

ultra_excerpt 重新检查权限和原文 hash，过期引用返回 stale_source，不拿新原文冒充旧引用。单次最多返回 16 KiB，不允许偏移切开 Unicode 代理对。摘要引用、查询片段都能使用这一入口。

ultra_read 和 ultra_retrieve 的 summary 参数可设 prefer（默认）、require、off。prefer 只用当前缓存，否则明确降级；require 遇到缺失缓存返回 summary_unavailable；L2 始终为原文。ultra_summary_status 不调用模型，ultra_summary_forget 只清除当前读者的派生缓存，不删除原文、其他读者的缓存或历史备份。

## 文末检索与目录补查

没有适用摘要时，L0/L1 检索优先从授权原文中选取与查询匹配的片段，而不是固定只读开头。已有摘要没有词法匹配但原文有匹配时，prefer 模式也可以转为原文片段。中文查询包含有限的双字词片段，属于确定性词法方法，不是中文语义理解的质量证明。

可选 scope_scan_limit（0..500）在目标目录查询时补查已授权 source 的页面列表；在读正文之前先筛选目录，scan_read_limit 默认 50、最高 100 次补充正文读取。types 在原生搜索阶段传入类型过滤。

```json
{"name":"ultra_retrieve","arguments":{"uri":"ultra://development/project","query":"本机数据库","scope_scan_limit":200,"scan_read_limit":50,"summary":"prefer","budget_bytes":16000}}
```

这可以发现未进入首批全局候选、但位于目标目录且含查询文本的页面。它不是无限遍历，也不是把所有原生向量查询改成 SQL 层前缀过滤。扫描窗口和正文读取上限都在响应中报告；空结果只表示本次范围内未找到证据，不能认定资料不存在。目录排序是 live pagination，并发修改可能改变窗口。

证据数组预算继续使用真实 UTF-8 JSON 字节数，包含引用和元数据。不是模型 token 数；预算过小无法容纳引用时可能丢弃整条证据，结果明确报告 dropped。检索 trace 只包含实际返回的证据。

## 程序接入

AgentMemory 可在构造时设置 summary 和 scopeScanLimit，并提供 summarizeResource(uri,{allowModelCall:true}) 与 sourceExcerpt(citation)。已有 beforeTurn / runTurn 流程兼容，采集和摘要生成的授权不混为一谈。

新增通用 JSON stdin/stdout MCP 客户端，便于其他语言或自动化程序调用已经部署的服务：

```bash
printf '%s' '{"uri":"ultra://development/project/design","level":"L1"}' | \
  bun scripts/mcp-call.mjs --url https://memory.example.com/mcp \
  --token-file /home/agent/.config/ultrabrain/token --tool ultra_read
```

令牌文件由服务账号持有、权限 0600；使用 HTTPS 或 loopback HTTP，凭据不跨 origin 且不跟随重定向。输入最大 512 KiB。stdout 按设计包含请求的记忆结果，调用方必须保护日志与输出；stderr 不打印原始错误或令牌。该客户端在真实 HTTP MCP 上验收，不等于已经提供并验收每个 Agent 框架或 n8n 的安装插件。

## 本版之外

尚无多文档目录递归摘要树、具体模型的总 token 预算、完整多模态定位、事实时态治理 UI、每个 Agent 的专用安装器或全量无损迁移。原文引用校验与提示中的 untrusted 标记不构成完整的记忆投毒防护证明。
