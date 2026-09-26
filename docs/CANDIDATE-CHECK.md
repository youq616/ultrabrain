# 候选版本验收证据检查器

此工具把“CI已通过，但精确提交的独立审阅证据仍缺失”变成可执行检查，避免只根据绿色标志、旧SHA批准、审核请求或emoji判断候选已完成。它不替代人工/独立代理代码审查、不批准合并、不执行被检查PR的代码，也不修改仓库、数据库或用户服务。

## 使用

在可信的本轮源码目录中运行（Node22.16+，不需Bun、第三方包或数据库）：

```bash
node scripts/candidate-check.mjs --pr 29 --head ddc75d0e5688289fe1722e616f8503269b293a4d --base d5e3c3c322e68e06405f511580d36a48b64ca577 --reviewer-id 199175422
```

也可使用 `npm run candidate:check -- ...`。PowerShell可执行相同的单行Node命令。仓库固定为 `youq616/ultrabrain`，必须提供完整小写head/base SHA；不接受分支名、缩写、URL或自动追随新的head。数字reviewer ID必须由可信操作者预先确定，可重复该选项配置最多8个不同审核者。**未配置审核者不会接受任何批准**。PR作者即使在名单内也不能给自己通过；名单本身不能证明同一人没有控制其他账号。

公开数据可以匿名读取。`GITHUB_TOKEN`是可选环境变量，只需要目标仓库的Contents/Actions/Pull requests读取权限；不要在命令行、聊天、配置文件或报告中填入令牌。工具只向固定 `https://api.github.com/repos/youq616/ultrabrain/...` 发送GET，不跟随重定向或API返回的任意URL，不下载工件，不读取日志或聊天内容。报告包含仓库、PR、SHA、数字审核者/运行编号及状态，仍是项目内部元数据。

## 检查范围

读取PR、提交树、PR事件的工作流运行、每个运行当前尝试的作业、正式提交的review，完整分页后复查PR及两类集合。检测到head/base/draft、运行尝试/状态、批准撤销或审阅正文变化时，整体返回证据变化，不输出部分成功报告。REST不是事务；变化后恢复原值等未被观察到的竞态不在保证范围内。

固定基础工作流为：ci、client-portability、native-client-engines、personal-identity、personal-overview-smoke、personal-recall-preview、personal-services、recovery、task-context（均为 `.github/workflows/*.yml`）。这是本轮经代码审阅的九项基础清单，不是从PR正文或任意调用参数获得，也不会自动把未来新增工作流当成必需项。新 `candidate-evidence.yml` 是检查器自身的测试，故不加入其诊断条件；完整Validate及跨平台测试仍执行检查器的新单元用例。

必须同时匹配仓库ID、PR编号、head与同一个PR关联中的base；push或pull_request_target不能替代PR运行。相同head/base下的**所有相关运行**均须completed/success，当前尝试的所有作业必须存在且成功，不接受skipped/neutral。重跑较旧run ID也可能发生在较新ID之后，不能只取最大ID隐藏它。历史失败可通过对同一个run ID成功重跑覆盖当前attempt；保留另一失败run ID则继续阻断，这是一项故意保守的策略。旧base运行不作为当前base证据；没有匹配当前base的运行会报告stale_base。

每页最多100项、最多10页，每个HTTP响应最多4MiB，最多80次GET；单次请求10秒、总网络窗口90秒。超过分页/大小/请求上限、重复编号、数量不一致、权限拒绝、限流或取消都返回未确认，不悄悄截断、重试或降级。对同一SHA的并行大量历史运行可能触发上限，需要另行人工调查，不代表候选通过。

## 独立审核证据

只从GitHub正式review记录读取批准，不从普通评论、PR描述、CI结果或附件取得批准。配置名单中非PR作者的最新决定性review须为APPROVED，`commit_id`须为当前完整head，正文须是以下结构的**单个JSON对象**（不是Markdown代码块），且绑定完整base/head：

