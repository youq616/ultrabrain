# 跨快照重复变化审计

本模块比较两份**完整核验后的本地快照**中的重复组。用于人工检查两份文件的重复情况差异，不连接当前记忆服务，不自动删除、合并、归档、生成清理计划或调用模型。文件可能含不同时间、不同主体的数据，程序不猜测哪份较新、不认证它们属于同一人。

## 命令行与 API

已安装本轮私有客户端包后，将一个 JSON 请求送入已有 `ultrabrain-snapshot`：

```json
{
  "operation": "duplicate-compare",
  "consent": true,
  "files": [
    {"path": "/absolute/left.json"},
    {"path": "/absolute/right.json"}
  ]
}
```

`files` 必须恰好包含两份明确选择的文件。每项可以用 `expected_sha256` 绑定实际文件字节；使用自己计算或核对过的64位小写SHA-256，而不是上述占位路径。路径沿用现有绝对路径、普通文件、禁止符号链接及文件变更检查。Windows 使用本机带盘符的绝对路径。不给程序目录、URL或文件通配符。stdin最多16 KiB，拒绝重复JSON键。

Node 文件 API 仍为 `require('ultrabrain-client/dist/snapshot.cjs').inspectClientSnapshots(request, {authorize, signal})`。字节 API 为同一安装包的 `inspectClientSnapshotBytes({operation:'duplicate-compare', consent:true}, [{data:leftBytes}, {data:rightBytes}], {authorize, signal})`。字节选择同样可带 `expected_sha256`。选择、选项和字节会在异步检查前复制；授权必须同步，取消不能返回部分结果。

两份文件各自沿用1000条记录、8 MiB紧凑快照及16 MiB文件上限。无项目、状态或分页筛选，不能传 `include_text`、`memory_id`、`normalize`、`retry`、`options`。需要查看单条原文时，应另行使用已有显式 `record` 操作；本次比较无正文授权。

## 分组与四种结果

内容分组仅依据**原文完全相同**；不忽略空白、换行、大小写或Unicode表示形式，也不单凭内容指纹合并组。一份文件至少有两条同文记录才构成重复组。只在两份文件中都至多出现一次的内容不输出成重复组。

`left_only`：仅左侧达到重复条件；右侧可能没有同文记录，也可能仍有一条。`right_only` 是相反情形。`changed`：两侧都重复，但成员ID集合，或共有成员的被比较字段有差异。`unchanged`：两侧都重复且上述集合与字段相同。这里的左右是输入顺序，不是过去与现在；`left_only` 不等于已删除，`right_only` 不等于新增。

每组都保留左右的 `member_count`、`duplicate`、`additional_occurrences`、状态计数与有限成员元数据。**对侧单条记录不会被省略**，便于区分“未达到重复条件”和“本文件没有该内容”。`additional_occurrences` 仅为 `max(0, member_count-1)`，不是可删除数量。

`membership` 按原文组提供仅左、仅右、共有的ID。`shared_record_changes` 只提供共有ID及变化字段名，不包含字段原文。被比较字段包括类型、来源类型、项目、状态、可见性、重要性、可信度估计、Agent标签、修订号、时间、来源说明、直接来源状态及结构化派生引用。结构化对象忽略键顺序，数组保留顺序；比较引用字段不代表重新读取来源或证明引用有效。

一条ID在两份文件中改成另一段内容时，会分别出现在不同内容组的成员集合中；程序不把它自动推断成合并、拆分或迁移。需要按ID对照所有记录字段时，使用已有 `compare` 操作。

## 输出与限制

外层沿用 `ultrabrain-client-snapshot-v1`，`operation` 为 `duplicate-compare`。内层为 `ultrabrain-snapshot-duplicate-comparison-v1`：包括 `comparison_complete`、左右扫描记录数及重复统计、四类组计数、完整组列表和固定限制标识。组顺序为左侧规范ID扫描时首次遇到的内容，然后是右侧首次遇到的新内容；组内成员和共有记录变化按规范ID顺序。

原文、来源说明和派生引用的内容不输出；内容指纹、字节数、成员编号、项目与可见性等元数据仍可能敏感，不应公开。两份文件的 `source_id` 必须相同，但这只是文件声明的相同标签，**不是同一所有者证明**。`identity_verified`、`truth_verified`、`references_verified` 和 `merge_safe` 始终为false，`automatic_action` 为none。

两份文件全部通过结构、内容与全文件指纹检查后才比较。第二份文件中的无关损坏也会使整体失败；失败、撤销或取消不能伪装成“零重复”。索引、组投影和成员比较按有界批次让出事件循环；末尾再检查授权。没有缓存、浏览器存储、网络客户端、任务调度或记忆写入能力。两份文件不是事务性同一时点数据库视图。

## 可复现验证

```bash
node --test test/client-snapshot-duplicate-compare.test.mjs test/client-snapshot-duplicate-compare-boundaries.test.mjs test/client-snapshot-duplicate-compare-cli.test.mjs
```

专项包含完整字节与文件API、受既有副作用守卫保护的CLI、结构化引用、内容变动、碰撞注入、最大组、取消、假句柄和20组独立对照算法。`test/client-snapshot-offline-package.mjs` 在无SDK目录验证实际编译产物。`test/client-snapshot-duplicate-compare-integration.mjs` 使用隔离PostgreSQL导出、真实包和六张应用表指纹；只允许明确的合成数据准备阶段写入，生成器与外部模型调用均为0。

这些是测试入口，不是自动成功声明。实际执行状态、提交与独立审核限制见本轮复查报告和PR。
