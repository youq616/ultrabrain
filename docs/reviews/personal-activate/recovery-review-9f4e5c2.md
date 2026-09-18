# Independent recovery review — candidate 7

**Whole-candidate verdict: BLOCK** for **`9f4e5c2ac81250b7025234fd61008d0bc92e31ef`**. The narrow CI registration wait and safe D-Bus error enum passed this reviewer's 14 additional controlled tests. Both real CI jobs now pass the unchanged production manager identity verifier, but both first activation plans fail with `invalid_manager_dependencies` before completing an activation check. The actual start/crash/recovery acceptance remains unexecuted.

- Actual independent reviewer identity: `/root/activate_recovery_review`.
- Repository: `youq616/ultrabrain`; branch `development/personal-activate`; draft PR #13.
- Full reviewed commit: `9f4e5c2ac81250b7025234fd61008d0bc92e31ef`.
- Reviewed tree: `a03ce02592501574bf03d145cce127fe8eebe5fd`.
- Immediate parent: `c6b409c9864f0d0d97577bde9b2a3d84207ee717`.
- Entire-phase base: `5b3c88826984a9b5c8b34ca2cf7ffff171501697`.
- Review date: 2026-09-18. Exact HEAD/tree and clean status were checked directly before and after the new targeted executions.
- Independence: this reviewer wrote only an external reviewer script, logs and reports under `/workspace/scratch/be43dca0ab34/activate-evidence`. The reviewer did not implement or edit repository code, tests, workflow or product documentation.

## Blocking finding and actual integration

**B1 — The first actual activation plan still fails before dispatch at the dependency-name boundary.** `scripts/personal_activate_manager.py:139–143` validates dependency/name arrays as lists of at most 512 distinct strings matching the accepted unit-name grammar. Its fixed failure code is `invalid_manager_dependencies`. The exact candidate's two real jobs each report:

```json
{"personal_activation_failure_after_checks":0,"case":"plan","error_code":"invalid_manager_dependencies"}
```

The first-plan call is at `test/personal-activate-integration.mjs:265–268`; the success wrapper rejects a nonzero exit at lines 120–122. The current log establishes refusal in `names()`'s guard, but **does not identify the rejected unit, property, value type, duplicate, count, or unit name**. This review does not diagnose one of those possibilities as fact or recommend accepting arbitrary dependency data. The responsible condition must be observed in the disposable CI environment and resolved without silently broadening the mutation/dependency contract; the resulting exact SHA must be independently reviewed and the required real activation checks must pass.

The CI setup has made measurable progress: each run recorded first-attempt `NameHasNoOwner`, then second-attempt production identity success, actual permitted capabilities empty, stable process observations, and readable/equal PID and network namespaces. A new read-only identity diagnostic after the failed plan also succeeds in each run. These are actual CI7 observations. They do not retrospectively prove the unrecorded D-Bus error name in CI6 or erase any preceding failure.

I independently read the saved raw logs, including the setup attempts, post-failure identity success, activation and deployment failure counters, and final exit 1. `/root/activate_integration` fetched and produced the full audit; its audit is explicitly implementation-agent triage, not substituted for this independent review. I did not duplicate network log retrieval.

