# Personal activation independent recovery review — preliminary

Reviewer session identity: `/root/activate_recovery_review`.

Review time: 2026-09-18, beginning before 15:06 UTC. This reviewer did not implement application code or tests. Only this review report was written by the reviewer.

Reviewed working tree: `/workspace/scratch/be43dca0ab34/ultrabrain`, branch `development/personal-activate`, based on `5b3c88826984a9b5c8b34ca2cf7ffff171501697`. The changes were not yet committed when inspected. **Verdict: PENDING final exact application SHA and real ordinary-user CI. This report is not approval to merge.**

## Independent inspection

Read `AGENTS.md`, the entire new activation coordinator and manager adapter, all affected ready/deploy lock and pending paths, the underlying descriptor-bound Store operations, CLI/package wiring, the activation state/manager/CLI tests, the process-exit integration harness, deployment integration insertion, workflow, and usage documentation.

Verified the transaction ordering in `scripts/personal-activate.py`: immutable intent before the sole shared reservation (lines 356–364), durable attempt before the single direct StartUnit (369–375), receipt before last history and pending removal (310–330). Startup is not retried; recovery has no startup, stop, restart or cancellation action. `_held()` closes the manager before releasing the account-global lock (53–64). The shared format 2 pointer makes existing deployers fail closed instead of allowing a second coordinator namespace. Canonical JSON, private ordinary-owned files, no-follow descriptor walks, no-replace publication and directory fsync are inherited from `personal_deploy_store.py`.

Independently read the pinned systemd v255 source through the GitHub connector after web fetches of the GitHub blob pages returned DisabledError. The relevant primary source is commit `db11bab38ccf1ed257f310d29070843d4c58ea01`: `dbus-unit.c` lines 408–421 and 1825–1842; `bus-polkit.c` 502–506; `bus-convenience.c` 704–747; `sd-bus.c` 2413–2515 and 2968–3049. Same-UID authorization completes synchronously; the synchronous credential call does not dispatch newly queued method calls. The subsequent unique-owner Ping therefore cannot overtake this request through a deferred same-UID polkit completion. This is a limited source-based proof, not a general D-Bus barrier claim. Also read `service.c` 1933–2011: before-auto-restart states remain distinct from strict `dead`/`failed`, so the exact SubState terminal checks do not equate an automatic restart delay with completed inactivity.

## Findings sent to the implementation owner

1. **Evidence-scope gap, pending correction:** `after_start_before_ack` at coordinator lines 373–375 runs after the synchronous D-Bus reply was already received and validated, before `ack.json` was durable. The existing real CI case must be described as missing durable acknowledgement, not as a coordinator killed while awaiting the wire reply. At first inspection actual NoReply behavior was only covered by injected manager fixtures. Root accepted adding a separate real send/flush/exit-before-reply case, without replacing the existing checkpoint.
2. **Output-semantics issue, pending correction:** `_finish()` line 334 returned `application_ready: false` while merely completing an already-durable historical `not_running` or `not_dispatched` receipt, even though this path does not inspect current application state. It returned `"not_checked"` only for historical ready receipts. Recommended `"not_checked"` for every historical receipt cleanup, retaining false for a newly observed terminal result. Root accepted this correction and requested its regression test.

Neither observation changes the no-duplicate-mutation proof. No additional filesystem/recovery safety blocker was found during this preliminary pass. A separate boundary reviewer independently reported a device sibling dependency omission; root is correcting it. This reviewer has not yet reviewed that final correction and does not adopt another reviewer's verdict as its own.

## Actual preliminary test executions

- `python3 -B -m unittest discover -s test -p 'test_personal_activate_manager.py' -v`: 47 passed, 0 failed.
- `python3 -B -m unittest discover -s test -p 'test_personal_activate.py' -v`: 51 passed, 0 failed.
- `python3 -B -m unittest discover -s test -p 'test_personal_ready*.py' -v`: 71 passed, 0 failed.
- `python3 -B -m unittest discover -s test -p 'test_personal_deploy*.py' -v`: 87 passed, 0 failed.
- `node --test test/personal-activate-cli.test.mjs`: 6 passed, 0 failed.

Total: 256 Python tests and 6 Node CLI tests. These reviewer-run suites had no first test failure. They were executed in the local root container and cover controlled manager/process/HTTP fixtures, real private filesystem/locks/HMACs, read-only proc checks and public refusal paths. No ordinary-user systemd or PostgreSQL activation was executed by this reviewer locally. No user-host deployment, Windows client integration or real-model quality is established by these results. The implementation agents' separately reported earlier test failures must remain in the overall phase evidence; these passing reruns do not erase them.

Final review will identify the exact full candidate commit, inspect all final changes, rerun affected checks, distinguish real CI from unit fixtures, and issue an explicit PASS or BLOCK.
