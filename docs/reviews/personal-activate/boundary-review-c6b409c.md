# Independent full-phase boundary review — c6b409c

**Verdict: BLOCK for the entire phase at `c6b409c9864f0d0d97577bde9b2a3d84207ee717`.** The new CI capability preparation has no additional concrete safety blocker in the inspected code and isolated checks. However, both real services jobs for this exact candidate fail the required production manager identity postcondition immediately after restart; no subsequent service/activation acceptance checks execute. This is not a passing phase or a completed integration.

- Actual reviewer: `/root/activate_boundary_review`.
- Exact candidate: `c6b409c9864f0d0d97577bde9b2a3d84207ee717`.
- Exact tree: `6921e7e0cc63ce915012d6736579f4b239210d14`.
- Full phase base: `5b3c88826984a9b5c8b34ca2cf7ffff171501697`.
- Repository: `/workspace/scratch/be43dca0ab34/ultrabrain`.
- Review independence: no repository code was edited or implemented by this reviewer. Evidence and isolated fixtures were written outside the repository.
- HEAD/tree were verified clean at initial inspection. At final verification, 2026-09-18 16:24:50 UTC, HEAD/tree still matched, but the implementation agent had begun the next candidate's uncommitted changes in the workflow and two diagnostic files. Exact workflow checks therefore use `git show` at the full c6b409c SHA; this report does not approve those later working-file changes.

## Blocking real integration result

**P1 — required manager readiness after the CI restart is not established.** In `.github/workflows/personal-services.yml:140–151`, the immediate diagnostic must pass the production identity verifier and then observe actual empty permitted capabilities. Both exact-candidate jobs instead report `manager_unavailable`, with a `DBusException` beneath `_connect` line 215 (`GetNameOwner`) and `_raw_call` line 259. No manager PID is obtained, and the proc capability observation is null. The assertion at workflow line 150 then fails.

I independently read both saved raw logs:

| Exact-candidate job | Observed evidence | SHA-256 |
| --- | --- | --- |
| PR run `35367592709`, job `105673679377` | Diagnostic at log line 505; setup assertion at 506–509 | `0112f5861cafc9a94fd182f14b077422bcd8d28e72b3dc9ad2efe6b358691937` |
| Push run `35367588704`, job `105673665304` | Diagnostic at log line 489; setup assertion at 490–493 | `5f53cbc387ac073e80da0c8a2a3c25dc91158f9699b518f2dda82de75307e0b6` |

The files are `job-105673679377.log` and `job-105673665304.log`. They were fetched/preserved by the integration agent, then read independently here. The setup reached the post-restart diagnostic after the loaded capability-property assertions; **actual manager CapPrm empty and successful production identity verification were not achieved or observed**. Subsequent services, activation, readiness, and deployment acceptance steps did not run.

The sanitized exception in this candidate does not report a D-Bus error name. This report does not infer that the actual error was NameHasNoOwner, a transient startup race, or a particular permanent configuration problem. Closure requires the required postconditions and actual acceptance checks to succeed on the corrected exact candidate, while preserving the initial failure and maintaining the production identity checks. Any fixture-only retry must not become another manager restart or product dispatch, and needs its own exact-candidate review.

## Scope and code findings

The full phase spans 16 files relative to the base. I reassessed the complete phase using the retained full reviews, exact diffs, the new workflow/documentation inspection, and fresh affected suites. The production `scripts`, `src`, and `package.json` paths are byte-identical to `def34fb9577167bebc6f7d41d0c6bb8138220087`. The two diagnostic iterations were already independently inspected at their exact commits; they add read-only observations without changing manager acceptance. Those prior reports remain unchanged.

The canonical-device/reverse-follower blocker remains fixed before LoadUnit; the device and swap regressions pass. The selected dependency graph checks, same-manager/bus binding, explicit message flags/reply validation, single-dispatch journal, observation-only recovery, historical-terminal cleanup, source binding and held-lock ready/deploy composition retain their reviewed implementation. The fresh suites exercise their existing refusal, partial-failure and recovery cases. The CI environment change does not grant the production tool another start, stop, restart, retry, reload, or enablement path.