| Actual run/job | Source binding | Setup and legacy suite | Activation/deployment/readiness |
| --- | --- | --- | --- |
| [PR run 35368448951, job 105676442134](https://github.com/youq616/ultrabrain/actions/runs/35368448951/job/105676442134) | Audited merge `21bfb93925b5b5d50948df0f449c153310ec9385`, tree equals this candidate | Setup succeeds on attempt 2; 18 legacy services checks pass with 2 calls to the local synthetic model fixture | Activation fails at first plan, 0/18 completed; deployment reports 3/15 before failure; readiness not reached |
| [Push run 35368445358, job 105676431152](https://github.com/youq616/ultrabrain/actions/runs/35368445358/job/105676431152) | Exact candidate checkout | Setup succeeds on attempt 2; 18 legacy services checks pass with 2 calls to the local synthetic model fixture | Activation fails at first plan, 0/18 completed; deployment reports 3/15 before failure; readiness not reached |

The PR activation failure is at raw log line 546, timestamp `2026-09-18T16:27:51.5489984Z`; the push failure is at line 530, timestamp `2026-09-18T16:28:14.9763710Z`. The genuine send-without-reading-reply case, durable ack interruption, recovery checkpoints, source-removal check and final activation readiness assertions were not reached. The successful legacy model calls use a synthetic provider and are not real-model-quality evidence.

Preserved raw evidence hashes, recomputed by this reviewer:

| File under `activate-evidence` | SHA-256 |
| --- | --- |
| `CI-SEVENTH-SERVICES-AUDIT.json` | `8cb6ee555d90ef3c23694f1edd7bbe3aa4825d538d99e1981810e913cceec82f` |
| `job-105676442134.log` | `831d997c4cb7a4fae0ae926ce8e17685bf03a76538b1d899996e8e8d1b92035b` |
| `job-105676431152.log` | `d9aa399e05b3a4a8f56aea86a77e28a218eb823ae13d66bdc2fe2963495959e3` |

## Three-file correction reviewed

1. **The wait can retry only the observed unbound-name condition.** `.github/workflows/personal-services.yml:140–167` sets a 35-second monotonic budget and at most 20 helper invocations, passes only remaining time to the fixed isolated Python subprocess, and sleeps at most 0.5 seconds after an accepted transient failure. Each attempt is printed before any retry, preserving the first failure. Retry requires exactly two exception layers: an `ActivateManagerError` with `manager_unavailable`, then `DBusException` with enum `NameHasNoOwner`. Manager proc availability must be false, proc errno null, and capability/process-stability observations unknown. Nonzero exits, timeouts, malformed envelopes or any other identity/permission/bus error fail the setup. Once a PID has been observed, another NoOwner cannot satisfy the unbound condition.

2. **Each attempt executes the original read-only verifier.** `test/personal-activate-crash.py:259–273` creates the real `LocalManager`, invokes `connection_identity()`, emits bounded diagnostics and closes the connection in `finally`. This does not call an activation coordinator or any StartUnit/restart/stop/reload method. `.github/workflows/personal-services.yml:135` retains the single existing disposable-manager restart outside the wait; the new loop does not repeat it. The preceding exact-account/cgroup guard, fixed no-follow exclusive root runtime drop-in, cached empty capability checks and actual empty-capability postcondition remain intact. No signal or fallback root attestation is introduced.

3. **The new D-Bus field is a fixed enum.** `test/personal-activate-crash.py:57–68,71–102` maps only five full D-Bus error names to fixed short labels. It requires an exact Python string, catches failed getter lookup/invocation, and returns null for unrecognized values. It never stringifies an exception or emits an arbitrary error name. Exception counts, traceback frame counts, safe-code allowlists and proc disclosure limits remain unchanged. `test/personal-activate-integration.mjs:139–179` adds the exact new schema key and accepts only those enum values or null before emitting diagnostics. Product CLI output is unchanged.

No additional code blocker was found in this three-file correction. Its narrow review result does not satisfy B1 or constitute approval of the entire phase.

## Entire-phase boundary review

I read the repository's `AGENTS.md`, inspected the complete phase diff inventory, reviewed all three new file deltas, and reinspected the activation transaction/fence/readiness code at the precise current checkout. The complete production, filesystem, manager, ready/deploy, CLI, crash-fixture and test review is recorded across the preceding independent reports. `git diff --exit-code def34fb9577167bebc6f7d41d0c6bb8138220087 9f4e5c2ac81250b7025234fd61008d0bc92e31ef -- scripts src package.json` passed with no difference. I also individually compared candidate 6/7 bytes for the coordinator, manager, ready/deploy commands, shared store, shared process verifier, CLI and package scripts.

- `scripts/personal-activate.py:53–89,310–377` keeps the shared deployment flock and sole format-2 pending reservation. Intent is immutable and synchronized before pointer publication; attempt precedes one start; ack follows a validated response; receipt precedes history and pending removal. Existing descriptor/path identity checks remain in `personal_deploy_store.py:225–292` and the deployment lock/pending paths. A prepublication orphan has no start authority, and other coordinators fail closed on the shared reservation.
- `personal_activate_manager.py:191–234,253–268,283–329` still binds fixed local bus ID, unique manager owner, credentials, live process identity and supported version. The positional synchronous C ABI fix remains intact. Recovery requires the saved identity, an explicitly departed old sender, the matched same-owner Ping barrier and subsequent identity closure. CI registration waiting and the production recovery fence are different operations; this correction does not broaden the fence.
- `personal-activate.py:282–295,310–343,406–436` still observes authenticated source/database/instance/token/installation readiness afresh when claiming current readiness. Existing receipts return `application_ready: "not_checked"` during cleanup. Recovery never resends startup or performs any stop/restart/reload/cancel action. `personal_activate_manager.py:549–563` remains the sole one-shot fixed console request.
- `personal_activate_manager.py:431–547` still rejects unsupported device/swap propagation, checks recursive start/stop/requisite scope and relevant cached lifecycle state, and requires other start dependencies/database already active. B1 shows a stricter validation guard currently blocks the real environment; accepting unknown data is not a reviewed correction. No database migration, upstream lock, Windows qbrain or unrelated memory-contract change has appeared.
- The actual unread-reply helper at `test/personal-activate-crash.py:323–344` continues to send and flush a fixed verified-owner request, then exit without reading its response. It stays distinct from a validated reply whose ack has not yet been persisted. Integration at `test/personal-activate-integration.mjs:300–340` permits only fresh ready or fenced terminal observations without another start. These are inspected implementation paths, not successful CI7 executions.

## Personally executed evidence and carried-forward tests

On exact candidate 7 I wrote and ran `recovery-9f4e5c2-targeted.py`: **14 tests passed in 0.051 seconds**, with no first failure. Unlike a hand-built envelope-only test, its controlled bus feeds the actual `LocalManager._connect`, `_call`, reply validation, `connection_identity`, and actual `diagnose_manager`; that producer output is then consumed by the extracted actual workflow wait. The bus transport and proc observations are injected and are not real systemd/capability verification.

The cases cover NoOwner followed by success with both connections closed, immediate success, all other recognized bus errors and private unknown names, NoOwner after manager PID binding, UID mismatch, proc permission failure, NoOwner followed by permission failure, 20-attempt exhaustion, 35-second exhaustion, subprocess timeout, exact boolean identity/capability postconditions, malformed outputs and exits, getter failure/enum privacy, and the actual public helper's root rejection. Every observed manager call in these fixtures is a read and every message has auto-start and interactive authorization disabled. Subprocess stderr carries an injected private sentinel, which is never emitted by the wait. The clock is controlled; no real sleep or service action was performed. The public root rejection alone is a real isolated subprocess.

| Candidate 7 execution | Result/evidence |
| --- | --- |
| `python3 -B /workspace/scratch/be43dca0ab34/activate-evidence/recovery-9f4e5c2-targeted.py` | 14 pass; `recovery-9f4e5c2-targeted.log` |
| `node --check test/personal-activate-integration.mjs` | Pass |
| Python AST parse of changed helper; compile of actual workflow wait | Pass |
| `git diff --check 5b3c88826984a9b5c8b34ca2cf7ffff171501697 9f4e5c2ac81250b7025234fd61008d0bc92e31ef` | Pass |
| Production path identity comparison and final clean checkout check | Pass |

The reviewer script SHA-256 is `03132a08afffd428cbcf7f69d7e3f112bb2783e176be27f933510f40bfd6862b`; its log SHA-256 is `cb78ec095a7e222f532e4e9ac472973a282e0c9318efed2e06ccaf733e28fa43`.

**The 259 Python and 14 Node CLI tests were personally executed on exact parent `c6b409c9864f0d0d97577bde9b2a3d84207ee717`, not rerun on candidate 7.** All passed, and their files/production subjects are unchanged by this three-file correction. The saved `recovery-c6b409c-{activation,ready,deploy}-python.log`, `recovery-c6b409c-cli.log`, and `recovery-c6b409c-deploy-cli.log` provide their original outputs. Candidate 6's 16 CI-setup/diagnostic controlled tests also remain historical evidence; the replaced waiting postcondition is covered by the new candidate 7 tests above. Earlier 51 capture and seven cache-helper tests belong to exact `071b7f4...` and are not added to this candidate's new-run count.

This report preserves all older reports and first failures without amendment. The full SHA reviewed here remains **BLOCK** because B1 and the required real start/crash/recovery checks are unresolved. It provides no user-host deployment, Windows-client integration or real-model-quality certification.
