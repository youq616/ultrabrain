# Personal-ranking 接收端复核与修复

这是实施助手独立于编码过程的自查记录，**不是另一个独立子代理的审核批准**。独立 GitHub Codex 审核与最终 CI 结论应绑定 PR 中完整候选 SHA；未获得这两项证据不得合并。此前本地 reviewer 的有条件批准仅作为历史材料保留，不能覆盖本次发现和修复。

## 原始交接与真实执行

ZIP SHA-256 `c0c4a81d799ab5a8187318ad576904454a39177b99ede447972955e58d979610`，增量 bundle SHA-256 `ae7b98995c372dca17fbe79520d797a04153e29c78eb0ede6d7dd74079fedea5`。基线为 `5f175cb4b4ba7f8d603ee9a61b59c414ab983e0d`。三次提交 `4fda603 → 14e43fa → bcef3ab` 的父子链和 tree 与清单逐一吻合，最终 tree 为 `32aacf399c1592408785ea8d62c6e58850109714`；末次仅审核文档。没有重写原始提交。

接收端先运行原交付版本：Linux Node 单测 476/476、Python 119 项通过，但真实 PostgreSQL 排序测试**第一条 INSERT 就失败**。`[actor]=SELECT actor_key` 取得的是整行对象而非哈希，导致 personal_owner_shape CHECK 拒绝。只修复该点后，第二次真实执行又在时间平局断言失败：测试用 low+1=2 的条目与已存在 high=3 的条目比较，误以为前者应排第一。这不是应通过降低权限或改变排名规则来解决的产品错误。原始两次失败日志保持未覆盖，其摘要哈希见旁边 JSON。

## 接收端修复

- 从查询结果明确解构 actor_key 标量；不放宽数据库所有权约束。
- 时间测试加上实际 query 过滤隔离同分集合；UUID 测试使用共享随机前缀下的明确完整 UUID，逆序插入，并故意让正文顺序、微秒顺序与 UUID 顺序相反，不再用随机生成 UUID 却猜测正文 aa 会先返回。
- 将误写在 SQL 中的 `day(503)` 改成绑定的时间参数，来源指纹同样绑定为 text。
- 只读的另一个主体只能看见一条明确共享记忆，不是五条其他身份私有记录；断言精确核对内容及 owned_by_caller:false。
- 字节预算断言改为完整实际响应严格不超过预算，核对完整 content hash；纯预算测试补齐 type，确保确实因为过大而非错误类型被排除。
- 明确共享 schema 中 offset 的 context=0 限制，纠正 profile 参数拒绝层次和 Unicode 空白兼容表（旧 JavaScript \s 本已覆盖 NBSP/全角空格，NEL/BOM 才是差异）。历史审核记录不抹去。

## 额外自查与真实回归

使用基线 commit 中原始 Store 和原始组装器再次执行：真实 PostgreSQL 中旧 high 偏好被新记录的最近100窗口排除；Date(2024-01-03) 错排在 Date(2024-01-04) 之前。当前代码在相同数据上修正了两个结果。

新 safety 集成加入1005条新 normal 偏好，核对 profile 和 context 都保留旧 high 项；验证512/700/2000/8192字节完整响应、不同 source 与非 ASCII 任务字面匹配。它还使用原生适配器 poolSize:1，比较同一 PostgreSQL backend PID：成功读后设置恢复；另一个事务在隔离数据库持表锁，真实 context SELECT 触发57014，实际 MCP dispatcher 返回安全 personal_storage_error 而非空成功；释放锁后，**同一连接**的 statement_timeout、transaction_read_only 恢复原值，真实写入成功。该测试不得用于生产库。

当前本地执行：478 JS 全过（0失败/0跳过）、119 Python 通过；20项排序集成（包含450条新增语料加边界夹具的20组SQL/JS对照）、10项安全集成；43项个人核心、21项管理台、29项整理、7项模型调用准入、49项认证HTTP回归通过。以上使用普通Linux账号、托管PostgreSQL、合成数据；没有调用付费模型，没有操作用户设备、真实会话或配置。最终GitHub CI和独立代理复审状态只以PR为准，不预写为成功。

没有改动历史数据库迁移、上游锁、企业白名单、采集许可或模型配置。纯排序仍是全授权候选排序后取前100，再裁剪整条证据；不是语义搜索、全量导出或长期模型效果认证。当前测试修复不是“整个Personal V1无问题”的证明。
