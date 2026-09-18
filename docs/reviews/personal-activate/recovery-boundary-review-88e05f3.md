# Supplementary independent activation recovery boundary review

Actual reviewer: `/root/activate_boundary_review/dbus_abi_crosscheck`.

Verdict: **PASS for the journal, recovery and CLI boundaries reviewed on the exact candidate below; no concrete blocking defect found.** This is a supplementary independent review, not the prior `/root/activate_recovery_review` agent's report and not whole-phase acceptance. The main reviewer retains the phase decision, including actual CI8 service acceptance.

Repository: `/workspace/scratch/be43dca0ab34/ultrabrain`.

- Candidate: `88e05f3f84d1cd1ac2e3fdf2f22237c84c6cb3c4`.
- Tree: `f8f540288ffcc5de31b865588130528f05130c71`.
- Phase base: `5b3c88826984a9b5c8b34ca2cf7ffff171501697`.
- Previously examined ABI candidate: `def34fb9577167bebc6f7d41d0c6bb8138220087`.

HEAD and tree were checked during the review and again on completion; the worktree was clean. `git diff --check` from the phase base to the candidate exited 0. No implementation file was edited. I independently read all 499 lines of `scripts/personal-activate.py`, the relevant persistence/locking, readiness/process and manager fence implementations, CLI routing, and the state/recovery fixture assertions. I did not simply accept an implementer's test summary.

## Executed verification

Both suites below were executed by this reviewer, sequentially, with `python3` 3.12.14, from the repository directory. Both returned exit status 0. The complete logs contain respectively 52 and 71 successful test rows and the final `OK`; there was no first failing test.

| Actual command | Result | Evidence file |
| --- | --- | --- |
| `python3 -B -m unittest discover -s test -p 'test_personal_activate.py' -v` | 52 passed, 4.235 seconds | `recovery-88e05f3-state-tests.log` |
| `python3 -B -m unittest discover -s test -p 'test_personal_ready*.py' -v` | 71 passed, 0.819 seconds | `recovery-88e05f3-ready-process-tests.log` |

Both evidence files are in `/workspace/scratch/be43dca0ab34/activate-evidence`. Their SHA-256 values are:

```text
2536623f36cce7351c3e9489f68808832a783b899f63c173227aa49e9d1ece74  recovery-88e05f3-state-tests.log
0d31a116a675eebff4ed460d6cb49cc0c1d1b61e50fdcd9d425e94df84ed6726  recovery-88e05f3-ready-process-tests.log
```

The state tests exercise crashes at journal, attempt, dispatch, acknowledgement, receipt and reservation-clear boundaries; a lost reply without a second dispatch; uncertain jobs/process states; stale sender/fence and identity failures; changed installation/token/database/runtime bindings; offline status; exact record schemas; shared reservations; readiness retry bounds; lock lifetime; and Python CLI parsing/privilege/error boundaries. The readiness/process suite covers protocol validation and isolated process fixtures. These runs do not substitute for real systemd, PostgreSQL, client/model, or MCP integration. I did not rerun the parent's separate manager/deploy tests or Node CLI suite and do not count those as my executions.

## Journal and recovery findings

1. **The existing shared lock and reservation remain authoritative.** `scripts/personal-activate.py:43–89` reads and locks the existing deployment lock without creating one, requires its identity, and closes the manager connection before releasing it. It rejects local deployment pending state and validates the activation reservation's exact format and home bindings. `scripts/personal-deploy.py:176–224` separates exclusive locking from write/create permission; `344–358` retains shared reservation exclusion across deployment and other homes. Public readiness goes through the same reservation check; internal readiness requires an already held, checked lock (`scripts/personal-ready.py:308–318`).

2. **The durable sequence preserves dispatch uncertainty.** `scripts/personal-activate.py:345–391` rechecks the exact plan digest before writing intent and reservation, reobserves the baseline, then persists an attempt before the sole `start_console` call at line 373. A failure after attempt creation cannot be reported as definitely not dispatched. An acknowledgement is a separate record. The only direct `Context` call to `.start_console()` found by an independent AST inspection is `apply:373`; status and recovery have no such call. The readiness loop retries observations with fixed count and time limits, while receipt persistence lies outside that retry catch.

3. **Record validation rejects invented progress.** Intent validation at `185–219` binds the digest, nonce, sender, homes, action, source/runtime arguments, regenerated service plan and baseline. Record validation at `221–269` requires typed exact schemas, the correct operation, attempt/acknowledgement consistency, and a receipt whose dispatch state follows durable records. A ready receipt needs the bounded readiness proof and either an acknowledgement or a recovery fence. Terminal receipts need a recovery fence and cannot silently turn an attempted dispatch into `not_dispatched`.

4. **Recovery remains an observation and cleanup operation.** At `406–436`, the requested pending digest is checked before opening the manager; the old sender is fenced before a terminal or ready conclusion. Saved manager identity is checked, old-sender disappearance requires the exact NameHasNoOwner case, and a Ping to the same manager owner plus repeated identity checks closes the fence (`scripts/personal_activate_manager.py:285–326`). Observation comparison at `scripts/personal-activate.py:275–296` retains installation, graph, manager-process and other-unit bindings, and repeated console invocation/PID checks surround fresh authenticated readiness. Uncertain conditions propagate an error and retain pending state. No recovery path starts, restarts, or retries an application dispatch.

