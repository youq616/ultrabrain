# 候选记忆审阅清单

本模块把“找出要核对的候选编号”接到已有 inspect / correct / apply 流程之前。使用实际私有客户端中的 `ultrabrain-candidates` 或 SDK `listClientCandidates`，每次只读取一页，不自动确认、编辑、归档、下载或翻页。

```bash
ultrabrain-candidates --profile /absolute/private-profile.json < request.json
```

Windows 可以使用同一 Node 入口及本机绝对路径。profile 必须预先绑定实际观察的 expected_instance、expected_actor 和 workspace；不得自动采纳陌生服务器的身份。无需开启 allow_capture、allow_documents 或模型配置。请求 JSON：

```json
{"workspace":"/absolute/workspace","consent":true,"limit":20}
```

workspace 必须是实际存在且与可信 profile 绑定一致的工作区。limit 可省略（20），范围1–50。consent 必须明确为true；样例文件 `examples/candidates.example.json` 默认false，不能直接作为授权使用。stdin上限16 KiB；重复键、BOM、字段拼错、include_text、项目覆盖和任意额外字段均拒绝。命令等待上限25秒，信号可取消，取消不能撤回已送达的只读查询。

## 覆盖范围

只返回当前服务器认证主体拥有的、origin_kind=agent 且 status=candidate 的记录。未绑定项目的 profile 只读全局候选；绑定项目则读“全局 + 该项目”。不读同源其他主体的候选/共享记录、其他项目、已启用和已归档记录，也不包括不可直接编辑的文档片段。明确采集的原文输入也可能是agent候选；列表并不把它判为已提炼知识或可安全启用。

原搜索接口依赖正文预算，还允许不同范围的读取；本模块使用新增的独立只读 `ultra_personal_candidates`，SQL只投影固定元数据。它不选择或传输正文、来源说明、引文或完整引用对象。直接来源有效标记沿用既有规则；指纹是数据库记录的指纹值，此次未读取正文，因此没有重新验证内容指纹，更不是真实性证明。ID、指纹、Agent和项目标签本身仍可能敏感。

服务端从认证 source/principal 计算所有者，不接受调用方传入owner/actor。项目是此读取接口的筛选，不是新的服务器身份或权限体系。原通用MCP读取权限仍有效，高层CLI/SDK另行实施工作区和同意约束。旧服务器没有新工具时明确失败，不改用会读出正文的搜索接口。旧客户端probe的必需工具清单不变，新工具是可选扩展。

## 分页与输出

响应 `page` 含 request_id、source_id、project_id、after_id、limit、observed_at、returned、memories、has_more、next_after。单页完整验证后才交付。编号升序不是时间排序，也不用于排序事实可信程度。

has_more=true时，取 next_after 作为下一次请求的 after_id：

```json
{"workspace":"/absolute/workspace","consent":true,"limit":20,"after_id":"REPLACE_WITH_RETURNED_FULL_UUID"}
```

只有真实返回的完整编号才可替换占位值。服务端取limit+1条来判断是否还有下一页，不以“刚好一页”猜测还有数据。next_after来自本页最后一条实际返回记录；终页为null。after_id可省略，不接受显式null。游标不是签名或写入授权；可以用于显式跳过前面的编号，但不能据此声称已遍历整个集合。变更身份、项目或筛选范围时，从不带after_id的新请求重新开始。

**每页是单次数据库观察，多页不是同一时点快照。** 已经翻过的编号之后又变成候选、或者新增编号排在游标之前，需从头刷新才能看到。记录可能在下一步inspect之前被更改或归档。使用编号分页避免因前页移除造成offset位移，但不提供锁定集合、全量总数或持续实时视图。错误、取消和超限不伪装成“零候选”。

一次调用最多一条实际列表请求，外加身份核对；不预取，不自动重试。源码中的直接服务端接口使用同一元数据合同、只读事务和五秒statement timeout。最多50项、响应最多64KiB，超限整页拒绝，不丢弃较大条目。

## 与确认／纠错衔接

从列表选择ID后，用原 `ultrabrain-memory-review` 的inspect重新读取，明确授权include_text才能核对正文；再提交correct或apply。不要仅凭列表状态或来源有效标记自动激活。客户端和服务器的现有版本检查继续生效，历史回执也不是当前状态。列表无write capability。

SDK：

```javascript
const {listClientCandidates} = require('ultrabrain-client/dist/candidates.cjs');
const report = await listClientCandidates(trustedProfile, selection, {signal, authorize});
```

变量由调用方定义，authorize必须同步；返回Promise不能授权。SDK/CLI会复制选择、绑定身份和工作区，在查询前后、关闭连接及最终交付前再次核对。授权撤销或清理失败会丢弃整页结果，返回只读错误；错误不输出原始服务端诊断或本地路径。已发送只读请求的失败保守为read_delivery=unconfirmed，不暗示服务器没有执行。

## 验证和限制

四个候选专项测试文件覆盖合同、模拟DB、官方SDK替身、真实Node CLI子进程、撤销及畸形元数据。`test/client-candidates-integration.mjs` 使用实际编译的Node CLI/SDK、官方MCP和隔离PostgreSQL，检验完整分页、项目/主体隔离、长正文、文档排除、与inspect衔接、只读/撤销令牌及六张表不变。设置身份的probe和写入仅在明确合成测试准备中执行，不是用户部署指令。该模块没有浏览器面板。

本模块基于已发布的PR34（927f1f5e）的correct / replay-correction接口追加，不重复发布本会话早先仅本地的edit接口，也不改写PR34分支。并行PR32的召回评测不被覆盖或冒充为已整合。源码、完整SHA、测试结果、独立审核及远端CI以最终交付报告/PR为准；示例、测试脚本或review请求存在并不意味着已经执行通过。
