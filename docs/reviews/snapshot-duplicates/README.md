# Offline exact-content duplicate review — 2026-09-26

Implementation and separate implementer self-review completed. Independent second-agent review: **NOT EXECUTED / NOT APPROVED**. No remote publication or CI result is claimed for this phase. Current GitHub connector discovery exposes read operations only; the local Git transport failed DNS resolution. Plugin discovery found the already installed GitHub integration and optional methodologies/security products, not an executable independent reviewer in this session. Prior review quota failures are historical, not evidence of a new review attempt. Main and all remote PR branches remain unchanged.

## Baseline and scope

Remote base: `8d373b38195f0134a2374cd3996811568d5621e9`, tree `41259f0550ce6bb401de965147d1e441bdf90fd6`. The provided source archive was reconstructed locally including executable modes, tracked historical evidence and all four original gitlinks. The full tree matches GitHub. The local baseline commit is a source reconstruction, not the original remote commit or full remote history. Deliverable patches target the exact verified remote tree; do not replace remote history with the reconstruction.

The new `duplicates` operation is available through the existing offline CLI and both path/byte APIs. It verifies the complete selected file, groups by exact raw content (not hash equality), preserves cross-project/state/origin peers, and reports only bounded metadata. It does not pick a survivor, compare arbitrary source references, normalize text, invoke MCP/models/network, or change a record. All-project/all-state coverage is explicit. Existing server/migration/upstream/tool authorization and n8n integration files are unchanged.

## Findings fixed in a separate self-review pass

1. **Unsafe exception projection**, `src/client-snapshot.mjs`, `snapshotFailure`: the prior implementation read `error.code` multiple times, so a getter could throw or swap a whitelisted code for an unchecked value; a revoked Proxy could also throw. Replace this with one guarded own-data-descriptor read. Three regression assertions reproduce this one defect category (15 tests: 12 pass / 3 fail before correction); all pass afterwards. Original output is retained in `self-review-first-failures.tap.gz`. This is an in-process callback/error robustness issue, not evidence of a remote exploit.
2. **Stale packaging assertion**, `test/client-snapshot-package.test.mjs`: the first full regression run found 11 local imports where the old test expected 10. Preserve builtin/network restrictions and replace the bare count with the exact reviewed eleven-path set including the new module. The first full run was 2499 pass / 1 fail; the exact failure excerpt is retained in `initial-full-regression-excerpt.txt.gz`, and the complete log is in the handoff evidence.

The initial TDD run was 8 pass / 23 fail because the operation did not exist yet; it is not a vulnerability finding. Inspection of the final implementation additionally checked whole-file hash/schema validation, WeakSet-backed handles, deterministic ordering, raw content vs injected synthetic hash collisions, no partial results, large-group cancellation, input copying, fixed metadata projection, provenance/quote non-disclosure and unchanged file bytes/mtime. No remaining blocking issue was identified by this implementer; that is not proof of zero defects or a second-agent verdict.

## Actual local execution

Ordinary uid 1000, Node 22.16.0: full Node regression **2500/2500**, no failures/skips/cancellations. The **56** new tests are included, not added again. The unchanged Python suites and actual Windows were not rerun locally in this phase.

Bun 1.3.13 produced the private npm package. The tarball was extracted locally, not installed from the network. The built offline CLI and both APIs ran **40** checks from an SDK-free directory under the existing sticky no-network/no-child-process/no-file-write descriptor guard; inputs' bytes and mtimes were unchanged. This suite includes **3** new duplicate-operation checks and existing offline operations.

The actual packaged offline entries also ran against a real PostgreSQL/consolidator export: **48** checks, including **3** new duplicate checks across CLI/path/bytes. The fixture explicitly prepares six synthetic records using three injected synthetic generations, not external model calls. Read-phase fingerprints show all six application tables and exported file unchanged. No user dataset, production service or external model was used. The new isolated database was explicitly stopped afterwards.

The runtime and upstream dependency source came from the previously downloaded CI artifact whose ZIP SHA-256 was rechecked as `9c2db948f54f99c04ca7e0f624751a4c23ce130b8ddadf5fba319f9010f8f7b8`. This is use of the pinned runtime in a new local database, not rebuilding PostgreSQL from source or a fresh online install. Exact per-log digests are in `local-evidence.json`.

## Remaining gates

The original Windows/Ubuntu portability command is retained and a new three-file duplicate test step is appended. Existing packaged offline and real database-export fixtures now include duplicate assertions. These are local source changes, **not remotely executed CI** until publication. Neither the prior base's nine successful workflows nor this self-review is a final-SHA independent review. Preserve development-candidate status; do not merge, auto-delete/merge records, deploy user services or claim absolute correctness. The final handoff report records the local commit/tree and clean patch-replay result without changing this historical record.
