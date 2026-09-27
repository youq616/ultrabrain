# 显式单条记忆纠错

本模块扩展已安装的 `ultrabrain-memory-review`、公开 SDK `reviewClientMemory` 和连接方法 `.reviewMemory()`，新增 `correct` 与 `replay-correction`。原有 inspect/apply/replay 行为不变，复用同一个服务端 `ultra_personal_update`、个人记忆规范化合同和原子版本检查，不另建数据库或工具权限。

## 使用流程

先使用原 inspect 读取并人工核对一条记录；需要原文时明确提供 include_text:true。inspect 的有限元数据新增 importance 和 confidence，连同已有类型、项目、状态、可见性、版本和指纹，可完整构造纠错请求。默认隐藏输出正文不代表服务器没有传输正文：完整记录仍先在客户端内存中验证。

```bash
ultrabrain-memory-review --profile /absolute/private-profile.json < correction.json
```

PowerShell也可把明确选择的JSON文本经标准输入送入同一命令；不自动扫描目录或读取会话。仓库 `examples/memory-correction.example.json` 是默认不同意的模板，所有编号、指纹、工作区和内容须替换为实际核对值，不能直接执行。SDK沿用 `reviewClientMemory(trustedProfile, selection, {authorize, signal})`，不是新建另一条绕过权限的连接。

`correct` 要求 operation、memory_id、workspace、consent:true、稳定 event_id、expected_revision、expected_content_hash、expected_status、expected_visibility、expected_project_id，以及 acknowledge_reset:true 和 memory。memory 必须明确包含且只包含七项：type、content、provenance、importance、confidence、visibility、project_id。confidence与project_id可明确为null，但不能省略或用undefined。不会把遗漏字段悄悄替换成默认私有、全局或空可信度。

沿用现有规范：content最多65536 UTF-8字节，provenance最多2048字节，正文原样保留，不裁剪空白或归一化Unicode；拒绝非法字符、空正文和未知类型。整个纠错JSON最多128 KiB（含JSON转义后的长度），CLI标准输入也有该上限；非纠错操作仍为16 KiB。拒绝BOM、重复JSON键、隐藏或访问器字段、多余字段、非有限数和超限请求。所有字段在连接前校验、复制和冻结，修改原始对象不能改变已开始的操作。

## 写入语义

profile仍须预先绑定观察过的实例、主体和工作区；写入使用既有allow_capture:true开关。该开关同时允许原客户端的其他手动个人写操作，本模块不会自动开启它。每次纠错另需明确consent。当前记录必须是当前主体自有的非文档片段，并且仍在客户端允许的全局或所配项目范围。共享可见不等于拥有写权限。

客户端重新读取完整记录，核对期望版本、正文指纹、旧状态、可见性和项目；写入前再次核对身份、工作区和即时授权。只向服务器发送 memory_id、expected_revision、event_id、memory。服务器在事务内执行原版本CAS，读取后发生竞争编辑时拒绝旧请求，不能覆盖新修改。目标项目同样只能是全局或profile所配项目。目标可见性必须明确填写；选择source表示重新确认启用后可能共享，不能把纠错一律理解为私人内容。

**纠错必定回到candidate，并清除结构化派生引用和最后确认时间。** acknowledge_reset:true 是对这一行为的明确知情，不是自动启用许可。原来active或archived的记录也会变成候选，从正常召回中退出；需要再次人工核对并使用原apply明确启用。修改来源记录还可能使其派生记录的引用失效，这些记录不能继续作为当前有效记忆召回。来源失效的自有派生记忆可以通过人工纠错重新建立内容，但不继续冒充原引用仍然有效。

七个可编辑字段均未改变时拒绝，不把同文重提当成隐式清除来源的请求。不接受status、derivation、last_confirmed、owned_by_caller等不可编辑字段，也不允许纠错同时启用。没有自动修复、合并、批量更改、删除、生成模型、Hook或自动重试。

## 失败与原事件重放

丢失响应时，先inspect，再决定是否处理原事件；不要换新事件编号盲目提交。`replay-correction` 要求完整原纠错请求，仅替换operation；当前版本必须严格大于原expected_revision，且记录仍在允许范围并处于本次纠错选择的目标项目。此时原CAS不能作为一次新的普通更新执行，服务器只能返回已记录的同事件、同规范化memory回执或拒绝。未知事件及相同事件但不同replacement内容不会生成另一条修改。

纠错允许明确的项目迁移，因此重放核对目标项目，而不是强迫记录仍在迁移前的项目。后来再次迁移出该目标项目时，本入口保守拒绝，不放宽范围恢复回执。超出已选择范围的历史调查需要另外处理。

回执包含id、原结果revision、candidate、replayed和review_required:true。它不是当前状态。例如纠错得到candidate版本3，后来独立启用成版本4，再取原纠错回执仍返回candidate版本3，但数据库保持active版本4。current_state_verified和truth_verified始终false。历史回执不能认证原请求中并未记入服务端事件的额外期望指纹或旧可见性。

成功输出不包含新旧正文、来源说明、工作区或凭据。取消、身份变化、清理失败会阻止交付，但已核验回执的事实仍保留为write_delivery:confirmed；进入发送后而未核验的结果为unconfirmed，不能自动重试或改报未写入。

## 验证及上轮CI修复

新增纯逻辑、实际CLI子进程、公开SDK、对抗复查及安装布局测试。新的 `test/client-memory-correction-integration.mjs` 使用实际编译Node入口、官方MCP、隔离PostgreSQL，检查纠错退出召回、再次确认、历史重放、项目迁移、并发编辑、真实派生引用清除和HTTP权限边界。准备真实派生关系使用一次明确注入的合成生成器输出，不调用外部模型；这些得分/记录不代表用户数据或实际模型质量。

上一提交f29a4206的Task-aware personal recall实际失败在并发测试的预加载器：它硬编码SDK必须位于包内node_modules，而npm默认可以把依赖提升到上层。现在使用Node createRequire，以实际安装的入口为解析基准，加载SDK公开入口；不改生产权限、不改用另一个SDK副本。两种目录布局均有实际Node回归，且修复后重新执行原20项数据库/stdio/HTTP检查，保留此前真实失败记录。参考官方Node `module.createRequire` 和npm v10 install-strategy文档。

工作流保留原检查，并追加新模块，不用单元成功替代真实安装包验收。源码、测试、CI与独立代理结论分别记录，仍为开发候选。该分支基于PR33，未改写并行PR32，也不替前序叠加PR或用户部署验收。
