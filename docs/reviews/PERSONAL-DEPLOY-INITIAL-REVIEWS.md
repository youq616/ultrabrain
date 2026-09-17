# Personal deployment initial independent reviews

These are the original BLOCK reports on `d6919fa66ba3e94fc8bf57210a6565472f722e7c`. Their findings were corrected before acceptance. This archive preserves first findings; it is not the verdict on the accepted candidate.

Temporary paths in original reports record their execution-time locations. Final reports and CI run links are recorded in PERSONAL-DEPLOY-EVIDENCE.json.

---

Transaction reviewer original report SHA-256: `0dd5a7a9cd00144738cfbeb39ee7869efab695116a019b70d05073ddfecb47fa`.

# Independent transaction review — initial candidate BLOCK

Reviewer session: `/root/deploy_transaction_review`. This is a separate reviewer agent; I did not implement or modify repository files.

Reviewed full commit: `d6919fa66ba3e94fc8bf57210a6565472f722e7c`.
Reviewed tree: `f403ec7ced57880f79bca56284287e4a2e78bc1d`.
Base commit: `6f2c60fd2d27e4bcbb9046fe298fa6bebc6278d6`.
Verdict: **BLOCK**. Approval must be obtained again for a corrected full commit.

Scope: `scripts/personal-deploy.py`, `scripts/personal_deploy_store.py`, the service-generator export/verification boundary, deployment documentation, and transaction test coverage. Reads began from the clean candidate checkout; further adversarial probes use files extracted with `git show` into `/tmp/ultrabrain-transaction-review-d6919fa`, so later implementation edits cannot change this reviewed source.

## Blocking finding

**R1 — Publish the account-wide coordinator before the installation-local journal.** At `scripts/personal-deploy.py:504–507`, `_publish_journal` publishes the local `pending.json` and then the shared `pending.json`. A process interruption between those writes leaves a durable transaction that the same account's other data installations cannot see. The shared lock is released by process termination. A subsequent cooperative installer for a different `ULTRABRAIN_HOME` can claim the fixed unit namespace, and the first installation's recovery becomes stranded.

Independent reproduction: `/tmp/deploy-review-crosshome.py` injects a `BaseException` immediately after `_atomic_new(self.state/'pending.json', ...)`, then plans/applies a second data home under the same account. Actual output:

```text
First home pending True shared pending False
Second home installed True
First home recovery: deployment_recovery_required
Second home preserved True
```

The second installation's files are preserved, which is correct. However, the durable pending reservation was bypassed, and the first transaction no longer converges through normal recovery. The documented shared coordinator promise is not met at this crash boundary. Publish the shared journal first, followed by its local mirror; all referenced stages and receipts are already durable. Keep clearing the shared coordinator last. Add a regression for interruption between the two publications, rejection of the competing data home's apply, and successful recovery from the shared-only record.

## Executed evidence

| Command / probe | Actual result | Scope |
| --- | --- | --- |
| `python3 -I -B -m unittest discover -s test -p test_personal_deploy.py -v` | 68 tests passed in 4.497 seconds | Existing deployment unit suite on the initial clean candidate |
| `python3 -I -B /tmp/deploy-review-crash-matrix.py` | 254 interruption/recovery cases passed | Before/after actual filesystem helper mutations: first install 40, first install with Worker 44, add Worker/update 50, remove Worker/update 50, rollback update 38, rollback to absence 32 |
| `python3 -I -B /tmp/deploy-review-recovery-matrix.py` | 36 interruption-during-recovery cases passed | Recovery itself interrupted before/after link/current/journal mutations; first install, update and uninstall each 12 cases |
| `python3 -I -B /tmp/deploy-review-crosshome.py` | R1 reproduced | Durable local-only journal followed by another data-home installation |

The probes use real private files, symbolic links, inode identities and cooperative locks, with an explicitly injected cached manager and `BaseException` interruption. They do not start or stop actual services and do not constitute physical power-loss, live systemd, actual client, or model quality testing. The public ordinary-user gate is retained; running internal temporary-filesystem fixtures as container root does not test a production root deployment.

## Other reviewed boundaries

