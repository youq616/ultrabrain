# PR45 independent review and bounded worker-diagnostic correction

Development candidate, 2026-09-29. This supplements the initial implementation
record in REVIEW.md; its 3751/72 figures are historical, not final totals.

## Actual independent finding

Reviewer: `chatgpt-codex-connector[bot]`. Reviewed exact commit
`3ddc2f1635c0768ba37d9c6443360b8476cc8a9f`, tree
`ce2f2f816375bd0d1cee61a5aa992e0bfe12a494`, against actual PR44 parent
`5b8715013a84575407a118bdd481f9454e84a962`.
Review5351485915, discussion4132627368, submitted2026-09-29T10:59:17Z:
https://github.com/youq616/ultrabrain/pull/45#discussion_r4132627368

The reviewer raised P2 at scripts/check-capture-delivery-control.mjs:61: a child
failure before the staged barrier became a generic checker failure, and completed
worker results also discarded their error code. Thus artifacts could not distinguish
native permission/IO errors, corruption, timeouts or unexpected worker exits.
Review state was COMMENTED, not approval. The summary completed at10:59:19Z; it
provided no independently executed-test record or separate session identifier.
Neither has been invented or inferred from the implementer's test results.

## Reproduction and correction

Four real-child fault regressions first ran against the original implementation:
**0/4 passed,4 failed**. Original TAP is committed as codex-diagnostic-before.tap.gz.
All four are retained, with no weakened success assertion. The correction keeps
all child completion reports even when ready/staged barriers reject; reports carry
worker index, stage, bounded exit/signal/error fields and safe lock/journal phases.
Timeout, stderr presence and output overflow remain distinct. Serialized child
JSON is capped at4096 bytes and revalidated against fixed enums before emission;
it is a synthetic report, not an authenticated local error or server receipt.
No arbitrary message, path, body, getter or credential is copied into artifacts.

The child uses the existing authentic local diagnostic extractor. Additional
adversarial tests cover actual timeout termination, malformed/oversized output,
unknown fields and bounded nested cleanup diagnostics. Correction scope is the
checker, worker, test-only preload, report parser, tests and this evidence. No
production capture, gate, CLI, consent, retry or package-build code changed.
The deliberate Linux EPERM/ENOSPC injections are NOT a real Windows reproduction,
permission retry, or proof that any Windows filesystem issue is fixed.

## Executed corrected local evidence

Ordinary Linux UID1000, Node22.16.0: diagnostic plus existing process suite
**10/10**, control plus inherited journal **144/144**, full suite **3759/3759**,
zero failures/skips/cancellations. The module's **80 added tests** (72 initial +8
review regressions) are included in the full total, not additive coverage.
Corrected control checker:25 rounds x8 real independent processes, each round
exactly1 resume and7 stale conflicts,8 byte-identical entries,0 spent attempts,
no remaining lock/temp files. Existing enqueue checker also passed25 rounds.
First-failure and corrected-run hashes are in codex-correction-evidence.json.
Final sealed-tree replay/rebuild evidence belongs to the matching handoff/PR;
this document does not assert future executions or its own not-yet-known SHA.

The previously executed real compiled SDK/stdio-MCP/PostgreSQL13 checks and existing
capture26 checks apply to production code unchanged by this correction. They were
not rerun just to relabel them as new tests; the matching compiled artifact hashes
and package digest identify that scope. No real Agent host/model/user deployment.

## Initial-head CI, separately from corrected-head acceptance

Initial3dd delivery-control run36558404814: both Ubuntu jobs succeeded, while both
Windows jobs failed. Downloaded Windows22.16 artifact11029391798 has39/134 passing,
95 failures, chiefly outbox_corrupt at queue-lock release while preparing tests;
it is NOT evidence of the same EPERM root cause. Windows22 artifact11028532405
passed134/134 focused checks then failed the stress run after13 completed rounds,
with only generic delivery_control_check_failed: exactly the missing-diagnostic
boundary identified in review. Raw artifacts are preserved in the handoff.

The initial/new workflow counts differ from local counts where existing tests are
platform-conditional. No failed assertion or job has been removed to make CI green.
Older PR44 queue/create/EPERM and the Windows22.16 lock-release failures remain
unresolved platform gates; local Linux passes do not establish their repair.

## Acceptance boundary

The correction must be committed as an actual child of3dd, preserving main and all
other PR heads, then independently reviewed at its exact new SHA. Initial-head
review and CI cannot approve the correction. At preparation of this committed
record, corrected-head independent acceptance is PENDING. Record the actual new
review and CI status in PR45 and the final handoff; do not turn a completed bot
summary, an emoji or an implementer rerun into an explicit release approval.
No merge or deployment; keep draft while any required gate is unresolved.
