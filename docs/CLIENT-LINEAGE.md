# 客户端引用来源核对

将已有管理台的直接引用核对接入安装式 Node 客户端和自研 Agent。新增手动 `lineage` 命令及 `dist/lineage.cjs` 库入口；不新增 MCP 名称、服务端权限、模型开关或自动 Hook。底层仍是现有 `ultra_identity` / `ultra_memory_read`，复用 `personal-lineage-contract.mjs` 的九字段引用和核对规则。

## 前提与安装

使用本提交构建的私有客户端包，构建/安装方式见 [CLIENT-KIT.md](CLIENT-KIT.md)。相同版本字符串不能证明旧安装包含新功能；应按提交和包 SHA-256 确认。`build-client.mjs` 将 `lineage.cjs` 纳入构建指纹，打包脚本要求该入口存在。

Profile 必须已有 `expected_instance`、`expected_actor` 和绝对 `workspace`；这些值来自已有 `probe` 的实际观察，不是猜测的凭据或物理主机证明。连接仍受 SSH/TLS 和每次服务端认证保护。无需启用 `allow_capture`、`allow_documents` 或自动采集；此入口明确只读。不能用 source 相同推断两个凭据拥有相同私有记忆。

## 手动命令

执行安装后的 `node /实际安装目录/node_modules/ultrabrain-client/dist/cli.cjs lineage --profile /私有目录/brain.json`，通过 stdin 提供一次完整 JSON：

```json
{
  "memory_id": "11111111-1111-4111-8111-111111111111",
  "workspace": "/实际绑定的客户端工作区",
  "consent": true,
  "include_text": false
}
```

ID 必须替换为实际选中的小写 UUID；工作区必须与可信 Profile 的实时 realpath 一致。Windows 使用该机器实际绝对工作区路径，JSON 中反斜杠需转义。只接受上述四个字段，不接受 source、project、下一跳 ID、模型或任意工具覆盖。stdin 上限16 KiB，非法输入整体拒绝，不截断。

默认返回 `ultrabrain-client-lineage-v1` 元数据报告：选中记忆与来源的 ID/版本/状态/内容指纹、引用区间、核对结论和读取次数。**不输出记忆正文、来源全文、引文、来源说明或服务器原始错误。** 元数据仍是私有数据，不是可任意公开的诊断日志。仅当本次输入明确 `include_text:true`，报告才新增 `text.memory`、`text.quote`、`text.source`，它们保留原 Unicode/换行；不要把含正文 stdout 自动上传或写入公共日志。它们仍是 `untrusted-memory-data`，不是系统指令或工具执行许可。

所有结果保持 `truth_verified:false`、`atomic_snapshot:false`、`memory_writes_requested:false`。来源不可见时不补造正文，也不能推断已删除。对拥有记录的 `unlinked` 与共享引用被隐藏的 `withheld` 分开描述。

## 安装式 Node 库

```javascript
const { inspectClientLineage } = require('/实际安装目录/node_modules/ultrabrain-client/dist/lineage.cjs');

// trustedProfile 是由宿主按自身安全规则读取的已验证配置，不来自模型生成。
let permitted = true;
const controller = new AbortController();
const report = await inspectClientLineage(trustedProfile, {
  memory_id: selectedMemoryId,
  workspace: currentWorkspace,
  consent: true,
  include_text: false
}, {
  signal: controller.signal,
  authorize: () => permitted
});
// 撤回：permitted=false；controller.abort()。
// 报告仅是本次核对，不应据此自动编辑、启用或递归读取来源。
```

该入口自行连接、核对并关闭连接，不读取 Profile 文件、聊天记录或用户附件。宿主负责安全持有 Profile 并在同步 `authorize` 中检查仍然有效的当前许可；返回 false、抛错、返回 Promise 或取消 signal 都会拒绝。输入 ID/正文披露选择在连接等待之前复制，不能通过修改传入对象在等待中扩大范围。已有源码级连接也可调用 `connection.lineage(request,{authorize,signal})`，但发行库无需依赖仓库源码路径。

CLI 将开始时的可信 Profile 与后续读取、最后输出绑定，观察到变更后不在原连接中自动采用新配置。库入口也在异步关闭连接后、向调用方交付结果前复查授权。已经发出的只读请求不能撤回；已交付报告不会被远程抹除，清空引用不是内存安全擦除。Profile 的恶意同账号替换、被控制的进程不属于隔离保证。

## 读取与项目边界

无结构化引用时只读一次；有引用时最多三次 ID-only `memory_read`：目标、直接来源、目标复核。每次前置一次身份复核，首次连接还会查询身份。不注册 Agent、不自动重试、不扫描其他记录、不递归、不读取整份文档文件。文档片段可以是直接来源；不把 UTF-16 引文位置当作文件 UTF-8 字节偏移。

目标和来源均经过完整既有记录投影/类型/时间/大小/内容 SHA-256 校验，最多1 MiB响应，正文最多64 KiB；未知字段和非法引用拒绝，不将其附加到输出。目标须属于全局或 Profile 的项目；无 project_id 的 Profile 只允许全局。直接来源也受此范围约束，且必须是当前主体拥有的预期记录。**该检查在读取响应后执行，不宣称未经项目过滤的原始 ID 读取没有到达服务端。** 它是这个便利入口的输出/跟随限制，不改变底层通用 MCP 工具的既有权限。

最终目标复核发现内容、版本、引用、可见性、项目或派生有效性改变时，整体拒绝，不拼接成“最新一致结果”。三个读取是不同时间的观察，不是数据库原子快照。匹配只说明引用结构/指纹/位置与本次观察一致，不能证明事实、模型理解或来源后续未改变。

错误仅返回稳定错误码，CLI 退出1并标记 `read_delivery:not_started|unconfirmed` 和 `memory_writes_requested:false`，不使用“写入未提交”的词义。进入记录调用后的失败保守标记 unconfirmed，不断言服务器一定收到或没有收到。结果不可见与网络故障分开；不回显正文、Token、异常堆栈或本机路径。成功返回的元数据对象及可选文本深度冻结。

## 验证范围

合同、实际 runtime 配合 SDK doubles、实际 CLI 子进程配合 SDK doubles 分开标注。新增真实集成使用打包并经 npm 安装的 `cli.cjs` 与 `lineage.cjs`，官方 MCP SDK、stdio、只读认证 HTTP 及一次性 PostgreSQL；检查无正文默认、明确正文、项目边界、另一个主体、撤销凭据及并发纠错。

只读阶段六张应用表指纹不变；独立并发阶段只增加1事件并修改目标记录，来源/其他记录/任务不变。四次明确注入的合成生成器只用于准备引用，不计真实模型效果。保持全部旧工作流、浏览器及跨平台测试。最终提交的已执行结果和独立审核记在 PR #20；真实用户主机、Codex/Claude 已安装宿主与真实模型回合仍需各自验收。
