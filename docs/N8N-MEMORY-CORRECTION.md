# n8n：明确纠正一条个人记忆

本模块在已有 Inspect / Review Personal Memory 之后补齐 **Correct Personal Memory / personal_correct**。它替换一条完整自有记录，立即退回候选，后续必须另行确认才进入召回。它不是自动批准、不接受批量候选、不引入 rejected 状态、审批人伪造字段或另一张审批表。沿用现有 `ultra_memory_read`、`ultra_personal_update`、数据库修订号 CAS 和 `personal_events`；服务器身份、写权限和所有权规则不变。

## 授权和选择

可信凭据新增三个独立设置：`allowMemoryCorrection`（默认false）、`allowCorrectionScopeChange`（默认false）及 `correctionProject`（默认空）。采集、启用或归档开关都不能代替纠错授权。源根 URI 与观察过的实例、主体绑定仍然必须匹配；不自动采纳未知服务器的身份。项目不从候选/核对/确认项目或普通输入项推导。

节点一次执行只能有**一个输入项**。操作与模式由工作流操作者明确配置；同意开关禁用数据表达式，但这不构成真人认证。`human_identity_verified:false`始终保留。操作者应核对旧记录及完整替换内容，再选择apply；服务端仍必须授予该凭据write权限。

填写完整旧ID、修订号、正文SHA-256、旧状态、旧可见性、旧项目和稳定事件ID；空旧项目表示全局。范围为global-only，或global-and-project（须有凭据的Correction Project ID）。原项目和目标项目都须在这个范围内。目标项目或可见性与观察值不同，还必须具备范围变更凭据授权和本次`correctScopeChangeConsent:true`，即使变化是改回私有也不静默执行。范围变更不会自动获得启用源共享记忆的权限。

## 完整替换，而不是部分补丁

`correctReplacement`是显式JSON文本，只接受恰好七个字段：

```json
{
  "type": "preference",
  "content": "用户已核对并纠正的完整内容",
  "provenance": "此次修正的来源说明",
  "importance": "normal",
  "confidence": null,
  "visibility": "private",
  "project_id": null
}
```

示例是格式，不是用户事实或自动同意。字段不能遗漏以套用默认值；只有confidence和project_id可明确为null。类型和数值复用原有规范归一化器，正文保留原始空白/Unicode，不去重或语义改写。正文最多65536 UTF-8字节，来源说明2048字节；完整JSON及所选请求各最多131072 UTF-8字节，转义较多的文本可能先碰到JSON上限。重复键、BOM、非法Unicode、额外字段、对象访问器和超限数据均整体拒绝，不截断。

须同时设置逐次`correctConsent`与`correctAcknowledgeReset`为true，承认完整旧记录会先传到适配器核验，再进行本地项目/所有权检查；该本地过滤不是服务器传输隔离。允许保存新正文意味着新正文会发送给指定服务器。n8n节点参数及执行历史可能保留新正文，成功输出隐藏正文并不意味着主机没有存储它；秘密、个人数据保留策略仍由操作者负责。

## apply与回执

apply先通过既有规范读取器完整校验旧记录、主体所有权和Agent来源，再核对全部旧观察值。文档片段应使用文档生命周期接口，共享非所有者记录不可修改。七字段全部相同则拒绝空操作，不能仅用无变化替换去清除派生引用。失效来源的自有记录可被明确纠错，但修正后仍是候选。

写入前再检查身份和取消，仅发送`memory_id / expected_revision / event_id / memory`四个原接口字段；来源、主体由服务器推导。服务器原子修订号检查会拒绝读取后发生的竞争修改，不覆盖较新版本。成功必为candidate、revision加一、`review_required:true`，清除旧derivation与last_confirmed。完整响应经过严格单文本/有界JSON/字段与版本校验后才交付元数据回执，不回显新旧正文或引用。

须另行使用现有Review Personal Memory确认新版本，不能把纠错同意当成启用授权。源共享可见性只在之后独立启用并满足原权限时生效。归档记录纠错后也退回候选，不是删除。

## 丢失回执与replay

模块没有自动重试、自动生成事件ID或本地持久队列。出现unconfirmed时保留原事件ID、完整替换和原版本，先明确核对当前记录。若仍是原版本，仅在重新确认后再用原apply请求；若已推进可选replay，其余数据保持原样。

replay要求当前版本严格大于原expected_revision，当前项目须仍等于原替换的目标项目。在正常单调版本语义下原CAS不能产生新修改，服务器只能返回已保存的同事件/规范请求回执或拒绝。原事件存在但正文等替换值不同会conflict；不存在的事件会失败，不能伪造成功。之后又迁往其他项目时，本入口保守拒绝回执恢复。

回执为历史事实，不是持续当前状态。例如修改得到候选v3，随后另行启用v4，重放v3回执仍是candidate，但v4继续active，不再编辑或退回候选。服务器事件绑定规范替换内容和原四字段，不认证其未记录的额外旧指纹、可见性或真人审核声明。`current_state_verified:false`、`truth_verified:false`始终保留。

## 失败与取消

读取、发送前后、最终身份检查和连接关闭各阶段都可能停止交付。固定安全错误不会回显远端错误正文、输入或令牌。`write_delivery`区分not_started、unconfirmed及confirmed：最后一种只表示此前确实校验过回执，但最终结果因取消/身份改变/清理失败被撤下；不能将已发生的写入改报为未发生。弱引用映射保存本地确认事实，远端异常不能伪造confirmed。

continueOnFail只返回保留`pairedItem.item`的安全错误项，不返回部分成功正文。取消不能撤销已经发送的更新，不触发另一次请求。更改全局n8n凭据不是本执行的实时撤销机制；每次执行固定可信配置，执行取消和服务器令牌撤销分别生效。

## 接线和实际验证入口

未启用、无凭据、无正文、未同意的手动示例：`examples/n8n/personal-correction.private.json`。它使用私有加载器名称`CUSTOM.ultrabrain`，无自动触发或重试。导入示例不会执行纠错。

`node --test test/n8n-memory-correction.test.mjs test/n8n-memory-correction-audit.test.mjs`执行生产session/executor及明确的合成传输上下文测试。`bun test/n8n-memory-correction-integration.mjs`使用实际打包Node运行库、官方MCP/认证HTTP和隔离PostgreSQL，包含真实竞争写、真实提交后注入丢回执、范围移动、重新确认及历史回执。这里的n8n上下文仍为夹具。

加`--engine`并设置实际`ULTRABRAIN_N8N_BIN`才执行真实n8n：导入私有凭据和本提交包、纠错、独立再确认、历史回执、不同意和范围变更拒绝。专用CI固定沿用n8n2.38.7/Node24，测试脚本存在不代表已执行。引用清除测试采用本轮合成源内、由认证MCP创建的记录及明确合成的结构化引用，不冒称模型生成或实际整理器输出；外部模型与生成器均不调用。

工程依据：n8n官方Item linking for node creators要求程序式节点保留输入关联（https://docs.n8n.io/data/data-mapping/data-item-linking/item-linking-node-building/）。本模块保留旧操作，未修改main、服务器工具目录、已应用迁移、上游锁、受阻管理台或其他项目。独立审核与最终SHA的CI结果分别记录于PR，不沿用前序提交的批准。
