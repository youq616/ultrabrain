# 0.3.1-alpha.1：可验证的迭代流程

## 本轮范围

本版本不变更 GBrain、OpenViking、PostgreSQL 或 pgvector 的锁定提交，也不声称已经完成语义摘要、多模态或数据库跨主版本升级。它修复实际采集缺陷，并把应用升级与上游候选审查纳入可重复测试。

### 队列大小与损坏隔离

原始 transcript 限制仍是 64 KiB。JSON 转义可能扩大到六倍；现在读写两端使用同一个 512 KiB 日志 envelope 限制，并在创建临时文件之前检查序列化大小。旧版本已经写入的较大合法记录可以由新版本读取，不需要修改内容或更换 event_id。

flush 遇到损坏事件、ACK、重试记录或不安全符号链接时，会创建不含正文的 quarantine 标记，保留原文件并继续处理其他记录。force 不会绕过 quarantine。inspect 是只读的，输出状态而不是正文。人工核查并修复相关文件前不得删除 quarantine 标记；未确认事件不会被自动丢弃。磁盘故障等未知 I/O 错误仍会明确失败。

### GBrain 适配层和接口合同

`src/adapters/gbrain.mjs` 集中管理原生导入、导出检查、136 个初始原生工具的参数/scope/mutating 指纹及目录写授权集合。新增、删除和改变工具均需审查；描述文字变动不触发误报。

```bash
bun src/cli.mjs compat
bun scripts/export-contract.mjs > /tmp/gbrain-contract-candidate.json
```

第一条只报告，不写数据库。第二条只导出建议合同，不覆盖 `compat/gbrain-v1.json`。核对上游源代码、安全语义、参数和行为测试之后，才能在候选 PR 中显式更新合同。合同相同只证明结构相同，不证明函数内部行为、ACL 或返回内容一定相同。

### 自有 schema 迁移账本

`migrations/0001-baseline.json` 固定了 0.3.0 的元数据建立与旧 JSONB 修复语句。迁移以显式 statement 数组保存，不在执行时按分号拆 SQL。`ultrabrain.schema_migrations` 保存编号、checksum 和时间；事务级 advisory lock 串行化并发迁移。语句与账本一起提交，失败一起回滚。未知历史、缺号或已执行迁移内容被改动会拒绝继续。

旧安装的元数据按幂等基线语句接纳，不删除页面和项目数据。迁移后仍需保留上游 GBrain 自己的 schema 迁移机制；这个账本不是 PostgreSQL 主版本升级器，也不保证上游迁移全部可逆。

升级应用前停写并备份，使用原服务账号运行 `db init`、`migrate`、`health`。MCP preload 会检查迁移状态，不把尚未迁移的应用当作可服务状态。回退到不认识迁移账本的旧应用必须经过单独兼容性判断。

### 真正的旧应用升级测试

CI 从不可变提交 `38e0e6657561e17ba85c71d0783d604242a054e8` 检出旧应用并运行其 bootstrap，再写入页面、private 数据、项目/历史、会话回执及旧队列大记录，然后才运行候选版本。验证保留数据指纹、ACL、事件重放、队列读取、重复迁移、并发迁移及故障回滚。

```bash
# 仅用于隔离的测试 ULTRABRAIN_HOME。会创建数据库和写测试数据。
ULTRABRAIN_TEST_ALLOW_WRITE=1 bash scripts/test-upgrade.sh
```

这证明的是所测旧应用到候选应用的路径，不是所有历史版本或跨 PostgreSQL/pgvector 版本的迁移矩阵。默认仍拒绝未实现的跨主版本切换。

### 独立检查与候选 PR

每个上游现在使用独立的 matrix job；某一检查失败不会取消其他上游。一个项目内部若原作者查询成功、fork 查询失败，仍报告候选，同时明确报告失败，作业保留 failure 状态。不要把部分失败解释成没有更新。

`tracking_ref` 与锁定发行 `ref` 可分别记录；prepare 改变发行目标不会顺便停止跟踪主分支。候选还必须从一个全新的 bare 仓库证明能通过配置的安装地址获取确切 commit，不依赖维护者已有对象缓存。

```bash
python3 scripts/upstreams.py check --project gbrain
python3 scripts/upstreams.py prepare gbrain --ref refs/heads/master
# 只有确认要将安装来源改为原作者仓库时才额外使用 --use-upstream-source。
```

在 GitHub Actions 选择 **Prepare upstream candidate**，从默认分支手动执行，选择项目和完整 ref。它只准备源码指针、lock、安装来源和审查记录，创建 draft PR，并显式 dispatch 权限为 contents:read 的 CI。没有自动 merge 或生产部署。新增工具的合同变动会让 CI 失败，需要审查后更新。

写权限 job 不安装依赖、不构建、不执行上游程序；不得改成 pull_request_target 执行候选代码。现有候选分支不会被强制覆盖；重复运行需复用审查，遇到创建 PR/dispatch 失败可人工继续现有分支。仓库必须允许 Actions 创建 PR 和执行工作流；本版本不会修改仓库的权限设置。

GitHub 使用 GITHUB_TOKEN 创建的 push 不保证启动 push CI，所以这里显式调用 workflow_dispatch。参考 GitHub 官方说明： https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow 。源检查和候选发布的 API 调用有离线模拟测试；真实远程候选生成的结果应另行绑定具体工作流运行。

### 功能映射和效果门槛

`compat/upstream-features.json` 记录参考提交、关注路径、Ultrabrain 实现、测试及尚未完成的边界。prepare 会把变更映射到 affected_features；未映射路径仍要求审查，不能默认安全。OpenViking 指针更新不会自动带来其功能。

成对检索报告必须有相同的标签集 hash、语料 fingerprint、评测类型和案例集合。不同语料、不同类型或缺少身份的报告会被拒绝比较；候选泄露禁用证据或降低检索指标会失败。

```bash
bun scripts/compare-evals.mjs baseline-eval.json candidate-eval.json
```

CI 在旧数据上进行的是两个固定合成词法案例的前后对比，另保留原有五案例回归。没有调用语义模型，也不证明真实长期语义质量。延迟记录但暂不设置跨机器硬阈值；模型质量、成本、多模态和生成答案需额外数据集与验收。
