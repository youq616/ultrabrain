# 个人任务召回基准评测

本模块用明确标注的任务与记忆ID评估现有个人任务召回，不添加另一套排序算法。独立CLI、Node SDK和现有连接入口均使用 `ultra_personal_context`，相同任务、项目、20条上限和客户端字节预算。它只读，不登记Agent、不采集记忆、不整理、不调用模型或自动重试。

## 使用范围与授权

配置需要 `allow_task_context:true`、事先核对的 `expected_instance`、`expected_actor` 以及绑定的绝对工作区。评测请求还必须另行提供 `consent:true`。不需要开启采集、文档写入或任何自动Hook。开启评测不会修改其他客户端或工作流配置。

**任务正文会发送到所选服务器。** 不读取会话记录、附件或目录，不自动采集任务。服务器的日志策略可能记录任务，已经发送的查询不能撤回。预期/禁召回ID、用例标签、工作区路径不会随任务发给服务器。服务器返回的记忆正文只在本次进程中用于既有内容指纹/状态/权限合同核验；报告不包含任务、记忆、来源说明或引用正文。报告仍含私有ID、项目标识、套件指纹，应当保护。

## CLI 与输入

从本轮源码构建并安装的私有客户端包提供：

```bash
ultrabrain-recall-eval --profile /absolute/private-profile.json < labelled-recall-suite.json
```

Windows PowerShell 7 使用绝对路径与明确UTF-8输入：

```powershell
Get-Content -Raw -Encoding utf8 C:\private\labelled-recall-suite.json | ultrabrain-recall-eval --profile C:\private\profile.json
```

操作方须确保该shell管道实际发送UTF-8；也可由Node程序直接使用下述字节无关对象API。本轮跨平台测试执行的是Node CLI子进程，不把这条PowerShell示例称作实际用户机器验收。

套件为单个JSON对象，仅接受以下字段：

```json
{
  "workspace": "/absolute/workspace",
  "consent": true,
  "top_k": 5,
  "cases": [
    {
      "id": "configuration-preference",
      "task": "配置文件 修改方式",
      "relevant_ids": ["00000001-1111-4111-8111-111111111111"],
      "forbidden_ids": ["00000002-1111-4111-8111-111111111111"]
    }
  ]
}
```

这里的路径和ID只是示例，必须替换为本人有权选择的环境与已标注记录。仓库 `examples/recall-evaluation.example.json` 故意以consent:false提供，不会直接发送任务。不能把示例不存在的ID评测结果当产品质量。

最多32个用例；`top_k`必须是1–20整数；用例ID是1–64字符的字母、数字、下划线或短横线，且全套件唯一。任务保留原始空白/换行/Unicode，不改写、不截断；每条1–4096 UTF-8字节，拒绝空白字符串、NUL和非法代理字符。每个ID列表最多100个不重复的完整小写UUID，两个列表不相交，不能同时为空。只做负向标注时可令relevant_ids为空。

整个stdin与规范化套件各最多128 KiB；拒绝UTF-8 BOM、重复JSON键、隐藏/符号/访问器字段、稀疏或超限数组。所有用例在建立连接之前完整验证，不会先发合法的第一条、再发现后面的用例无效。CLI在等待stdin前绑定可信profile，观察到配置改动不会自动采纳新身份。CLI退出0表示评测完整执行，不是得分达到质量门槛；失败退出1且只返回安全错误和尝试计数。

## Node 接口

```javascript
const {evaluateClientRecall} = require('ultrabrain-client/dist/recall-eval.cjs');
const report = await evaluateClientRecall(trustedProfile, labelledSuite, {
  authorize: () => evaluationStillAuthorized,
  signal: controller.signal,
});
```

示例变量由调用方提供。`trustedProfile`是可信操作者配置，不是模型生成的命令。SDK不会读取profile文件或保存报告；实时权限变化由同步authorize回调表达。返回Promise不算批准，false或异常会阻止后续发送/交付。profile和完整请求在第一个异步等待前复制。已存在的 `connectClient` 连接也有 `.evaluateRecall(suite, {authorize, signal})`，其连接生命周期由调用方负责。

每用例恰好一次context调用，前后检查身份，逐条串行执行，无自动重试、缓存、并发或降级正文检索。最多32次context读取；`query_requests`不包含协议握手及身份读取。接口和CLI均配置120秒取消信号，底层单请求仍沿用profile超时；这不是操作系统级强制杀死或精确墙钟时限。独立SDK关闭连接后再次核对工作区与授权，才允许返回完整报告。

## 指标定义

`top_ids` 是实际返回顺序的前K个ID。设匹配预期标注的数量为H，预期ID总数为R：

- precision_at_k = H / K。即使只返回两条而K=5，分母仍为5；未填满位置不计命中。
- recall_at_k = H / R。第一次命中位置为r时，reciprocal_rank_at_k = 1/r；K以内未命中为0。
- 汇总hit_rate_at_k为有至少一个命中的正向用例比例；其他mean指标按用例等权平均，不按预期ID数量加权。

R=0的负向专用用例，其三个正向指标均为null，从正向汇总分母排除；全套件没有正向用例时这些均值和hit_rate为null，而不是满分。仍计入case_count及负向统计。每例返回matched_ids、missing_ids等编号，不回显文本。

**禁召回列表在整个实际返回集合中检查，最多20条，而不是只查前K。** forbidden_case_count统计至少出现一次的用例数，forbidden_occurrences是逐用例命中次数之和。同一编号跨两个用例出现计两次。该列表是本次评测标注，不会修改服务端权限；未标注的泄露无法据此排除。响应重复ID、过量条目、错误来源、正文指纹或不合格记录都会拒绝整个评测，不能用重复编号抬高分数。

套件SHA-256绑定有序用例、任务、标注与K，不包含工作区路径。来源、项目、预算和固定查询上限另行返回；比较两次评测必须同时核对这些配置及数据状态，不能只看套件指纹。短任务的指纹也不是匿名化。两次任务读取之间数据库可能改变；本报告不是一致性数据库快照。

## 失败与解释边界

任一用例、授权、身份检查或清理后验证失败，整个套件不返回部分分数。安全异常/CLI错误包含 `query_attempts`、`completed_cases` 与 `query_delivery:not_started|unconfirmed`。进入context发送函数就保守计一次尝试，即使底层没发出字节；completed_cases只计已完成响应和身份复核的用例，不代表获得最终交付授权。计数依据本地控制流，不信任远端异常附带的计数，不自动补跑。

这些是**调用者标注下的ID召回指标**，不是语义相关性真值、模型答案质量、实际用户收益或安全认证。未标注但相关的结果会在precision中作为未命中；标注不完整会影响解读。missing_id也可能因项目、权限、状态、字节预算而缺席，不能推断删除。`semantic_quality_verified`与`truth_verified`始终false，没有自动通过阈值或修改记忆动作。

## 可复现验证

专项：`node --test test/client-recall-evaluation*.test.mjs`。SDK传输替身和CLI子进程测试明确区分。

`test/client-recall-evaluation-integration.mjs`在安装后的包、官方锁定SDK、真实隔离PostgreSQL和stdio/只读HTTP上验证排序、标签不扩权、未启用/跨项目/已归档记录不进入评测、令牌撤销、CLI/API一致性及读取前后六表指纹不变。准备只写明确合成记录，无生成器或外部模型。已接入原task-context工作流的实际npm安装之后；新增跨平台专项保留所有既有测试。真实结果见本轮PR和审核报告；脚本存在不等于通过，合成基准也不等于真实模型质量验收。
