# 采集队列只读健康审计

`queue-audit` 用于诊断本地采集队列，不是服务器确认、恢复授权或新记忆数据库。它不实例化写入器，不创建目录或绑定，不取锁、不删除残留文件、不改尝试次数，也不连接服务。明确读取既有队列记录到内存验证，但报告不输出正文、事件编号、文件名、目录、账户、绑定指纹或锁 PID。

## 入口

重新编译客户端后，原客户端提供 `ultrabrain-client queue-audit --profile PATH`。另有独立入口 `ultrabrain-queue-audit --profile PATH`，或直接 `node packages/ultrabrain-client/dist/queue-audit-cli.cjs --profile PATH`。独立构建产物不导入 SDK、网络或子进程模块；无需安装 MCP SDK 就可执行该入口。完整客户端的其他功能仍有原依赖，不能将此理解为整个客户端不再需要 SDK。

源码可直接执行 `node packages/ultrabrain-client/src/queue-audit-cli.mjs --profile PATH`。参数仅允许 `--profile PATH` 或独立入口的 `--help`；没有修复、强制、批量目录或正文输出开关，不读取标准输入。PATH 必须指向现有可信的私有客户端配置；不把命令中的 PATH 原样当实际文件路径。

API：`await auditCaptureOutbox(input, {signal, authorize})`，位于 `src/capture-audit.mjs`。配置需要原 outbox/workspace/身份绑定。读取不需要 allow_capture，撤销采集后仍可检查自己的既有队列；不重新启用授权。authorize 必须同步，false、Promise 或抛错均中止。CLI 持续复核所选 profile，取消或复核失败不输出已准备的审计报告。同步系统调用不能被 AbortSignal 强行中断；较大扫描在记录组之间让出事件循环。

## 输出与退出码

输出固定 JSON 包装 `{ok, result}`；参数或配置读取错误返回 `{ok:false,error,...}`。只有 absent、uninitialized、healthy 的正常结果退出 0；所有 attention/busy/changed/limited/unavailable 和错误退出 1，供调用者告警。

| status | 含义 |
|---|---|
| absent | 配置指向的队列目录未发现；不会创建目录。缺失父目录或工作目录不当作空队列。 |
| uninitialized | 现有目录为空；不会写入 binding.json。 |
| healthy | 两次目录/文件元数据核对一致，绑定和识别出的记录通过本轮验证，没有发现需要处理的项目。 |
| attention | 发现坏记录、绑定不匹配、阻塞投递、临时残留、未知文件或不安全文件元数据。没有执行恢复。 |
| busy | 观察到 queue 或 delivery 锁；不打开锁、绑定或记录正文。并不据此判断进程是否已死。 |
| changed | 扫描期间观察到目录、文件、内容长度或元数据变化；撤下部分计数，建议停止写入者后再检查。 |
| limited | 文件数或字节预算越界；不输出不完整的健康结论。 |
| unavailable | 权限、路径、打开、读取、关闭等检查未完成；只给固定诊断类别及允许的系统错误码。 |

`complete` 仅说明本次入口检查/记录检查是否完成，不表示数据库一致性。`snapshot_consistent` 永远为 false：无锁读取不是原子快照，双次元数据比较无法排除所有平台的时间戳粒度、同账户恶意替换或最后一次检查后的变化。`server_confirmation` 永远为 false。即使 healthy，也不证明服务器收到了记录或生成了已确认记忆。

`counts` 在忙碌、变动、未绑定、错误绑定、超限或 IO 失败时为 null，而不是伪装成零。`records_validated` 仅统计本轮通过内容合同验证的记录；坏记录另计 invalid。发现扫描变化或 IO 中断后清除部分统计。`bytes_read_budget_used` 是预扣的读取预算，包含增长检测字节及失败读取预留，不等于 OS 实际读取字节。

最多观察 272 个目录项；识别记录上限 256，单条上限 220000 字节，记录及临时文件声明尺寸合计最多 8 MiB，绑定读取最多 4096 字节。总读取预算为 8 MiB + 4096 + 257；目录使用小批量枚举，未知文件和临时文件只检查元数据，不读取其正文。JSON 拒绝重复键、非法 UTF-8 和过深嵌套；生产写入器与审计共用格式、绑定和事件指纹验证器，不新增第二套规范化规则。

## 安全与恢复边界

沿用队列必须位于 workspace 外的约束。检查私有目录、常规文件、符号链接和硬链接；POSIX 校验 UID/权限位。Windows 不声称此模块验证了完整 ACL，也不新增目录刷盘保证。只读指没有应用级写入系统调用；读取可能由操作系统更新 atime、触发审计日志或杀毒扫描，不承诺磁盘零变化。

残留锁请继续使用已有 queue-lock / queue-recover-lock 的明确核对流程。审计不给“可安全删除”的证明，不按年龄/PID 猜测、不自动恢复临时文件。配置、目录和写入者由可信本地账户管理；本模块不是隔离同账户恶意程序的沙箱，不提供网络文件系统原子性承诺。

## 验证入口

`node --test test/capture-audit*.test.mjs` 是源码级合同、CLI 和实施者复查用例。`bun scripts/build-client.mjs` 重新编译当前源码，`node scripts/check-capture-audit-package.mjs` 将实际独立二进制复制到没有 SDK 的临时目录，在禁止网络、子进程和文件写入的测试护栏下执行合成案例。完整包可通过 `--cli` 指向解包后的同一构建入口再测。Windows/Linux 专项位于 `.github/workflows/capture-audit.yml`；存在工作流不等于已执行或已通过。

上轮 Windows writer_failed 的原始 errno 未知，本功能不声称已修复该故障。实施者分阶段复查不等于另一代理审核，主线接纳仍须真实独立审阅和相应平台验收。

参考 Node 官方 fs.opendirSync、文件标志与目录遍历语义： https://nodejs.org/download/release/latest-jod/docs/api/fs.html 。
