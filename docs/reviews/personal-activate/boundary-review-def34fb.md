# Independent boundary review — candidate 3

**Verdict: BLOCK for the entire phase at commit `def34fb9577167bebc6f7d41d0c6bb8138220087`.** The D-Bus positional-argument correction is supported by independent source review and the affected local tests, but this exact candidate's real services job still fails the first activation plan with `manager_process_unverified`. The phase cannot be accepted while its required ordinary-user activation path fails before any activation checks complete.

- Actual reviewer: `/root/activate_boundary_review`.
- Repository: `/workspace/scratch/be43dca0ab34/ultrabrain`.
- Exact candidate: `def34fb9577167bebc6f7d41d0c6bb8138220087`.
- Exact tree: `769471a8c864a94c68e2e3b0edcf187ade7b22a1`.
- Phase base: `5b3c88826984a9b5c8b34ca2cf7ffff171501697`.
- Parent candidate: `071b7f4390dfe9e92c9de96b26068617b26bee7a`.
- Last identity/status verification: 2026-09-18 15:42:34 UTC; exact HEAD/tree matched and the worktree was clean.
- Independence: no repository code was edited or implemented by this reviewer. Test logs, source snapshots, and reports are outside the repository.

## Blocking finding

**P1 — the supported ordinary-user integration cannot produce its initial activation plan.** The actual PR services job `105659868935` for candidate `def34fb9577167bebc6f7d41d0c6bb8138220087` reports:

```json
{"personal_activation_failure_after_checks":0,"case":"plan","error_code":"manager_process_unverified"}
```

I independently read the saved raw job log at `job-105659868935.log:449–458`, including the first-plan assertion failure. At line 437 the older services integration reports 18 checks passed; at line 450 deployment reports failure after three checks. The older 18-check success is not the new activation sequence: **zero activation checks completed**. Log SHA-256: `30d1d9a93b1ef46f2dd2c28303b34f7996bb21cfcee80eddee8c66702a3e1eef`. The job log was retrieved and initially preserved by the separate recovery reviewer; I did not execute or retrieve this CI job myself.

The concrete product boundary is `scripts/personal_activate_manager.py:151–165`, where `manager_process` reads the process executable and calls the existing procfs snapshot verifier, and `:219–225`, where initial connection construction requires that process proof. The snapshot verifier checks a trusted executable, process directory/UID, repeated stat/status/executable observations, and PID/network namespaces at `scripts/personal_ready_process.py:150–178,194–223`. The existing broad wrapper collapses underlying failures to the fixed `manager_process_unverified` code. The saved log does not expose that underlying failure, so this report does **not** assert a specific permission, namespace, executable, or process-identity cause.

The current refusal preserves the verification boundary; it is not evidence of an unauthorized startup. It nevertheless prevents the required first plan in the project's actual ordinary-user CI environment. Closure requires obtaining the concrete failing process observation, correcting the implementation or fixture as the evidence warrants without bypassing the manager identity proof, and completing the required real activation checks on a new exact candidate. That corrected candidate requires another independent review. A local fixture pass or the narrow ABI finding below cannot close this blocker.

## Full-phase scope and the candidate 3 delta

The entire phase includes the activation coordinator, manager adapter, shared ready/deploy locking and reservation, CLI/package routing, generator compatibility, documentation, crash/recovery integration, and affected tests. Earlier independent full-phase reports remain unchanged. I inspected the complete new two-file delta from 071b7f4, re-read the affected manager construction, transport, reply, and sender-fence paths, inspected the crash helper's use of the transport, and reran all 259 affected Python and 14 CLI tests on this exact candidate. The remaining phase code and the candidate-2 capture/cache-fixture changes are unchanged.

The earlier independently found canonical-device/reverse-follower dependency issue remains fixed by refusal before `LoadUnit`; those regressions pass in this candidate. The manager/bus binding, graph limits, one-dispatch journal, observation-only recovery, historical receipt cleanup, canonical source checks, and public/internal readiness lock distinction received the prior full review and retain their prior implementation here. This scope statement is not approval over the newly observed real-manager failure.

At `scripts/personal_activate_manager.py:253–268`, the synchronous transport now calls `send_message_with_reply_and_block(message, timeout)` with the timeout positionally. The activation/interactive-authorization flags, selected sender/serial/signature checks, exception handling, and bounded timeout calculation remain intact. At `test/test_personal_activate_manager.py:148–156`, the fake now makes both method arguments positional-only, preventing a permissive Python signature from hiding this C API incompatibility again.

