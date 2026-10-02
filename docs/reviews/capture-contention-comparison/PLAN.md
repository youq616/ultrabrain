# Finite capture-contention comparison

## Purpose and baseline

The Windows Server 2025 / Node 22.23.3 capture-lock job at public commit
`c379604af7c12a7154ce02b902933e81c2b5a816` failed its eight-process contention
test. The exact base tree is `965cdb95484d1adf896dd69b667bf7043867a1ef`.
The original TAP is retained unchanged beside this document; `baseline.json`
identifies its run, job, artifact and hashes.

Three writers reported bounded queue-create `EEXIST` exhaustion, three completed,
and two were killed during subsequent fail-fast shutdown. The round never reached
integrity validation. Neither corruption nor a harmless timing flake is established.
This candidate adds observations and one finite comparison; it does not change the
production locking protocol or declare the historical failure fixed.

## Immutable behavior

Keep production capture, queue, lock, journal and retirement code unchanged. Also
keep the existing workflows and worker supervisor unchanged. Preserve eight
writers, the start barrier, the three fixed synthetic events, seven outer retries,
25 ms retry delay, 1,000 ms production acquisition limit, nominal 10-second worker
budget and 15-second supervisor bound. The worker budget is checked on collision;
it is not an absolute completion deadline.

All integrity assertions remain: exactly 17 distinct expected records, seven
identical replays, expected file and pending/blocked counts, zero delivery attempts,
and the exact synthetic payloads. Fail-fast shutdown and close-before-cleanup stay
in place. There is no lock stealing, retrying of non-collision I/O errors, new
failure injection, extra progress IPC, or production timing seam.

## Bounded observations

Final worker reports contain a versioned diagnostic with event index, completed
event count, elapsed milliseconds, explicit timing saturation, a terminal reason,
and at most 24 tuples: `[event, attempt, elapsed_ms, outcome]`. Events are 0..2,
attempts are 1..8, and outcomes are accepted/replayed/busy/error. Terminal reasons
are complete/retry_limit/deadline/non_busy_error/setup_error.

Elapsed times are nonnegative integers capped at 60,000 with saturation explicitly
marked. Observations never decide retries. On failure, resolve the original
non-busy/retry-limit/real-deadline short-circuit decision before diagnostic clock
reads or recording; apply that decision without rechecking afterward. Recording
still adds small scheduling overhead and cannot establish identical timing.

The diagnostic is limited to 2,048 UTF-8 bytes. The complete worker report remains
limited to 4,096 bytes including its newline. Validation rejects unknown fields,
bad ordering, contradictory terminal states, impossible counters and inconsistent
retry/replay totals. No paths, event IDs, transcripts, native messages, stacks,
environment contents or arbitrary properties are added.

Legacy synthetic reports without diagnostics keep their existing parser behavior.
The real contention test separately requires eight valid diagnostic-bearing
outcomes before it can pass. Actual checker artifacts must meet the same evidence
criterion; legacy-compatible parsing alone is not qualification. Normally exited
failure reports require diagnostics. Fail-fast-killed siblings can be explicitly
unavailable, without inventing their terminal reason or turning the round into a
pass. Missing command, TAP or round evidence is inconclusive.
Supervisor timeout, infrastructure failure, unconfirmed shutdown and cleanup
failure are also inconclusive, even if some complete worker reports survived.

The evidence reader validates the fixed flat Node TAP shape: header, sequential
test results, one final plan, all completion counters, no cancellation/skip/todo,
the exact named contention result and agreement with its round diagnostic. It
counts unrelated failures without echoing arbitrary test names into new metadata.
The comparison requires the original 198-test suite and agreement between TAP and
actual exit status. Mixed contention plus unrelated failures remain inconclusive.

## One Windows comparison

The new workflow activates only on the uniquely scoped
`dev/capture-contention-diagnostics-20261002` push branch and only on run attempt 1.
Publication is limited to one approved experimental head. No scheduled, PR or
manual trigger, retry loop or additional experimental push is part of this plan.

One Windows 2025 runner uses Node 22.23.3 and the existing eight-minute job bound.
After the new pure unit preflight, run the exact current 16-file capture-lock suite
once with its default file concurrency and once with `--test-concurrency=1`.
Eight writers remain concurrent inside the contention case in both arms. The
serialized arm still runs after a grouped failure. Genuine command exit codes,
step outcomes and complete available TAP are retained; either failed arm keeps
the workflow failed. There is no timeout increase or rerun-until-green.

Metadata records actual checkout/tree/sole parent, run identity, Node/platform,
available parallelism, runner image, commands, fixed execution order and evidence
qualification. The expected sole public parent is the baseline commit above.
Use read-only contents permission and nonpersistent checkout credentials.

Interpretation and stopping rules:

- Serialized contention failure: stop this harness-only track and request a
  separately reviewed production-liveness investigation
- Grouped contention failure with serialized success: evidence consistent with
  suite-load sensitivity, not definitive causality; a scheduling repair needs a
  separate decision and review
- Both pass: the historical failure remains unexplained
- Other test failures, missing evidence, cancellation or timeout: inconclusive

The observation window closes when this single paired job and its artifacts reach
terminal outcomes. Fixed order and instrumentation are known confounders. Existing
matrix jobs and their 25-round checker remain unchanged and retain their own gates.

## Review and verification

Local verification covers pure diagnostic bounds and redaction, missing-evidence
rejection, real eight-worker output, existing supervisor unit contracts, workflow
syntax and exact suite membership. Local Linux results do not substitute for the
Windows comparison. Independent exact-source review, full-tree binding to the
actual public parent, and publication approval remain required. No merge,
deployment or public PR action is included.
