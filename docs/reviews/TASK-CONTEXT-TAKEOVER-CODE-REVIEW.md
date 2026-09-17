# Independent task-context code review

- Reviewed commit: `5359c113b28b8a3e54ca67f0c6d3a1d1d28aad4c`
- Comparison base: `a5e76f7ab2af4dddb1f72d8a95ab02d2f32593f6`
- Actual reviewer agent/session identity: `/root/task_context_review`
- Review date: 2026-09-17
- Worktree: `/workspace/scratch/be43dca0ab34/ultrabrain-task-context`
- Verdict: **PASS for the code/runtime boundary scope below. No blocking defect found.**

This is a separate reviewer-agent judgment. I read `AGENTS.md`, inspected the candidate diff and relevant surrounding implementation, and executed the tests below. I did not implement or modify the candidate. The full SHA was checked at the beginning and end; the worktree was clean at both checks. This approval does not cover a later implementation commit.

## Scope and findings

Reviewed the task helper, profile contract, runtime wiring, and client CLI directly. Followed their dependencies into trusted-profile file reads, workspace matching, MCP invocation/HTTP credential transport, context-envelope validation, the server tool definition, authenticated personal principal derivation, and the existing read-only context SQL/ranking path. Also inspected the new unit/integration tests and task-context documentation. The configuration merger is being reviewed separately; this verdict is not a substitute for that review.

No blocking findings were identified in the reviewed scope. Concrete boundary findings:

1. **Separate consent and automatic scope are enforced before the task request is accepted.** `src/client-kit.mjs:22-28,48-52` defaults the new permission off and requires absolute workspace plus both identity pins. `src/client-task-context.mjs:9-18,23-34` requires per-request consent for the explicit entry point and the additional `claude-user` scope for the automatic entry point. Unsupported/child events are refused before prompt access. `packages/ultrabrain-client/src/cli.mjs:26-35` binds the original profile before waiting for stdin.

2. **Input cannot choose a new source, project, budget, or server.** `src/client-task-context.mjs:16-21` permits only task/workspace/consent and derives the MCP arguments from the trusted profile. `src/client-task-context.mjs:37` clones the submitted input before asynchronous work. `packages/ultrabrain-client/src/runtime.mjs:21-39,55` creates the transport from that profile and verifies authenticated source, instance, and actor through `src/client-kit.mjs:54-58`. `packages/ultrabrain-client/src/cli.mjs:34-39` rereads and compares the profile at the connection/delivery boundaries, preventing a waited-for event from acquiring a replacement profile's authority.

3. **Cancellation and revocation are checked around the relevant awaits.** `src/client-task-context.mjs:38-53` requires a synchronous authorization assertion, rejects false and thenable assertions, checks cancellation before and after it, checks workspace again, and repeats authorization after identity verification and after the context response. No registration or write lies on this path. The existing SDK invocation receives the connection signal and timeout at `packages/ultrabrain-client/src/runtime.mjs:35-39`. The last local check cannot retract a request that has already started; the documentation accurately describes that limitation.

4. **Task validation preserves the consented string rather than silently shortening it.** `src/client-task-context.mjs:19-21` rejects blank, ill-formed Unicode, NUL, non-string, and greater-than-4096-byte text; it returns the original text unchanged. Hook metadata and workspace are checked before constructing the task request at `src/client-task-context.mjs:26-34`. No transcript path, tool result, attachment, assistant response, or hidden-reasoning file is opened by the helper.

5. **A failed query is not falsely reported as definitely unsent.** `packages/ultrabrain-client/src/cli.mjs:37-40,89-94` marks entry into task delivery conservatively and uses `query_delivery:unconfirmed` thereafter. Prior failures report `not_started`, whose meaning is documented as task delivery rather than absence of all connection/identity traffic. The hook error path emits no stale `hookSpecificOutput`, and both entry points sanitize error codes instead of returning exception messages or request bodies. The fault-injection test at `test/task-context-integration.mjs:31-36,77-84` checks loss after a real context reply rather than merely throwing before invocation; I inspected that test but did not execute its PostgreSQL path locally.

