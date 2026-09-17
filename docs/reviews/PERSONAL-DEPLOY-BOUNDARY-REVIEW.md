# Independent final deployment boundary review

- Reviewer session: `/root/deploy_boundary_review` (separate reviewer agent; no implementation edits).
- Reviewed commit: `8c519f23a359691a24e9780766c5baed54c58c40`.
- Reviewed tree: `9fa4b6574c7b1e9278eeb11dc5de9b3b6ec76789`.
- Previous reviewed candidate: `868625f4c30bd52f241753483e6e5bef34efdae6`.
- Last production-code change: `ed65c0f073b334075e4f2482b140fd8dd0a769df`.
- Initial blocked candidate: `d6919fa66ba3e94fc8bf57210a6565472f722e7c`.
- Scope: systemd/CLI and filesystem boundaries, including the new deterministic cache-retention fixture and parent process protocol. Full durable transaction review is separately assigned.
- Verdict: **PASS at this exact full SHA for the reviewed source boundary scope**, with one nonblocking documentation-order correction recorded below. No remaining source blocker was identified. Actual disposable systemd/PostgreSQL CI remains a separate required acceptance gate; this review does not assert live CI or user-host deployment has passed.

## Legitimacy of the cache-retention fixture

The earlier unreferenced-cache assertion failure is consistent with documented systemd garbage collection, but no collection trace from that specific run was obtained. I do not describe that inference as a proven observation of the particular failed run.