The code uses descriptor-relative traversal with `O_NOFOLLOW`, private and ownership checks, bounded canonical state reads, immutable generation copies verified against the service generator, a fixed unit inventory, no-replace first installation, receipt/current compare-and-swap checks, and explicit pending recovery. It issues only manager show and daemon-reload actions. Unknown or replaced journal/stage/unit identities are refused rather than repaired.

The documented maintenance constraint remains essential: the cooperative lock does not isolate another same-UID editor or a concurrent external systemctl invocation. Updating an already installed link is not an atomic conditional write against arbitrary external edits. This limitation is stated in the source and deployment documentation; the review does not certify otherwise.

No additional blocker was found in the tested single-installation recovery boundaries. The result above remains BLOCK because R1 is a required crash/coordinator behavior, even though the existing 68 tests and the 290 additional single-installation interruption cases pass.

---

Boundary reviewer original report SHA-256: `bb40c7b3e741fd53679e321b95d0eb41cba382c69716aabed20a6af03989ee08`.

# Independent deployment boundary review — initial candidate

- Reviewer session: `/root/deploy_boundary_review` (separate reviewer agent; no implementation edits).
- Reviewed commit: `d6919fa66ba3e94fc8bf57210a6565472f722e7c`.
- Reviewed tree: `f403ec7ced57880f79bca56284287e4a2e78bc1d`.
- Baseline parent: `6f2c60fd2d27e4bcbb9046fe298fa6bebc6278d6`.
- Review scope: production systemd command/parser and unit search boundaries; CLI isolation and ordinary-account restriction; actual CI deployment/crash fixtures; workflow and deployment documentation. Core durable transaction review is assigned separately.
- Verdict: **BLOCK**. The two findings below require a corrected full-SHA review. Passing unit tests do not override them.

## Blocking findings

### B1 — `.upholds` dependencies bypass the reviewed unit configuration

`scripts/personal-deploy.py:298-307` rejects fixed-name `.d`, `.wants` and `.requires` paths throughout the manager's UnitPath, but omits `.upholds`. systemd 255 processes `.upholds` as `Upholds=` dependencies, independently of `.conf` DropInPaths. Consequently, the other manager fields checked by `_manager_guard` do not reveal these additional dependencies.

I executed an isolated real-filesystem probe using the committed deployment implementation and the injected manager fixture. It created `ultrabrain-personal.target.upholds/unreviewed.service -> ../unreviewed.service` before first install. Both plan and apply succeeded, despite a reviewed plan without a worker, returning `unreviewed_upholds_accepted: true`. The directory was preserved. A later explicit start of the target can therefore also activate a dependency outside the reviewed plan.

Required correction: refuse `.upholds` alongside `.wants` and `.requires` for every personal unit in every active manager UnitPath, with a regression that preserves the untrusted directory and proves no installation mutation occurs.

