# PR50 native contention acceptance continuation — 2026-09-30

Actual baseline: `fd9d6061f205c0156b0e6878c7f2004cc99d4fe8`, tree
`bfc02b29de7bd9723f94347089f449ac3d9d948d`, branch
`development/capture-lock-retirement-20260930-16c1b912`.
Continue the existing PR50, not a replacement module or new PR. No src/, package,
server, migration, dependency pin, deployment or user data changes.

## Native first failures

The fd9 PR-triggered CI observation had19 successful runs and2 failures:
Personal client portability36673626876 and Capture delivery control36673626704.
The original ZIP bytes and extracted TAP/JSON are retained in the handoff archive;
repository provenance contains their GitHub IDs and verified SHA256 values.

Windows Node22 control test failed while enqueueing: three workers reported
`outbox_busy`, authenticated queue/create/EEXIST. Node22.16 control contracts
passed142/142, but its25-round workload failed in round2 during resume with the
same pre-acquisition refusal. This is not evidence of another EPERM, a missing
record, or a changed lock owner. Ubuntu control matrices passed. The production
one-second acquisition bound is intentional; failure to obtain it grants no
mutation authority. The existing enqueue checker already explicitly schedules
bounded busy work; the control checker incorrectly demanded immediate acceptance.

Portability's exact failing test was capture-lock.test.mjs, persistent contention:
`assert.ok(calls>=2&&calls<=3)` with waitMs20. Native callback timing is not bounded
above by the requested delay. The real deadline correctly refused a second claim
when the timer resumed late; the test was making an OS-scheduling assumption.
The log excerpt and native artifact provenance are retained, not overwritten.

## Narrow correction and unchanged acceptance criteria

A TEST-ONLY control workload window now retries only an actual library WeakMap
`outbox_busy` whose diagnostic is queue/create/EEXIST. That pre-acquisition
failure means neither enqueue nor resume has run its critical section. Plain or
copied errors, other lock kinds, EPERM/EACCES/ENOENT, later write/release phases,
publication errors, conflicts and corruption remain terminal. No production
retry or timeout was added; a queued network delivery is never retried here.

Each of the two fixed stages can wait at most7 times (8 attempts), sharing one
absolute10s monotonic window, consistent with the existing enqueue stress caller.
The15s process supervisor is unchanged. Deadline is checked before any invocation,
including after sleep and time spent at the IPC barrier. The exact frozen event
or original pause hash is retained; no regenerated IDs or fresh CAS observations.
A busy wait is never counted as a successful resume or a stale conflict. Native
IO failures remain red. Permanent contention still fails. Counts are included in
bounded worker reports and successful round summaries, not silently suppressed.

The original acceptance assertion remains exact after separately checking the
new bounded counters:8 records,1 resume winner,7 genuine CAS conflicts, unchanged
payloads,attempts0,no leftover files. There is no whole-round or workflow retry.
Both25-round stress commands, matrix cells and all prior assertions are retained.

The20ms unit keeps its old retry-count and diagnostic assertions, adds exact2
claims, and controls only the monotonic test clock. Real timers still execute.
The separate real late-timer deadline audit remains unchanged. Node reference:
https://nodejs.org/download/release/v22.16.0/docs/api/timers.html

## Executed reproduction and review

Three actual filesystem/worker regressions hold a known synthetic queue lock
until the production acquire really returns outbox_busy. Only then an IPC barrier
allows the parent to remove its own lock. The injected wrapper never retries or
changes the returned error. Old worker0/3, corrected worker3/3: enqueue, resume,
and stale resume after another winner. Exact event/hash, single record,revision2,
no spent attempts and no leftover locks are checked. No timed release gamble.

A delayed-timer preload reproduces the old20ms unit failure0/1; the unchanged
preload after the correction passes1/1. Separate policy tests cover deadline,
attempt bounds, retained selection, foreign/forged errors, fatal post-acquisition
errors and report bounds. The first90-case focused run had89pass/1fail because
Node assert.rejects itself probes revoked Proxy exceptions; the test now catches
opaquely and compares identity. The implementation did not change for that test
preparation issue. Final focused90/90 passes (including the real late-timer audit).

Actual UID1000 Linux Node22.16: two25x8-process workloads pass; enqueue600calls,
425records and175replays across25 queues; control8records/round,1winner+7conflicts,
attempts0. No server, model or user queues. A local full-suite command was stopped
by its outer240s tool deadline, without a completed summary, so it is NOT counted
as a pass. A subsequently isolated unmodified baseline readiness file passed29/29;
the unfinished full-run cause has not been established. Do not fabricate a full
local count from its printed partial results; inspect final-SHA CI separately.

Independent review is PENDING at source finalization. Request the exact new SHA
and record only real reviewer findings/executed tests/verdict. Prior fd9 feedback
is not approval of these changes. Main stays unchanged and PR stays draft until
required independent and complete native acceptance is verified.
