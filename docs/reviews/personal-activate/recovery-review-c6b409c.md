# Independent recovery review — candidate 6

**Whole-candidate verdict: BLOCK** for **`c6b409c9864f0d0d97577bde9b2a3d84207ee717`**. This reviewer independently reran 259 Python tests and 14 Node CLI tests successfully at that exact commit, and added 16 controlled checks of the CI setup and diagnostic boundaries, all passing. The two real ordinary-user services jobs both failed during setup before any service, activation, recovery, deployment or readiness scenario began. The candidate has therefore not met the phase acceptance gate.

- Actual reviewer identity: `/root/activate_recovery_review`.
- Repository: `youq616/ultrabrain`; branch `development/personal-activate`; draft PR #13.
- Full reviewed commit: `c6b409c9864f0d0d97577bde9b2a3d84207ee717`.
- Reviewed tree: `6921e7e0cc63ce915012d6736579f4b239210d14`.
- Entire-phase base: `5b3c88826984a9b5c8b34ca2cf7ffff171501697`.
- Review date: 2026-09-18. HEAD/tree and clean status were checked at the beginning of this candidate's inspection and local executions. By report completion the implementer had advanced HEAD to candidate 7; this report remains scoped to the exact candidate 6 object and its saved test/CI evidence.
- Independence: no repository application, test, workflow or documentation file was edited by this reviewer. Reviewer scripts and logs were written only under `/workspace/scratch/be43dca0ab34/activate-evidence`.

## Blocking finding

**B1 — The actual post-restart manager identity postcondition is not established, so the required real integration remains unexecuted.** The new CI setup in `.github/workflows/personal-services.yml:125–151` performs a daemon reload, checks both cached capability properties are empty, enables linger, restarts the fixed disposable manager, then immediately calls the read-only production identity diagnostic. Both actual jobs reached that diagnostic and failed at `scripts/personal_activate_manager.py:215`, the fixed manager name's `GetNameOwner`, through `_raw_call()` at line 259. The diagnostic reports `manager_unavailable` with an inner `DBusException`. It does not record that exception's D-Bus name in candidate 6.

The failed calls occurred before acquiring the manager PID or checking its process metadata. In both logs, `manager_proc_available` is false and `manager_capprm_nonzero`, `manager_process_stable`, and all manager credential comparisons are null. Success of the earlier shell commands and empty cached properties does not establish the running manager's actual permitted capabilities, executable, namespaces or identity. A registration delay is plausible, but the exact `NameHasNoOwner` error is **not established** by these logs and is not retrospectively claimed here.

I independently read the already-preserved raw logs and audit; integration-agent interpretation alone was not treated as independent evidence. The implementation agent `/root/activate_integration` fetched and audited the runs. I did not duplicate the network retrieval.