For the new workflow:

- `.github/workflows/personal-services.yml:70–88` checks Linux, matching nonzero real/effective UID, the three explicit CI flags, fixed passwd/environment home and synthetic installation path. It bounds and parses the current process's cgroup file and refuses a `user@UID.service` path component before restarting that manager. This is a check of the hosted job's visible cgroup ancestry; it is not isolation against another privileged actor or a separately hidden cgroup namespace. The workflow declares a hosted ubuntu-24.04 job and introduces no container context.
- `:91–124` binds the root helper argument to a canonical positive numeric UID, SUDO_UID and the fixed runner account home. It opens root-owned, non-group/other-writable directory ancestors through descriptors with O_DIRECTORY/O_NOFOLLOW, then creates only the fixed runtime drop-in using O_EXCL/O_NOFOLLOW. It checks regular-file type, root owner and single link, writes the literal two capability resets, and fsyncs file and directory. Existing files/links are not overwritten.
- `:125–139` requires the loaded CapabilityBoundingSet and AmbientCapabilities properties to be exactly empty before one bounded restart of the current runner's user manager. Daemon reload, linger and restart have explicit timeouts. This is CI preparation on the disposable host; the product and user-host procedure gain no permission mutation.
- `:140–151` requires the production LocalManager identity probe and actual manager permitted capabilities to be empty. A missing capability observation, failed identity or nonzero result cannot pass. The currently failed postcondition is preserved as the integration blocker above.
- `docs/PERSONAL-ACTIVATE.md:14,77` accurately adds the proc-readability prerequisite and confines the capability adjustment/restart to disposable CI. It does not say equal UID is sufficient, instruct the user to relax their host, or claim the real checks passed.

I also delegated a separate narrow workflow/source check to actual independent reviewer `/root/activate_boundary_review/dbus_abi_crosscheck` and read the completed report. It found no additional concrete safety blocker, independently checked systemd v255's empty capability-set semantics, and explicitly withheld integration approval. Its report is `boundary-ci-capabilities-c6b409c-review.md`, SHA-256 `bdc6631ca7a2a305df1c7b3573ffaf72e0bdbfc530e5561938161a965a1ecd05`. The [fixed v255 documentation](https://github.com/systemd/systemd/blob/db11bab38ccf1ed257f310d29070843d4c58ea01/man/systemd.exec.xml#L754) supports the resets; checking actual permitted capabilities remains necessary, including for command-prefix exceptions.

## Executed validation on exact candidate

| Command | Accepted complete result | Log |
| --- | --- | --- |
| `python3 -B -m unittest discover -s test -p 'test_personal_activate*.py' -v` | 101 passed | `boundary-c6b409c-activate-tests.log` |
| `python3 -B -m unittest discover -s test -p 'test_personal_ready*.py' -v` | 71 passed | `boundary-c6b409c-ready-tests.log` |
| `python3 -B -m unittest discover -s test -p 'test_personal_deploy.py' -v` | 87 passed, complete separate rerun | `boundary-c6b409c-deploy-tests-complete.log` |
| `node --test test/personal-activate-cli.test.mjs test/personal-ready-cli.test.mjs test/personal-deploy-cli.test.mjs` | 14 passed | `boundary-c6b409c-cli-tests.log` |

Accepted full-suite evidence is **259 Python and 14 CLI tests** on this candidate. These are local fixtures, not actual user-manager/PostgreSQL activation. Complete log SHA-256 values:

