# Snapshot impact — implementation review and execution record

## Status and scope

Base: `3fe12777cd1e77deaa02e8c3837dd5aa91b2767d`.
The complete reconstructed base tree is
`f59d863083c9935e118f911dddacabe3fd75d297`; its original commit object also matched
(the original Git timezone was +0800). Source came from Actions artifact
10688030113, not a guessed reconstruction of selected files. Submodule pointers
were retained; submodule contents are not present in this local source copy.

New operation: `impact` on the existing offline CLI and both public Node APIs.
Known reverse consolidation dependencies only; exact root; whole-file
verification; direct/indirect counts; current direct-source observations;
propagated path findings and project crossings; selected-root cycle detection;
coverage gaps; no text, repair, automatic invalidation, server query or writes.
All existing operations, canonical snapshot/lineage contracts, file reader,
authorization helper, dependencies, migrations and upstream pins are unchanged.

**Implementation-assistant self-review completed. Separate reviewer PENDING.**
This record is not a separate-agent approval. No reviewer identity or execution
is invented. The available GitHub actions in this session support reads, not
repository writes or review triggers; the local runtime has no authenticated
GitHub CLI or independent Codex runtime. Plugin discovery found the existing
GitHub connection and unconnected security-review tooling, not an executable
separate-review path. Direct Git transport also failed at DNS resolution.
The local development commit is not a remote commit or accepted release.
No main merge, deployment or user-service change was performed.

## Executed tests (ordinary Linux uid 1000, umask 0022)

| Evidence | Actual result |
|---|---|
| Node 22.16.0 complete `node --test test/*.test.mjs` | 2,071 / 2,071; fail 0, cancelled 0, skipped 0; exit 0; 25.331 seconds. |
| New impact suites | 76 tests, already included in the Node total. |
| Python 3.13.5 complete discovered test ID set | 683 / 683 in seven disjoint batches; fail/error/skip 0; all exits 0; summed runtime 42.948 seconds. |
| Graph oracle | 96 deterministic 17-node graphs compared with a separate fixed-point reachability algorithm, inside one counted test. |
| Boundaries | Every one of 55 actual public authorization checkpoints denied in one test, then aborted in another; no partial results. |
| Size/topology | 1,000-record chain, fan-out and cycle; 999 unique dependents; no depth truncation. |
| Source CLI/wrappers | Real Node subprocesses under existing descriptor/FileHandle/network/subprocess guard, with actual files; bytes/mtime unchanged. |
| Mutation checks | Nine temporary faulty source variants detected by the tests; not nine product defects or additional passing test cases. |
| Static boundaries | Syntax and diff checks; old 44 portability suites retained in order, three new suites appended; other workflows byte-identical; matrix, permissions and timeouts preserved. |

## First failures and self-review follow-up

The initial missing-operation run was 50 tests / 14 pass / 36 fail. After adding
the implementation, 48 passed and two failed: these two were test expectation
mistakes, not new authorization defects. The canonical authorization helper
returns `invalid_params` for asynchronous callbacks, not
`client_authorization_revoked`. The assertions were corrected to that exact
existing contract; the authorization implementation was not changed.

The first expanded run was 77 / 74 pass / 3 fail. All three failures were a
misnamed expected internal error: the canonical handle contract says
`snapshot_not_inspected`, not `snapshot_inspection_required`. Assertions were
corrected without accepting arbitrary errors. The forged handle getter still
must never execute.

A self-review mutation removing inherited cross-project state survived the
then-current tests. The implementation itself already propagated this state
correctly. Added regression covers a project crossing followed by same-project
edges; another distinguishes the root's own upstream finding from descendant
path findings. All nine tested mutations then failed as required: stale-edge
omission, direct-only traversal, hidden root cycle, lost project history, lost
finding history, body disclosure, false complete-impact claim, hidden invalid
coverage, and missing deterministic sort. Original implementation bytes remained
unchanged during mutation runs. Full regression was repeated after adding the
new tests. These are implementer findings, not independent-reviewer findings.

Raw first-failure, successful test and mutation logs are preserved in the
conversation's local evidence archive. `evidence-manifest.json` binds their
SHA-256 digests and the tested source/test files; it does not fabricate a CI job.

## Integration prepared, not counted as executed

`test/client-snapshot-offline-package.mjs` adds impact to CLI/library/bytes tests
on actually compiled, manifest-checked entries in an SDK-free directory.
`test/client-snapshot-audit-integration.mjs` adds 18 impact checks using its
existing six real PostgreSQL/consolidator records, preserving three explicit
synthetic generations and zero external models, plus the six-table and input
file fingerprint checks. Deep graphs are synthetic file fixtures, not fabricated
server-generated lineage. The established task workflow already invokes these
scripts after its build and isolated database setup.

No Bun compiler is installed locally; this session did not execute the canonical
Bun build, npm-installed compiled package, real PostgreSQL integration, Windows,
macOS, external model or actual user-host acceptance. Source execution is not
reported as compiled-package execution. The old base's eight successful CI runs
and its Codex comment 5774466230 cover the base only, not this change.

Required before acceptance: publish the candidate without overwriting concurrent
work, execute exact-commit CI including the prepared package/database checks,
obtain a real separate reviewer verdict bound to that full SHA, resolve blockers
and re-review corrected code. Keep review PENDING and main unchanged until then.
