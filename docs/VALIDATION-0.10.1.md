# Personal Console 0.10.1 验收范围

结果需绑定实际 commit 的测试，不在文档中预填 CI 成功。

- personal-console.test.mjs：本机 Host、Origin、认证、CORS、固定路由、请求大小/格式、令牌权限及安全渲染。
- personal-console-integration.mjs：真实 PostgreSQL 与 HTTP 管理台的注册、候选/激活/编辑/归档、CAS、同事件重试、其他身份隔离，以及同所有者 AgentMemory 的实际个人上下文读取。
- personal-client.test.mjs：默认兼容、显式个人上下文、项目/目录限制、内容指纹与响应预算、个人候选提交许可、通用桥和 automation 接线。
- personal-browser-fixture.mjs / personal-console-browser.py：真实 Chromium 登录、采集同意、文字安全展示、激活、编辑重审、并发版本冲突、归档、当前页导出及锁定。依赖不满足时失败，不以模拟 DOM 替代浏览器。

未改变迁移 0001..0012、企业工具白名单或四个上游锁。追加 c0c85d8 为旧应用基线。n8n 客户端增量为 0.8.1-alpha.1，仍需实际 n8n CLI 回归。浏览器导出不等于全库备份；网络恢复请求不是本地持久队列；所有 Agent 自动 Hooks、语义整理与完整个人 V1 仍未据此通过。
