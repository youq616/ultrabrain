# Capture delivery control — implementation-author review

Development candidate, 2026-09-29. This document records the implementation
assistant's separate review pass, not approval by a second agent. The final PR
must identify its exact head, independent reviewer activity and actual CI gates.
Keep draft until the repository's independent-review and platform gates are met.
No merge or deployment is authorized by these results.

## Provenance and integration

Initial work started from the supplied local capture-lock tree
`6901ca832526610862cdc3a586a804d2f2628d3a` (local label `661db1fa`).
Current repository inspection then found PR44, including that module plus atomic
journal publication and a Codex-requested diagnostic correction. The module was
ported onto **actual remote parent `5b8715013a84575407a118bdd481f9454e84a962`**,
**tree `336f2140c03d5fe4607372a5e1f1533f49f4abea`**. The source was recovered from
CI artifact11015083807/run36528190089 and all954 blobs, modes and4 upstream
gitlinks were verified against its exact tree. Artifact ZIP SHA256:
`c4afd6538120bf5cf40686d42b32424c0747ad2ff9eaab0dd05951424abb6e99`.
The merge-labelled artifact contains explicit source IDs for the head, not an
assumption that a merge commit has the same tree.

Three merge regions in automatic-capture/capture-outbox were resolved by
preserving PR44's journal diagnostics and cleanup ordering while adding the
pause gate. Existing CLI post-enqueue diagnostic propagation was preserved.
The low-level publication target allowlist was minimally extended for `control`;
no alternate write primitive, permission retry or new server mutation was added.
Reconstructed local baseline commit ancestry must never be pushed in place of
the real remote parent. Main and all existing PR branch heads remain unchanged.

## Separate adversarial self-review

Checked consent/profile/live authorization, all send boundaries, queue vs delivery
lock ownership/order, fresh restart and disabled profile handling, canonical
control/foreign binding/aliases/bounded inventory, revision exhaustion and CAS
ABA, cancellation, atomic publication, primary/cleanup diagnostics, stale resume,
already-reserved attempts, actual in-flight receipts and same-event replay.

Initial new-feature tests:8/8 failed before implementation because the APIs did
not exist. This is not eight distinct security defects. Initial audit:55 tests,
52 passed and3 failed. Two implementation issues were reproduced: a release
failure obscured the primary write failure, and a pause between entries threw
away the batch's already-confirmed delivery count. The first initial correction
was superseded by the stronger existing PR44 authentic-journal/lock diagnostic
retention during porting; that inherited correction is preserved rather than
reimplemented. The second is fixed by returning the completed partial report and
remaining counts. The third failure was test setup: capture was disabled without
also clearing configured automatic scopes; only the fixture was corrected.
Post-correction55/55 passed on the initial snapshot, not the final-base result.

On PR44, fault assertions intentionally follow its stronger semantics: failed
publication retains a prepared temporary file and a safe authentic diagnostic,
not a raw native Error or silently deleted evidence. This is a contract migration,
not assertion removal. Four additional cases cover temp-file fsync, a rename that
actually succeeds then throws, unknown filenames and a symlinked control. The
latter visible-but-unconfirmed result must not be rolled back or blindly retried.
No remaining blocking implementation issue was identified by these executed
checks; this is not a zero-defect guarantee or independent-agent approval.

## Actual local evidence

Ordinary Linux UID1000, Node22.16.0. Latest full suite before evidence packaging:
**3751/3751**, zero failures/skips/cancellations. The **72 new unit/CLI/process
cases are included**, not additive. Focused control+inherited journal suite:
**136/136**. Final-base checks are in `control-pr44-final.tap` and
`full-pr44-first.tap`. Final sealed-tree replay/full runs are recorded in the
handoff/PR rather than asserted in advance here.

**25 rounds x8 separate Node processes** passed the new control race: each private
synthetic queue retains8 byte-identical events while paused; exactly1 resume
wins and7 return conflict, attempts stay0 and no temporary/lock remains. A further
25 rounds of the existing enqueue checker passed:600 calls,425 stored records,
175 idempotent replays across25 queues. These are different checks, not425 records
in one queue or200 simultaneously running processes. SIGKILL happens only after
the child acknowledges its completed pause; no power-loss guarantee is claimed.

Bun1.3.13 rebuilt the actual client, then npm pack --ignore-scripts created the
private package. Independent extraction verified all11 compiled bundle hashes.
Pinned official SDK1.29.0 and native dependencies came from an existing verified
runtime archive; no fresh registry install, SDK replacement or user install is
claimed for the packaged execution. Source-CLI tests do explicitly replace SDK
imports; their no-connect markers are not live network tests.

Actual **unpacked compiled Node CLI -> official SDK -> stdio MCP -> isolated
managed PostgreSQL**: **13 checks passed**, with3 real committed capture events,
including pause/no-send, stale CAS, resume/no-send, separate flush, pause after
actual server commit, synthetic loss of an actual receipt, and idempotent replay.
Server jobs stayed queued with0 processing attempts; resulting memories remained
private candidates with null confidence. Existing actual capture integration:
**26 checks passed**. No external model/generator, real Agent host, user service
or user queue was used. The temporary PostgreSQL cluster was stopped successfully.

Integration first failures are preserved and classified as fixture preparation,
not production bugs: an overlong synthetic source ID was correctly rejected;
a reused source display name hit a unique constraint while ON CONFLICT DO NOTHING
hid the missing new row; and the first verification query used a nonexistent
event_id column. The fixture now uses a valid unique source, requires one returned
insert row, and queries the real consolidation id/state/attempts schema. Production
validation and schemas were not relaxed. Successful results came from the actual
unmodified package, not the temporary diagnostic build used to expose the cause.

## Platform and independent-review gates

Predecessor PR44 head5b had14 successful and2 failed workflows when read here.
Downloaded Windows22.23.2 lock evidence (run36528190045/job109275744663,
artifact11016020786) failed in round10 with **queue/create/EPERM**. This localizes
that new Windows failure; it does not prove the original PR41 failure's root
cause or justify treating permissions as lock contention. Exact synthetic JSON is
retained. The predecessor portability workflow also failed; its precise cause
was not inspected in this pass. New workflow files are executable entrypoints,
not already-green Windows evidence. Local Linux passes do not establish a fix.

PR44's Codex activity applies to its older commits only. A fresh exact-head
request is required for this module. A completed bot summary or reaction alone
is not the explicit approval/test record required by AGENTS.md. Record the actual
new response and unresolved gates in the PR; never fabricate session IDs, test
runs or verdicts. Until then independent acceptance remains PENDING.

No migrations, server tools, upstream pins, n8n functionality, qbrain, previously
blocked administration UI, main merge or user deployment is part of this change.
