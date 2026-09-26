# 离线重复记忆审计

本模块在一份明确选择、完整校验过的个人记忆快照中查找**原文完全相同的不同记录**，供人工核对。它不是自动去重、删除、归档、合并或数据库修复工具。无需连接服务器、加载 MCP SDK、配置模型或读取客户端 profile。

## 如何使用

安装匹配本轮源码构建的私有客户端包后，将一条 JSON 请求送入已有离线入口：

```json
{
  "operation": "duplicates",
  "consent": true,
  "files": [{"path": "/absolute/path/owned-memories.json"}]
}
```

```bash
ultrabrain-snapshot < request.json
```

Windows 路径使用本机绝对路径，例如 JSON 中的 `C:\\Users\\you\\snapshot.json`。`files` 必须只有一个文件，可附 `expected_sha256` 绑定原始文件字节；未提供指纹并不意味着文件身份可信。仍遵循现有的符号链接、路径替换、文件大小、UTF-8、JSON 重复键和整个快照校验规则。操作只接受 `operation`、`consent` 和 `files`，不接受 `include_text`、`memory_id`、筛选、归一化、分页、重试或修改选项。

同一安装包的 `dist/snapshot.cjs` 继续提供两个接口，无需新建 profile：

```javascript
const {inspectClientSnapshots, inspectClientSnapshotBytes} =
  require('ultrabrain-client/dist/snapshot.cjs');
const report = await inspectClientSnapshots({
  operation: 'duplicates', consent: true,
  files: [{path: selectedAbsolutePath, expected_sha256: expectedFileHash}],
}, {authorize: () => stillAuthorized, signal: controller.signal});
// 已由调用方明确选取的字节也可使用：
const sameOperation = await inspectClientSnapshotBytes(
  {operation: 'duplicates', consent: true}, [{data: selectedBytes}],
  {authorize: () => stillAuthorized, signal: controller.signal},
);
```

调用方必须自己定义示例中的变量。同步 `authorize` 回调与取消信号沿用既有合同；异步回调不代表授权。取消后不返回部分报告，不承诺安全擦除内存。字节选择在首次异步校验前复制，后续修改调用方缓冲区不会替换已选择内容。

## 判定与覆盖范围

完整校验每条原文和整个记录数组的指纹后，按完整原文字符串分组，而不是仅按 SHA-256 分组。**不去空格、不忽略大小写、不转换换行、不做 Unicode 归一化，也不合并近义表达。** 例如“可以共享”和“不可以共享”始终是不同内容；LF 与 CRLF、Unicode 组合形式不同也不会匹配。若合同允许的文件包含空字符串，它们也按同样精确规则统计，不推断其用途。

所有项目、候选／已启用／归档状态及 Agent／文档片段来源都参与扫描。同文记录可能有不同项目、可见性、生命周期、来源或引用，因此报告保留它们之间的差异，不选择“保留哪条”。记录 ID 相同是快照损坏，不能算作两条重复记录；无关的非重复记录损坏也会阻止整个报告。

范围限制沿用既有快照合同：最多 1000 条记录、紧凑内容最多 8 MiB、输入文件最多 16 MiB。超过限制整体拒绝，不截断。扫描包含周期性让出事件循环与权限检查，单个包含全部记录的大组也会响应取消。组按最小记录 ID 排序，组内按记录 ID 排序；不推断时间先后、原始记录或可信程度。

## 返回内容

外层仍为 `ultrabrain-client-snapshot-v1`，操作为 `duplicates`。内层格式为 `ultrabrain-snapshot-duplicates-v1`：

- `counts`：组数、组内记录数、组外记录数、`additional_occurrences`。最后一项是各组“成员数减一”的合计，**不是可删除数量**。
- `groups`：每组的原文 SHA-256、UTF-8 字节长度、成员 ID 及有限元数据、三类状态计数、元数据存在差异的字段名称，以及包含派生引用的记录数量。正文、来源说明原文、引文和引用对象不会输出。
- `compared_metadata_fields` 明确给出哪些元数据用于差异检查。派生引用不在比较范围内，`references_compared` 始终为 false；即使 `differing_fields` 为空，也不证明记录可以互换。

固定边界：`text_included:false`、`merge_safe:false`、`automatic_action:"none"`、`identity_verified:false`、`truth_verified:false`。`scan_complete:true` 只表示这份已经完整校验的文件被扫描完，不证明真实数据库全部记录、当前权限或所有者身份。零组仅表示精确匹配规则下未发现重复，不表示没有语义重复或质量问题。

元数据、ID、项目标签、原文指纹与长度仍可能泄露私有信息，报告不应公开。路径可能位于挂载的文件系统上；`network_requests:0` 指应用没有调用网络 API，不代表底层挂载不会产生网络流量。

## 校验与阶段

模块测试：`node --test test/client-snapshot-duplicates.test.mjs test/client-snapshot-duplicates-boundaries.test.mjs test/client-snapshot-duplicates-cli.test.mjs`。

实际安装包检查复用 `test/client-snapshot-offline-package.mjs`：复制两份构建文件到无 SDK 的目录，并以网络／进程派生／文件写入拒绝守卫运行 CLI、文件 API 和字节 API。真实数据库导出检查接入现有 `test/client-snapshot-audit-integration.mjs`，在已有明确合成夹具中增加三条入口的重复组断言；读取阶段核验六张表和导出文件不变，不增加外部模型调用。

这是开发候选。源码实现、自查、运行测试、远端 CI 和第二代理独立审核是不同门槛。本轮推送和审核状态以随附报告为准，不能把此文档或测试脚本的存在当作执行结果。