The primary [systemd v255 unit documentation](https://github.com/systemd/systemd/blob/v255/man/systemd.unit.xml), lines 544–574, describes unloading unused inactive units and retaining units referenced by an active IPC client. In [unit.c](https://github.com/systemd/systemd/blob/v255/src/core/unit.c), lines 433–464, an active bus track prevents collection. [dbus-manager.c](https://github.com/systemd/systemd/blob/v255/src/core/dbus-manager.c), lines 891–900, loads and validates a RefUnit target; [dbus-unit.c](https://github.com/systemd/systemd/blob/v255/src/core/dbus-unit.c), lines 631–658, adds sender tracking without starting the unit, and lines 2558–2570 release tracking on client disappearance. [unit-serialize.c](https://github.com/systemd/systemd/blob/v255/src/core/unit-serialize.c), lines 215 and 473, preserves references through reload serialization.

A persistent reference therefore makes the stale-cache condition deterministic without changing service properties, starting a service, weakening the deployment guard, or substituting a fake manager for the live integration. The regression still requires the actual manager to retain B after A files/current are restored, and requires public recovery to load A before the reference is released.

## New helper and parent boundaries

`test/personal-deploy-cache-pin.py:37-67` requires Linux, equal non-root real/effective UID, all three explicit CI authorization variables, the exact passwd-home-derived disposable data directory, and a clean non-null managed receipt with validated generation contents and console link binding. There are no unit-name or bus-address CLI options.

`test/personal-deploy-cache-pin.py:70-103` connects only to `unix:path=/run/user/<guarded UID>/bus`, the fixed systemd manager object and the fixed personal console unit. It calls only LoadUnit, RefUnit and UnrefUnit, with five-second method timeouts, an exact object-path check and the same connection throughout. Readiness is emitted only after RefUnit is acknowledged. Startup is bounded to 15 seconds, holding to 180 seconds and cleanup to ten seconds. Valid release or parent EOF drops the reference and closes the connection; invalid input, lost replies and other exceptions still close it. Errors expose fixed codes rather than raw D-Bus exception details.

`test/personal-deploy-integration.mjs:50-76` launches a fixed `/usr/bin/python3 -I -B` child with the fixed helper/home arguments, enforces an exact READY/RELEASED protocol, limits stdout accumulation to 256 characters and discarded stderr to 4096 bytes, and checks premature exit. Startup has a 15-second deadline; release has a five-second kill deadline and awaits closure. Malformed/oversized output and timeouts fail the fixture instead of authorizing success.

The integration acquires the reference while A is clean, before planning B; holds it through both interruptions and the final public recovery; verifies actual cached A; then releases before HTTP validation. Cleanup attempts release even when the separate owned-link cleanup rejects an unexpected filesystem state. The workflow adds only the distribution python3-dbus package for this CI helper. No production dependency or command is added.

## Independent exact-commit tests

At `8c519f23a359691a24e9780766c5baed54c58c40`, I independently executed seven Python helper scenarios against the exact extracted source with mocked D-Bus objects and real temporary input pipes:

1. Valid release: LoadUnit → RefUnit → UnrefUnit, exact successful protocol, connection closed.
2. Parent EOF: same safe release and closure.
3. Invalid release bytes: error, no successful RELEASED acknowledgement, UnrefUnit and closure.
4. Wrong returned unit object path: refusal before RefUnit, connection closed.
5. RefUnit reply failure: no false readiness/release success; connection still closed, covering a potentially acquired reference with a lost reply.
6. UnrefUnit failure: no false success; connection still closed.
7. Hold timeout: UnrefUnit and closure, no successful release acknowledgement.

All seven passed. Every call used the fixed unit and a five-second method timeout, and ambient bus/HOME injection did not redirect the connection. Synthetic private error/input content never entered the helper output.

I additionally executed the actual isolated helper CLI as root. It exited 1 with exactly `ULTRABRAIN_CACHE_PIN_ERROR:ordinary_ci_account_required` and empty stderr, before importing D-Bus or inspecting an installation. The local review runtime does not have the distribution dbus module installed; real D-Bus execution is therefore reserved for the explicitly prepared CI runner, not claimed by these mock results.

I extracted the exact parent `pinConsoleCache`/`releaseConsoleCache` functions into an isolated JavaScript VM and ran nine child-process protocol scenarios: split valid READY output, invalid acknowledgement, oversized stdout, oversized stderr, premature child exit, missing RELEASED acknowledgement, release timeout, startup timeout and spawn failure. All nine behaved as required: only the valid protocol succeeded, required failure paths killed the synthetic child, and all deadlines were cleared. No real child process or service was operated in these parent-protocol tests.

Other exact checks:

- `node --check test/personal-deploy-integration.mjs`: exit 0.
- `git diff --check 868625f4c30bd52f241753483e6e5bef34efdae6 8c519f23a359691a24e9780766c5baed54c58c40`: exit 0.
- `git diff --exit-code ed65c0f073b334075e4f2482b140fd8dd0a769df 8c519f23a359691a24e9780766c5baed54c58c40 -- scripts src test/test_personal_deploy.py test/personal-deploy-cli.test.mjs test/personal-deploy-crash.py package.json`: exit 0, confirming the production code and prior suites/crash helper are byte-identical.
- Clean worktree and the full final HEAD were confirmed.

## Retained production findings and earlier executed evidence

The unchanged production source retains narrow installed-link/generation FragmentPath authorization, receipt/generation/link identity validation, singleton Names, `.upholds`/`.wants`/`.requires`/drop-in refusal, strict inactive/no-Job requirements, bounded fixed local-user systemctl commands and mandatory acknowledged reload for every pending recovery. The shared journal still reserves fixed names before local publication; generic managed/export/state traversal still forbids symlink ancestry. The exact root-controlled distro search-path compatibility exception and disposable workflow-only ancestry hardening remain separate from those production restrictions.

On byte-identical production source at `ed65c0f073b334075e4f2482b140fd8dd0a769df`, this reviewer actually ran **87 Python tests, zero skipped, all passed**, and **4 public CLI tests, zero skipped, all passed**. The independent repeated-recovery probe restored cache A with one reload after two interruptions; four additional foreign/absent-receipt/wrong-fragment probes were refused with exact filesystem snapshots unchanged. These results remain attributed to that earlier commit and are not misrepresented as newly rerun here.

The final stop synchronization was independently exercised at `868625f...` in five exact-function scenarios, including deactivating state, queued jobs, deadline failure and stop-command failure. That logic is unchanged in the current candidate.

## Nonblocking documentation note

The sentence in `docs/PERSONAL-DEPLOY.md` currently places reference release after HTTP verification. Actual code correctly releases after verifying the manager's cached A and before HTTP. The parent agreed to align this wording in the documentation-only acceptance update. This sequencing detail does not weaken the cache regression or source safety, so it is not a blocking code finding.

No live user-manager or actual PostgreSQL integration, model call, or user-host deployment was executed by this reviewer. Their acceptance evidence must be recorded separately. This PASS applies only to `8c519f23a359691a24e9780766c5baed54c58c40`; later implementation edits require another pinned review. The previous report is preserved as `/tmp/deploy-boundary-review-868625f-pass.md`, with earlier reports and independent reproductions retained separately.