| Actual job | Checkout binding | Result |
| --- | --- | --- |
| [PR run 35367592709, job 105673679377](https://github.com/youq616/ultrabrain/actions/runs/35367592709/job/105673679377) | PR merge `caf2a654338491ecc1a5a0a744f079da874115f2`, audited tree equals the candidate tree | Step 9 setup failed; diagnostic at `2026-09-18T16:18:23.8107436Z`; assertion failure and exit 1 follow. |
| [Push run 35367588704, job 105673665304](https://github.com/youq616/ultrabrain/actions/runs/35367588704/job/105673665304) | Exact `c6b409c9864f0d0d97577bde9b2a3d84207ee717` checkout | Step 9 setup failed; diagnostic at `2026-09-18T16:18:04.9131030Z`; assertion failure and exit 1 follow. |

In **each** job, the legacy 18 service checks, 18 activation checks, 15 deployment checks and 12 readiness checks were not reached. No unread-reply crash, recovery checkpoint outcome, authenticated readiness or model-call result is reported as executed for these jobs. CI must reach and pass those scenarios on a corrected, independently reviewed exact SHA before whole-phase acceptance. An allowed bounded read-only registration wait must distinguish the actual fixed `NameHasNoOwner` result from permission, identity, timeout, disconnection or arbitrary `manager_unavailable` failures. Neither an extra mutation nor weaker production identity checks are justified by this evidence.

Preserved evidence under `activate-evidence` (hashes recomputed independently when writing this report):

| File | SHA-256 |
| --- | --- |
| `CI-SIXTH-SERVICES-AUDIT.json` | `b8bfc96219bbf8a7f178cd7c31079227a7b118665ed01deef65c2e0dfdb0caeb` |
| `job-105673679377.log` | `0112f5861cafc9a94fd182f14b077422bcd8d28e72b3dc9ad2efe6b358691937` |
| `job-105673665304.log` | `5f53cbc387ac073e80da0c8a2a3c25dc91158f9699b518f2dda82de75307e0b6` |

## Full-phase review and new CI fixture

I read `AGENTS.md`, checked the complete 16-file diff from the phase base, and reviewed the complete activation implementation, affected ready/deploy locks and filesystem store, CLI, tests, diagnostics, workflow and documentation across the recorded independent reviews. I reread the complete `def34fb...` to candidate 6 delta and the original production boundary locations this round. Production paths `scripts`, `src`, and `package.json` are byte-identical between `def34fb9577167bebc6f7d41d0c6bb8138220087` and this candidate. The detailed unchanged-boundary findings in `recovery-review-def34fb.md` and `recovery-review-9e85892.md` remain inspection evidence; their historical verdicts do not approve this SHA or erase real failures.

1. **The fixture preserves the production process verifier.** `.github/workflows/personal-services.yml:70–88` requires Linux, an ordinary real/effective UID, the explicit CI/write/systemd flags, the exact runner account and disposable installation path. It reads every cgroup hierarchy with a bounded no-follow open and rejects the exact `user@UID.service` path component at any depth. The intended runner process is therefore checked outside the service it is about to restart. Invalid, empty, oversized or NUL-containing paths refuse setup.

2. **The root write is limited to a new fixed runtime drop-in.** Lines 91–124 bind the positive canonical UID to `SUDO_UID` and the known runner account. Descriptor-bound directory walks require root-owned non-group/non-world-writable parents and no-follow opens. The fixed `90-ultrabrain-ci-capabilities.conf` uses exclusive creation and rejects pre-existing files, including links. It writes only `[Service]`, an empty `CapabilityBoundingSet`, and an empty `AmbientCapabilities`; the file and containing directory are synchronized. Lines 125–135 bound client commands and require the cached settings to be exactly empty before the fixed CI manager restart. This is an ephemeral CI-host setup mutation, not a product permission adjustment. The command timeout bounds the client invocation; it does not independently prove that a server-side job cannot outlive a client timeout.

3. **Postconditions remain mandatory.** Lines 140–151 invoke the original `LocalManager.connection_identity()` through the gated helper and require both its success and `manager_capprm_nonzero is False`. They do not substitute cached ExecStart/MainPID, D-Bus self-report or process-directory ownership for the existing executable, UID, process lifetime and namespace checks. The lack of these successful postconditions is B1, not a reason to bypass them. `docs/PERSONAL-ACTIVATE.md:14,77` accurately adds the proc-readability prerequisite and identifies the capability adjustment as CI-only. A matching UID alone is not claimed sufficient.

4. **The CI diagnostic remains read-only and private.** `test/personal-activate-crash.py:29–274` restricts exception metadata to fixed file/function/type/code labels, bounded errno and traceback lines, and selected proc booleans or fixed security-label enums. It never prints exception messages, raw status/namespace/security-label strings or locals. Missing process observations remain null or unavailable. The public helper retains the ordinary-user disposable-CI gate. `test/personal-activate-integration.mjs:127–180` validates the bounded structured diagnostic, invokes it only to investigate an initial plan failure, and preserves the original failure and completed-check count.

5. **Journal ownership and dispatch remain unchanged.** `scripts/personal-activate.py:53–89,310–377` reuses the existing deployment flock and sole format-2 pending pointer. Immutable synchronized intent precedes pointer publication; durable attempt precedes the sole StartUnit; validated reply precedes ack; receipt precedes history and pending removal. Existing lock and descriptor identity checks remain in the shared filesystem store and `personal-deploy.py:182–226,344–357`. An operation directory without a published pointer does not authorize dispatch, and a foreign reservation remains fail-closed.

6. **Recovery cannot duplicate a mutation or turn history into live readiness.** `personal_activate_manager.py:253–268,549–563` validates the fixed owner's typed response and marks its one permitted start before transmission. Positional timeout ABI remains consistent with the independently inspected dbus-python 1.3.2 C implementation. `personal-activate.py:282–295,310–343,406–436` uses the saved same-manager fence, a proven departed old sender, matched Ping response, strict fresh observations and identity closure. Recovery contains no StartUnit/stop/restart/reload mutation. Existing committed receipts return `application_ready: "not_checked"`; only newly authenticated ready observations return true. The manager's executable/UID/start-time/namespace identity guards and supported-v255 source constraints remain intact.

7. **Dependency and mutation scope remains constrained.** `personal_activate_manager.py:431–547` rejects unmodeled device/swap following relationships, validates recursively propagated start/stop/requisite dependencies, requires the database active, and rejects unexpected executable/lifecycle/cache state. Its closed graph and filesystem/database/token/manager binding are checked before dispatch and before fresh readiness acceptance. The public CLI exposes no test seam. The genuine send-and-flush-before-reading fixture remains separate from reply-received-before-ack persistence; its implementation is present, but CI6 never executed either case.

No additional journal, source, shared-reservation or privacy blocker was found in the inspected code. This narrower inspection outcome does not override B1.

## Tests personally executed at candidate 6

| Actual command | Result | Saved output |
| --- | --- | --- |
| `python3 -B -m unittest discover -s test -p 'test_personal_activate*.py' -v` | 101 passed: 52 state/CLI fixtures plus 49 manager | `recovery-c6b409c-activation-python.log` |
| `python3 -B -m unittest discover -s test -p 'test_personal_ready*.py' -v` | 71 passed | `recovery-c6b409c-ready-python.log` |
| `python3 -B -m unittest discover -s test -p 'test_personal_deploy*.py' -v` | 87 passed | `recovery-c6b409c-deploy-python.log` |
| `node --test test/personal-activate-cli.test.mjs test/personal-ready-cli.test.mjs` | 10 passed | `recovery-c6b409c-cli.log` |
| `node --test test/personal-deploy-cli.test.mjs` | 4 passed | `recovery-c6b409c-deploy-cli.log` |
| Reviewer script `recovery-c6b409c-targeted.py` | 16 passed | `recovery-c6b409c-targeted.log` |

The first five rows are 259 Python plus 14 Node CLI tests actually rerun at this exact commit. No failure occurred in those executions. The additional 16 tests compile and execute actual workflow heredoc bodies with controlled credential/proc/subprocess seams: four ordinary/cgroup-gate cases, five root writer cases, two cached-property cases, two postcondition cases, and three diagnostic/privacy/root-rejection cases. The writer redirects only its initial `/` directory descriptor to a real temporary directory in the evidence area; subsequent actual no-follow/dir-fd/exclusive file operations take place there. No actual `/run` drop-in, daemon reload, loginctl or systemctl mutation was performed locally. Manager and subprocess objects are controlled fixtures. These 16 tests are not ordinary-user real systemd acceptance.

The reviewer is locally root. All Python/CLI tests use controlled filesystem/process/manager/HTTP fixtures or verify root rejection. This reviewer did not create a local ordinary-user systemd installation. Earlier 51 capture tests and seven controlled cache-reference helper tests passed at exact `071b7f4390dfe9e92c9de96b26068617b26bee7a`; their unchanged code was inspected, and their logs remain carried-forward evidence, not claimed as new candidate 6 executions.

Previous first failures and all earlier reviewer reports remain untouched. The earlier infra-error-ended candidate 2 attempt never became approval. This exact candidate remains **BLOCK** pending a corrected full SHA, independent review, and successful required real integration. No user-host deployment, Windows client integration or real-model-quality certification is implied.
