# 0.3.0-alpha.1 验收说明

本轮基于开发分支 a7520153f06598b22bd4c4dfb3741ae3a21c000c，并保留上游 gitlink。

本地验收使用从仓库 Actions 产物恢复的锁定 GBrain/Bun/PostgreSQL 程序，在独立数据目录、非 root 账号和真实 PostgreSQL 上执行。工作容器无法解析 github.com，因此本地结果不能冒充“在此容器重新从网络构建源码成功”；GitHub CI 负责重新拉取锁定源码与 bootstrap。

已加入的检查：

- Node 单元测试：outbox 重启、内容冲突、丢 ACK、退避、隐私回调、篡改拒绝；项目结构、证据、查询构造；真实本地子进程退出与超时；检索评测器。
- 真实 PostgreSQL：检查点并发冲突、事件重放、伪造/失败/过期任务规范回执拒绝、权限、换会话上下文、断线补交、JSONB 修复、项目遗忘及防重放。
- 原有 stdio 与 HTTP 基线继续执行；HTTP 额外覆盖项目共享读、只读拒写及跨 source 拒绝。
- 合成词法检索的 5 项 fixture：两个正确召回、private 不可见、软删除不召回、未知词为空。
- backup/restore 必须包含新 metadata 表，并检查恢复指纹。

结果分类：单元测试、集成测试、合成检索 fixture 与真实模型语义质量不能互相替代。当前没有付费或本地生成/embedding 模型验收，也没有证明完整上游功能等价。

在隔离目录 bootstrap 后运行（不要指向生产数据）：

```bash
export ULTRABRAIN_TEST_ALLOW_WRITE=1
node --test test/*.test.mjs
python3 -m unittest discover -s test -p 'test_*.py' -v
bun test/integration.mjs
bun test/bound-integration.mjs
bun test/http-integration.mjs
bun test/reliability-integration.mjs
ULTRABRAIN_EVAL_OUTPUT=/tmp/ultrabrain-memory-eval.json bun test/memory-eval.mjs
bun src/cli.mjs health
```

CI 将评测 JSON 作为与 commit SHA 绑定的 artifact。应读取最终候选提交的 workflow conclusion；旧版通过或源码归档成功不算本版通过。
