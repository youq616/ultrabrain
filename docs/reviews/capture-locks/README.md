# Capture lock lifecycle — 2026-09-29

Base: remote PR41 head `f53e1c8fda8caca2f90ced2adb15b76ad0494626`, tree `0eb8b4359e257223fbebfc3e9c2dde43025b9789`. All 917 baseline blobs, executable modes and four upstream gitlinks were verified from the supplied prior archive before editing. The reconstructed local Git parent is not the original remote history. Publish a reviewed patch on the actual remote base; never force-push reconstructed ancestry.

## Complete local module

Bounded monotonic cooperative lock acquisition with AbortSignal and synchronous live authority; only authenticated local create-stage EEXIST is retried. Actual lock IO is labeled with fixed kind/phase/system-code metadata. Permissions, disk/IO failure and unknown exceptions are not retried as collisions. Partially initialized locks remain for explicit inspection. Existing lock formats, exact content verification before release, recovery requirements and queue binding remain unchanged. No age/PID lock stealing, implicit permission changes or network retry.

Cancellation is wired through queue enqueue/status, flush acquisition/pre-send bookkeeping, automatic capture manager lifetime and the three ordinary queue CLI commands. Once a request was dispatched, acknowledgement/retention bookkeeping completes despite later cancellation, and owned locks are released. Cancelling cannot retract already sent requests or interrupt synchronous native filesystem calls. The constructor may create an empty private directory; no blanket zero-IO promise is made. The CLI signal tests emit a Node signal event in a subprocess; they do not prove all Windows termination mechanisms deliver a catchable signal.

A source-side self-test runs eight independent barrier-started Node workers in newly created synthetic queues; it takes no user queue/profile path. It verifies unique events and exact idempotent duplicates, untouched attempt counters and no leftover lock/temp files. The original multi-process test retains its acceptance assertions and gains only bounded safe errno/syscall/target diagnostics. No body, path or arbitrary exception is reported. Old portability commands remain; additional four-job Linux/Windows and Node22.16/22 CI is prepared, not executed.

## Separate implementation-assistant review and real failures

Five added filesystem cancellation probes first failed against the baseline (0/5 passed): pre-cancelled enqueue/status/flush and cancellation during queue/delivery lock acquisition could proceed to binding, mutation or attempt bookkeeping. They pass after propagation and pre-mutation checks. These are concrete regression cases, not five unrelated vulnerabilities.

A separate deadline audit reproduced another issue in the new scheduler (3 tests, 2 pass/1 fail): delayed timer resumption could try a fresh exclusive create after the deadline. Check the monotonic deadline before every retry claim; retain the refusal assertion and first-failure TAP. All three audit cases now pass. No remaining blocking implementation finding was identified in the executed review; this is not a separate-agent verdict or proof of zero defects.

Four CLI subprocess tests initially failed during test preload because an existing minimal SDK loader lacked the server/type stubs imported by the actual CLI proxy. Switch only the new test preload to the existing complete lineage CLI loader; do not alter production imports or weaken assertions. First combined run 77 tests, 73 passed/4 failed; corrected run 77/77. The three first-failure logs are retained as deterministic gzip and full raw TAP in the handoff. No synthetic failure is represented as a discovered production vulnerability.

## Executed evidence

Ordinary Linux UID1000, Node22.16.0: final full suite **3615/3615**, zero failed/skipped/cancelled, exit0; **80 new tests** included. Earlier 3603 suite precedes the final added tests. A first launcher timeout left partial `full-first.tap` with no authoritative exit; it is not counted as a completed suite. Final code passed the full run and the 80-test focused run. Exact-base clean patch replay will be recorded separately in the handoff when executed.

The final scheduler code also passed **25 real multi-process rounds**, eight workers each: 600 enqueue calls, 425 stored records across independent queues and 175 idempotent duplicates, no lost updates. This is Linux execution, not a Windows result. Test queues were removed. Lifecycle receipt tests use synthetic responses; CLI tests use explicitly mocked SDK import seams. No external models, user queues, network or running user service was used.

`git diff --check`, JavaScript syntax and YAML/path checks complement, not replace, execution. No new compiled client installer was built: Bun and locked build dependencies were not available through a usable local path. No old tgz is renamed as a new build. No new PostgreSQL/MCP, full Python, browser or actual user deployment result is claimed.

## Windows and release gate remain open

Previous PR41 Windows job109213014310 failed the eight-writer test with one generic writer_failed and no errno. Ubuntu job109213014303 succeeded. The retained excerpt is explicitly an excerpt, not the full log. **The root cause of that Windows failure remains unconfirmed.** The cancellation/deadline fixes and improved diagnostics are not represented as a proven Windows fix. No EACCES/EPERM retry, permission weakening, removed assertion or unlimited timeout is used to obtain green.

Current GitHub tool discovery exposes read operations only; no new remote commit/branch/PR, CI dispatch or reviewer request occurred. Independent second-agent review is **NOT EXECUTED / PENDING**. Main, earlier PRs, applied migrations, upstream pins, n8n/server tools, qbrain, the previously blocked console patch and user services remain untouched. Self-review, fresh directories and passing tests do not authorize merge. The final local commit and tested patch are development artifacts, not remote publication or release approval.
