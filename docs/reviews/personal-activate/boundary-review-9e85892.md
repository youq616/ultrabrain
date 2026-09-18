# Independent activation boundary review — 9e85892

**Code verdict: PASS** for the entire application candidate `9e85892c54006dedfc7dda2135de3b8f90155347`, tree `10495f79e8e1d88e0c72e8bc5126bbf97f6fb045`, based on `5b3c88826984a9b5c8b34ca2cf7ffff171501697`.

Reviewer: `/root/activate_boundary_review`, an independent reviewer agent that did not implement or edit the application. Review completed on 2026-09-18 at 15:15 UTC. I verified the exact HEAD/tree and a clean worktree before and after testing. This is a code-review verdict; ordinary-user real-service CI was still pending or in progress when review was requested. It is not a declaration that CI, user-host deployment, Windows integration, or real-model validation passed.

## Scope and findings

I reviewed all 15 changed files in this commit, including the activation coordinator and manager adapter, deployment/readiness lock composition, CLI and package routing, documentation, all new test files, integration wiring, and the workflow label. I also inspected the unchanged service generator, durable Store, procfs bindings, readiness protocol and affected deployment boundaries. No migration, upstream pin, database schema, Windows qbrain or model permission change was introduced.

**The preliminary P1 dependency fanout finding is fixed.** The earlier worktree allowed a canonical active `sys-*.device` whose `Following` property was empty, while systemd could still traverse its unseen same-sysfs siblings and their dependencies. The original accepted-fixture reproduction and independently fetched fixed v255 source are retained in `boundary-review-preliminary.md`. The final adapter rejects `.device` and `.swap` graph nodes at `scripts/personal_activate_manager.py:433–442`, before their LoadUnit/read operation. The canonical-device-hidden-Worker and swap refusal regressions are at `test/test_personal_activate_manager.py:287–304`.

I independently reran my original canonical-device/follower/Worker reproduction against this exact candidate. It now returned `unsupported_activation_unit`; assertions proved no LoadUnit for the canonical device and no StartUnit were sent. This is a fixture reproduction plus source-backed reasoning, not a real Worker activation experiment.

No unresolved blocking code finding remains. The principal boundary checks are:

- `scripts/personal_activate_manager.py:30–57,418–541`: bounded effective start/verify/stop graph, refusal of unsupported following sets, stable active non-console start dependencies, inactive stop closure, and selected exact console execution/dependency properties. The fixed v255 transaction and dependency-atom source supports the selected closure. Device/swap are excluded rather than inferred safe from an empty Following property.
- `scripts/personal_activate_manager.py:191–323,548–562`: fixed local private bus, ordinary same-UID manager process verification, supported v255 gate, unique-owner-bound requests, no auto-activation or interactive authorization, reply sender/serial/signature validation, one StartUnit attempt, and explicit departed-sender lookup followed by same-owner Ping and identity rechecks. There is no generic stop/restart/cancel/reload mutation route.
- `scripts/personal-activate.py:53–89,185–343,345–436`: shared deployment reservation and flock, intent before the sole shared pointer, durable attempt before dispatch, acknowledgement distinct from readiness, receipt/history before pending removal, close before releasing the lock, and recovery without another StartUnit. Unknown or changed bindings preserve pending. Persistence failures are outside the readiness retry catch.
- `scripts/personal-activate.py:310–343,421–423` and `test/test_personal_activate.py:393–425`: historical receipt cleanup returns `application_ready: "not_checked"` for terminal outcomes as well as previous ready outcomes. It does not make a fresh current-state claim after the application changed.
- `scripts/personal-ready.py:308–329` and `scripts/personal-deploy.py:182–225,350–357`: public readiness acquires its shared lock; internal composition requires the verified held lock; an activation reservation excludes deployers, including another data home under the same account. Old-format deployers fail closed on the distinct shared reservation schema.
- `test/personal-activate-crash.py:31–49,67–91`: the new sent-before-reply case is explicitly restricted to the disposable ordinary-user CI installation. It replaces only the fixed StartUnit transport call, sends and flushes an actual low-level request with the production action flags, and exits without reading a reply. Product code receives no public fault injection option.
- `test/personal-activate-integration.mjs:149–179,248–286`: the new unread-reply case accepts either a fenced terminal observation or authenticated ready state and retains `dispatch_state: "outcome_unknown"`. It does not infer manager acceptance from flush or turn recovery into another startup request. The older after_start_before_ack checkpoint still means synchronous reply received but acknowledgement not yet persisted.

