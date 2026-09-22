# Ultrabrain personal client

Private local tgz; not a published registry package. Node.js 22.16+ and the official MCP SDK 1.29.0, no Bun/PostgreSQL runtime on the client. Supports stdio commands (including an operator-configured SSH command) and authenticated Streamable HTTP. `probe` checks actual identity/tools/read behavior without printing memory; `context` returns explicitly active memory; `capture` requires profile and per-event consent. `claude-hook` supports only SessionStart/UserPromptSubmit for automatic **reading**, not automatic capture. Never reads prompt or transcript_path fields. Install/configuration and limits: docs/CLIENT-KIT.md in the same source release. Source-root personal identity must match the existing memory owner. A connected MCP server is not proof that an Agent used it.

## Native read integrations (0.13)

The package also ships native-adapters.cjs (OpenCode factory), openclaw.cjs plus openclaw.plugin.json (additive exact-session Hook), and hermes-ultrabrain (primary CLI read-only MemoryProvider). Automatic readers require an observed identity-pinned profile and exact workspace. They do not upload chats, run consolidation or replace memory slots. Use dist/native-adapter-config.py for plan/apply/rollback. Read docs/NATIVE-AGENT-ADAPTERS.md in the matching repository commit for installation and test boundaries. No package with this name is published to npm by this project.

## 0.14 candidate — explicit automatic capture

Automatic capture is disabled unless the trusted profile enables allow_capture, separate automatic_capture scopes, observed identity pins, an exact workspace and an outbox outside that workspace. The new queue-* commands persist pending personal capture events; direct capture retains its previous no-outbox contract. Claude hooks require a stable prompt_id (official schema v2.1.196+). OpenCode callbacks never collect attachment files, tools or hidden reasoning. See docs/AUTOMATIC-CAPTURE.md in the source repository. This candidate requires an independent reviewer before merge; CI success alone is not acceptance.

## Task-aware reads

The task-context command accepts only an explicitly consented task/workspace JSON on stdin. A new allow_task_context profile opt-in, verified identity pins and bound workspace are mandatory; claude-task-hook additionally requires the separate automatic_task_context scope claude-user. Existing context/claude-hook and raw MCP tool contracts are unchanged. No capture, registration or model call is requested. Tasks are sent to the chosen server and may be subject to its operator logging policies. See docs/TASK-CONTEXT.md at the exact source commit for constraints and config/rollback instructions. This is not a new npm registry release or live Claude-model certification.

## Explicit direct-source inspection

The `lineage --profile PATH` command accepts one JSON stdin object with `memory_id`,
`workspace`, `consent:true`, and optional `include_text` (default false). It requires
observed instance/actor pins and workspace binding. It emits verified metadata by
default, never captures text or calls a model. `dist/lineage.cjs` exports
`inspectClientLineage(profile, request, {authorize, signal})` for explicit Node use.
See `docs/CLIENT-LINEAGE.md` in the same repository commit for the complete contract.

## Offline snapshot tools

`ultrabrain-snapshot` (or `node dist/snapshot-cli.cjs`) accepts an explicit JSON
request on stdin: `inspect`, `compare`, `page`, or `record`, `consent:true`, and
one local file selection (`compare` requires two). This is a separate offline
executable: it does not load MCP, open a profile, contact a server, restore data,
or call a model. `dist/snapshot.cjs` exports `inspectClientSnapshots` for selected
paths and `inspectClientSnapshotBytes` for caller-supplied byte buffers.

Each file is completely checked using the existing snapshot contract. A selection
may pin `expected_sha256`. Metadata is the default; only an explicit `record`
request with `include_text:true` returns body/provenance/derivation. File metadata
is still private, matching source labels do not prove the same owner, and absence
in a comparison is not deletion. Local paths may reside on a network-mounted
filesystem; no application network API is used. Full schema and examples are in
`docs/CLIENT-SNAPSHOTS.md` at the exact source commit. A prior package with the
same version string may not have this entry: identify builds by commit and hash.
