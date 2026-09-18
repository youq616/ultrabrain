# Personal activation independent recovery review

**Whole-candidate review verdict: BLOCK** for **`def34fb9577167bebc6f7d41d0c6bb8138220087`**. The positional D-Bus API correction is independently confirmed, and the reviewer reran 259 Python tests and 14 Node CLI tests successfully on this exact commit. However, the candidate's real ordinary-user CI still refuses its first activation plan with `manager_process_unverified`. The underlying failure remains unresolved at this review. This is not an approval of the full phase or permission to merge it.

- Actual reviewer session identity: `/root/activate_recovery_review`.
- Review completed: 2026-09-18 15:41 UTC.
- Repository: `youq616/ultrabrain`, branch `development/personal-activate`, draft PR #13.
- Full reviewed commit: `def34fb9577167bebc6f7d41d0c6bb8138220087`.
- Reviewed tree: `769471a8c864a94c68e2e3b0edcf187ade7b22a1`.
- Immediate parent: `071b7f4390dfe9e92c9de96b26068617b26bee7a`.
- Entire-phase base: `5b3c88826984a9b5c8b34ca2cf7ffff171501697`.
- Local checkout: `/workspace/scratch/be43dca0ab34/ultrabrain`. HEAD, tree and clean status were checked directly before and after the final test executions.
- Independence: the reviewer did not implement or modify application code, tests, workflow or product documentation. Only evidence files outside the repository checkout were written.

## Blocking finding

**B1 — The required ordinary-user manager process boundary still prevents the first actual activation plan.** In `scripts/personal_activate_manager.py:151–165`, `manager_process()` reads the manager's executable and delegates to `personal_ready_process._process_snapshot()`, then replaces unexpected underlying exceptions with `manager_process_unverified`. `_connect()` calls this verifier at line 222 before reading the supported manager version or proceeding to graph inspection. The reusable verifier in `scripts/personal_ready_process.py:194–230` checks proc identity, all UID values, executable metadata, process liveness and PID/network namespaces. These checks can reject without the fixed public code distinguishing the specific cause.