6. **Existing response and server ownership boundaries are retained.** The task path ends in `clientContext` at `src/client-task-context.mjs:54`; `src/client-kit.mjs:60-64` checks the source, serialized budget, active status, content hash, project eligibility, and ownership/source-sharing eligibility. The server still exposes this operation with read scope at `src/personal-plugin.mjs:26,48-55`, derives the principal from authenticated server context at `src/personal-memory-store.mjs:9-21`, and performs context retrieval in a read-only transaction with bound task parameters and source/actor/project/current-derivation filters at `src/personal-memory-store.mjs:191-229`. The new entry point does not add memory/event/document/job writes or a model call.

7. **The opt-in is intentionally specific to the new helper/hook.** The pre-existing raw MCP forwarding path remains able to call the existing context tool with task arguments (`packages/ultrabrain-client/src/runtime.mjs:17-19,46-52`). `docs/TASK-CONTEXT.md:20` explicitly states this scope. I did not treat this documented unchanged contract as a bypass of a newly claimed global policy.

## Non-blocking boundary observation

`src/client-profile-file.mjs:30-34` implements equality of currently resolved workspace paths; it does not pin a directory inode or retain its original realpath. In an additional adversarial check, retargeting a profile workspace symlink during the identity await correctly rejected a request whose cwd named the original canonical directory. When both fields intentionally named the same mutable alias, equality continued to hold after retargeting. This is the unchanged helper's existing path-based contract, consistent with `docs/CLIENT-KIT.md:99`, and the new task path did not change its destination as a result. I do not classify this as a blocking regression or a same-account filesystem sandbox guarantee. A future requirement for immutable directory identity would need a separate design and implementation change.

## Executed evidence

All commands below ran against the reviewed worktree. No installed Claude session or live model was involved.

| Command/check | Actual result |
| --- | --- |
| `git rev-parse HEAD` and `git status --short`, before and after inspection | Exact reviewed SHA; clean worktree |
| `node --version` | `v24.19.0` |
| `node --test test/client-task-context.test.mjs test/client-kit.test.mjs test/client-document-boundaries.test.mjs` | Exit 0; 71 tests passed, 0 failed, 0 skipped |
| `python3 -B -m unittest discover -s test -p test_task_context_config.py -v` | Exit 0; 16 tests passed |
| `git diff --check a5e76f7ab2af4dddb1f72d8a95ab02d2f32593f6 5359c113b28b8a3e54ca67f0c6d3a1d1d28aad4c` | Exit 0; no whitespace errors |
| Additional inline `node --input-type=module` assertion harness described below | Exit 0; all assertions passed |

The additional independent harness created temporary workspace directories and a workspace alias, then used the real candidate contracts to check exact BOM/CRLF/emoji string preservation, source/instance/actor mismatch rejection before task invocation, rejection of an asynchronously resolving authorization thenable without an unhandled rejection, rejection after workspace-alias retargeting with a canonical cwd, and the same-alias path behavior documented above. It performed no network call or implementation edit and removed its temporary directory afterwards.

Local runtime dependencies for the built MCP client were absent (`node_modules/@modelcontextprotocol/sdk` and `packages/ultrabrain-client/node_modules` did not exist), so I did not claim an installed-client, real PostgreSQL/MCP, Node 22, Windows, or actual Claude-engine result from this review session. The parent agent is separately collecting exact-commit CI/integration evidence; that evidence must remain labeled as CI rather than this reviewer's locally executed tests. The local root-only environment limitations reported by the parent do not change the successful focused test results above.

## Acceptance

**PASS** for `5359c113b28b8a3e54ca67f0c6d3a1d1d28aad4c` within the stated code/runtime scope. No blocking fix is requested. Complete acceptance still requires the separately assigned configuration review and exact-commit validation evidence required by `AGENTS.md`.
