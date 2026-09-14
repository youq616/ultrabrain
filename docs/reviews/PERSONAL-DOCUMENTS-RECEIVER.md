# Personal documents：接收端修复与实施验证

本文件是实施者记录，不是独立审核批准。最终验收须以 PR #3 中实际 Codex 对完整候选 SHA 的书面结论、同提交 CI 及合并源码树核对为准；不预填未来成功。

## 接收的原始源码

基线 `09a4c8fe95242d5939e28cc3957d4605a6823a81`；原始三次提交 `8fc75aa4949baffc5c3c4c5f4c1df6376d28ba8c` → `2e10b9c88920d0b49f73cf71f2033e45272683ff` → `1e60ac891b22a307f42cbfeaa3e8637299266336`；树 `633be38bb3eeb1c5f40221983a4f02b8956febdb`。ZIP SHA-256 为 `e644d5e74476a1fd203025e7c20dc8298d423788e2b81be87154ebf0c787042e`，增量 bundle 为 `85c35ffaeb4147c28741a58f40bcb0a0bc2e37619ad11d22c09c8b2609efa0f3`。

接收端导入和 bundle verify、提交父子链及源码树核验完成。原始作者和提交对象已经保存在远端，没有为了传输改写 SHA。最后一个原提交只追加审核记录。该本地审核记录的条件性结论不能代替实际 Linux CI。

## 独立审核原始发现及修复

实际 GitHub Codex 审核主体 `chatgpt-codex-connector[bot]`，PR #3 原始审查 `5198549764` 指向 `1e60ac891b`。下列编号是其真实评论，不是实施者生成的独立身份：

| 评论 | 原问题 | 修复 |
|---|---|---|
| 4005899922 / P1 | ownedDocument 查询缺少 Agent/项目字段，真实排队违反 SQL 约束 | 完整查询并贯穿导入、读取、去重及片段 provenance，真实数据库断言 |
| 4005899935 / P1 | delivery 辅助函数制造 consent:true | 独立 allow_documents 与本次明确 consent，冻结原请求，拒绝缺失同意 |
| 4005899946 / P1 | 浏览器 await 后未检查撤销 | 读取/摘要/注册后重查文件、项目、令牌与同意，重试保留同一授权断言 |
| 4005899957 / P2 | 同名同内容跨项目错误复用旧快照 | 去重纳入 Agent 和 nullable 项目，独立快照有独立归属 |
| 4005899962 / P2 | 浏览器固定字节边界切断中文/emoji | 服务器依据不可变原文件做 UTF-8 对齐规划，覆盖全文而不截断 |
| 4005899971 / P2 | lstat 后按路径读取可能跟随替换文件 | no-follow 描述符、读取前 inode 检查、有界读取及读取后目录/文件身份检查 |
| 4005899982 / P2 | 文件模块没有接入实际客户端 | 打包 CLI document-import、5 个受限 MCP 工具、独立许可及真实 Node/PG 测试 |

另修正集成夹具把 64 字节作为中文边界的真实失败，以及夹具 actor 字段/参数类型/SQL 指纹；保留原失败日志，没有删除产品断言或把数据库失败当 Windows 差异。模型不可处理的 NUL/全空白片段明确拒绝，原文件 bytea 不变。管理台锁定清空缓存并拒绝迟到的预览；文件片段不显示普通编辑/激活入口。恢复验证使用文档和片段全列 SHA-256，包含原字节与归属。

## 实施侧实际执行

隔离 Linux 普通用户、Node 22.16.0、Bun 1.3.13、托管 PostgreSQL 18.6。使用与已有 pin 一致的已构建原生运行文件；没有声称重新编译了所有上游。所有输入为合成数据，不读用户文件、真实聊天或客户端设置。

| 执行 | 结果 |
|---|---|
| node --test test/*.test.mjs | 462 通过，0 失败、0 跳过 |
| Python unittest discover test_*.py | 86 通过 |
| personal-documents-integration.mjs | 42 检查通过，真实 PG / dispatcher / stdio |
| document-client-integration.mjs | 11 检查通过，真实打包 Node CLI / MCP 代理 |
| personal-integration.mjs | 43 通过 |
| personal-console-integration.mjs | 21 通过 |
| personal-consolidation-integration.mjs | 29 通过 |
| personal-provider-integration.mjs | 5 通过，受控本地供应商，不是真实模型质量评估 |
| http-integration.mjs | 49 通过 |
| capture-integration.mjs | 20 通过 |
| client-kit-integration.mjs | 19 通过 |
| native-adapters-integration.mjs | 7 回调集成通过，不冒充实际 OpenCode 宿主运行 |
| db backup → restore-new → restore-verify.py | 新隔离恢复目标，27 类指纹一致 |
| health / package-client.sh | 健康检查与实际私有 tgz 构建通过 |

本机 Chromium 被既有管理员策略以 ERR_BLOCKED_BY_ADMINISTRATOR 阻止访问测试地址，**未通过本机浏览器测试**，没有修改或绕过策略。追加的真实浏览器用例、Windows/Linux、实际 OpenCode、n8n 和 15 条旧数据升级路径须由最终 SHA 的 GitHub Actions 验证，不能沿用旧提交绿灯。包装多个测试的外层时间限制曾中止恢复比对进程，随后单独重新运行 restore-verify，27 项完整通过；不把未执行完的第一次当作成功。

原始日志留在隔离运行目录；不上传可能包含私有路径的整份日志。0014 保持接收原文不变，0001..0013、四个上游 pin 与企业白名单没有变化。文件导入不等于完整多模态或 Personal V1 完成，付费模型和用户实际部署未验收。
