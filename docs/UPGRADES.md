# 上游更新与安全升级

## 版本来源

`upstreams.lock.json` 是版本依据。GBrain、OpenViking、PostgreSQL 和 pgvector 分别记录完整提交 SHA；Git submodule gitlink 必须与之匹配。原作者上游和你的 fork 分开检查，不能把 fork 没有更新误认为原作者没有更新。

OpenViking 当前是参考来源，不是运行依赖。仅更新其 gitlink 不会自动给 Ultrabrain 增加功能。

## 日常检查：不改变运行中的系统

```bash
python3 scripts/upstreams.py check
```

输出 JSON 包括锁定版本、原作者与 fork 的变化、比较地址、PostgreSQL 同主版本稳定发行候选及跨主版本提示。网络失败或 ref 不存在返回非零状态，不能解释为“没有更新”。

`.github/workflows/upstreams.yml` 在成为默认分支工作流后可每周检查，也支持手动触发。新候选集合会产生去重的审查 Issue。它只发现更新，不自动合并代码、不部署、不迁移数据库。

## 准备代码候选

在干净的开发 checkout 中操作，不在生产运行目录里直接更新：

```bash
python3 scripts/upstreams.py prepare gbrain --ref refs/heads/master
```

OpenViking 使用 `refs/heads/main`；PostgreSQL 必须指定稳定发行 tag，不能把开发分支当作发行版。脚本创建独立候选分支、更新源码指针与 lock、生成 `upgrade-candidate.json`，不会自动提交或部署。

许可证文件有变更时先停止审查；只有完成审查后，才使用 `--accept-license-change`。这个选项是显式操作确认，不是许可证兼容性证明。

候选的提交必须能从 `.gitmodules` 指定的仓库获取。吸收原作者提交后，需要确认你的 fork 含有该提交，或者在同一个审查变更中调整来源地址。不能只在维护者机器上 fetch 成功就假定其他服务器可安装。

## 功能吸收流程

先阅读差异及相关测试，更新 `docs/FEATURES.md`，区分修复、公共接口变化、新功能、数据结构变化和许可证变化。GBrain 的公共功能优先通过原生入口继承；适配层只处理 Ultrabrain 的命名、上下文和运行约束。不要把整份代码复制到第二套业务实现里。

OpenViking 的候选功能需要实际移植或独立实现、迁移映射与验收。检查到新提交不代表功能已经吸收。必须保持单一记忆存储和统一授权，不引入两个彼此分离的生产记忆库。

## PostgreSQL / pgvector 运行目录

每个运行目录包含 PostgreSQL 与 pgvector 两个提交的标识。构建新版本不会覆盖当前使用的目录。数据库管理器使用 `postgres/runtime.json` 中的活动绑定；即使源码 lock 已改变，也应仍能用原来的活动二进制停止旧进程。

同 PostgreSQL 主版本的切换顺序：停止 MCP 服务和 Agent 写入；完成备份与恢复演练；构建并验证候选；停止数据库；显式激活候选；启动数据库；运行管理员准备、应用迁移和健康检查。

对应原语是：

```bash
bash scripts/build-postgres.sh
bun src/cli.mjs db stop
bun src/cli.mjs db activate-runtime
bun src/cli.mjs db start
bun src/cli.mjs db init
bun src/cli.mjs migrate
bun src/cli.mjs health
```

这段命令不是无人值守升级配方：执行前必须完成前述停写、备份、审查与隔离验证。不要在不了解当前 schema 兼容性的情况下直接复制到生产主机。

**pgvector 二进制更新与 SQL extension 更新不同。** 当前 `db init` 的 `CREATE EXTENSION IF NOT EXISTS` 不会升级已经安装的扩展。需要审查相应 extension 迁移脚本，再以本地管理员执行所需更新；`health` 会报告扩展版本不一致。在这条路径完成独立验收前，不把 pgvector 升级描述成全自动。

## 备份和恢复

```bash
bun src/cli.mjs db backup --destination "$HOME/ultrabrain-backup-before-upgrade"
bun src/cli.mjs db restore-new "$HOME/ultrabrain-backup-before-upgrade" --database ub_restore_upgrade_test
```

目标备份目录必须尚不存在。恢复只创建以 `ub_restore_` 开头的新数据库，不替换当前数据库，不自动切换应用配置。格式 2 会核验 dump 的 SHA-256，拒绝不完整标记或校验不匹配。

这是 **database-only** 备份。模型与数据库配置、令牌秘密文件、资源附件/对象文件、源仓库和部署配置需要另行以适当权限备份。不能用一份数据库 dump 宣称全部业务资产可恢复。

历史备份应配合创建它的版本和运行依赖保存；新工具明确拒绝不认识的备份格式。数据库内容指纹校验只在隔离、停写测试库中有确定意义。

## 跨主版本及回退

当前管理器拒绝把旧主版本 PGDATA 直接交给新主版本运行目录。跨主版本必须采用单独的新集群逻辑恢复或经过演练的 pg_upgrade 流程；该自动化还没有完成验收。

切回旧二进制不是数据库 schema 回滚。应用迁移、扩展迁移或跨主版本变化后，应根据兼容性选择经过验证的恢复流程。原运行目录和备份应保留，但不要承诺任意升级都能原地一键回退。

## 发布门槛

发布应绑定具体 commit SHA。必须确认同一提交的单元、运维、真实 PostgreSQL、MCP stdio、HTTP 鉴权、备份恢复和运行目录切换测试完成并成功。源码快照工作流成功只证明归档完成，不证明程序测试通过。不能拿上一个提交的绿色 CI 代替新提交的结果。
