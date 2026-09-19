# 首次控制台凭据初始化

`personal-init status|create-token` 补齐首次 bootstrap 与个人控制台部署之间的凭据准备步骤。它只用于**已经 bootstrap 的普通 Linux 账号安装**，不负责 bootstrap 本身，也不是完整安装或应用就绪认证。

## 调用与部署顺序

在可信仓库目录、安装所属的普通 Linux 账号执行；明确设置 `ULTRABRAIN_HOME` 或传入绝对 `--home`。新入口在 Linux 下使用 `/usr/bin/python3 -I -B`，不会从 PATH 选择其他 Python，也不会启动 Bun、psql、systemctl 或模型进程。直接 Python 入口不要求先安装客户端。

```bash
# bootstrap 已由操作者明确执行完毕；此命令不会自动执行它。
bun src/cli.mjs personal-init status --home "$ULTRABRAIN_HOME"
bun src/cli.mjs personal-init create-token --home "$ULTRABRAIN_HOME"
# 或使用同一实现的直接入口：
/usr/bin/python3 -I -B scripts/personal-init.py status --home "$ULTRABRAIN_HOME"
```

`status` 在缺少令牌时返回退出码 1、`token_creation: "absent"`、`credential_ready: false`，但不创建任何文件。`create-token` 是明确的创建请求：固定目标为 `$ULTRABRAIN_HOME/personal-console-token`，输出只给相对文件名，不给令牌内容、令牌哈希、数据库密码或模型密钥。已有合法令牌返回 `existing`，保持原字节、权限与 inode，不自动轮换。

推荐顺序：`bootstrap-linux.sh` → `personal-init create-token` → [个人服务计划](PERSONAL-SERVICES.md)与[部署](PERSONAL-DEPLOY.md) → [激活](PERSONAL-ACTIVATE.md) → [就绪检查](PERSONAL-READY.md)。后续部署、数据库启动和控制台激活仍各自需要原有显式操作及校验；本入口不会代为执行。成功初始化不提供可信实例 UUID；UUID 仍按 PERSONAL-READY.md 通过可信数据库/MCP 身份取得，不能猜测。令牌只在本机供操作者登录控制台，不发到聊天或提交到仓库。

当前阶段的测试和审查状态见 [实现复查记录](reviews/personal-init/README.md) 及候选 PR；不以文档新增或命令存在宣告个人 V1 全部完成。

## 安全与持久化合同

复用 `preflight.py` 的目录描述符、私有文件和有界读取校验；检查既有数据库状态、原生配置的回环地址/密码绑定、固定 PostgreSQL/pgvector 版本、构建标记、可执行文件元数据和集群 major。不会连接数据库、启动服务、开放端口、读取记忆、迁移结构、修改模型配置或启用采集。检查的是离线元数据和已声明绑定，不是二进制供应链认证、MCP 鉴权验收或在线健康。

创建使用固定文件名与目录描述符上的 `O_CREAT|O_EXCL|O_NOFOLLOW`，只对本次新文件设定 0600，处理短写，并依次同步文件和父目录。返回成功前，比对原始生成字节、最终 inode/文件签名、安装路径与已读配置。符号链接、硬链接、FIFO、目录、宽权限、过长或畸形令牌均拒绝，不修复、不删除、不截断；外部创建者先占据文件名时，只校验其已有结果，不发第二次写入。

初始化进程之间使用安装目录 inode 的非阻塞 flock，没有额外锁文件。冲突明确返回 `initialization_busy`，进程退出后内核释放锁。它**不**锁住运行中的控制台、部署器或其他同账号操作者；也不提供同 UID 对抗性隔离或原子目录快照。操作应在协作维护窗口进行。并发非协作写入会尽力检测后拒绝，而不是宣称能阻止所有竞争。

缺少令牌且已有 `personal-deployment` 或 `personal-activation` 路径时，返回 `token_recovery_required`；空目录、损坏记录和链接也不按“首次运行”处理。防止把部署后丢失的凭据自动解释为新安装。初始化器不读取或修复这些记录，也不取代部署/激活的共享日志与锁。

## 失败和恢复边界

故意不采用删除后重建，也没有自动轮换或清除残留开关。磁盘满、零字节写入、同步失败、进程被终止或路径变化可能留下不完整文件；失败输出为 `token_creation: "not_proven"`，不能据此声称没有落盘。下次遇到畸形或空文件会拒绝并保留原文，不生成另一个令牌掩盖第一次失败。应在本机检查并按现有恢复流程处理；不要把令牌贴到工单或日志。

如果第一次文件已完整写入但同步/回执阶段失败，后续只读 `status` 可观察到一个合法的 `existing` 文件。这只证明本次观察可读取该字节，不是过去那次 fsync 成功或未来掉电持久性的证明。已发送或已泄露的凭据也不可能靠这个入口撤回。

本轮另修正 `personal-deploy` 的命令行默认 home 求值顺序：先解析参数与校验平台/UID，再在确实需要时查询账号默认目录，并把账号查询异常包含在脱敏错误处理内。显式 `--home` 和 `ULTRABRAIN_HOME` 不再触发不必要的 passwd 查询；部署本身的授权、状态机、日志和服务操作不变。
