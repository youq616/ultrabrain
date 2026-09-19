# 独立审查反馈修正：只读状态也识别凭据恢复

本修正在 `b24f1c4d2dd9a8bf2a2b84a45c55d6f7515b665b` 之后追加，不覆盖先前提交与首败记录。

## 实际独立审查记录

GitHub reviewer：`chatgpt-codex-connector[bot]`，用户 ID 199175422；GitHub review ID **5255138559**，提交时间 2026-09-19T08:43:26Z；绑定的完整审查提交为 `b24f1c4d2dd9a8bf2a2b84a45c55d6f7515b665b`。审查状态 `COMMENTED`，不是 `APPROVED`。活动汇总评论 5740543567 报告该轮 Completed，内联发现评论 **4052688941** 位于 `scripts/personal-init.py` 原第 97 行附近。

独立 reviewer 指出一项 P2：令牌不存在且已有 personal-deployment/personal-activation 历史时，status 跳过恢复检查，误报普通首次运行 absent；只有后续 create-token 才返回 token_recovery_required。应对所有缺失令牌执行只读历史判断。该发现不是实现助手自审冒充的独立意见。reviewer 未披露内部执行 session ID 或运行过的测试，相关字段不推断、不伪造；没有将该轮算作正式独立批准。

## 修正与新增验证

把 `require_fresh_setup()` 移到“令牌缺失”的公共路径；创建动作前的第二次历史/路径检查保持不变。status 不生成随机数据、不创建文件，不读取历史内容；空目录、损坏文件、悬空链接和 FIFO 都视作已有历史。合法既有令牌在已部署情况下仍能只读复用，不改变字节/权限/inode。

新增 `test/test_personal_init_recovery_status.py` 5 个方法。先在被审 b24f1c4 应用源码上运行：10 个失败断言（包括 subTest），首败保存为 `reviewer-first-failure.log.gz`；修正后 5/5 通过。重新执行普通账号 Node 全量 **615/615**、Python 全量 **594/594**、优化模式初始化相关 **48/48**，均通过。一次把多组测试放在同一工具执行中的优化组被总执行期限中断，完整原始日志保留，另行重跑才取得 48/48；中断不计为通过。

真实 CI 初始化测试增补 status/create-token 两项：测试本身暂存其新生成的令牌，建立临时历史标记，验证没有生成替代凭据，并在 finally 恢复测试原始状态，再继续认证控制台与实际服务/部署/激活测试。这只是固定授权 CI 安装上的负例，不访问用户部署。最终新提交的 CI 与独立复审须重新读取，旧 b24f1c4 的10项初始化成功不能替代修正后的12项。

日志和源文件哈希在 `review-correction-evidence.json`。新提交发布后需要对最终 SHA 再次独立审查；旧提交的 Completed 或绿灯不覆盖本次变更，main 保持不变。
