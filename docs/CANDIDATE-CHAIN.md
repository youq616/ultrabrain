# 显式候选链检查

用于检查叠加开发分支：末端 PR 的绿色结果不能替代前序 PR 的 CI 或独立审阅证据。本模块在原有单候选检查器之上提供显式链路选择、Git 祖先关系核对、逐层检查及全链二次观察；不自动发现分支，不执行被检查 PR 的代码，不合并或部署。

## 运行

在可信的本轮仓库源码目录中使用 Node 22.16 或更高版本，不需要额外 npm 依赖、Bun、数据库或模型：

```bash
node scripts/candidate-chain-check.mjs < examples/candidate-chain-pr29-pr30.json
```

PowerShell 可使用 `Get-Content -Raw -Encoding utf8 examples/candidate-chain-pr29-pr30.json | node scripts/candidate-chain-check.mjs`。也提供 `npm run candidate:chain`。输入仅从 stdin 接收，不接受 URL、目录、文件路径参数或自动跟随分支。`--help` 不读 stdin、不访问网络。

示例明确选取 PR29、PR30，起点是 PR28 的提交。示例的可信审核者名单为空，因此返回 `blocked` 是预期行为，**不是对这三个 PR 的验收批准，也没有检查起点之前的开发历史**。GitHub 后续如改变所选 head/base，示例会拒绝而不是采纳新版本。

可选 `GITHUB_TOKEN` 只从环境变量读取，仅向固定 GitHub API 的 Authorization 请求头传递。建议多层检查使用只读令牌，以降低匿名限流影响；遇限流不会自动重试。公开数据的读取不要求用户在聊天中提供任何秘密。

## 选择合同

stdin 最多 16384 字节 UTF-8，必须是一份 JSON 对象；拒绝 BOM、重复键（包括转义别名）、过深结构、额外字段、无效 SHA、重复审核者、稀疏数组及访问器。格式如下，实际示例已保存在仓库：

```json
{
  "format": "ultrabrain-candidate-chain-selection-v1",
  "repository": "youq616/ultrabrain",
  "anchor_sha": "完整起点SHA",
  "tip_sha": "完整末端SHA",
  "reviewer_ids": [],
  "candidates": [{"pr": 30, "base_sha": "完整基线SHA", "head_sha": "完整目标SHA"}]
}
```

上述中文占位值无效，不能当实际输入。仓库固定，链按起点到末端顺序排列，包含 1–8 个不同 PR；第一层 base 必须等于 anchor，此后每层 base 必须等于上一层 head，最后一层 head 必须等于 tip。不能重排、跳过失效节点、重复 head、形成环路或回到 anchor。全链使用同一份可信数字审核者名单，最多 8 个。名单由操作者确定，不从 PR 正文获取；它本身不能证明审核者真正独立。

选择对象在首次异步操作前进行数据属性快照并冻结。程序接口为 `collectCandidateChain(selection, {token, signal, authorize})`，其中 authorize 必须是同步实时授权回调。测试用 `get` 可替代传输，但结果明确标为 `caller-supplied-transport`，不是实际 GitHub 认证数据；可信替代函数需要自行配合取消，不保证控制恶意或永久不返回的外部代码。

## 链路与证据校验

先验证起点 Git 提交及树，再用 GitHub Compare API 的不可变完整 SHA 核对每个 base 是对应 head 的祖先：状态必须 ahead、behind_by 为零，merge-base 必须等于所选 base，提交数量须为正且一致。读取固定的 `per_page=1&page=2` 元数据页，避免请求首屏文件补丁；只依赖关系摘要，不宣称遍历了全部提交列表。返回的 patch、diff、URL 和提交消息不会被执行、跟随或写入报告。

每层复用 `collectCandidate` 的九项基础工作流、完整分页、当前 run attempt/jobs、正式 review、非作者可信审核者和精确 head/base 条件，不另写一套放宽的通行规则。所有层必须对应同一数字仓库 ID，不能仅凭同名仓库拼接证据。旧单候选工具默认返回字段和判定保持原样；新增两个显式选项仅供本模块使用：受限祖先查询权限，以及证据观察指纹。

第一次依次检查各层，之后按末端到起点重新检查所有层，最后重新读取起点 Git 元数据。除了比较状态，还比较 Git 身份、工作流和作业身份、审核状态与正文等证据的 SHA-256 指纹。审核正文从一种无效声明改成另一种，即使汇总依然 blocked，也会被视为观察变化。指纹不是数字签名，也不证明测试真实执行；报告只包含摘要，不泄露原始审核正文、会话或测试命令。

没有任何一层可借用末端的批准。draft、失败/缺失 CI 或独立审核缺失均按层列出；存在任何阻断即整体 blocked。当前阶段只支持显式“待验收候选链”，已关闭或合并的节点仍沿用单层规则返回阻断；需要把已经正式验收的历史作为起点时，必须由操作者另行核实并更新选择，程序不会自动认证起点。

整个工具最多 320 次 GET、180 秒网络/CLI 等待窗口，仍保留单层每页 100 项、最多 10 页、最多 80 次请求、单次 HTTP 10 秒和 4 MiB 响应上限。常见两层、每工作流一个 run 的夹具实际为 68 次 GET；更多运行或分页会增加读取。超过上限、部分分页、任意层变化、取消、HTTP 错误均返回未确认，不输出残缺的绿色链。无重试、无缓存、无后台监控。两轮 REST 读取仍不是数据库事务，未观察到的变化或 ABA 变化不能被保证发现。

## 输出和退出码

输出格式 `ultrabrain-candidate-chain-check-v1`，包含选择指纹、数字仓库 ID、起点/末端、逐层候选报告、祖先关系和 `blocked_prs`。退出 0 只表示显式选定范围的机械条件满足；退出 2 表示完整观察到了阻断；退出 1 表示无效、失败、变化或证据不完整。失败只返回安全代码，无原始 HTTP 错误、令牌或部分节点报告。

以下限制始终保留：`merge_authorized:false`、`anchor.acceptance_verified:false`、`unselected_dependencies_verified:false`。此模块不认证起点、未选依赖、整个仓库所有 PR、分支保护、runner 实际 checkout、测试质量、独立会话真实性或用户部署。单层报告中关于它自身不验收整个叠加链的限制也仍保留；本模块只是对显式选择的相邻层逐项检查，不能变成自动合并门槛。

## 验证

`node --test test/candidate-chain.test.mjs test/candidate-chain-cli.test.mjs test/candidate-chain-review.test.mjs` 包含 87 项本轮测试；与原有检查器 115 项同时运行共 202 项，均计入全量测试，不重复相加。使用合成 REST 数据、真实 Response 流和真实 CLI 子进程，不等同真实在线请求。

原有 Windows／Ubuntu 清单保持不变，新增独立步骤。`candidate-evidence.yml` 保留原单层在线检查，再运行 `test/candidate-chain-live-integration.mjs` 对固定 PR29/30 进行真实只读 API 验证。它故意断言无审核者配置时被阻断；成功只证明收集/拒绝误批准的链路可执行，不能当独立代码审核。实际执行结果以最终提交的 CI 为准。

API 依据：GitHub 官方 Compare two commits 与 Actions/Pull request reviews 文档。祖先摘要页已通过当前连接实际读取验证；本机原生网络测试如受 DNS 限制，不能将连接器读取或合成传输改称原生 CLI 在线验收。

参考：https://docs.github.com/en/rest/commits/commits#compare-two-commits
