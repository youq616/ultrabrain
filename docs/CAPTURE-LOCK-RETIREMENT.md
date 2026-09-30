# Windows采集锁：先释放锁名，再回收旧文件

基线PR49（e8eadd1099cb71bab2c02a362f82f077f4a4b633）的原生Windows25轮检查仍报告queue/create/EPERM。本模块保留权限错误失败政策，改变的是Windows释放锁的名称生命周期；没有添加EPERM重试、忽略权限、抢旧锁或自动清理用户证据。

## 行为与边界

原临界区和排他创建仍使用`.queue.lock` / `.delivery.lock`与原格式。Windows临界区结束后，不直接对可复用名称执行unlink，而是在同一已核验私有目录内排他创建一个随机的`.retired-queue-UUID.lock`或`.retired-delivery-UUID.lock`保留文件，写入并刷盘、关闭它，核对原锁指纹和保留文件指纹，再将原锁原子移名到该自己创建的目标。只有移名成功后才核对并删除移走的旧锁；此后绝不再读取或删除原来的可复用锁名。

这样，即使旧锁文件仍有允许删除/移名共享的读取句柄，其删除待完成状态也属于唯一的退休名称，而非下一位写入者要取得的锁名。下一位拥有者仍必须成功排他创建原锁，不能跳过互斥。本协议不绕过不允许共享删除的外部句柄，也不保证解决所有EPERM来源。

Linux等其他平台的正常释放仍沿用原先已验证的unlink路径。显式Windows锁恢复也使用新释放原语，但保留writerStopped、锁hash及原有PID存活检查；没有自动根据锁年龄判定死亡。

## 失败与证据

每个创建/写入/刷盘/关闭/复核/移名/删除/目录刷盘阶段均有固定诊断。保留最先失败原因，关闭只尝试一次。移名前失败不会开始临界区以外的新操作；移名返回错误时命名空间结果为unconfirmed，成功返回后为released。后续错误不能冒称锁仍占据原名，或已经写入的事件没有发生。

错误报告的`lock.retirement.namespace_state`为`not_released | unconfirmed | released`，另有固定close_failed标志；不含路径、锁nonce、正文或任意异常文本。采集/日志既有错误包装保留这些真实本地事实，子进程报告只按白名单复制，不认证序列化数据。

失败时不删除保留文件或猜测回滚。`queue-status`增加`retired_lock_files`计数；已绑定队列可以报告遗留证据，但不会自动清除它们。文件总量仍有原有上限。退休文件不被当成payload或发布临时文件，也不计入正文扫描，避免下一位写入者扫描到正在回收的旧锁。未绑定队列发现此类证据仍拒绝静默建立绑定。

## 兼容性

不修改队列entry、binding、control或原锁的内容格式，不修改服务器或模型接口。新增退休文件名是一个本地兼容性变化：旧版本遇到该名称可能按未知文件拒绝，因此升级/降级应在停止所有共享该队列的进程后进行；不能承诺新旧客户端混跑完全无中断。失败遗留证据存在时，不应降级并删除文件来强行恢复。

这里仍假定目录由可信本地账户管理。hash核对与rename之间不是原子compare-and-swap，不能抵御有同等文件权限的恶意进程在检查间置换。排他创建目标避免正常碰撞覆盖，不是同用户沙箱。只在所有原临界区工作完成后释放名称；不提供数据库式回滚或超出现有file-fsync/平台目录刷盘能力的断电保证。

## 可运行检查

`node --test test/capture-lock-retirement*.test.mjs`包含旧删除待完成语义的明确IO替身、真实临时文件的拥有者/失败/证据保留检查及实施者另行审计。替身不是原生Windows验收。

`node scripts/check-capture-lock-retirement.mjs`不接受用户路径或配置，只在临时目录做25轮保持旧读句柄、移走锁、重建同名新锁与互斥验证。它同时报告旧unlink后重建名称在当前平台的实际结果，不要求所有Windows/文件系统都返回同一种错误。

原有两套25轮×8进程压力脚本保留，专用四格Ubuntu/Windows×Node22.16/22工作流调用它们。各步即使失败仍保留独立证据，但失败不会变成成功。客户端包沿用现有构建入口，无新增授权或外部依赖。

原生系统依据：Microsoft CreateFile文档说明待删除文件在最后句柄关闭前可能令新打开返回ERROR_ACCESS_DENIED；Node/libuv22.16默认共享READ/WRITE/DELETE。但此前CI的单个EPERM本身不证明是哪一种系统原因，须以最终SHA的实际原生结果限定结论。

- https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilea
- https://github.com/nodejs/node/blob/v22.16.0/deps/uv/src/win/fs.c

本阶段独立第二代理复审仍需单独执行；实施者审计、绿色测试或旧提交反馈不替代批准。保持开发分支，不合并main、不安装用户服务。
