# 离线快照多级来源追踪

`ultrabrain-snapshot` 的 `trace` 操作从一条指定记忆开始，在同一份完整校验的
快照里逐级检查直接来源。CLI、路径 API `inspectClientSnapshots` 和字节 API
`inspectClientSnapshotBytes` 使用同一实现。它不联网，不导入或修改记忆，
不执行模型，不扫描目录，也不读取快照所指向的外部文件。

## 使用

```json
{
  "operation": "trace",
  "consent": true,
  "memory_id": "00000004-1111-4111-8111-111111111111",
  "max_hops": 32,
  "files": [{"path": "/private/snapshots/selected.json"}]
}
```

把 JSON 通过 stdin 传给 `node <安装目录>/dist/snapshot-cli.cjs`。替换示例 ID
和明确选中的本地绝对路径。Windows 编码及客户端包安装说明见
[CLIENT-SNAPSHOTS.md](CLIENT-SNAPSHOTS.md)。必须用本模块提交构建的包；同一个
版本字符串不证明包包含本功能，应核对 `dist/build-manifest.json` 的入口摘要。

`memory_id` 是必填的完整小写 UUID。`max_hops` 可省略，默认 32；只接受 1 至
128 的整数，不接受字符串、null、布尔值或小数。只允许一份文件，可提供
`expected_sha256` 绑定原始文件字节，包括 BOM、空白和结尾换行。正文选项
`include_text`、筛选条件和其他字段都会被拒绝，不会静默忽略。

```js
import {inspectClientSnapshotBytes} from './packages/ultrabrain-client/src/snapshot.mjs';
const report = await inspectClientSnapshotBytes(
  {operation: 'trace', consent: true, memory_id: selectedId, max_hops: 32},
  [{data: selectedBytes, expected_sha256: previouslyRecordedDigest}],
  {signal: abortController.signal, authorize: () => currentConsent === true},
);
```

上例的 ID、字节、指纹和授权状态由调用方显式提供，不从环境或 Profile 读取。
`authorize` 必须是同步断言，false 或异步结果不能授权。请求和输入字节在
首次等待前复制；撤销和取消沿用既有边界检查，不返回部分追踪报告。

## 追踪规则

复用 [SNAPSHOT-SOURCE-AUDIT.md](SNAPSHOT-SOURCE-AUDIT.md) 的同一套引用合同和
比较逻辑，不近似匹配引文，也不建立第二套版本一致性规则。只有一条边的
state 为 `matched` 才能继续：来源版本、正文 SHA-256、UTF-16 引文位置以及
当前记忆的 `derivation_current` 均须一致，且来源未归档。

A 指向 B，B 指向 C 时，即使 A→B 匹配，只要 B→C 不匹配就停止。不把 C
当前版本的来源继续拼接成 B 所记录的历史版本。没有回退查找、自动修复、
替代 ID 猜测或在线查询。跨项目关系只报告 `same_project`，不授予工作区权限。

输出的 result 格式是 `ultrabrain-snapshot-lineage-trace-v1`：

| 字段 | 含义 |
|---|---|
| root_id / snapshot_record_count | 选中的根 ID，以及整份已校验快照的记录数。 |
| max_hops / followed_hops | 允许跟随的最多来源跳数，以及实际跟随的跳数。 |
| visited_count / steps | 实际访问的唯一记录数及按根到来源顺序排列的检查结果。 |
| termination | 本次追踪终止的原因。 |
| reached_unlinked_record | 是否到达没有本合同引用的记录；不是最终真实来源证明。 |
| cycle | 检出的闭环入口 ID、入口步骤下标、闭合步骤下标；未检出则为 null。 |

每个 step 复用 audit 的受限元数据结构，包括 memory、state、reference、source、
comparison 和 same_project，不含正文、引文、provenance 或完整 derivation。
全部结果深度冻结。查看原文须另行使用明确授权的 `record/include_text:true`。

## 终止原因与边界

| termination | 含义 |
|---|---|
| unlinked | 到达没有本合同引用的 agent 记录。 |
| unsupported_origin | 到达 document_fragment；文档原始字节与来源合同不在本功能范围内。 |
| invalid_reference | 引用结构非法，不跟随或回显未验证字段。自引用按原合同归此类。 |
| source_missing | 尚有跳数预算，但来源 ID 不在本文件；不证明数据库已删除。 |
| changed / archived / quote_mismatch / inconsistent | 当前直接引用不满足继续条件；优先级、独立比较维度与 audit 相同。 |
| cycle | 完整匹配的边指向已访问记录；保留闭合边的比较结果，不重复访问。 |
| depth_limit | 跳数预算耗尽，当前记录仍有合法引用；不查询或披露再下一条来源。 |

循环下标从 0 开始。闭合边不会增加 followed_hops；两节点循环访问两条记录，
跟随一次来源，随后在第二条记录检查到指回第一条的闭合边。

最多输出 `max_hops + 1` 个 step：根不消耗一跳。在预算用尽的最后一条记录，
可以判断其自身无引用、文档来源或非法引用；如果有合法引用，则只保留经过
校验的 reference 元数据，source/comparison/same_project 均为 null，并报告
`depth_limit`。不会读取该引用的下一条来源来判断是否缺失或成环。因此
`cycle:null` 只表示已检查范围没有检出闭环，不是无环证明。恰好在跳数边界
到达无引用记录时返回 `unlinked`，不误报截断。

无论跳数多小，都会先校验整份文件；无关记录损坏也会使整个操作失败。
仍采用 16 KiB 控制请求、16 MiB 文件、8 MiB 紧凑快照和 1000 条记录上限。
遍历为有界迭代，每 16 个步骤让出事件循环并复查授权；不采用递归调用栈。

## 不代表什么

退出 0 代表报告生成完成，**不代表完整来源链通过**。调用方必须读取
termination 和各 step；循环、变更和深度限制都是正常报告里的发现。文件
损坏、非法请求、缺少同意或根 ID 不存在则非零退出，不返回部分报告。

源 ID、版本、job_id 和 profile_hash 都来自未签名快照。结果中的
`identity_verified`、`truth_verified`、`graph_verified` 和
`historical_chain_verified` 始终为 false。到达无引用记录不证明没有其他
来源；当前内容指纹一致不证明真实作业执行顺序、历史因果、事实正确性或
整个图谱无环。其他记录的链和外部文档不在本次路径检查范围内。

本功能不使用 SDK/Profile/模型/网络或写接口。操作系统读取可能改变 atime；
文件系统不是原子事务，操作系统网络挂载与调用方重定向 stdout 不属于应用
零网络/零写入保证。取消不能收回已经交付的输出。

## 验收

源码、真实文件及 Node CLI：`test/client-snapshot-trace*.test.mjs`。
实际构建包：`test/client-snapshot-offline-package.mjs` 保留原五操作并追加
trace，以无 SDK 目录和已有描述符/FileHandle/网络/子进程守卫运行。

`test/client-snapshot-audit-integration.mjs` 在原真实 PostgreSQL/consolidator
检查上追加 trace，模型生成仍为明确注入的合成结果，不是外部真实模型。
`test/client-snapshot-trace-integration.mjs` 另用真实数据库 commit/snapshot
及显式合成引用元数据，检查三跳路径、中间来源更正、两节点闭环和深度
限制；报告明确标记 synthetic_relation_updates，不把注入引用冒充真实
模型作业历史。只读阶段核对六表指纹及快照文件字节/mtime。

具体提交的通过情况见绑定该提交的 CI、独立审查和阶段验收记录。新增
测试脚本、已有旧提交批准或本地自审均不能替代当前提交的独立验收。