I independently retrieved the actual logs for [PR Personal user services run 35363387656](https://github.com/youq616/ultrabrain/actions/runs/35363387656), job `105659868935`, on the exact reviewed SHA. The earlier real service suite passed 18 checks. The activation suite then logged:

```json
{"personal_activation_failure_after_checks":0,"case":"plan","error_code":"manager_process_unverified"}
```

The timestamp is `2026-09-18T15:38:57.6516930Z`. Deployment reported failure after 3 checks; the first activation success assertion is `test/personal-activate-integration.mjs:120–123`. Activation, its actual crash/recovery scenarios, and the subsequent readiness/deployment checks therefore have not passed for this candidate. The failure occurs while planning, before activation dispatch. The actual integration setup and initial counter reset reached the plan; this is different from candidate 1's earlier fixture failure and candidate 2's `manager_unavailable`.

The original log is preserved at `/workspace/scratch/be43dca0ab34/activate-evidence/job-105659868935.log`, mode 0600, SHA-256 `30d1d9a93b1ef46f2dd2c28303b34f7996bb21cfcee80eddee8c66702a3e1eef`. It contains no underlying process-verifier exception, so this report does **not** assert a particular proc permission, namespace, executable or import cause. Root and the implementation/integration agents were notified immediately. The manager unit fixture replaces `_process_probe` with a lambda at `test/test_personal_activate_manager.py:210–213`; those passing tests do not establish this real process boundary.

Required resolution: determine the actual failure in the disposable ordinary-user environment, correct the responsible implementation or fixture with a focused regression while preserving the intended identity checks, and obtain review of the resulting full SHA. Do not weaken the process verifier merely to suppress the error. Required real service CI must then reach and pass the activation checks before phase acceptance.

## Entire-phase inspection and verified corrections

I read `AGENTS.md`, checked the complete 16-file phase diff from the base, and inspected the complete activation coordinator, manager adapter, state/manager/CLI tests, crash helper and integration suite. I reinspected affected ready/deploy locks, private state and filesystem primitives, public CLI dispatch, the existing CI cache-reference helper, the workflow and documentation. The earlier full review of the unchanged boundaries is retained in `recovery-review-9e85892.md`; its historical code PASS is not transferred to this newer candidate and does not erase subsequently observed real failures. No migrations, upstream locks, memory contract or Windows qbrain files were altered in this phase.

1. **The positional ABI fix is correct within the independently checked 1.3.2 implementation.** `scripts/personal_activate_manager.py:253–268` now calls `send_message_with_reply_and_block(message, timeout)` with positional arguments. I fetched both the [.version file](https://github.com/openkylin/dbus-python/blob/f05cf618f62336d77ec2dfbb1d40a97e5a207c7a/.version), which says `1.3.2`, and the fixed [conn-methods.c source](https://github.com/openkylin/dbus-python/blob/f05cf618f62336d77ec2dfbb1d40a97e5a207c7a/dbus_bindings/conn-methods.c). Lines 470 and 480 accept `PyObject *args` and parse a tuple; line 1056 registers this synchronous function as `METH_VARARGS` without `METH_KEYWORDS`. The adjacent asynchronous function explicitly has the keyword flag. This establishes the calling convention from C implementation, not a Python-looking documentation signature. The timeout still has the same positive bounded value. `test/test_personal_activate_manager.py:148–160` now makes the fake positional-only, so the old keyword call cannot silently pass through it. Final manager tests actually passed. This source check does not by itself prove all real D-Bus integration works.

2. **Shared reservation and crash ordering remain intact.** `scripts/personal-activate.py:53–89, 345–377` reuses the deployment lock and sole shared pending pointer, requiring an existing lock. Intent is immutable and synchronized before publication; attempt precedes dispatch; acknowledgement follows the validated reply. The existing descriptor-bound filesystem store uses private files, no-follow walks, no-replace publication and directory fsync. Receipt, history and pending removal remain ordered at lines 310–343. `personal-deploy.py:182–226, 344–357` retains lock identity checks and fails closed on activation reservations, including older schema rejection. No additional unresolved journal or coordinator ownership issue was found in the reviewed code.

3. **Recovery does not resend startup.** `personal_activate_manager.py:549–563` marks its one permitted fixed-owner console request before sending it. Reply sender, serial and signature remain validated at lines 260–267; post-send failures remain uncertain. `personal-activate.py:406–436` requires the saved identity and departed-sender fence, then observes strict terminal state or fresh authenticated readiness. It never invokes stop, restart, cancel, reload, enablement or another StartUnit. The same-manager/source-bound fence reasoning from the earlier independent pinned-systemd source inspection remains unchanged, but its real integration is blocked by B1.

4. **Current readiness and historical cleanup remain separate.** `personal-activate.py:282–295` closes fresh readiness against installation, token, database, manager, graph, invocation and PID changes. Existing receipts take `_finish(..., observed=False)` at lines 310–343 and return `application_ready: "not_checked"`; new observed terminal results return false, and fresh ready returns true. The historical terminal regression at `test/test_personal_activate.py:393–425` forbids new application observations while finishing the already-written receipt. State tests on this final SHA passed.

5. **Dependency scope and public error privacy remain enforced.** `personal_activate_manager.py:431–547` rejects hidden device/swap following-set cases, recursively checks start/stop/requisite dependencies, requires the database already active, rejects extra console commands and lifecycle side effects, and closes the graph against observable change. `src/cli.mjs:38–44` and `personal-activate.py:444–495` retain fixed isolated Python, ordinary Linux identity, strict options and bounded error codes. No test environment override was exposed through the product CLI. The B1 log demonstrates that the fixed public code remains redacted, although that also limits the current diagnosis.

6. **The real unread-reply case is represented honestly in code.** `test/personal-activate-crash.py:67–91` sends and flushes an actual fixed-owner StartUnit then exits without waiting for its reply. `test/personal-activate-integration.mjs:149–179, 248–287` distinguishes it from the synchronous reply received before durable ack case. It accepts only fresh ready or fenced terminal outcome without presuming delivery acceptance, and performs bounded read-only recovery. The required 18 activation checks are wired into real CI, but none completed in the observed failing run; this report does not claim that the unread-reply case executed successfully.

7. **Candidate 2's four-file test/documentation delta remains narrow.** `test/capture-outbox.test.mjs:96–135` retries only the documented `outbox_busy`, keeps the same payload and event ID, allows at most 7 retries with time bounds, emits bounded allowlisted diagnostics and asserts exact IDs for all 8 writers. Production outbox behavior did not change. `test/personal-deploy-integration.mjs:164–175` reuses the existing verified console RefUnit helper, has explicit release acknowledgement and preserves an original activation error if cleanup also fails. The unchanged helper's 180-second hold and bounded release paths were reviewed; product activation does not gain RefUnit, reset or stop actions. Activation fixture failures now include the safe case and verb. No additional blocker was found in this narrow delta.

## Reviewer executions on the exact final SHA

| Personally executed command | Result | Saved output under `activate-evidence` |
| --- | --- | --- |
| `python3 -B -m unittest discover -s test -p 'test_personal_activate*.py' -v` | 101 passed: 52 state/CLI fixture and 49 manager | `recovery-def34fb-activation-python.log` |
| `python3 -B -m unittest discover -s test -p 'test_personal_ready*.py' -v` | 71 passed | `recovery-def34fb-ready-python.log` |
| `python3 -B -m unittest discover -s test -p 'test_personal_deploy*.py' -v` | 87 passed | `recovery-def34fb-deploy-python.log` |
| `node --test test/personal-activate-cli.test.mjs test/personal-ready-cli.test.mjs` | 10 passed | `recovery-def34fb-cli.log` |
| `node --test test/personal-deploy-cli.test.mjs` | 4 passed | `recovery-def34fb-deploy-cli.log` |
| `git diff --check 5b3c88826984a9b5c8b34ca2cf7ffff171501697 HEAD` | Passed | Tool execution record |

These are **259 Python and 14 Node CLI tests actually rerun at `def34fb...`**, with zero test failures in this reviewer's local run. The local process runs as root and uses controlled manager/process/HTTP fixtures; it is not a deployment to an ordinary-user manager. The reviewer did not install or start local systemd/DBus/PostgreSQL to substitute for CI.

Separately, this reviewer previously executed **51 capture-related Node tests** on exact parent `071b7f4390dfe9e92c9de96b26068617b26bee7a` using `node --test test/capture-outbox.test.mjs test/automatic-capture.test.mjs test/capture-hardening.test.mjs test/capture-delivery.test.mjs test/capture-profile-binding.test.mjs`, all passed (`recovery-071b7f4-capture.log`). The reviewer also executed **7 controlled tests of the actual existing cache helper** on that parent: reference/release/close acknowledgement, bounded timeout, invalid release, unexpected unit path, Ref failure, Unref failure with connection close, and the public root rejection before D-Bus. All passed (`recovery-071b7f4-pin-helper.log`). They used injected D-Bus objects and real pipes/select/cleanup; they were not actual RefUnit CI. These files and production outbox remain unchanged in `def34fb...`. These carried-forward executions are not represented as reruns on the new SHA or added to the 259/14 final-run totals. Syntax checks of the changed JavaScript also passed on the parent.

## Failure history and remaining evidence

The candidate 1 first failures, candidate 2 `manager_unavailable` failure, and implementation diagnosis records remain preserved. The exact original portability child error was discarded by the old test; a controlled busy-lock reproduction demonstrates a plausible supported outcome but does not establish that old failure's exact cause. The candidate 1 reset-failed/GC account was source-consistent inference, not a retained raw-error diagnosis. This report does not turn either inference into fact.

At the reviewer's latest workflow query, the exact-SHA PR services run was failed, push services run `35363380510` remained queued, and other checks were queued or in progress. The integration agent owns the remaining full CI audit. No overall-green or real-activation success is claimed here. The historical `9e85892` review report remains unchanged; no infrastructure error or interrupted response from the attempted `071b7f4` review counts as an approval.

The candidate remains blocked on B1 and the required actual integration. Any correction requires an independent review of its complete new SHA. This review provides no user-host deployment, Windows-client integration or real-model-quality certification.
