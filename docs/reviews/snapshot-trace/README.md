# Snapshot trace implementation review (2026-09-22)

## Scope and provenance

Remote baseline: `3fe12777cd1e77deaa02e8c3837dd5aa91b2767d`.
Baseline full tree: `f59d863083c9935e118f911dddacabe3fd75d297`.
Source came from Actions artifact 10688030113, run 35712460005,
SHA-256 `4d797e17d293b0da70e5238a483e057eb5ea924fde421856184cbacd68d74a9a`.
The extracted tree, including executable modes and pinned gitlinks, was rebuilt
and matched the baseline exactly. No user worktree or running service was used.

Module: `trace` on the existing offline CLI and both installed Node APIs.
Single selected root, required consent, optional integer max_hops 1..128 (default
32), verified whole-file input, metadata-only output, canonical matched edges,
cycle and hop-boundary handling, and no historical or identity certification.

## Implementer self-review (not independent-agent review)

Checked request and byte copying, strict root/bounds admission before file IO,
whole-file verification despite a small hop budget, canonical-handle rejection,
iterative termination, cycle indices, mismatch precedence, no historical-version
splicing, no next-source lookup at the budget boundary, exact-boundary unlinked
termination, immutable metadata projection, and cancellation between batches.
No unresolved defect was found in this pass. This statement is not proof of
zero defects and is not an independent-agent verdict.

Existing audit outputs remain unchanged: the optional no-lookup branch is used
only by trace. The standalone client import closure remains nine approved local
modules, with no SDK/Profile/env credentials/network/model/write capabilities.
No server schema, production application writes, permission changes, dependencies,
upstream pins, qbrain files, user services, or UI were changed.

## Actual local execution

Linux, uid 1000, Node 22.16.0, Python 3.13.5.
Node: 2066/2066 pass, zero failed/cancelled/skipped/todo. Four disjoint batches
cover all 96 test files exactly once; 71 new tests are included, not added twice.
Python: 683/683 pass, zero failures/errors/skips. Seven disjoint ID batches cover
the complete unittest discovery exactly once. Full statistics and log fingerprints
are in local-validation.json. A test performs 32 deterministic combinations of
relationship changes; this is not a general property proof.

First missing-feature run: 57 tests, 23 rejection controls passed, 34 failed before
trace existed. Raw TAP is retained as first-failure.tap.gz. Initial implementation
passed 57/57; CLI/audit/package subset passed 138/138 before the final workflow
retention test was added. A monolithic Node run and a combined Node/Python tool
call reached the local tool time limit; those partial runs were not counted as
passing. Complete disjoint reruns supplied the totals above. No product or test
assertion timeouts were increased to obtain a pass.

Node syntax, Python AST, shell syntax, YAML, git diff whitespace, old workflow
step sequence, platform matrices, permissions, timeouts and test coverage checked.
No local Bun, PostgreSQL or Windows execution is claimed.

## CI and independent acceptance gate

At preparation of this commit, current-change CI and separate review are PENDING.
They must be bound to the actual pushed full SHA; old baseline approval does not
cover trace. Keep main unchanged and PR #20 a draft until the appropriate gates
are complete. Final CI and reviewer results belong in the PR acceptance record.

The actual built package is checked without SDK under the existing negative-
capability guard. The PostgreSQL/consolidator audit acceptance now also exercises
trace; its three synthetic injected generations remain explicitly labeled and
external model calls remain zero. A separate trace integration uses real commit/
snapshot storage with five explicit synthetic relation-metadata updates, exports
4/4/6 records, then checks a three-hop path, source correction, two-node cycle,
and bounded traversal in CLI/path/bytes APIs. It does not invent real job history.
Both phases fingerprint six application tables and file bytes/mtime; fixture
preparation does write. Pending executions are not listed as passed here.
