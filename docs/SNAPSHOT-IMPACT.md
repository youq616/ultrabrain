# 离线快照依赖影响分析

`impact` 是个人客户端离线工具箱的新操作：给定一份快照和一条记忆 ID，
定位在这份文件中声明依赖它的记录，包括直接依赖和多层间接依赖。
例如 A → B → C 表示 B 引用 A、C 引用 B；选中 A 会返回 B（距离 1）
和 C（距离 2）。这是供人工检查的潜在依赖清单，不是自动失效或删除计划。

本操作已接入 `packages/ultrabrain-client/src/snapshot-cli.mjs`、
`inspectClientSnapshots` 路径 API 和 `inspectClientSnapshotBytes` 字节 API。
现有构建脚本会将它打入 `dist/snapshot-cli.cjs` 和 `dist/snapshot.cjs`。
需要重新构建；旧包即使版本字符串相同，也不因此具备 impact。
具体提交的构建、平台测试及独立代理验收状态须查对应证据，不由本文预判。

## 请求

```json
{
  "operation": "impact",
  "consent": true,
  "memory_id": "11111111-1111-4111-8111-111111111111",
  "files": [{"path": "/private/snapshots/selected.json"}]
}
```

CLI 从 stdin 接收一次请求。以上路径和 ID 必须替换为实际选择。
路径 API 接收相同对象；字节 API 将 files 移至第二个实参：

```javascript
const report = await inspectClientSnapshotBytes(
  {operation: 'impact', consent: true, memory_id: selectedMemoryId},
  [{data: selectedBytes, expected_sha256: previouslyRecordedHash}],
  {authorize: () => currentlyPermitted, signal: controller.signal},
);
```

运行时版本、安装路径和 PowerShell UTF-8 管道方法见 CLIENT-SNAPSHOTS.md。
本操作要求完整小写 UUID，且根记录必须存在于该文件。不存在时返回
`snapshot_record_missing`，不会把“根不存在”伪装成“没有依赖，可以安全修改”。
不接受第二份文件、来源 URL、`include_text`（即使为 false）、查询、项目覆盖、
自定义方向或 max_depth。没有静默截断，也没有跨文件或在线回退查询。

请求、文件选择、原始字节和授权沿用既有复制/冻结机制。即使只选一个根，
也必须先验证完整快照：不相关记录摘要错误、重复 ID、部分导出或超限均导致
整个操作失败。可选预期文件摘要绑定包括 BOM 和格式空白的原始字节，不是签名。

## 结果

外层仍为 `ultrabrain-client-snapshot-v1`，operation 为 impact。
`result.format` 是 `ultrabrain-snapshot-impact-v1`。

| 字段 | 含义 |
|---|---|
| root / root_audit_state | 被选根的受限元数据，以及既有直接来源审计状态。 |
| counts | direct、indirect、total；不把根自身计算为依赖项。 |
| entries | 按 distance 升序、ID 升序排列的已知依赖，每条最多返回一次。 |
| entries[].parent_id / distance | 此记录声明引用的上一级 ID，以及从根到它的依赖边数。 |
| entries[].direct_source_state / comparison | 直接来源的既有审计状态，以及版本、摘要、引文位置的独立比较维度。 |
| entries[].same_project | 该记录与它的直接来源的项目值是否相同。 |
| entries[].path_crosses_projects | 从根到此记录的路径上，是否至少有一条边的项目值不同。 |
| entries[].path_has_reference_findings | 该路径上，是否至少有一条直接引用的状态不是 matched。 |
| status_counts / reference_state_counts | 依赖项按生命周期、直接来源审计状态的统计，不包含根。 |
| max_distance | 本次已知依赖的最大距离；没有依赖时为 0。 |
| cross_project_paths / paths_with_reference_findings | 对应路径标记为 true 的依赖记录数量，不是项目或问题的去重数量。 |
| root_in_cycle | 在本文件已知有效引用边中，是否存在包含所选根的循环。 |
| coverage | 整份文件的扫描量、有效引用数、非法引用数、不支持来源数和缺失来源数。 |

每条依赖的 memory 仅包含 ID、type、origin_kind、status、revision、project_id、
content_hash、derivation_current；不返回正文、引文、provenance 或原始 derivation。
comparison 复用来源一致性审计，不另造近似匹配规则。元数据仍属于私密数据。

## 重要语义

