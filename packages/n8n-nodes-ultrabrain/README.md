# n8n-nodes-ultrabrain — private self-hosted adapter

Client-only package 0.8.2-alpha.1. Personal context requires Ultrabrain 0.10.1 or newer; existing lifecycle operations retain their prior compatibility. It reuses AgentMemory and the official MCP SDK (direct dependency pinned at 1.29.0). No PostgreSQL, Bun server runtime, credentials, shell executor or paid-model implementation is bundled.

Operations: Check Connection, Get Context Before Turn, Save Consented Turn, Get Session Status, Resume Project. Context uses the current governance policy; historical selection is explicit. Source-bound facts are optional. Summary reading never generates a summary.

Build from the Ultrabrain repository using `bash scripts/package-n8n.sh`. Install the generated tgz on the n8n host, and add its `dist` directory to `N8N_CUSTOM_EXTENSIONS`. This private-loader mode registers `CUSTOM.ultrabrain`; example workflows use that name. The package is not published to npm and not verified for n8n Cloud. Do not install a similarly named registry package as a substitute.

Configure the endpoint and token in a dedicated Ultrabrain credential. HTTPS is required except explicit loopback HTTP. One credential/source is resolved per execution, and server identity is checked before every item. Optional expected actor and instance pins further constrain it. Only trusted n8n administrators should manage endpoints; this direct MCP fetch adapter does not claim to enforce every n8n HTTP-node proxy/SSRF option.

Saving requires both credential permission and per-item consent. Shared `world` capture also requires a credential-level grant; `private` is host-private under the native server, not a remote personal namespace. Use a stable producing application session/event ID and immutable transcript when retrying. Do not derive new IDs from n8n retry executions. The adapter does not write a local outbox: before server confirmation, the producing system or configured n8n workflow must retain the original event. n8n execution retention can itself store sensitive input/output; configure it separately.

Outputs contain requested memory, not source inputs by default. Failed items return safe error codes and `delivery: not_submitted|unconfirmed`; `continueOnFail` must be followed by an explicit success check. A `journaled` capture is not completed extraction or proof of truth. This node never schedules consolidation or captures conversations it was not given.

Test baseline: n8n 2.38.7, n8n-workflow 2.38.1, Node.js 24+. Full compatibility, loading, and workflow execution must be evaluated using the actual commit's CI; the source package alone is not a test result.

Full instructions and boundaries: https://github.com/youq616/ultrabrain/blob/main/docs/N8N-INTEGRATION.md

License: MIT for this adapter. MCP SDK and n8n remain separate dependencies under their own licenses.

0.8.1 增加 Include Active Personal Memory，默认关闭。启用时需要 source 根目录和至少 4096 字节预算，读取此凭据身份可见的已激活全局/当前项目记忆；不是默认自动采集或自动学习。详见 docs/PERSONAL-CONSOLE.md。

## Personal memory overview (development candidate)

Get Personal Memory Overview reads owner-wide statistics through the existing read-only MCP tool. It requires a source-root credential, observed instance/actor pins, explicit all-project scope and per-item consent (off by default). It sends only a fresh UUID, never body text, and requests no model calls or memory writes. It preserves item pairing; failures use `read_delivery`, never a fabricated successful empty library. Cancellation before final node delivery suppresses pending overview results, including cancellation during connection cleanup. Old capture/context operations retain their semantics.

The inactive, credential-free `examples/n8n/personal-overview.private.json` and full contract `docs/N8N-PERSONAL-OVERVIEW.md` are in the matching repository commit. Counts remain private and may be retained by n8n history or downstream nodes; this operation does not change global logging. This is not an npm release or independent review approval. Identify the private package by commit and SHA-256, not its unchanged development version alone.
