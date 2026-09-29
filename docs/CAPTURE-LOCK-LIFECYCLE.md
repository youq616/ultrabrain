# 采集队列：可取消锁调度与安全诊断

本模块修复客户端本地采集队列的取消边界，复用原文件格式、事件编号、队列绑定和回执规则。它不是新记忆数据库，不自动修复文件、不抢占旧锁，也不执行服务器写入重试。

## 使用现有接口

`CaptureOutbox.enqueue(payload, {signal, authorize})` 和 `status({signal})` 新增可选取消信号；`flush(connect, {signal, authorize, ...})` 将已有信号传入投递锁与发送前队列锁等待。未传信号的调用保持兼容。`signal` 必须是当前运行时的原生 AbortSignal，授权回调仍必须同步，返回 false、抛错或返回 Promise 均不能批准操作。

方法在已取消时拒绝，等待锁期间取消也拒绝；不会仅因为后来取得锁而继续创建事件或消耗发送次数。构造器仍可能创建私有空目录，不能将取消描述为“整个对象创建没有任何文件系统访问”。锁操作本身仍采用同步系统调用，AbortSignal 不能中断正在执行的原生 fsync 或系统调用。

队列命令 `queue-status`、`queue-capture`、`queue-flush` 将各自的执行信号贯穿本地等待，并注册 SIGINT/SIGTERM 处理器。这是 Node 收到相应事件后的行为，不保证任意平台的强制进程终止都会发送可处理事件。SIGKILL、崩溃和断电依然需要既有显式恢复流程。自动采集管理器现在从入队开始跟踪整个操作，close() 能取消尚在等待锁的提交，不再只取消网络阶段。

## 等待和错误

保留排他创建原语与原锁文件格式。队列锁默认最多等待约 1000 毫秒，投递锁不等待；使用单调时钟而不是 Date.now 计算期限。每次重试重新检查授权、取消和私有目录，事件循环恢复时若已超时，不再发起一次新的排他创建。线程调度和正在进行的同步系统调用耗时不属于可精确中断的保证。

只有创建阶段产生的 EEXIST 是可等待的竞争。EACCES、EPERM、EBUSY、ENOSPC、EIO 等不重试，也不被改写为竞争成功；写入、fsync、close 阶段即使抛 EEXIST，也不是别人的锁。未完整初始化的锁保留供显式核对，不由失败的创建者自动删除。释放前核对锁的完整内容指纹；身份不符、内容损坏、文件别名或权限异常时，不删除其他持有者的锁。没有按年龄、PID 猜测或超时自动偷锁。

底层失败使用固定代码 `outbox_lock_io`；可识别的原所有权/损坏错误保留既有代码。`captureLockDiagnostic(error)` 仅对本模块产生的本地错误返回：

```json
{"kind":"queue","phase":"create","system_code":"EACCES"}
```

kind 只有 queue/delivery；phase 区分 create、write、file-sync、close、directory-sync、verify-release、unlink、release-sync。未知系统码为 null。不会带路径、正文、原生错误消息、环境变量或任意属性。CLI 的错误 JSON 可增加同一 `lock` 字段。该诊断不是写入回执、服务器拒绝证明或真人审核凭据，复制一个错误对象也不能冒充原始本地诊断。

## 已发送的结果不能被“取消”改写

取消只阻止尚未发生的入队或发送。请求已发送后，客户端仍会完成原有本地记账：已验证的服务器回执删除相应事件；不确定结果保留原事件和尝试计数。记账及持有锁的释放不服从已经取消的信号，否则会留下错误状态或导致不必要的重复发送。测试使用明确的合成服务器回执；此阶段没有新的实际 MCP/PostgreSQL 集成结果。

文件 fsync、目录 fsync 以及 Windows 的原有限制均保持原样：Windows 不声称目录已刷盘。这里的锁仍是可信本地账户之间的协作机制，不是对同账户恶意程序的沙箱，也不承诺网络文件系统排他创建语义。

## 可重复的进程压力核验

开发源码目录可执行：

```text
node scripts/check-capture-contention.mjs --rounds 25
```

工具只新建临时合成队列，不接受现有队列或用户 profile 路径，不连接服务器。每轮八个独立 Node 进程在屏障后同时开始，每个进程创建两个独有事件并重放一个共同事件。核对 24 次请求最终恰好 17 条记录、7 次相同事件重放、尝试计数为零、内容完整且没有遗留锁/临时文件。只有既有 outbox_busy 允许测试重放同一事件，权限/IO 失败立即失败。报告包含进程结果和固定错误分类，不输出原路径或正文。清理仅针对工具本轮创建的临时目录。

专用 CI 为 Linux/Windows、最低受支持 Node22.16.0/Node22 分支建立矩阵；旧 portability 命令不删减。脚本存在不等于运行成功，实际状态须按提交另行核对。

## 本轮已知限制

PR41 的 Windows 作业 109213014310 在八写入者测试中有一个 writer_failed，但旧日志未保留底层 errno/syscall，不能据此确定原因。此模块补充诊断并修复已经独立复现的取消和截止期限问题；**不宣称已经修复原 Windows 根因**。没有通过吞掉 EPERM/EACCES、删除并发断言或延长无限等待使其变绿。

Node 官方语义参考：fs 排他创建/文件标志（https://nodejs.org/docs/latest-v22.x/api/fs.html#file-system-flags），支持 AbortSignal 的 Promise 定时器（https://nodejs.org/docs/latest-v22.x/api/timers.html#cancelling-timers），performance.now 单调运行时间（https://nodejs.org/docs/latest-v22.x/api/perf_hooks.html#performancenow）。
