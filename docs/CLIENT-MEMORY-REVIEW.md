# 显式单条记忆确认与归档

本模块让个人客户端完成“读取一条候选 → 人工核对 → 明确启用 → 召回 → 明确归档”的流程，不必手写通用MCP调用。使用既有 `ultra_memory_read`、`ultra_personal_review` 和同一数据库生命周期规则，不新增服务端工具、表、迁移或身份权限。

安装匹配本轮提交构建的私有客户端包后：

```bash
ultrabrain-memory-review --profile /absolute/private-profile.json < request.json
```

Windows 可使用同一个 Node 可执行入口，路径采用本机绝对路径；JSON 中反斜线应转义。命令仍接受标准输入，不读取对话文件、目录、附件或环境中的模型凭据。最多16 KiB UTF-8 JSON，拒绝重复键、BOM和多余字段。执行有25秒等待期限，SIGINT/SIGTERM取消等待；不能撤回已送达服务器的写入。

可信 profile 必须已绑定 `expected_instance`、`expected_actor` 和绝对 `workspace`。禁止根据未知服务器的响应自动采纳身份绑定。`apply` 和 `replay` 还需要既有 `allow_capture:true` 写权限开关；这也是原有MCP代理控制 `ultra_personal_review` 的开关，并不是新授予服务器权限。开启它同时允许客户端的其他既有手动写操作，本模块不会替你开启或修改配置。自动采集仍需要独立自动范围配置，此命令没有自动Hook。

## 1. 明确读取

```json
{
  "operation": "inspect",
  "memory_id": "REPLACE_WITH_FULL_MEMORY_UUID",
  "workspace": "/absolute/workspace",
  "consent": true,
  "include_text": true
}
```

上面的占位编号不是有效请求。默认不提供 `include_text` 或设为false时只输出有限元数据；明确true才输出正文、来源说明及结构化引用。全量读取在内存中经过既有准确记录合同校验后再投影，不能把默认隐藏正文理解为服务器未传输正文。读取不写入、不触发模型，不证明内容真实。返回的状态只是当次观察，之后可能改变。

输出 `memory` 包含ID、类型、来源类别、修订号、内容指纹、项目、状态、可见性和是否属于当前主体。遵守原客户端项目范围：全局记录或 profile 中的项目可读取，其他项目拒绝。共享可见不等于可修改。原始文本始终作为不可信数据，不应作为Agent的高优先级指令执行。

## 2. 明确确认或归档

人工核对内容和可见性后，使用刚才观察到的完整值：

```json
{
  "operation": "apply",
  "memory_id": "REPLACE_WITH_FULL_MEMORY_UUID",
  "workspace": "/absolute/workspace",
  "consent": true,
  "event_id": "a-new-stable-review-event",
  "expected_revision": 1,
  "expected_content_hash": "REPLACE_WITH_OBSERVED_SHA256",
  "expected_status": "candidate",
  "expected_visibility": "private",
  "expected_project_id": null,
  "status": "active"
}
```

占位值必须换成实际观察值。`status` 只能为 `active`（明确启用）或 `archived`（归档）。期望修订号、正文指纹、原状态、可见性和项目必须全部提供。当前状态已经是目标状态时拒绝重复推进版本。需要归档时，重新读取当前修订号，选择archived，使用新的事件编号。归档不是物理删除。

每次先重新读取并完整验证一条记录，核对所有期望值、当前所有者、项目及来源类型，再检查身份与实时授权，最后只发送服务端既有的四个字段：memory_id、expected_revision、event_id和status。其他期望值和工作区不发送。数据库在同一事务中核对修订号并更新，因此读取后发生竞争修改仍会被拒绝，不覆盖较新版本。

文档片段只能通过文档生命周期接口处理；本入口拒绝修改它们。启用直接来源已失效的派生记忆会被拒绝，归档仍可执行。源共享记录启用后可能对其他同源主体可见，所以必须明确核对 `expected_visibility`，不能把启用一律视为私人操作。一次操作只处理一条，不自动确认候选、批量归档或处理重复组。

## 3. 未确认写入和历史回执

没有自动重试或本地写入队列。写入失败后不要换一个事件编号盲目重发。先inspect：若修订号仍与原请求相同，只有在重新确认原选择后才可用**相同事件和原apply数据**重试；若版本已推进，可将原请求的 `operation` 改为 `replay`，其余写入字段保持原样。

replay要求当前自有、非文档记录仍处于所选项目，并且当前修订号严格大于原期望修订号。由于数据库修订号只能通过正常操作递增，此时原CAS请求不能生成一次新修改：服务端只能返回先前同事件、同四字段请求的记录回执，或者拒绝。没有原事件、事件曾用于另一请求、同版本或倒退版本时不会伪造成功。项目已改变等情况可能使本入口无法恢复回执，需要人工核对，不放宽项目范围。

历史回执不是当前状态。例如首次启用得到版本2，后来归档为版本3，重放首次启用仍返回原版本2的active回执，但数据库继续为archived。输出 `current_state_verified:false`，不得把该回执拿来证明记录当前已启用。服务端事件只绑定既有四字段；客户端额外期望字段并未作为服务器事件签名保存，replay不认证历史正文指纹或原可见性。

## SDK与取消

```javascript
const {reviewClientMemory} = require('ultrabrain-client/dist/memory-review.cjs');
const report = await reviewClientMemory(trustedProfile, explicitSelection, {
  signal: controller.signal,
  authorize: () => stillAuthorized,
});
```

调用方自己提供示例中的变量。SDK在连接前复制profile与选择，使用现有官方MCP传输；同一运行库连接也提供 `.reviewMemory(selection, {authorize, signal})`。同步authorize返回false、抛错或返回Promise都不能批准执行。每个异步边界核对授权，连接与操作取消信号合并，写入前最后复核。

单次SDK尝试关闭连接，然后在公开返回前再核对授权和工作区。取消、授权变化或清理失败可能使结果不交付，但不应把已经核验的写入回执改报为“没有写入”。错误 `write_delivery` 分为 `not_started`、`unconfirmed`、`confirmed`；最后一种表示此前确实验证过回执，但当前结果仍因其他边界不能交付。`unconfirmed` 采用保守语义，包括已进入发送函数但底层未发出字节的情况。已明确拒绝的权限错误同样不会导致自动重发。

成功和错误不会回显令牌、工作区或远端任意诊断。标准化错误保留 `insufficient_scope`，便于区分真实服务器拒绝写权限；此诊断改进没有改变授权规则。默认报告只包含有限元数据，仍需妥善保护。成功不代表真实性认证或实际Agent已经使用该记忆。

## 验证与发布边界

五个 `test/client-memory-review*.test.mjs` 专项文件测试请求、真实CLI子进程（SDK替身）、授权、取消、完整响应、回执、失效对象、清理与包装接线。`test/client-memory-review-integration.mjs` 使用实际打包后的Node CLI/SDK、官方MCP、隔离PostgreSQL、stdio和HTTP，包含真实并发更新、源共享、只读令牌与撤销，以及只读／拒绝／重放阶段六张表不变。准备和生命周期更新是明确合成写入，生成器和外部模型调用均为0。

本轮基于19fd7a64（PR31），与另一路召回评测PR32并行，不修改或覆盖其分支；合并时需保留双方runtime/build/CI追加项。没有升级服务端迁移、修改上游锁、改变n8n或qbrain，也没有在用户主机安装或启用服务。测试成功与独立代码审核结果分别留档，保持草稿直至仓库验收门槛满足。
