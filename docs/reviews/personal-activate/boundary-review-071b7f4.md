# Independent boundary review — candidate 2

**Verdict: PASS on the entire phase at commit `071b7f4390dfe9e92c9de96b26068617b26bee7a`.** No unresolved blocking code finding was identified. This verdict is an independent code review and the local validation described below; it is not a claim that real ordinary-user service CI has passed.

- Actual reviewer identity: `/root/activate_boundary_review`.
- Reviewed repository: `/workspace/scratch/be43dca0ab34/ultrabrain`.
- Candidate commit: `071b7f4390dfe9e92c9de96b26068617b26bee7a`.
- Candidate tree: `2893d69c602212aadf071b041337b5d05c02cc4a`.
- Phase base: `5b3c88826984a9b5c8b34ca2cf7ffff171501697`.
- Parent candidate: `9e85892c54006dedfc7dda2135de3b8f90155347`.
- Review completed: 2026-09-18, with final identity/status verification at 15:30:46 UTC.
- Independence: reviewer did not implement or edit repository code. Scratch fixtures and this report are outside the repository. HEAD and tree matched the values above and the working tree was clean at final verification.

## Scope and prior evidence

The full phase was previously independently inspected at `9e85892c54006dedfc7dda2135de3b8f90155347`, including activation coordinator, manager/D-Bus graph inspection, canonical source handling, generator and CLI composition, ready/deploy boundaries, durable journal and recovery, historical terminal cleanup, documentation, and the real integration fixture. That report remains unchanged:

`boundary-review-9e85892.md`, SHA-256 `d0732c74f9982f55bd3bb49cd3cdc5a1f4cf67af1db2937dc438e04ac35f0f61`.

For the present full-commit verdict, I inspected the complete four-file parent-to-candidate delta and checked that the production scripts, source, package metadata and workflow have no changes from that independently reviewed candidate. The delta is 60 additions and 9 deletions in `test/capture-outbox.test.mjs`, `test/personal-activate-integration.mjs`, `test/personal-deploy-integration.mjs`, and `docs/PERSONAL-ACTIVATE.md`. The earlier production review and its limitations therefore still apply, with the test/documentation changes assessed below. No implementation approval is inferred from the implementer's own diagnosis.

The original independently found P1 remains resolved: canonical `.device` units can have an empty `Following` property while reverse-following siblings contribute dependencies to a systemd transaction. The implementation now rejects `.device` and `.swap` graph nodes before `LoadUnit`; the canonical-device/unseen-follower regression prevents this effective dependency fanout from passing inspection. Its preliminary first failure and the fix validation remain in the earlier reports. This candidate does not change that code or its regressions.

The retained full-phase inspection also covers the manager/bus identity and sender checks, observation-only recovery, single dispatch intent, durable partial-failure handling, and the absence of an authorized path to stop/restart/retry unrelated services. The CI-only send/flush/exit-before-read case remains an actual unread-reply scenario; a transport `NoReply` exception itself remains fixture coverage, not an independently exercised real transport failure.

## Candidate 2 findings

### Capture concurrency fixture

At `test/capture-outbox.test.mjs:96–136`, the generated writer retains a stable payload and event ID while retrying only `outbox_busy`. It permits at most seven retries after the initial attempt, checks a ten-second retry window, and is bounded by the parent's fifteen-second child timer. The retry-window check is a pre-retry check, not a strict interrupt at exactly ten seconds. There are no production outbox changes.

The fixture fails on every other error, reports only a fixed allowlist of codes plus bounded numeric/boolean fields, limits child stdout, discards raw stderr, and does not echo payload or arbitrary error text. The parent still requires all eight children to succeed and now additionally verifies the exact stored event IDs `child0` through `child7`, so success cannot be obtained by dropping or duplicating an event.

The existing production queue can legitimately return `outbox_busy` after its bounded lock wait. The narrow fixture retry is consistent with this contract. I also independently exercised the actual writer extracted from the current test under controlled contention; results are recorded below. The original CI child's error is still unknown because the old fixture discarded its diagnostic output. The controlled reproduction establishes a plausible contract mismatch, not proof of that original error code.

### Activation fixture cache reference and diagnostics

At `test/personal-deploy-integration.mjs:164–174`, the activation integration sequence is enclosed by the existing `pinConsoleCache()` and `releaseConsoleCache()` helper. The pin is released in a `finally` block, and concurrent activation/release errors are preserved together. Acquisition failures still enter the outer cleanup flow. The existing pin wrapper bounds startup and output, tracks helper exit, and bounds release before terminating a stuck helper.

I inspected the entire unchanged `test/personal-deploy-cache-pin.py` helper. Its main entry point requires the ordinary CI account and the designated fixture home, verifies the owned installed console, loads/references only that fixed unit, and has a default 180-second hold bound. Its lifecycle attempts `UnrefUnit` after a successful reference and always closes the connection; a failed release does not print a successful release marker. It has no production activation dispatch role.

At `test/personal-activate-integration.mjs`, stopped-state/reset/snapshot setup now runs inside the existing error-reporting scope with explicit setup case labels. The systemctl diagnostic label is restricted to the fixed operation names and does not expose raw subprocess error text. The initial start-count reset and console stop remain ordinary-user CI fixture actions. The fixture records its existing bounded cache reference; the 18 real activation checks retain their intended assertions.