5. **Receipt and history ordering supports crash cleanup without implying new readiness.** At `310–335`, an immutable receipt is stored before the history pointer and before removal of the exact shared reservation. Ownership and receipt checks precede cleanup; directory changes are synchronized. `status` at `393–404` is file-only and reports historical readiness as `not_checked`. Recovery of an already completed receipt also reports `not_checked`, rather than replaying its old application readiness as a fresh probe. A new ready result uses the fresh authenticated check at `288–296`.

6. **The storage implementation supports these assumptions.** `scripts/personal_deploy_store.py:120–238` anchors operations in checked directory file descriptors, uses no-follow and ownership/mode/link checks, bounds regular-file reads, rechecks identities, and requires canonical JSON. New files are exclusive private files with file and directory synchronization. `263–292` uses no-replace rename for first publication and synchronized, parent-anchored replacement/removal for subsequent metadata operations. The coordinator's `_once` at `179–183` additionally reads back and compares the exact immutable value.

7. **Readiness and CLI boundaries retain their scope.** `scripts/personal-ready.py:80–124` binds the challenge/response proof fields; `308–358` caps the deadline, uses the existing private token and loopback endpoint, validates the backend process, and repeats installation/process/lock bindings. It does not upgrade the proof to socket ownership or Worker readiness. The process identity checks in `scripts/personal_ready_process.py:83–223` include process/namespace, UID, start-time and trusted executable bindings. `scripts/personal-activate.py:444–495` permits only the four explicit actions, rejects abbreviated/duplicate/inapplicable options and invalid ordinary-user contexts, and uses bounded diagnostic codes with `activation_outcome: not_proven` on error. `src/cli.mjs:38–44` invokes the fixed script through an argument vector with `/usr/bin/python3 -I -B`, preserving arguments without a shell or fixture-selection option.

## Exact production delta and carried primary-source evidence

I compared `def34fb9577167bebc6f7d41d0c6bb8138220087` with the final candidate for `scripts`, `src`, and `package.json`. The only production difference is in `scripts/personal_activate_manager.py`: `.swap` is accepted by the unit-name grammar at line 66, with explanatory comments. The coordinator state machine, storage, deployment lock/reservation behavior, readiness/process implementations and CLI production code are unchanged from that comparison point.

The final manager blob is **`12e5ad8589d98e147612ff25ad8dc8c637d478a3`**, exactly the blob inspected in my earlier `boundary-passive-swap-source-review.md` (SHA-256 `44990e32ae62bdb38bf69a990bc2cb77c96005a6608df7bf0bafc46474b3dc45`). That report was preliminary; its source reasoning is now bound to the exact final blob, without retroactively treating it as a phase approval. I rechecked the common guard at `scripts/personal_activate_manager.py:433–448`: it rejects both `.device` and `.swap` at line 441 before `_read`/LoadUnit at line 444. Every pending start, stop or verify entry passes this function at line 456. Passive reverse/ordering names remain cached observations and do not authorize traversal.

The fixed [systemd v255 dependency atom mapping](https://github.com/systemd/systemd/blob/db11bab38ccf1ed257f310d29070843d4c58ea01/src/core/unit-dependency-atom.c#L16) and [transaction construction](https://github.com/systemd/systemd/blob/db11bab38ccf1ed257f310d29070843d4c58ea01/src/core/transaction.c#L1012) support that distinction: RequiredBy does not pull a dependent into an ordinary START/fail transaction, ordering examines existing jobs, and following-set expansion belongs to a unit actually receiving a job. The slice vtable has no following-set callback. Reached device and swap units remain unsafe because an empty displayed Following can hide same-device siblings; active-state job redundancy occurs after dependency expansion and is not sufficient protection. The earlier report contains exact fixed-source links, line references and limits. I did not independently execute the parent's new graph regression tests in this supplementary run.

The final `_raw_call` still passes the timeout positionally at `scripts/personal_activate_manager.py:261`. My prior `boundary-abi-def34fb-review.md` (SHA-256 `ec719cf678fc0b6d98def03937f8ba46a28dc72ab284c387cf4b9680b8527cdd`) checked the actual dbus-python 1.3.2 C source at fixed distribution commit `f05cf618f62336d77ec2dfbb1d40a97e5a207c7a`: METH_VARARGS, positional timeout seconds, DBusException error-name preservation and reply message APIs. That is carried source evidence, not a claim that I ran the installed CI C binding or repeated its source retrieval today. The report explicitly retains its historical failed-CI limitation.

## Scope limits and acceptance handoff

This review found no concrete blocker in the examined final journal/recovery/CLI behavior. It relies on the documented supported manager contract and cooperative maintenance assumptions; fixture tests do not prove arbitrary concurrent external changes safe. I did not perform sudo, install dependencies, restart or otherwise mutate services, contact a real manager, or verify CI8. Existing diagnostic/workflow reviews and their historical failures are separate evidence, not additional passing tests in this report. The parent reviewer owns new diagnostic privacy/schema checks, graph/manager and Node CLI results, actual service CI evidence and the whole-phase verdict.
