# Capture-contention boundary checklist

This is an implementation boundary checklist, not an independent review verdict.
Independent exact-source review and public-parent binding are publication gates.

- Production capture/lock/journal/retirement files are unchanged
- Existing capture workflows and the worker supervisor are unchanged
- Eight writers, acquisition/retry/deadline limits and integrity assertions remain
- New observations use fixed projections and never control retries or ownership
- Original short-circuit decisions precede diagnostic recording
- Successful real-test results require eight valid diagnostic-bearing outcomes
- Missing normally completed reports differ from explicitly shutdown-killed siblings
- Supervisor timeouts and infrastructure failures remain inconclusive with any report count
- Complete TAP, named-test status, suite counters and command exit must agree
- Mixed contention and unrelated test failures cannot imply suite-load sensitivity
- Original failed TAP is byte-identical; no failure is reclassified as passing
- The Windows experiment is one pinned, finite grouped/serialized pair
- Both exit codes and TAP outputs survive a grouped failure
- A failed arm keeps the workflow red; missing evidence is inconclusive
- Public comparison metadata checks actual checkout, tree and sole baseline parent
- No automatic retry, new production probe, public PR, merge or deployment is added

Local Linux Node 24.19.0 validation passed 114 focused tests, including the actual
eight-writer contention case and existing supervisor unit contracts. The evidence
gate qualified all eight diagnostic reports. The tested maximum-size reports were
1,877 bytes including newline, with a 599-byte diagnostic, below the unchanged
4,096-byte report and new 2,048-byte diagnostic limits. Workflow YAML, Bash snippets
and summary JavaScript passed syntax checks. Exact commands and source hashes are
in `evidence.json`.

Pure negative-case coverage includes partial-worker supervisor timeout,
deadline-crossing close, mixed/unrelated failures, cancellation, bailout,
truncation, mismatched test/round status and contradictory command exit metadata.
These are deterministic report-classification tests, not new process-failure
injections or another Windows experiment.

The paired Windows experiment has not run at this source checkpoint. These local
checks do not resolve the retained Windows failure or qualify repository-wide CI.