```json
{
  "format": "ultrabrain-independent-review-v1",
  "repository": "youq616/ultrabrain",
  "pr": 29,
  "head_sha": "REPLACE_WITH_ACTUALLY_REVIEWED_FULL_HEAD_SHA",
  "base_sha": "REPLACE_WITH_ACTUALLY_REVIEWED_FULL_BASE_SHA",
  "scope": "entire-diff",
  "reviewer_session": "REPLACE_WITH_ACTUAL_REVIEWER_SESSION_OR_RUN",
  "independent": true,
  "verdict": "approve",
  "findings": [],
  "tests": [{"command": "REPLACE_WITH_ACTUALLY_EXECUTED_COMMAND", "exit_code": 0, "passed": 1, "failed": 0, "skipped": 0}]
}
```

示例占位值不是有效证据，不得把它当成真实批准。实际审核者须自行执行复审并填写事实；非阻断发现的结构为 `{severity:"nonblocking", path:"src/file.mjs", line:1, note:"实际发现"}`。存在阻断发现、未执行测试、错误SHA、部分范围或缺失会话时不通过。tests须至少一项真实执行结果，记录跳过数量但不据此证明充分覆盖。其命令只是数据，程序绝不执行它。重复JSON键与超深结构拒绝。

正式决定按submitted_at及同时间编号排序，不以草稿创建编号代替提交时间。新的CHANGES_REQUESTED会阻断，包括对旧SHA尚未被该审核者的新决定取代的请求；另一个人的批准不会取消它。DISMISSED使对应批准失效，普通COMMENTED不会创造批准，也不会自行撤销正式决定。正式review正文和记录绑定真实GitHub审核者ID，但**本工具不能证明其会话真实存在、确实独立、测试确实执行或覆盖充分**；这些仍需人工检查。报告仅输出review编号与正文SHA256，不回显会话、审阅文字或测试命令。

先前自然语言形式的独立审核记录不会被自动转换或冒充为此格式。它们仍是有效的人类可审阅证据；该机器工具只会报告“未找到符合当前格式的证据”。检查当前PR的entire-diff并不验收base及整个叠加PR链。

## 输出和退出码

成功收集返回 `ultrabrain-candidate-check-v1`。`status: blocked`表示完整观察到了缺失/不满足项；`metadata_requirements_met`仅表示上述机械条件满足。**`merge_authorized`始终false**。draft、PR关闭、未通过基础CI、缺少独立review、review要求修改都会作为blockers列出。

退出0：机械条件满足，但不是合并批准；退出2：有明确阻断项；退出1：读取/证据不完整或变化。失败只输出安全错误码，无原始HTTP错误、令牌或局部计数。SIGINT/SIGTERM停止等待；收集完成到stdout之前还要再检查取消。

不能从workflow元数据证明实际checkout提交/源码树、每个测试步骤确实覆盖本模块、模型质量、分支保护全部满足、基础分支已接受或实际用户部署成功。`tree_sha`来自候选Git提交，不是runner checkout证明。报告明确保留这些限制，禁止将机械绿色用作自动merge条件。

## 程序接口与验证

`collectCandidate(selection, {token, signal, authorize})`实时读取GitHub。同步authorize沿用既有授权边界。`get`仅供受信任调用方替换传输、如测试；结果标为caller-supplied-transport，不能冒充官方网络读取。纯函数 `evaluateCandidate(selection, evidence)`只评价调用方提供的已收集JSON，不认证数据来源；不要把模型生成的“全绿证据”当作GitHub事实。

本轮使用真实CLI子进程、模拟官方REST分页/限流/变化/取消、正式review版本绑定和副作用边界测试。`candidate-evidence.yml`另用只读GitHub令牌调用已固定PR29，断言在没有配置审核者时仍然blocked；它的成功仅表示在线收集和拒绝误批准路径可执行，不是接受PR29。该历史PR的head/base以后变动会让测试明确失败，需要经审核更新固定夹具，不自动跟随。

API依据：GitHub REST workflow runs、workflow jobs与pull request reviews文档。工具声明的范围与官方API字段不同于仓库强制独立代理门槛；它辅助该门槛，而不是绕过它。完整本轮执行结果与首次失败见复查报告，CI脚本存在不代表已经通过。
