# 控制台激活与中断恢复验收档案

本阶段已通过 [PR #13](https://github.com/youq616/ultrabrain/pull/13) 合并，并完成主分支回归。当前结论以 [最终机器记录](evidence.json)、[完整阶段独立审核](boundary-review-88e05f3.md) 和本索引为准。命令与支持边界见 [PERSONAL-ACTIVATE.md](../../PERSONAL-ACTIVATE.md)。

| 对象 | 精确提交或代码树 |
| --- | --- |
| 完整审核候选 | `88e05f3f84d1cd1ac2e3fdf2f22237c84c6cb3c4` |
| PR 实际测试 merge | `bdb287727eed2c574385aded849e8b923bf71fda` |
| main 应用合并 | `17bf51a2e998718665082a0245b5b49369ac6ec6` |
| 上述三者的共同代码树 | `f8f540288ffcc5de31b865588130528f05130c71` |

候选的六组 PR 工作流 23 jobs 与七组 push 工作流 24 jobs 全部成功；合并后的 main 七组工作流 24 jobs 再次全部成功。[候选完整 CI](CI-EIGHTH-ALL-AUDIT.json) 和 [main 完整 CI](POST-MERGE-ALL-AUDIT.json) 逐项保存真实运行与作业身份。main 记录只计算 main/push/精确合并 SHA，排除了相同 SHA 的文档分支运行。

普通用户 CI 的完整单元测试为 563 Node / 542 Python，均通过、无跳过；15 条历史升级路径与 n8n 引擎成功。两份候选服务运行和 main 服务运行分别通过 18 项 activation、15 项 deployment、12 项 readiness 与 18 项既有 services。每份既有 services 另有 2 次本地合成供应商调用；新 activation/readiness 的模型调用为 0。原始计数见 [候选服务](CI-EIGHTH-SERVICES-AUDIT.json)、[主分支服务](POST-MERGE-SERVICES-AUDIT.json)、[候选单元测试](CI-EIGHTH-UNIT-AUDIT.json) 和 [主分支单元测试](POST-MERGE-UNIT-AUDIT.json)。

## 实际独立审核

| 实际审核者 | 结论与本人执行 |
| --- | --- |
| `/root/activate_boundary_review` | [完整阶段 PASS](boundary-review-88e05f3.md)；本人执行 52 manager、87 deploy Python 和 14 Node CLI，另有 42 Python / 16 JavaScript 边界检查。 |
| `/root/activate_boundary_review/dbus_abi_crosscheck` | [journal/recovery/CLI 补充 PASS](recovery-boundary-review-88e05f3.md)；本人执行 52 state 和 71 ready/process Python。此报告明确不是另一份独立的整阶段验收。 |

两者均未参与实现；当前提交的相关测试合计为 262 Python 与 14 CLI，另有 58 项补充检查。此前的 `/root/activate_recovery_review` 报告只覆盖其原提交，不能冒称该旧会话审核了当前候选。[最初保存的当前 PASS](boundary-review-88e05f3-initial-pass.md) 与最终加入全部 CI 交叉核对的报告均按原字节保留；其审核代码和 PASS 结论相同。

七个真实进程退出点全部执行，每个点均无额外启动。未读取回复的发送场景在三份服务运行中都观察到 ready，同时保留 dispatch outcome_unknown；不能据此声称执行了该路径的 manager 拒绝终态或真实 transport NoReply 分支。两个已经持久化 receipt 的恢复场景返回 application_ready=not_checked。源记录删除后的拒绝、恢复源后的同一 console 实例、真实 flock 互斥和配置不变均通过。

## 首次失败与完整原始材料

[验收前历史快照](history-before-acceptance.json) 保持 revision 4 原字节，其中 PENDING 和“尚缺最终审核”准确描述生成时状态；它不是本阶段当前结论。快照包含八个候选、逐轮 CI 和审核归属，不把取消、未执行或继承测试改写为通过。

| 历史候选或预审 | 保留的发现及修正 |
| --- | --- |
| 未提交预审 | device 的隐藏 following 集合可扩大事务；实际复现后增加可达 device/swap 的拒绝。 |
| `9e85892` | 初始 systemctl 缓存夹具失败；另有并发 capture 夹具失败，原 child stderr 已丢失，不能确定其错误码。 |
| `071b7f4` | dbus-python 1.3.2 同步 C API 不接受 timeout 关键字；以真实位置参数限制建立失败回归后修正。 |
| `def34fb`、`70cd4cc`、`80d6314` | manager proc 验证失败；诊断确认读 exe 的 EACCES 及能力条件。保留生产验证，仅规范一次性 CI manager 能力。 |
| `c6b409c` | CI setup 即时名称查询失败，服务测试均未开始。 |
| `9f4e5c2` | setup 通过后初始 plan 拒绝依赖数组；实际字段未记录。 |
| `88e05f3` | 固定 v255 源码和先失败回归证明被动 swap 引用的兼容问题，修复后全部真实场景通过；不倒推 CI7 未记录的原始值。 |

全部历史快照 source_inventory 原始字节及最终补充材料已存入 [raw-evidence.zip](raw-evidence.zip)，共有 181 项，逐项字节数和 SHA-256 见 [归档清单](raw-evidence-manifest.json)。ZIP 内以原 relative_path 保存；原文报告中的临时路径指其原执行环境，可通过同名 ZIP 条目取得原始文件。ZIP CRC、全部条目哈希以及历史 170 项字节均已逐项校验。当前核心报告与 CI 摘要另以本目录独立文件提供阅读，完整测试日志和实现者源码分析保存在 ZIP 中。保留的受控脚本和源代码片段是审核材料，不是新增产品入口；上游源码保持原通知及固定来源链接。

本地 UID 0 环境最初全量门槛失败、受控夹具失败、分析器首次提取断言及后续修正都在材料中区分，未放宽普通账号保护或冒充真实服务通过。真正的普通用户 manager、数据库和 HTTP 结果来自明确标识的 GitHub CI。

## 验收边界

支持已安装且停止的 console-only 配置、已有令牌与已运行的托管数据库，以及 systemd 255 同管理器的观察式恢复。运行中切换、自动停止/回滚、跨 manager/boot 恢复、用户主机部署、全部客户端与真实模型质量仍未验收。同 UID 维护窗口与可读 proc 身份是明确前提，所选缓存属性的验证不等于所有设置或内核 socket 归属认证。

本档案、README、项目状态与检查表是应用合并后的文档更新。上述应用 CI 只属于精确应用提交及相同代码树，不是对后续文档提交重新运行的应用测试。
