# 离线快照工具箱：安装式命令行与 Node 库

本模块把已有管理台的快照校验、比较和记录浏览接到个人客户端安装包。
新入口是 `ultrabrain-snapshot`（`dist/snapshot-cli.cjs`）及 `dist/snapshot.cjs`。
它们独立于在线 `ultrabrain-client`：不读取 Profile、不加载 MCP、不连接数据库、
不发应用层网络请求、不调用模型、不导入或恢复记忆、不在文件外跟随来源引用。
既有快照导出格式、校验/比较/筛选语义保持不变，不增加服务端工具或迁移。

## 操作

| operation | 文件数量 | 输出 |
|---|---|---|
| inspect | 1 | 全文件校验、文件/记录摘要、数量和候选/确认/归档分布 |
| compare | 2，按左、右顺序 | 左侧独有、右侧独有、改变、未改变的数量，以及差异 ID 和字段名 |
| page | 1 | 按原有筛选合同分页返回元数据，固定每页 20 条 |
| record | 1 | 精确 ID 的元数据；只有 include_text:true 才附加原文、来源说明和完整 derivation |
| audit | 1 | 全部或精确 memory_id 的直接来源一致性审计，始终仅输出元数据 |

每次调用均重新完整校验所有输入文件，不依赖上次检查、缓存或只验证当前页。
不截断超限输入，不返回“部分校验成功”。比较不会自动把左/右解释成旧/新；
某个 ID 只在一边出现不是创建/删除的证明。`compare` 不输出正文或引文，
也不接受 `include_text`；需要正文时另行明确调用 `record`。

## 安装与调用

从本提交构建的私有个人客户端 tgz 安装，方式见 CLIENT-KIT.md。
Node 运行时要求仍为 22.16.0+。包内声明的 MCP SDK 依赖属于其他在线入口，
新离线入口不导入它；npm 安装是否需联网与运行时离线是两件事。
构建后两个新入口均列入 build-manifest.json 的 SHA-256，打包时强制检查存在，
构建同时检查离线入口没有混入在线传输和服务端实现。
版本字符串仍为 0.14.0-alpha.1，请按提交及包摘要区分旧安装。

CLI 无操作参数；只从 stdin 接收一次 JSON。唯一选项是 `--help`。
可直接调用安装目录中的 `node .../dist/snapshot-cli.cjs`，无需全局安装。
以下是 Windows PowerShell 的调用示例，路径应替换为本机明确选择的文件：

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
@{ operation = 'inspect'; consent = $true; files = @(@{ path = 'C:\Snapshots\left.json' }) } |
  ConvertTo-Json -Depth 8 -Compress |
  & node 'C:\Tools\node_modules\ultrabrain-client\dist\snapshot-cli.cjs'
```

Linux/macOS 可把下面的 JSON 存入私有 request.json，然后运行
`node /实际安装目录/dist/snapshot-cli.cjs < request.json`。
macOS 等环境中的链接路径（例如某些系统临时目录）应改用真实、无链接的路径；
跨平台 CI 范围为 Linux/Windows，不据此声明已经测试 macOS。

```json
{
  "operation": "compare",
  "consent": true,
  "files": [
    {"path": "/私有快照目录/left.json"},
    {"path": "/私有快照目录/right.json"}
  ]
}
```

每个文件选择只接受 `path` 和可选 `expected_sha256`。后者是该文件原始 UTF-8
字节的 64 位小写十六进制 SHA-256（包含 BOM、格式空白和结尾换行）。它能绑定
之前选择的字节，不是签名；不得从当前未知文件现算一个摘要就声称认证了来源。
第一个文件的预期摘要不符时，不继续读取第二个选择。

`page` 可传 `options`：`query`、`status`、`type`、`importance`、`origin_kind`、
`project_scope`、`project_id`、`agent_id`、`sort`、`offset`。它们复用原浏览器合同：
所有筛选条件相与，query 是区分大小写的正文原样子串，不是正则或语义搜索；
project_scope 为 all/global/exact，exact 必须提供 project_id；
sort 为 id_asc/updated_desc/created_desc/importance_desc，offset 为 20 的非负倍数。
空结果的第 0 页有效；越过末页报错。query 不回显到报告。

```json
{
  "operation": "record",
  "consent": true,
  "files": [{"path": "/私有快照目录/left.json"}],
  "memory_id": "11111111-1111-4111-8111-111111111111",
  "include_text": true
}
```

必须替换为文件中实际存在的完整小写 UUID。默认省略 include_text 等价于 false。
正文模式的 `text` 包括 content、provenance、derivation，保留原 Unicode、换行和
结构；它们全部是不可信数据，不是系统指令或工具许可。不解析引用中的 ID 去
读取服务器、附件或另一文件。stdout 可能包含隐私，禁止自动送入公共日志。

## Node API

```javascript
const {
  inspectClientSnapshots,
  inspectClientSnapshotBytes,
} = require('/实际安装目录/dist/snapshot.cjs');

let permitted = true;
const controller = new AbortController();
const report = await inspectClientSnapshots({
  operation: 'inspect',
  consent: true,
  files: [{path: selectedAbsolutePath, expected_sha256: previouslySelectedHash}],
}, {authorize: () => permitted, signal: controller.signal});