`docs/PERSONAL-ACTIVATE.md:74` accurately identifies the bounded existing reference helper and release requirement. It does not claim a production reset, a real host deployment, or a passing service CI result.

**Blocking findings on this candidate: none.**

## Checks executed on exact candidate 071b7f4

1. **51 related Node tests passed, zero failures**, using:

   ```text
   node --test test/capture-outbox.test.mjs test/automatic-capture.test.mjs test/capture-hardening.test.mjs test/capture-delivery.test.mjs test/capture-profile-binding.test.mjs
   ```

   Environment: Linux, Node `v24.19.0`, UID 0. Complete log: `boundary-071b7f4-capture-tests.log`; SHA-256 `1d8a3352499774b46ec21428941c7f33c716fa3ebea82db9daaaf5ea469b1040`.

2. **Six independent isolated cache-helper lifecycle tests passed**, using the checked-in helper with a fake D-Bus connection/manager and a real pipe; no actual service calls were made. These covered successful fixed-unit Load/Ref/Unref/close and exact markers; wrong loaded unit path; `RefUnit` failure; `UnrefUnit` failure; invalid release input; and expired hold. Failure cases asserted close behavior and the absence of a false release-success marker; cases with a successful reference asserted the unreference attempt. This was an independent scratch test executed through the review tool session, not a claimed checked-in test file or real-manager check. Tool output reported `Ran 6 tests ... OK`.

3. **Actual helper root entry-point refusal passed as expected**:

   ```text
   /usr/bin/python3 -I -B test/personal-deploy-cache-pin.py --home /tmp/ordinary-gate-review
   ```

   Exit 1 with the fixed diagnostic `ULTRABRAIN_CACHE_PIN_ERROR:ordinary_ci_account_required`. This verifies refusal; it does not bypass the root gate or exercise the real pin operation.

4. **Four controlled exact-writer scenarios passed.** I first inspected the implementation agent's diagnostic harness, copied it into the separate reviewer directory `boundary-capture-071b7f4`, and independently ran it. The harness extracts the writer literal from the exact candidate test. It uses private synthetic temporary queue data and performs no real client or service actions.

   - Two separate 1300 ms lock-holder rounds each accepted exactly eight IDs (`child0`–`child7`); all seven competing writers reported exactly one busy retry.
   - A foreign identity failed with `identity_mismatch`, zero busy retries, in 68 ms; only the pre-existing seed remained.
   - An 11000 ms lock holder caused the competitor to stop after exactly seven retries with `outbox_busy` in 8308 ms; only the holder's `child0` entry remained.

   Complete reviewer-run result file: `boundary-capture-071b7f4/results.jsonl`; SHA-256 `28a1d5580ea15cd62c0c4bb51dd22619faffa9b33f260b8b9bd766457bb9c7ab`. Reviewer-run `stderr.log` was empty (SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`). The inspected/copied harness and extracted writer remain in that directory.

5. **Syntax and identity checks passed:** `node --check` on all three changed JavaScript tests; `git diff --check` from the full phase base; clean working-tree verification; exact full HEAD/tree verification; and no production/source/package/workflow delta from the previously reviewed candidate.

There were no unexpected failures in these candidate-2 checks.

## Earlier tests, first failures, and checks not executed here

The prior independent **259 Python tests and 14 Node CLI tests passed on `9e85892c54006dedfc7dda2135de3b8f90155347`**, not on 071b7f4. They were not redundantly rerun for this test/documentation-only delta. The production and associated unchanged test files are byte-identical; the prior report records commands and complete log hashes. The earlier device proof-after-fix and root refusal checks also retain their original SHA attribution.

The initial preliminary `.device` finding and failing regression are preserved in `boundary-review-preliminary.md` and the implementation's `manager-device-before-fix.log`. The preliminary report SHA-256 is `de81b529f5653ab2eba8c7a8d8d64af33778b954da029bf59edb1de1cbc63793`. Earlier incomplete concurrent redirected logs were retained and were not counted as successful evidence; complete foreground reruns supplied the accepted prior test counts. The earlier local distro-Python probe failed with `ModuleNotFoundError: No module named 'dbus'` and remains an environment limitation.

The parent reported that initial-candidate ordinary unit jobs passed, while both initial service jobs failed before activation at the bare initial `reset-failed` fixture, and that one push capture concurrency test failed while the same-SHA PR job passed. Those original CI failures are not erased by this report. The initial capture child code remains unknown; the implementation diagnosis explicitly preserves that uncertainty. Candidate 2's real CI was queued/in progress when assigned, and I have not independently obtained a completed result here.

I did **not** run the actual ordinary-user manager/RefUnit/UnrefUnit integration, the 18 real activation checks, real PostgreSQL/service tests, manager replacement/reexec scenarios, a real transport `NoReply` exception, or any live deployment. I did not invoke production activation, stop/restart services, bypass account gates, or issue real model/client calls. Those omissions are not presented as successful checks. The ordinary-user real-service CI remains a separate completion requirement for the parent.

This exact-commit PASS therefore covers the independently reviewed phase code, the inspected candidate-2 delta, and the local evidence above, while preserving the outstanding real-CI validation requirement.