```text
bb69394a26a2c0a974e46637a62430bc2d80ee9a4ff6a8f41ce517e9260e7b01  boundary-c6b409c-activate-tests.log
84814fea86b37b07f603347c956872b18ff5f9e22df8414974795f42ad138d92  boundary-c6b409c-ready-tests.log
4bc339c40aa4c042abf75bb1dcf6d2e485fd3b6f5fee72bac1c0e0ec2d762d53  boundary-c6b409c-deploy-tests-complete.log
cdbc1e9e2b4ff414f67db9f56af4ebb737b2d3ed4df842eabdd2106c401a424f  boundary-c6b409c-cli-tests.log
```

I independently ran **seven isolated root-writer checks** using the exact Python body extracted from this commit. Only the fixed root open was redirected to a private temporary directory; no sudo, systemctl, loginctl, host `/run` write, or actual manager operation occurred. Cases checked exact literal output, preservation of an existing regular file, preservation of a symlink target, refusal of a symlinked directory, writable ancestor, foreign owner, mismatched SUDO_UID and invalid numeric UID forms. Every opened descriptor was checked closed. All seven passed in the complete run.

Reproducible reviewer harness: `boundary-c6b409c-root-fixture-check.py`, SHA-256 `c1cc51fe4cea41cb9fc4039aa63c7f12c766b88cd43fe75b4402f127aa2c1978`. Complete result: `boundary-c6b409c-root-fixture-tests-complete.log`, SHA-256 `402117a794ee334b820418dfd11a05bc143f0d0d39847170eff9bf81db86f501`.

The separate narrow reviewer independently executed **25 additional isolated checks** against exact-commit extracted Python: 18 CI/account/home/cgroup preconditions and seven identity/capability/JSON postconditions. They all passed. These are attributed to that actual reviewer and are not presented as commands run by me or as real CI.

Exact full-phase whitespace and production-path comparisons passed. The earlier diagnostic privacy tests remain attributed to 70cd4cc/80d6314; they were not relabeled as new executions here.

## First failures and evidence limits

The first concurrent deployment command returned tool exit 0 but its redirected log lacked a final unittest summary. I corrected the preliminary count, retained `boundary-c6b409c-deploy-tests.log`, and accepted only the complete separate 87-test rerun above. The incomplete log SHA-256 was `f71a3893e8bf740131e0c8f00c059d6f9c84ad84e9114faa5fb7902018bdf354`. This recurrence of the earlier capture anomaly is not an asserted application test failure.

The first root-writer fixture attempt had six passing cases and one environment error: changing the private test directory to UID 1001 returned OSError EINVAL before the foreign-owner test reached the workflow code. That original log is preserved as `boundary-c6b409c-root-fixture-tests.log`, SHA-256 `a6944301b58ff6f878b3aa73ca3ae7f4534b199fecdc2d2687a115aec9325581`. The corrected harness injects only fstat owner metadata for that case; it does not escalate permissions or alter the product. All seven complete checks then passed.

I independently read the precursor CI5 logs as well: both showed stable caller/manager observations, matching three-part UID/GID comparisons, caller permitted/effective capabilities empty, manager permitted capabilities nonempty and the effective-subset comparison false. The PR log `job-105669635143.log` has SHA-256 `4a133eda40e850a8e985f678d5ddb23cbd52cca7c7c478d0395a3fa890baeea8`; the push log `job-105669619777.log` has SHA-256 `53846261f5e12ea286ab4298c1936da7ff4a1190a37c12834e183e5be0b98485`. Those observations motivate the explicit CI normalization; they are not proof that the new setup has succeeded or a substitute for namespace/process identity checks.

All prior first failures and exact-SHA reports remain unchanged, including device dependency, reset fixture, capture diagnostic limitations, positional ABI failure, and manager process-read denial. This local environment still lacks distro dbus bindings. I did not run real user-systemd/PostgreSQL activation, ptrace attach, manager settings changes, user-host deployment, or real model/client calls. This review did not lower any product identity condition.

The required actual post-restart manager verification and real acceptance checks remain failed/unexecuted. The entire exact candidate therefore remains **BLOCKED**, regardless of the local suite and isolated safety-check results.
