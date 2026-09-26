# 快照重复记忆审计（离线、只读）

本模块用于人工整理前定位正文完全相同的记忆。它只读取明确选择的一份完整快照，不连接服务器、不读取 profile、不调用模型、不写入记忆，也不替你决定保留、合并或删除哪条记录。开发候选：独立代理复审通过前不合并或部署。

## 使用入口

使用同一提交构建的私有客户端包，命令行为 `ultrabrain-snapshot`：

```bash
printf '%s\n' '{"operation":"duplicates","consent":true,"files":[{"path":"/absolute/selected-snapshot.json"}]}' | ultrabrain-snapshot
```

Windows PowerShell 的 JSON 需要使用 UTF-8 传入：

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
@{ operation='duplicates'; consent=$true; files=@(@{ path='C:\Snapshots\selected.json' }) } | ConvertTo-Json -Depth 4 -Compress | ultrabrain-snapshot
```

SDK 沿用 `ultrabrain-client/dist/snapshot.cjs` 的 `inspectClientSnapshots(request, {authorize, signal})` 路径接口，以及 `inspectClientSnapshotBytes({operation:'duplicates', consent:true}, [{data: bytes}], {authorize, signal})` 字节接口。不增加新依赖或可联网入口。

请求恰好选择一份快照。文件选择可带 `expected_sha256`，它绑定本次选择的字节，不证明身份或真实性。本操作不接受 `memory_id`、`options`、`limit`、`include_text`、`normalize`、`delete` 或其他参数；不能用筛选掩盖未检查部分。标准输入继续有 16 KiB 上限并拒绝重复 JSON 键。文件沿用现有 16 MiB 原始文件、8 MiB 紧凑快照、最多 1000 条的限制；超过限制整体拒绝，不先截断再查重。

## 什么算相同

按已经完整验证的原始正文字符串逐字比较，不仅比较正文指纹。空格、大小写、换行、Unicode 组合形式、BOM 正文、零宽字符和否定词均不归一化。相似表达、同义句和语义冲突不在本模块判断范围。

候选、已启用、已归档，以及全部项目和文档片段都会参与分组。不同项目的相同正文可以属于同组，但会给出 `cross_project: true` 和 `project_id` 差异。这只是定位相同文字，不代表它们在不同项目中重复无用。文档片段按保存的片段正文比较，不代表原始文档字节相同。

## 输出与人工核对

外层仍为 `ultrabrain-client-snapshot-v1`，`operation` 为 `duplicates`，保留文件指纹及只读、无网络请求、身份未验证等声明。内层为 `ultrabrain-snapshot-duplicates-v1`。

`counts` 包含：不同正文数量 `distinct_contents`；只出现一次的记录数 `singleton_records`；重复正文组数 `duplicate_groups`；各重复组成员总数 `records_in_duplicate_groups`；每组首条以外的出现次数合计 `repeated_occurrences`。最后一项是数学计数，不是建议删除条数。例如五条记录的正文为 A、A、B、B、C，则上述计数依次为 3、1、2、4、2。

`groups` 按各组最小记忆 ID 排序；组内成员按 ID 排序。`group_id` 取最小 ID 作为可重复的标签，不表示“应保留此条”。每组还包含正文指纹、成员数、状态计数、跨项目标记及 `different_fields`。

成员只返回固定元数据：ID、类型、来源种类、状态、可见性、项目、Agent 标签、版本及直接来源有效性标记。不返回正文、来源说明或派生引用全文。来源说明、派生引用、重要性、可信度估计、时间等不一致会通过不同字段名提示，需另行明确核对正文或最新服务器记录。嵌套 JSON 元数据比较忽略对象键顺序，但保留数组顺序和值类型；不验证派生引用是否真实有效。

所有成功结果冻结，`automatic_merge_safe: false` 始终为假。即使 `different_fields` 为空，也不自动认为两条不同 ID 的记录可以互相替代，它们可能被其他记录引用。完整快照核验只证明文件内部一致，不是签名、身份认证、历史完整性或事实证明。输出中的 ID、项目和正文指纹仍是私有元数据，应妥善保护。

## 失败与取消

只有全文件结构、记录顺序、每条正文指纹和整体指纹都通过后才分组。无关的单条记录损坏也会使整个操作失败，不输出部分组或伪造“无重复”。零组只表示本文件内没有完全相同的正文，不表示没有语义重复。

分组和大组元数据投影分批让出事件循环，并在异步前后检查实时授权。取消、回调拒绝或回调异常会阻止结果交付。文件读取沿用现有的描述符、父目录和变更检查；这不是与恶意同 UID 进程对抗的文件系统事务。回调异常的 code 访问器或失效 Proxy 不会被直接执行或反射到输出。

## 验证

`node --test test/client-snapshot-duplicates.test.mjs test/client-snapshot-duplicates-cli.test.mjs`：完整合同、精确比较、跨项目差异、1000 条边界、独立二次方参考算法、取消、异常净化及实际 CLI/路径/字节入口。

`node test/client-snapshot-duplicates-package.mjs /path/to/client-package`：从实际构建包复制离线入口到无 SDK 的目录，在既有网络/子进程/文件写入限制守卫下执行十项检查。原文件字节及修改时间必须不变。测试数据全部为合成快照，不是用户设备部署、实时数据库或模型质量验收。

跨平台工作流追加新测试，原有命令保持不变；安装包工作流在真实 npm 安装后执行离线包测试。最终提交 CI 和独立复审结论以 PR 的实际证据为准。
