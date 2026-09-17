# Personal-status checkpoint self-review (historical record)

This file preserves the earlier unsubmitted checkpoint account. Publication state and test counts below are historical, not the current receiver verdict; see PERSONAL-STATUS-RECEIVER.md and the final candidate PR for subsequent work.

Base: `1a1c74474a057d2e60eac83a6b8e190792d234e0`, source tree `8d53706a1bb5cea1961afbaa84e8a28643db12d1`. The source snapshot archive digest was verified before reconstruction; the reconstructed Git index matches that tree, including all four unchanged submodule pointers.

This is the implementation assistant's separate self-review, **not a different reviewer Agent, external audit or merge approval**. No independent-Agent identity or verdict is fabricated. The current connector offers read operations but no publication or review-request operation, and the working runtime has no authenticated Git push path. The candidate has not been submitted to GitHub or merged. AGENTS.md's independent final-SHA review and CI gates remain pending.

## Scope and outcome

Checked the new host-only status command, CLI dispatch, unit/property selection, parser, state projection, exit semantics, child-process environment/output/deadline cleanup, tests and user-facing claims. Existing service exporter/installer, runtime database logic, Worker, console, MCP scopes, application migrations and upstream locks are unchanged. No credentials, service journals, arbitrary unit files or personal memory are read by the new command.

Within this implementation self-review, no unresolved blocking issue was found. This bounded review does not prove absence of defects, and actual user-manager behavior is **not yet certified** on this candidate.

### Improvements caught during the separate review

1. Diagnostic scope was implicit: a matching fixed unit name and expected Type cannot prove the unit's ExecStart points at this installation. Added explicit `installation_binding_verified:false` throughout reports and tests. No ExecStart/Environment/FragmentPath values are read as a workaround, and `application_ready` remains `not_checked`.
2. An optional Worker with an unknown enum state could return the default required-unit success without a warning (its per-unit state remained visible). Added `optional_worker_state_unrecognized`; raw unknown text is still redacted and the explicit optional-worker success contract is unchanged. `--expect-worker` still makes an unrecognized Worker fail the overall requirement.
3. Renamed the not-found reason to `unit_not_found`: it describes the manager observation, not proof that no unit file exists on disk.

The five dedicated review regressions were first run against the initial implementation. Two failed (scope flag and unknown optional-state warning); after correction, all five pass. This is a diagnostic clarity improvement, not a claim to have found or fixed a cross-user security exploit.

### Preserved first test failure

The first 38-test run failed the descendant-cleanup assertion: it read `/proc` immediately after SIGKILL delivery and observed the descendant still briefly runnable. The test now waits a bounded two seconds for disappearance/zombie state and handles disappearance between reads; it still fails if the process remains running. Product timeouts, cleanup and permissions were not weakened. The initial failure log and pre-fix review failures are preserved outside the delivered source patch and their hashes are recorded in the checkpoint validation manifest.

## Executed evidence

On the final executable source, as an ordinary Linux test account: all **497 Node tests pass with zero failures/skips**; all **255 Python tests pass**. These totals include six new actual Node/Python CLI checks and 43 new Python status/process/review checks. Static syntax checks of the actual CLI and modified live integration harness pass. Synthetic manager output tests are not live systemd tests.

The actual local `/usr/bin/systemctl` path was exercised by the shipped CLI. This container has no default user manager, so the command returned exit3 with `manager_unavailable`, an empty observed-unit list and no readiness claim. It did not initialize ULTRABRAIN_HOME, connect a database, start a service or call a model. The tests only create temporary synthetic files and child processes, never user data or existing Agent configuration.

The existing disposable-CI personal-services integration test now includes six new status assertions: all units absent; minimal console/database plan; failed model-disabled Worker; restored Worker; console restart; target stopped with database retained. The added assertions verify no extra model calls or task-state changes. **This current candidate's live systemd, remote CI, independent-Agent review and publication have not occurred.** An older baseline CI success does not satisfy them.

## Accepted limits

Only the conventional local user's default systemd bus and fixed `/usr/bin/systemctl` are supported. A trusted OS/manager/same-account process can affect observations; this is not a sandbox. Properties are not an atomic snapshot. A oneshot database unit remaining active is not SQL/socket health. Console running is not HTTP/MCP readiness. Worker exit2 is a troubleshooting hint, not an independently proven model-config diagnosis. Optional Worker status produces warnings by default; explicit expectation makes it required. `NRestarts` is the manager's current counter, not durable history. Raw stderr and arbitrary property values are never printed. Publication, real-systemd acceptance and final review remain necessary before releasing this feature.
