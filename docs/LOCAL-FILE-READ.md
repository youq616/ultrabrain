# 跨平台有界本地文件读取

本模块统一客户端 profile 与 capture outbox 的叶文件读取。基线为远端 PR45 的 b879cdc2；此前本会话的 ceb11205 仍是独立本地候选，未合入、不覆盖，也不迁移暂停格式。本模块不新增暂停/恢复接口，不更改服务器、队列格式或采集授权。

## 已知平台差异及处理范围

Node22.16.0 内置 libuv 的 Windows 路径 fast-stat 使用 GetFileInformationByName / FILE_STAT_BASIC_INFORMATION 的完整64位 VolumeSerialNumber；句柄 stat 从 FILE_FS_VOLUME_INFORMATION.VolumeSerialNumber 获取32位序列号。在支持 fast-stat 的系统/卷上，同一文件的两种 dev 表示可能不同。直接比较会把合法文件误报成更换。旧 Windows CI 出现 profile 的 “Profile changed or exceeds size limit” 和 queue lock verify-release/outbox_corrupt；原日志没有原始设备号，最终归因仍须结合新原生探针与平台回归，不把 Linux 注入测试当 Windows 修复证明。

实现只允许一个有方向的特例：运行平台为win32，路径dev为无符号64位且大于32位，句柄dev为非零无符号32位，两者低32位严格相等。反向、不符低位、两个不同的宽设备号、Number类型或其他平台均不接受该特例。所有采样使用bigint，不能先经浮点数舍入再掩码。inode始终精确相等，设备号绝不是单独的身份或权限证明。

同一命名空间的检查仍是全宽精确比较：读取前后两次路径stat的dev必须完全相同，两次句柄stat的dev也必须完全相同。同时检查inode、size、mode、link count、UID/GID、mtime/ctime/birthtime纳秒值，访问时间不参与（读取本身可能改变它）。额外末端路径检查避免只证明“打开的旧文件没变”却遗漏路径已换。Native探针仅输出设备关系分类，不打印卷序号或文件标识。

这不是恶意同用户进程的安全沙箱，不能排除所有检查间替换后恢复、文件系统伪造元数据、时间戳能力限制或32位卷序列号碰撞。本地目录必须仍由受信任账户管理。父目录、绑定和实时权限继续由原调用层检查，Windows ACL 不被POSIX mode代替。不同平台设备身份表示的兼容不能授予任何新的文件/网络权限。

## 读取与失败语义

`readLocalFileBytes(path, 'profile'|'outbox', maxBytes)` 是内部原语。profile上限16KiB，outbox上限220000字节且可进一步缩小。验证大小后只分配实际大小+1的Buffer，并以显式偏移读取；一个额外字节用于发现增长。不使用可能读到无限增长文件的readFileSync，不截断并返回部分成功。

原有安全差异保留：队列文件必须恰好一个硬链接和POSIX owner-only权限；profile沿用“所有者匹配、其他用户不可写”的策略，已有profile硬链接不被新模块静默禁止。叶文件类型和权限同时检查路径及打开后的句柄。失败时不写文件、不改权限、不重试、不删除锁或猜测死锁所有者。

描述符始终只尝试关闭一次；有主错误时，关闭失败仅增加固定诊断，不取代主错误。安全诊断通过WeakMap标记，仅含kind/phase/reason/允许的系统码/close_failed，不含路径、卷号、正文或原始错误消息。队列锁包装器保留真实读取错误的系统码和file_read诊断，复制异常不能冒充本地证据。文件数据只在全部校验和关闭成功后返回。

## 验证和运维

`node scripts/check-local-file-read.mjs` 只创建临时合成文件，不接受用户路径/profile/队列参数。进行原生bigint关系检查、200次读取、硬链接拒绝及profile兼容检查，输出201次成功读取与分类。它不宣称每种文件系统都兼容。

`node --test test/local-file-read*.test.mjs` 覆盖合成Windows后端差异、精确inode与纳秒值、文件替换、增长/缩短、硬链接、各阶段IO故障和主错误保留。两项回归在真实原基线消费者上0/2通过，修正后通过，首败留档。

`node test/local-file-read-package.mjs /absolute/installed/ultrabrain-client` 执行实际打包CLI和官方SDK导入：原生文件与明确模拟stat差异各执行status/pause/enqueue/resume，14项检查，暂停入队不启动服务器。它不是用户部署、真实MCP或Windows证据。

专用CI保留Ubuntu/Windows × Node22.16/22矩阵和25轮真实多进程入队；另有实际包安装检查。原锁/控制/全量CI命令未移除。该矩阵存在不等于它已经通过；Windows残余EPERM或旧测试计时故障必须单独记录，不能用设备号修正掩盖。

依据：
- Node22.16.0内置源码：https://github.com/nodejs/node/blob/v22.16.0/deps/uv/src/win/fs.c ，fs__stat_path、fs__stat_handle、fs__stat_assign_statbuf。
- Node22文档：https://nodejs.org/download/release/latest-jod/docs/api/fs.html ，BigIntStats、fstatSync/lstatSync及纳秒时间。

本模块仍是待审开发候选；最终SHA的独立代理审核和CI结果记录在PR及交付报告。不会将旧PR、自查或测试进程当作另一代理批准。