Primary source: [systemd v255 dependency loader](https://github.com/systemd/systemd/blob/v255/src/core/load-dropin.c), lines 91–103; [systemd v255 unit documentation](https://github.com/systemd/systemd/blob/v255/man/systemd.unit.xml), lines 2124–2126 and 2180–2185.

### B2 — alias dependency directories are not checked

`scripts/personal-deploy.py:38-39, 298-307, 309-341` neither queries a unit's `Names` nor checks dependency directories attached to aliases. systemd loads dependency directories for both the primary name and all aliases. An alias's `.wants` or `.requires` directory does not appear in `.conf` DropInPaths, and the canonical Id/FragmentPath can remain unchanged.

I executed a second pinned-code filesystem probe with `unexpected.target -> ultrabrain-personal.target` and `unexpected.target.wants/unreviewed.service`. Deployment accepted and preserved both. I separately checked the underlying systemd behavior with installed systemd 255.4 using `systemd-analyze --user --generators=no --man=no verify` and only synthetic files under `/tmp`. Its offline verifier emitted `Unit ultrabrain-personal.target has alias unexpected.target.` and constructed a planned start job for `unreviewed.service`. No live manager or service action was performed.

Required correction: the minimal conservative boundary is to query `Names` and require exactly the singleton canonical unit name, rejecting aliases. This must be verified for real loaded and not-found units and regression tested. Supporting aliases instead would require complete alias dependency/drop-in handling and a larger reviewed scope.

Primary source: [systemd v255 dependency loader](https://github.com/systemd/systemd/blob/v255/src/core/load-dropin.c), lines 17–23 and 91–103; [systemd v255 unit documentation](https://github.com/systemd/systemd/blob/v255/man/systemd.unit.xml), lines 215–224.

## Executed evidence

Executed from `/workspace/scratch/be43dca0ab34/ultrabrain` while HEAD was the full SHA above and the tree was clean:

1. `python3 -B -m unittest discover -s test -p 'test_personal_deploy*.py' -v`: **68 passed**, 3.999 seconds. These exercise actual temporary files/symlinks and injected manager responses, not live systemd.
2. `node --test test/personal-deploy-cli.test.mjs`: **4 passed**, 0 failed, 1.848 seconds. This container runs as root; production root refusal was tested, not bypassed.
3. `git diff --check 6f2c60fd2d27e4bcbb9046fe298fa6bebc6278d6 d6919fa66ba3e94fc8bf57210a6565472f722e7c`: exit 0.
4. Independent `.upholds` real-filesystem probe described in B1: unsafe acceptance reproduced.
5. Independent offline systemd alias/dependency verifier described in B2: alias dependency loading reproduced with systemd `255.4-1ubuntu8.17`.
6. Additional probes loaded files extracted with `git show d6919fa66ba3e94fc8bf57210a6565472f722e7c:<path>` into `/tmp/deploy-boundary-d6919fa` to remain pinned while implementation fixes proceeded. Nonzero Job, reloading ActiveState, running SubState, NeedDaemonReload=yes, masked LoadState, and a nonempty DropInPaths were all refused without creating deployment state. The alias filesystem probe reproduced B2 against this pinned copy.

No full old ordinary-account suites, live user service operations, production deployment, model invocation, or real PostgreSQL integration were executed by this reviewer. The parent is running actual disposable CI separately; its results are not substituted for this review.

## Other inspected boundaries

- `scripts/personal-deploy.py:53-100, 112-145`: `/usr/bin/systemctl` is fixed; the local UID bus and passwd home are selected using a clean environment; both output streams contribute to the output cap; timeouts terminate and reap the child; stderr is discarded. The allowed commands are read-only show and daemon-reload.
- `scripts/personal-deploy.py:317-339`: queued jobs, non-inactive states, failed/masked/unknown bindings, stale-manager states, foreign FragmentPath and loaded drop-ins fail conservatively. The real systemctl v255 Job printer prints an empty value when no job exists; accepting empty Job is consistent with the primary implementation.
- `src/cli.mjs:36-38` and `scripts/personal-deploy.py:727-775`: the router uses isolated Python `-I -B`, the production entry rejects root and mismatched real/effective UID, and errors use safe codes. Internal test injection has no CLI/environment option.
- `test/personal-deploy-integration.mjs:12-14, 93-128`: the live fixture is restricted to the disposable CI account/path, checks all units are absent before ownership, deletes exports before authenticated startup, refuses an update while active, performs a real process exit and public recovery, updates source/port, adds/removes worker configuration, and rolls back to absence. Starts/stops are explicit fixture actions; no model call is needed by the new deployment fixture.
- `test/personal-deploy-integration.mjs:36-64, 129-143`: cleanup records exact link target/device/inode and database unit content, preserves evidence on unknown link identity, and snapshots unrelated unit/enablement content. The preexisting workflow's unconditional final cleanup is confined to the explicitly disposable runner and was not introduced by this change.
- `test/personal-deploy-crash.py:17-43`: the fault hook is confined to an explicitly guarded CI helper. It interrupts after the real first link change using `os._exit(73)`, leaving durable recovery to the production CLI.
- `docs/PERSONAL-DEPLOY.md`: accurately distinguishes configuration rollback from Git/Bun/schema/data rollback, daemon-reload from explicit operator activation, filesystem status from application readiness, cooperative same-account locking from isolation, and current retained staging history from garbage collection. Its conservative refusal claim needs the B1/B2 corrections.

The initial candidate is not approved. A new commit, rerun regressions and real CI, and explicit corrected-SHA re-review are required before acceptance.
