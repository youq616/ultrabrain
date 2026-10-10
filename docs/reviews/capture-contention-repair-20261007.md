# Capture contention fixture repair (2026-10-07)

This is a follow-up to PR #55's exact candidate `d12cea0524eb2401ddcb5ecafe5730f120a4f63f`; it does not alter PR #60 or production capture behavior.

## Trigger and bounded diagnosis

The retained Windows 2025 / Node 22.16.0 job `37100274449`, job `111138274992`, failed the unchanged synthetic eight-process checker at round 23. Its artifact `11265569869` records 22 completed rounds, then a writer-stage `writer_failed`: workers 2 and 7 exhausted eight queue-create `EEXIST` attempts (about 9.47 seconds), while two siblings were stopped during fail-fast shutdown. The original 25 ms retry delay woke contenders together. This evidence is preserved; it does not establish a production locking defect.

## Minimal repair

`test/fixtures/capture-contention-worker.mjs` now uses a deterministic 25–120 ms backoff keyed by worker, event and retry attempt. The schedule is isolated in `test/helpers/capture-contention-backoff.mjs`, which validates the fixture coordinate bounds and is covered by direct boundedness, determinism and fail-closed input tests. It only desynchronizes this synthetic fixture; the production 1,000 ms queue acquisition bound, retry limits, supervisor and lock/journal code are untouched. `test/capture-contention-diagnostics.test.mjs` updates the source contract to require the helper-backed schedule and reject the old fixed-delay string.

The historical comparison plan and `docs/reviews/capture-contention-comparison/evidence.json` remain historical records of the prior source/evidence hashes; their old hashes are not presented as hashes of this repair.

## Local verification

- Focused command `node --test test/capture-contention.test.mjs test/capture-worker-integration.test.mjs test/capture-contention-diagnostics.test.mjs`: 126/126 passed (Node 24.19.0)
- Supervisor/batch contract command `node --test test/capture-contention-diagnostics.test.mjs test/capture-contention.test.mjs test/capture-worker-batch.test.mjs`: 161/161 passed (Node 24.19.0)
- Fresh post-qualification standalone command `node scripts/check-capture-contention.mjs --rounds 25`: 25/25 integrity rounds passed on Linux (zero busy retries)
- Capture lock/outbox/worker regression command with these 13 files: `test/capture-lock.test.mjs`, `test/capture-lock-cancellation.test.mjs`, `test/capture-lock-io.test.mjs`, `test/capture-lock-lifecycle.test.mjs`, `test/capture-lock-cli.test.mjs`, `test/capture-lock-audit.test.mjs`, `test/capture-contention.test.mjs`, `test/capture-contention-diagnostics.test.mjs`, `test/capture-worker-integration.test.mjs`, `test/capture-worker-batch.test.mjs`, `test/capture-worker-audit.test.mjs`, `test/capture-outbox.test.mjs`, and `test/capture-hardening.test.mjs`: 288/288 passed
- Full Node suite: 4,476/4,476 passed, zero skips
- Full Python discovery was attempted (683 tests); this container denied 13 UNIX-socket fixtures with `EPERM` and three systemd/ownership checks failed because `/run/systemd` is read-only or ownership differs. Those environment-limited results are not counted as a pass.

Windows CI on this repair branch is required before any acceptance claim. Keep the branch/PR draft; no merge or deployment is authorized.