## Executed validation on the exact commit

| Check | Actual result |
| --- | --- |
| `python3 -B -m unittest discover -s test -p 'test_personal_activate*.py' -v` | 101 tests passed: coordinator and manager fixtures |
| `python3 -B -m unittest discover -s test -p 'test_personal_ready*.py' -v` | 71 tests passed: readiness protocol, transport and procfs fixtures |
| `python3 -B -m unittest discover -s test -p 'test_personal_deploy.py' -v` | 87 tests passed: deployment and filesystem/manager boundaries |
| `node --test test/personal-activate-cli.test.mjs test/personal-ready-cli.test.mjs test/personal-deploy-cli.test.mjs` | 14 tests passed |
| Independent original device reproduction, with assertions on bus calls | Passed: unsupported device rejected before LoadUnit, no StartUnit |
| `node --check` for both affected integration modules; Python AST parse for crash helper | Passed |
| Direct crash-helper invocation as this container's root account | Expected refusal, exit 1: `Disposable ordinary-user CI fixture required` |
| `git diff --check BASE..HEAD`; HEAD/tree and clean-worktree checks | Passed |

Total accepted local suite evidence is **259 Python tests and 14 Node CLI tests**. The fixtures use real private files, symlinks, filesystem locks and protocol code, with controlled manager/process/HTTP observations. They are not actual ordinary-user systemd/PostgreSQL activation.

Complete logs are retained with these SHA-256 values:

| Log | SHA-256 |
| --- | --- |
| `boundary-9e85892-activate-tests-complete.log` | `ced03250a0df31891efeca941786244ade97628e5bedc6e92a232a0651c0fe38` |
| `boundary-9e85892-ready-tests.log` | `d4171f306696fb1cfb48bf2c701f3c94f1856f648e3f3a952c50aefdc3cb5962` |
| `boundary-9e85892-deploy-tests-complete.log` | `0a3c5c0e078c4cf192054bb61a180f68c73abe34d77739e18227620cd759d54d` |
| `boundary-9e85892-cli-tests-complete.log` | `974ee132a2d1cb26bd443d3d6005878f520193918099774ccc7007d09f966a6e` |

## First results and limits retained

The first local distro-Python API probe during preliminary review failed with `ModuleNotFoundError: No module named 'dbus'`; it is retained in the preliminary review, not relabeled a successful adapter test. No dependency was installed and no ordinary-user guard was bypassed. The first concurrently yielded redirected activation/deployment log captures on this commit ended without a unittest summary even though the execution-session tool reported exit 0. Those original logs remain retained and are not used as pass evidence. I reran both commands to completion in separate foreground calls; the complete 101-test and 87-test summaries above are the accepted evidence. No assertion failure occurred in these final complete suites.

The real CI fixture was statically reviewed and its syntax/gate checked, but I did not execute it against a real manager in this container. No real process was started, stopped, restarted, or reconfigured by this reviewer. The sent-and-flushed/unread-reply scenario must be reported separately from a genuine transport NoReply exception; the latter remains controlled fixture evidence. Actual CI status and results must be checked before merge.

The supported same-UID systemd v255 authorization path is essential to the recovery fence. This is not a general asynchronous-polkit completion barrier. The graph certifies the selected properties and a cooperative service-account maintenance window, not every cached systemd option or isolation from another same-UID actor. Source code is not frozen, socket ownership is not claimed, pre-start logical UUID/source validation is not claimed, and cross-manager-restart pending recovery remains unsupported. These material limits are explicit in `docs/PERSONAL-ACTIVATE.md:9,19,39–41,57–68` and are consistent with this code verdict.

This PASS applies only to `9e85892c54006dedfc7dda2135de3b8f90155347`. Later application changes require another review of their exact commit.