**过时的引用仍然是待检查的依赖。** changed、archived、quote_mismatch、
inconsistent 不会阻断边遍历。否则原始记忆刚被修改时，最需要排查的派生记忆
反而会消失。即使 C 对 B 的直接引用 matched，只要根 A 到 B 的引用有异常，
C 的 path_has_reference_findings 也为 true。这不证明 C 的内容错误。

路径标记只累计从根到条目的遍历边，不把根本身对其他来源的引用自动算入。
根自身的直接引用另见 root_audit_state。跨项目标记会沿路径累计，即使末端
记录又回到根的项目也不会被清除；它只描述文件声明，不授予在线工作区权限。

非法引用（包括自引用）不推测其 input_id，不建立边，也不回显未校验字段。
文档片段的文档来源合同不在本逻辑快照中，列为 unsupported_origins。
结构合法但来源不在文件中的引用列为 missing_sources，不代表数据库已删除。
以上任何一种情况都会使 coverage.unknown_dependencies_present 为 true。
valid_references 包括结构合法但来源缺失的引用，因此这些统计不是互斥分组。

`traversal_complete:true` 只说明**当前文件中可构建的支持引用边已遍历完**，
不是所有真实影响已知。`all_impacts_known:false`、`graph_verified:false`、
`identity_verified:false`、`truth_verified:false` 始终保留；即使没有覆盖缺口，
本文件仍可能排除了其他主体、原始文档、外部来源或文件之外的依赖。

循环处理采用带已访问集合的迭代遍历，不依赖递归栈。根不会再次输出，
包含根的二元或长循环会标记 root_in_cycle。`cycle_scope` 为
`selected-root-known-edges-only`；false 不证明整个快照无环，更不证明未知
引用中没有循环。不相关的循环不属于此次根的影响结果。

成功退出 0 表示完整报告已生成，报告可以包含循环、异常与覆盖缺口。
它不表示“可安全删除”。文件校验、参数、授权或取消失败返回受限错误与
非零退出，不返回半份图。应用不会自动执行修改、失效、修复、导入或恢复。

## 资源与安全边界

沿用 16 KiB 控制请求、16 MiB 原始文件、8 MiB 紧凑快照、最多 1,000 条记录。
建图和遍历均有界；每个阶段按 32 条记录或边让出事件循环并复核同步授权。
大扇出与深链都会让出执行机会，不允许通过单个大节点跳过取消检查。

完整文件校验与直接引用审计保持现有成本；新增建图和遍历为 O(V+E)，
最终确定性排序为 O(V log V)，附加元数据空间为 O(V+E)。每个受支持记录
最多声明一条来源边，E 不超过 1,000。没有缓存、目录扫描、网络、SDK、
模型调用或文件写入。内核 I/O、访问时间、stdout 重定向与已交付数据无法追回
等既有边界仍适用，见 CLIENT-SNAPSHOTS.md。

## 测试与门禁

`test/client-snapshot-impact.test.mjs` 覆盖图语义、状态传播、严格输入、
1,000 条深链/扇出/循环及确定性图与独立固定点可达性算法对照。
`test/client-snapshot-impact-boundaries.test.mjs` 覆盖真实校验句柄、每个公开
授权检查点、事件循环撤回、真实文件与原始字节摘要。
`test/client-snapshot-impact-cli.test.mjs` 在禁止描述符写入、网络与子进程
的守卫下运行真实 Node 源码 CLI 和两种公开包装接口。

Linux/Windows 的原有合同矩阵追加上述测试，不减少旧测试、权限或超时限制。
`client-snapshot-offline-package.mjs` 对实际编译包的三个入口追加 impact；
`client-snapshot-audit-integration.mjs` 对真实 PostgreSQL/consolidator 导出的
六条记录追加根和叶子的影响测试，保持三次明确合成生成、零外部模型。
深链和循环由合成快照测试，以及 trace 的真实数据库导出夹具追加验证；
后者显式注入关系元数据，不冒充当前服务端实际生成的模型/作业关系。
真实数据库只读阶段仍核对六表指纹及输入文件字节/mtime。

实现者自审、源码测试、实际打包、真实数据库、Windows 和独立代理审核是
不同证据层级。只有绑定最终提交的真实结果才能用于相应验收，旧提交的成功
和批准不覆盖新代码；缺少独立代理执行时继续保持开发分支与 review PENDING。
