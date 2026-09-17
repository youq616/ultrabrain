# Independent transaction review — persistent cache-reference fixture PASS

Reviewer session: `/root/deploy_transaction_review`. I am a separate reviewer agent and have not implemented the phase or modified repository files.

Reviewed full commit: `8c519f23a359691a24e9780766c5baed54c58c40`.
Reviewed tree: `9fa4b6574c7b1e9278eeb11dc5de9b3b6ec76789`.
Phase base: `6f2c60fd2d27e4bcbb9046fe298fa6bebc6278d6`.
Verdict: **PASS for the transaction/filesystem and affected CI fixture review scope on this exact commit.** No outstanding blocking issue remains in this scope. This is a source and isolated-test verdict; actual systemd integration and the other required CI checks remain separate merge gates.

I inspected the complete implementation and each correction. This review checks the four-file delta from `868625f4c30bd52f241753483e6e5bef34efdae6`: the CI-only cache-reference helper, its integration lifecycle, the distribution D-Bus Python prerequisite, and documentation. Exact source was extracted with `git show 8c519f23a359691a24e9780766c5baed54c58c40:<path>` under `/tmp/ultrabrain-transaction-review-8c519f2`. The previous review is retained in `/tmp/deploy-transaction-868625f-review.md`.

## Current fixture review

**Fixed local connection and owned console binding: CHECKED.** `test/personal-deploy-cache-pin.py:35–66` requires Linux, equal real/effective non-root UIDs, the three explicit disposable-CI environment flags, and the exact fixture data home under the account's real home. It reads the deployment's existing status and link state, requiring a current receipt, verified filesystem binding, no pending transaction, and a non-null console target matching the actual owned link. Binding failures are reduced to a fixed error code. The verification does not create deployment state, mutate links, or start a manager operation.

**Reference lifetime and cleanup: CHECKED.** `test/personal-deploy-cache-pin.py:70–105` connects to the fixed local `/run/user/<uid>/bus`, addresses only `org.freedesktop.systemd1` and the fixed console unit, checks the exact returned object path, and calls `LoadUnit`, `RefUnit` and `UnrefUnit`. It intentionally holds a manager lifetime reference; it does not call Start/Stop or change service properties or files. The parent receives readiness only after the reference method replies. Release input, parent EOF, hold timeout and errors all enter cleanup; the connection is closed even if Unref fails or a reference reply is lost. Method calls, startup, holding and cleanup have explicit bounds. Production deployment APIs expose no equivalent reference or test bypass.

I independently checked systemd v255's [sender tracking and reference removal](https://github.com/systemd/systemd/blob/v255/src/core/dbus-unit.c), [GC exclusion and reference restoration during coldplug](https://github.com/systemd/systemd/blob/v255/src/core/unit.c), and [reference serialization/deserialization](https://github.com/systemd/systemd/blob/v255/src/core/unit-serialize.c). These source paths support using a live connection to prevent collection of the inactive console while preserving its reference across reload. This source verification does not substitute for the pending real-manager CI execution.

**Parent integration ordering: CHECKED.** The JavaScript starts the fixed isolated helper on clean A, waits for its exact acknowledgement, and retains the child through the B apply/reload interruption, interrupted restoration, and public final recovery. It asserts the actual cached source before and after recovery, then explicitly releases the reference before starting HTTP validation. The final cleanup also attempts release when earlier operations fail. Child output is bounded, unexpected exit is a failure, and failed release cannot be reported as successful fixture completion. No model calls or production service activation are introduced by this helper. The pre-existing fixture remains responsible for explicit start/stop operations.

The documentation now identifies the lifetime reference as a fixture requirement for holding an inactive manager cache. The apt addition is limited to `python3-dbus` in the disposable CI prerequisite step; application dependencies and production code are unchanged.

## Actual checks on this exact commit

| Verification | Result |
| --- | --- |
| Targeted `git diff --quiet ed65c0f073b334075e4f2482b140fd8dd0a769df 8c519f23a359691a24e9780766c5baed54c58c40 -- scripts src package.json test/test_personal_deploy.py test/personal-deploy-crash.py` | Exit 0; production source, Python deployment suite and process-death helper are unchanged |
| Pinned helper parsed with Python `ast.parse`; pinned integration tested with `node --check` | Both syntax checks passed |
| `/usr/bin/python3 -I -B <pinned-helper> --home /tmp/wrong-fixture` in the root container | Exit 1 with only `ULTRABRAIN_CACHE_PIN_ERROR:ordinary_ci_account_required`; no D-Bus import/connection or filesystem mutation |
| `python3 -I -B /tmp/deploy-review-cache-pin-8c519f2.py` | 16 independent isolated cases passed |

The 16 cases comprise eight injected D-Bus lifetime/error paths (release, parent EOF, invalid release, timeout, wrong object, LoadUnit error, lost RefUnit reply, UnrefUnit error) and eight clean/invalid binding states (clean, pending, absent current, unverified binding, absent expected target, absent actual link, foreign target, read failure). They verify fixed bus addressing despite an ambient override, restricted method inventory, connection closure, no success acknowledgement on failure, and safe binding errors. These use injected D-Bus/context objects and real temporary pipe descriptors, not an actual manager or production services. They do not independently exercise server-side collection; that remains the live CI test's purpose.

## Transaction evidence retained at its executed commits

The final application is byte-identical to `ed65c0f073b334075e4f2482b140fd8dd0a769df`. On that exact source I previously executed 87 deployment Python tests (5.828 seconds), three cross-home coordinator interruption schedules, 36 recovery-interruption cases using installed-link FragmentPath and lazy manager loading, and four repeated stale-cache/reload-failure schedules. All passed. Those tests were **not rerun for this fixture-only delta**, and are not reported as new final-commit executions. Full details remain in `/tmp/deploy-transaction-ed65c0f-review.md`.

The original R1 coordinator bug was independently reproduced and marked BLOCK on `d6919fa66ba3e94fc8bf57210a6565472f722e7c`; `/tmp/deploy-transaction-initial-review.md` retains that evidence. Shared publication now precedes the local mirror and shared clearing occurs last. Current manager binding admits only an approved generation or its exact verified installed link, never an absent-only loaded pathname. Every pending recovery requires an acknowledged reload before journal removal, including when an earlier interrupted recovery already restored all links and `configuration_changed=false`.

The private generations, canonical receipts, no-follow Store mutations, inode/transaction identity checks, global cooperative lock and public ordinary-user gate remain unchanged. The distribution alias exception is still root-controlled and read-only; CI permission correction remains limited to the disposable runner.

Cooperative locking does not isolate arbitrary same-UID edits or external systemctl actions. Existing-link replacement is not an atomic conditional write against arbitrary external interference, and a manager reload does not prove database binding, application readiness or model quality. The real-manager integration result must pass separately before merge; no actual CI success is claimed by this report.

This PASS applies only to `8c519f23a359691a24e9780766c5baed54c58c40`. Later implementation or fixture changes require another exact-commit review.
