# Personal 0.12：分离实施阶段的仓库复核

## 结论与独立性边界

基线为 `a81374c1bc626623616a47358f7105c91a49dea5`。新客户端实现后，复制到单独的审核工作目录，重新检查全仓库入口、身份/授权、SQL/迁移、模型/队列、配置/凭据、Web/MCP、运行脚本、测试和备份边界，并在独立副本运行全套可执行回归。发现项采用先复现、再修复、再重测，不使用先前版本的通过数量替代本轮证据。

**这是同一助手在与开发分开的阶段和目录里进行的复核，不是另一名审查者、外部审计公司或独立安全认证。**全仓库检查指应用与运维范围、接口合同、变更影响和系统回归；不是对 PostgreSQL/GBrain/所有第三方依赖逐行审计，更不是已证明没有其他漏洞。未把新增客户端当成个人 V1 全部完成。

## 已复现并修复

| 编号 | 发现与影响 | 处置与回归 |
|---|---|---|
| R01 | 内部个人身份函数接受 `transport:http + remote:false + 无认证` 时可能落到 host owner。外部原生 HTTP 仍有认证，不将此内部组合复现包装成已证明的公网漏洞。 | 只允许明确 stdio，或非远程的本机 CLI/未设 transport 进入 host 分支。认证 HTTP 一律不回退。保留原生 stdio 本来使用 `remote:true` 的合同。测试未知 transport/矛盾 HTTP/正常 stdio。 |
| R02 | 共享 text 校验没有拒绝不完整 UTF-16 surrogate，UTF-8 编码可能将其静默替换，影响内容及指纹一致性。 | 写入文本统一要求 isWellFormed；原始采集同样检查。正常中文/emoji/否定词不变，不自动重写历史数据。 |
| R03 | 新客户端预检无条件要求注册/采集工具；原生只读 Token 正确隐藏写工具，却被判定无法接入。 | 按 profile 是否明确允许采集选择必要工具。实际只读 HTTP Token 成功读取，其他 owner 的私有记忆不可见，撤销后拒绝；不通过放宽 Token scope 绕过问题。 |
| R04 | profile 生成器的 source 语法最初比服务端宽，可能产生永远无法连接的配置。 | 与服务端 `[a-z0-9-]{1,32}` 对齐，加入生成器测试；不接受大写、点或超长 source。 |
| R05 | 配置工具需同时防护符号链接和 Windows junction；只依赖新 Python 的 is_junction 会遗漏较旧 Python 的检查。 | 使用 lstat 的 reparse-point 属性，profile 创建同样拒绝。增加配置回滚、同名冲突、未知锁不删除、写前回执、实际 CLI 应用/回滚与输出脱敏测试。Windows 平台结果以同提交 portability workflow 为准。 |

R01/R02 的独立回归在修复前四项中三项失败；修复后四项通过。R03 由新增真实只读 HTTP 路径捕获，保留首次失败信息后修复；最终客户端端到端十九项通过。

## 回归范围与本地实际结果

最终 JavaScript 单元测试 **369 通过，0 失败、0 跳过**；Python 运维测试 **59 通过**。检查旧应用所有 MCP/数据与业务路径，而不是只运行新增客户端文件：

| 路径 | 本次结果 |
|---|---|
| native catalog / schema | compat 136 操作一致；基础集成与 stdio 初始化/读测试通过。 |
| 授权与传输 | bound 6、HTTP 49、响应 metadata 6、企业控制 28 项通过。 |
| 项目、执行与队列 | reliability 25、revision evidence 14、deferred 25 项通过。 |
| 来源和记忆治理 | summary 30、memory policy 38、review dependencies 17、fact evidence 36 项通过。summary/提取含受控模型 fixture，不是语义质量分数。 |
| 个人功能 | personal 43、console API/Agent 13、consolidation 29、真实 Worker/原生 SDK 接本地模拟供应商 5 项通过。 |
| 新客户端 | 真实编译后的 Node CLI/stdio proxy/native MCP/HTTP/PostgreSQL 19 项通过，包含同事件重放、限制工具、身份 pin 和 Token 撤销。Claude Hook 使用官方形状的事件 fixture。 |
| n8n | 本地 context fixture 18 项通过；真实 n8n CLI 引擎保留在完整 GitHub CI，不能用前者替代后者。 |
| 运行与恢复 | pgvector SQL 升级 17 项通过；生成新备份并还原到独立数据库，25 类指纹一致；health 通过。 |
| 语料检索 | 现有小型合成 keyless memory-eval 通过，不外推为大语料/真实模型效果。 |

本地原生运行环境使用此前 CI 生成且与当前 pin 一致的依赖与 PostgreSQL 运行文件，在全新普通用户测试目录初始化；没有宣称本轮重新编译所有上游。历史迁移与四个上游 pin 未改变。CI 保留从真实旧应用建立数据再升级的流程，并增加 0.11 基线，矩阵变为十二条路径。

## 未隐瞒的首次失败和环境阻断

首次 Python 全量测试中，一条新配置测试因临时文件沿用进程 umask 成为组可写而被产品权限检查拒绝。修复的是**测试夹具显式设置私有 umask**，不是移除权限检查。最终 59 项通过，初始日志保留在隔离证据目录。

本地 Chromium 被当前容器的管理员浏览器策略阻止访问 loopback，报 `ERR_BLOCKED_BY_ADMINISTRATOR`。没有修改或绕过该策略，没有删掉浏览器测试；真实 Chromium 的 UI 验收交由同提交 GitHub CI 运行。若 CI 浏览器或其他门禁未通过，不合入 main。

原始日志含合成数据库运行细节，不直接上传公共仓库。旁边 JSON 保存日志的 SHA-256、阶段分类和结果；哈希供操作者校验留存日志，不是公众可仅凭哈希重建/证明命令结果的替代物。远程 GitHub CI 运行是另外可查的提交级执行证据。

## 仍未完成或需保留的限制

客户端配置形状通过合同测试，不等于用户电脑上的 Codex/Claude/ZCode/OpenCode 实际模型都完成回合联调。Claude 自动 Hook 是只读记忆；没有自动上传 prompt/transcript_path。Grok CLI/Hermes/OpenClaw 专用接入仍待完成。

个人归档仍不等于物理擦除；数据库恢复仍不包含完整附件/密钥灾备；运行角色、企业高可用及不可变审计外送是已有明确边界，不因本次个人客户端开发扩大保证。模型引用匹配仍不证明事实真实；记忆投毒及真实长会话语义质量尚须独立语料验收。

配置相邻锁/写前哈希不能排除不合作的同账号恶意写入器的全部 TOCTOU；当前产品假设个人账号和 profile 文件的控制权可信。HTTP 私有主体与 stdio owner 不自动合并。公网 native 管理路由仍不得随便全量暴露。

没有因“单元测试全绿”填写“整体个人 V1 已完成”或“大型企业可上线”。剩余范围继续维护在 `PERSONAL-V1-CHECKLIST.md`。本轮未修改用户电脑、生产服务、密钥或数据库。