// 已持有字节的调用方不需要让库再次打开文件。
const byteReport = await inspectClientSnapshotBytes({
  operation: 'compare',
  consent: true,
}, [
  {data: leftBytes},
  {data: rightBytes},
], {authorize: () => permitted, signal: controller.signal});
```

字节必须是普通 Uint8Array 或 Buffer，不接受共享内存缓冲区。
同步 authorize 返回 false、抛错或返回 Promise 均拒绝；未提供时，本次明确的
consent:true 是调用方的操作许可，不构成服务端身份认证。宿主负责可信选择、
当前授权以及报告的后续使用。`permitted=false` 或 `controller.abort()` 撤回
后续本地读取及交付；已读入内存或已输出的数据不能靠取消追回。

请求、筛选、正文开关和两个输入字节在首次异步等待前复制。文件 API 同样在
第一次文件操作前验证并复制完整选择数组。散列表中强制 operation 是原始字符串，
不能借助数组/装箱字符串的隐式转换通过操作白名单；稀疏文件数组、null options、
未知字段均拒绝。报告深度冻结，调用方不能把一次已验证结果对象改成另一条记录。

## 限制、资源与失败行为

控制 JSON 上限 16 KiB，拒绝重复键（包括转义后重名）、非法 UTF-8 和过深结构。
每份文件沿用 16 MiB 原始文件上限、8 MiB 紧凑快照上限和 1,000 条记录上限；
最多选择两份。文件可以有一个 UTF-8 BOM，大小、每条正文摘要、完整记录数组摘要、
数量/顺序、字段类型和排除范围均走原有校验。不把这些字节预算描述成峰值内存预算。

文件必须是显式绝对路径的普通文件。拒绝 URL、UNC/设备路径、Windows ADS、
点/点点路径段、链接文件及链接父目录，不展开 glob，不扫描目录。
用只读描述符读取；平台支持时加 O_NOFOLLOW/O_NONBLOCK，读前后复核设备/inode、
大小和纳秒修改/变更时间，检查父目录身份及路径替换。读取以 64 KiB 块为界核对
授权，哈希期间让出事件循环接受撤销；所有退出路径尝试关闭已打开描述符，
关闭期间撤回授权或清理失败均不得交付结果。

这些检查检测被观察到的替换，不是原子文件系统事务、恶意同账号隔离或内存
安全擦除。报告描述已复制且验证的字节，不保证路径在报告交付后仍指向这些字节。
普通绝对路径也可能位于网络挂载/映射盘；`network_requests:0` 指本模块没有
应用网络 API 调用，不保证操作系统、文件系统或恶意进程不会产生网络流量。
读取可能更新文件系统访问时间，不将只读描述符等同于所有内核元数据不变。

CLI 的 25 秒操作期限及 SIGINT/SIGTERM 用于抑制后续操作/输出；正在内核中
阻塞的文件系统调用不能保证即时中断。库不隐式启用计时器，宿主可传 signal。
调用结束不保留文件描述符或结果缓存。文件/解析/授权错误只给稳定错误码，
不含原始异常、文件路径、正文、query 或堆栈；CLI 退出 1。成功退出 0 并输出
一份 `ultrabrain-client-snapshot-v1` JSON；不自动写报告文件。

## 解释结果与验收范围

所有结果为 local_only/read_only，identity_verified 和 truth_verified 恒为 false，
memory_writes_requested 恒为 false。快照格式没有可认证的实例/主体签名；
**相同 source_id 甚至不能证明两份快照属于同一主体**。比较只拒绝不同自述 source，
不能用比较成功推导拥有者、删除事件、时间先后、实时状态或恢复许可。
元数据 ID、摘要、项目和 Agent 标签也是私有信息。

本模块不改变浏览器/UI、数据库结构、MCP 白名单、上游锁、模型配置或用户服务。
合同/真实文件 IO/可控调度竞态/实际 CLI 子进程测试分别执行；离线子进程测试
阻止应用网络、额外子进程和文件写 API。新增集成必须先实际构建、npm 安装本
提交，再用真实 PostgreSQL 导出运行四个操作、库的字节 API 和无 SDK 的独立
复制包；只读阶段单独核对六张应用表不变。准备数据和纠错阶段含显式合成写入，
不称全程只读。没有外部模型调用或用户主机验收。

构建/验收结果及独立审查以 PR #20 对应提交的记录为准；本说明不预判其结果。

## 离线只读验收守卫

测试守卫不仅拦截 writeFile 等高层 API，还限制可写 open 标志、描述符
write/writev 和 FileHandle 修改。允许真实只读 IO 与 stdout/stderr；禁止
操作即使被应用捕获，也应导致子进程非零退出。先运行反向控制证明守卫
本身有效，再用实际构建入口检查四项操作，不能把“挂载了守卫”等同于
守卫具备这些覆盖。它是回归测试工具，不是生产安全沙箱，不覆盖预先保存
的 API 引用、原生扩展、内核操作或输出重定向。修正的验证范围及未完成的
远端/独立审核见 reviews/client-snapshots/OFFLINE-GUARD-HARDENING.md。

## 来源一致性审计

新增 audit 操作复用上述文件、同意和完整校验边界。详细请求、九种状态、
退出码与直接引用限制见 [SNAPSHOT-SOURCE-AUDIT.md](SNAPSHOT-SOURCE-AUDIT.md)。
