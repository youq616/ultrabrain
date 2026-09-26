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

### Offline source audit

`ultrabrain-snapshot` also accepts `operation: "audit"`, with `consent: true` and
one explicitly selected file. Optional `memory_id` limits the audit to one record;
whole-file integrity is always checked. Reports contain direct same-file source
metadata and separate revision/hash/quote comparisons, never body text. A successful
exit reports completion, not absence of findings; inspect result.counts. No recursive
graph, owner authentication, truth certification or automatic repair is implied.
See docs/SNAPSHOT-SOURCE-AUDIT.md in the matching source commit.

## Offline dependency impact

`operation: "impact"` requires `consent: true`, one selected snapshot and an exact
`memory_id` root. The same CLI and path/byte APIs report potential direct and
transitive dependents, ordered by distance and ID. Stale references are included;
malformed references, unsupported document origins and missing sources are
reported as coverage gaps, not guessed relationships. Results never include
bodies or quotes. No automatic invalidation, deletion, repair or server lookup
occurs. `traversal_complete` covers known supported in-file edges only;
`all_impacts_known`, `graph_verified`, `identity_verified` and `truth_verified`
remain false. See `docs/SNAPSHOT-IMPACT.md` in the matching source commit.

## Explicit owner overview (development candidate)

`ultrabrain-client overview --profile /absolute/private-profile.json` reads one UTF-8 JSON selection from stdin: `{"workspace":"/absolute/workspace","scope":"owned-all-projects","consent":true}`. A trusted profile with observed instance/actor pins and a matching workspace is required. This is owner-wide metadata across **all projects**, even when the profile has a project filter. No capture/document-write opt-in, model calls, polling, automatic retries or body reads occur. The source/request/count contract is verified as a whole, and failures are not zero counts.

The installable Node entry is `require('ultrabrain-client/dist/overview.cjs').inspectClientOverview(profile, selection, {authorize, signal})`. It closes its connection and rechecks authority and workspace before returning. `authorize` must be synchronous; cancellation cannot retract a query already sent. CLI failures use `read_delivery: not_started | unconfirmed`, always with `memory_writes_requested: false`. See repository `docs/CLIENT-OVERVIEW.md` for disclosure limits, identity binding and verification commands. This module is not an independent review approval or a production release.

## Offline exact-content duplicate audit

`ultrabrain-snapshot` accepts `operation: "duplicates"`, `consent: true`, and one explicitly selected snapshot. The existing CLI, path API and byte API return all groups of exactly equal content, with metadata-only members and fields that differ across each group. No trimming, case folding, Unicode normalization, fuzzy matching or model call occurs. All projects, lifecycle states and stored origins remain included. Group IDs label the smallest member ID; they are not recommendations to keep a record. Repeated-occurrence counts are not deletion counts. No merge, delete, live lookup or restoration is performed. See `docs/SNAPSHOT-DUPLICATES.md` at the matching commit. This is a development candidate; identify the private package by commit and SHA-256, not its unchanged version string alone.
