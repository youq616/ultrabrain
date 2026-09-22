# 离线快照来源一致性审计

`ultrabrain-snapshot` 的 `audit` 操作检查一份完整快照内的直接来源引用。
同一操作可审计全部记录，或按 `memory_id` 精确审计一条；两种模式都会先
完整校验文件，不能用“只看一条”跳过其他记录的摘要错误。

该功能已接入源代码 CLI、安装包的 `snapshot-cli.cjs`、`snapshot.cjs`
两种公开接口 `inspectClientSnapshots` / `inspectClientSnapshotBytes`。
使用包含本模块的提交构建的包；版本字符串不作为区分构建的依据。
构建清单中两个入口的 SHA-256 会随代码更新。旧包不支持 `audit`。

## 请求与结果

```json
{
  "operation": "audit",
  "consent": true,
  "files": [{"path": "/private/snapshots/selected.json"}]
}
```

通过 stdin 传给 `node <安装目录>/dist/snapshot-cli.cjs`。Windows 的 path
应使用明确选中的绝对本地路径；编码和安装方式见 CLIENT-SNAPSHOTS.md。
文件选择还可提供此前可信记录的 `expected_sha256`，绑定包含 BOM、空白和
结尾换行的原始字节。指纹绑定不是来源签名或身份认证。

可额外指定完整小写 UUID `memory_id`；不指定表示审计全部记录。其他筛选、
`include_text`、第二个文件、来源 URL 等参数均拒绝，不会静默忽略。
字节接口的请求不包含 files，另传 `[{data: Uint8Array, expected_sha256?}]`。
同意、选择和字节均沿用既有冻结/复制、授权复查和取消机制。

结果外层保持 `ultrabrain-client-snapshot-v1`；result 格式是
`ultrabrain-snapshot-lineage-audit-v1`，包含 `selection`、快照总记录数、
实际审计数、各状态数量和按记忆 ID 排列的条目。单条模式不会把未选择的
其他记录元数据整批输出，但会包含被选记录的直接来源元数据。

每条结果包含 memory 元数据、state、经过验证的 reference 元数据、source
元数据及 comparison。reference 不含 quote。默认和全部可选模式都不返回
正文、引文、provenance 或完整 derivation；需要原文时另行使用既有 record
操作并明确授权 include_text。

## 状态的严格含义

| state | 含义 |
|---|---|
| unlinked | agent 记录没有该合同的派生引用，不证明内容没有其他来源。 |
| unsupported_origin | document_fragment 的文档来源不能用本合同认证；原始文档字节不在快照中。 |
| invalid_reference | 引用不符合既有九字段合同，例如非法 ID、自引用、错误偏移或超限引文；不跟随也不回显未验证字段。 |
| source_missing | 被引用 ID 在本文件中不存在；不证明数据库里已删除，也不触发联网查找。 |
| matched | 本文件中来源的版本、正文摘要、UTF-16 引文位置和派生有效标志均一致。 |
| changed | 来源的版本或正文摘要与引用记录不一致。 |
| archived | 文件中的来源处于归档状态。 |
| quote_mismatch | 版本和摘要一致，但指定位置的引文不匹配；不会改到其他相似位置。 |
| inconsistent | 来源版本、摘要和引文都匹配，但文件中的 derivation_current 为 false。 |

五种比较状态完全复用 personal-lineage-contract，不建立另一套近似规则。
归档优先于版本/摘要变化，后者优先于引文错误，再检查有效标志；comparison
仍分别保留 `revision_matches`、`content_matches`、`quote_matches`，不会因
首要状态而丢掉其他维度。候选、确认、归档是原数据状态，不会被审计修改。

## 不授予的保证

`audit` 的成功退出表示校验与审计操作完成，**不表示所有引用通过**。
例如 result.counts.invalid_reference 大于零时，CLI 仍返回合法审计报告；
调用方应按自身政策检查 counts，不能只看退出码。文件损坏、未同意、非法
请求或指定记忆不存在时，则返回受限错误并非零退出，不返回部分审计结果。

只在当前已验证文件的 ID 索引查找直接来源，深度为一，不递归检查来源的
来源、循环、整张谱系图或作业执行历史；`graph_verified` 恒为 false。
两条循环引用即使分别匹配，也不构成整条谱系无环的证明。

文件的 source_id、owned_by_caller、job_id 和 profile_hash 都是自声明。
`identity_verified` 与 `truth_verified` 恒为 false。相同摘要不是事实认证。
本操作涵盖显式选择文件内的所有项目；`same_project` 仅描述两记录项目值
是否相同，跨项目的直接文字一致性不授予在线客户端的工作区访问权限。

无 Profile、SDK、网络查找、模型调用、目录扫描、修复、导入、恢复或数据库
写入；不跟随引用中的本机路径或 URL。复用 16 KiB 请求、16 MiB 文件、
8 MiB 紧凑快照和 1000 记录界限；每 32 条审计让出事件循环并复查授权。
元数据本身仍私密；调用方写回报告、stdout 重定向和操作系统网络挂载不在
应用不写文件/不调用网络 API 的范围内。

## 验证范围

单元与真实文件/CLI测试：`test/client-snapshot-audit*.test.mjs`。
真实构建包：`test/client-snapshot-offline-package.mjs`，无 SDK 目录且启用
描述符/FileHandle/网络/子进程拒绝守卫。
真实数据库：`test/client-snapshot-audit-integration.mjs` 使用独立测试来源，
通过实际 capture/consolidator/store 导出六条记录，三次明确注入的合成生成，
零外部模型；审计阶段比较六表指纹及输入文件字节/mtime。准备阶段有写入。
具体提交是否通过远端 CI 和独立代理审核，以绑定该提交的实际记录为准。