I delegated a separate narrow API crosscheck to actual reviewer `/root/activate_boundary_review/dbus_abi_crosscheck`, who did not implement the product. I read its report and primary-source findings. The pinned distribution [dbus-python 1.3.2 C binding](https://github.com/openkylin/dbus-python/blob/f05cf618f62336d77ec2dfbb1d40a97e5a207c7a/dbus_bindings/conn-methods.c) registers the synchronous method as `METH_VARARGS` and parses a message followed by an optional double; the library's own [Connection.call_blocking implementation](https://github.com/openkylin/dbus-python/blob/f05cf618f62336d77ec2dfbb1d40a97e5a207c7a/dbus/connection.py) uses the same positional call. Timeout units, named error conversion, message setters/getters, and the crash helper's send/flush API are compatible with the change. The narrow report identifies no ABI blocker and expressly excludes whole-phase approval.

Narrow source report: `boundary-abi-def34fb-review.md`; SHA-256 `ec719cf678fc0b6d98def03937f8ba46a28dc72ab284c387cf4b9680b8527cdd`. Independently retrieved pinned source snapshots and their hashes are recorded there. This source check is not an execution of the installed distro C binding or a binary provenance attestation.

## Tests executed independently on exact def34fb

All four suites completed with zero unexpected failures and complete summaries:

| Command | Actual result | Complete log |
| --- | --- | --- |
| `python3 -B -m unittest discover -s test -p 'test_personal_activate*.py' -v` | 101 passed | `boundary-def34fb-activate-tests.log` |
| `python3 -B -m unittest discover -s test -p 'test_personal_ready*.py' -v` | 71 passed | `boundary-def34fb-ready-tests.log` |
| `python3 -B -m unittest discover -s test -p 'test_personal_deploy.py' -v` | 87 passed | `boundary-def34fb-deploy-tests.log` |
| `node --test test/personal-activate-cli.test.mjs test/personal-ready-cli.test.mjs test/personal-deploy-cli.test.mjs` | 14 passed | `boundary-def34fb-cli-tests.log` |

This is **259 Python and 14 Node CLI tests run on def34fb**, rather than counts carried forward from a previous SHA. The local suite runtime was CPython 3.12.14 and Node v24.19.0 on Linux, UID/EUID 0. These tests use fixtures for manager observations and do not exercise the ordinary-user manager process that fails in CI.

| Evidence | SHA-256 |
| --- | --- |
| `boundary-def34fb-activate-tests.log` | `1fb3e36a8dad292a06e84b725014776cef8b41ade651ce01d1d4ab43b94b10ac` |
| `boundary-def34fb-ready-tests.log` | `b3457b5d23696229507baa05c5896a943dc9a5937c5011cca6bbd286ea9ed0ee` |
| `boundary-def34fb-deploy-tests.log` | `35d8bb62bc0c48431703829e28dd7db34ed074684d125a0a7ea698aa5bc0fc37` |
| `boundary-def34fb-cli-tests.log` | `c11a102d5b5ec2b345a1d16d27f8d605313e01b92508a65e11ba1c5d688fd0be` |

I also executed an isolated negative control: load the production manager source from parent commit `071b7f4390dfe9e92c9de96b26068617b26bee7a` in memory and run the current strict-FakeBus identity test against it. It predictably produced one `manager_unavailable` error, with no bus messages/calls sent and the connection closed. Assertions verified that exact outcome. This is an intentional old-code failure showing the regression detects the original ABI issue, not a test failure in def34fb. No repository file was changed. The preserved log is `boundary-def34fb-abi-negative-control.log`, SHA-256 `b92afccb26a6726c198a590f62c78fcdf12f2dbf8fcd190231abdb2cd351b392`. The old source was compiled with the repository filename, so traceback line-cache display can show current text at a shifted old line; the source used was obtained directly with `git show` for the full parent SHA.

`git diff --check` across the full phase base, full HEAD/tree verification, the two-file delta inventory, and clean-worktree checks passed. Current production manager SHA-256 is `5ac4d2aae49f14336f99d5ca1455c9b539732f014b6d0cdeb2d0b6be7bebd6e1`; strict manager-test SHA-256 is `b365d4ba8132afc876676b72a650784589cb112a48c1677db21639d6d6f7a65d`.

## Preserved first failures and limits

The earlier broad Python fake and local-only review did not catch the C keyword-argument incompatibility. That earlier approval is not proof that the old transport worked in real CI. The implementation's first strict-fake/old-call failure remains preserved in `manager-positional-before-fix.log`, SHA-256 `dbeadc9616947216cba49fd5d34f7bd316f5c669a3fb552c411dad3174a1321f`. The exact candidate's newly observed process-verification failure is separately retained above and is the reason for this BLOCK verdict.

The original device finding, candidate-1 initial reset fixture failure, candidate-1 capture failure with unrecoverable original child error, and earlier incomplete log-capture attempts retain their original evidence. Prior reports remain unchanged: `boundary-review-9e85892.md` has SHA-256 `d0732c74f9982f55bd3bb49cd3cdc5a1f4cf67af1db2937dc438e04ac35f0f61`; `boundary-review-071b7f4.md` has SHA-256 `1683f50d4e055bbd92164db397ba5d77bb482d08a91bdc1ba849a60c6d95ec74`.

The candidate-2 independent 51 capture tests, six isolated pin lifecycle checks, actual pin-helper root refusal, and four controlled writer scenarios retain their **071b7f4** attribution; they were not rerun for this unrelated transport correction. The corresponding code is unchanged.

This container has no distro `dbus` module. The narrow reviewer independently confirmed the missing module using `/usr/bin/python3 -I -B` (CPython 3.12.3); no dependency was installed and no ordinary-user gate was bypassed. I did not locally run actual user-systemd or PostgreSQL activation, the 18 real activation checks, a real transport `NoReply` exception, manager replacement/reexec, or deployment. No real process was started/stopped/restarted by this reviewer, and no real model/client call was made. Sender disappearance, message flush, and unknown-dispatch fixture evidence retain the limitations documented in the earlier reviews.

The local test pass and source-confirmed ABI fix stand as valid partial evidence. The exact full candidate remains **BLOCKED** pending diagnosis and correction of the real first-plan process-verification failure and validation/review of the resulting exact candidate.
