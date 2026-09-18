# Independent full-phase boundary review — 9f4e5c2

**Verdict: BLOCK for the entire phase at `9f4e5c2ac81250b7025234fd61008d0bc92e31ef`.** The new bounded read-only manager-registration wait is safe within its inspected scope and now succeeds in both real CI runs. Those runs then fail the first activation plan with `invalid_manager_dependencies`, before any activation acceptance check completes. The working setup does not make the full phase ready for acceptance.

- Actual independent reviewer: `/root/activate_boundary_review`.
- Exact commit: `9f4e5c2ac81250b7025234fd61008d0bc92e31ef`.
- Exact tree: `a03ce02592501574bf03d145cce127fe8eebe5fd`.
- Full phase base: `5b3c88826984a9b5c8b34ca2cf7ffff171501697`.
- Immediately preceding reviewed candidate: `c6b409c9864f0d0d97577bde9b2a3d84207ee717`.
- Repository: `/workspace/scratch/be43dca0ab34/ultrabrain`.
- Last identity/status verification: 2026-09-18 16:35:44 UTC, with exact HEAD/tree and clean worktree confirmed.
- Reviewer did not edit or implement repository code. New local checks extracted source with `git show` at the full candidate SHA.

## Real results and remaining blocker

I independently read both saved raw CI7 logs and the implementation agent's separately labelled audit. The push log records checkout of the full candidate SHA. The PR log records merge checkout `21bfb93925b5b5d50948df0f449c153310ec9385`; the audit records its tree equal to the candidate tree and parents equal to the phase base plus this candidate.

| Real result | PR run 35368448951 / job 105676442134 | Push run 35368445358 / job 105676431152 |
| --- | --- | --- |
| First setup observation | Exact NameHasNoOwner, log line 520 | Exact NameHasNoOwner, log line 504 |
| Second setup observation | Production identity passed; actual manager CapPrm empty; process stable and PID/net namespaces equal, line 521 | Same postconditions passed, line 505 |
| Existing services integration | 18 checks passed with two calls to the local synthetic model fixture, line 533 | Same, line 517 |
| New activation | 0 completed checks; first `plan` failed with `invalid_manager_dependencies`, line 546 | Same failure, line 530 |
| Deployment/readiness/crash progression | Deployment stopped after three checks; readiness and activation crash acceptance not reached | Same |

Thus the previous setup failure is resolved on this exact candidate without bypassing the production identity probe, and its first failed observation is retained. The new **P1 blocker** is the actual initial activation plan refusal. The failing code boundary is the bounded dependency/name-array validator at `scripts/personal_activate_manager.py:139–143`, used for Names and every selected dependency field at `:351,358–359`. The emitted safe error does not identify the actual property, unit, type, cardinality, duplicate, or invalid-name predicate. This report does not guess the malformed value or recommend weakening the validator without evidence.

Closure requires identifying the exact failing observation, making the justified correction while retaining dependency/startup boundaries, and completing the real activation/deployment/readiness/crash checks on a new exact candidate. A subsequent commit needs another independent review. Current source/fixture passes do not override this real failure.

Raw evidence:

```text
831d997c4cb7a4fae0ae926ce8e17685bf03a76538b1d899996e8e8d1b92035b  job-105676442134.log
d9aa399e05b3a4a8f56aea86a77e28a218eb823ae13d66bdc2fe2963495959e3  job-105676431152.log
8cb6ee555d90ef3c23694f1edd7bbe3aa4825d538d99e1981810e913cceec82f  CI-SEVENTH-SERVICES-AUDIT.json
```

The raw logs and audit were fetched/preserved by `/root/activate_integration`; I read their contents independently. The audit is explicitly an implementation-agent CI triage record, not an independent review. I did not rerun those remote jobs myself.

## Complete phase scope and new delta

I reassessed the entire phase using the retained exact-SHA code reviews and c6b409c's fresh full affected suites, then inspected the complete three-file delta here. Production `scripts`, `src`, `package.json`, and documentation compare unchanged against c6b409c. The prior graph, canonical-device refusal, message/reply binding, single-dispatch journal, observation-only recovery, durable cleanup and ready/deploy lock composition therefore retain their previously inspected implementation. No production retry, restart, stop, enablement, source-principal or model-call path was added.

The new findings are:

- `test/personal-activate-crash.py:57–68,71–89` maps only five complete D-Bus error names to fixed short enums. Missing, noncallable, failing or non-string getters yield null; unknown names are not rendered. The original bounded exception chain, code/type/frame allowlists and numeric errno limits remain. Calling this accessor does not print an exception message or a raw returned name.
- `test/personal-activate-integration.mjs:151–154` requires the new exact field and limits it to those five enums or null. An arbitrary name, full error string, wrong type or missing field is rejected before logging.
- `.github/workflows/personal-services.yml:141–166` creates one 35-second monotonic budget and permits at most 20 fixed read-only diagnostic children. Each child receives the remaining timeout; sleeps are at most 0.5 seconds and never exceed the remaining budget. A child timeout is not caught as retryable. This is subprocess timeout budgeting, not a mathematically exact OS scheduling deadline.
- Only the exact two-layer manager_unavailable / DBusException NameHasNoOwner condition with unavailable manager proc, null proc errno, null permitted-capability observation and null stability observation can retry. Other D-Bus errors, wrapper shapes, proc bindings and non-boolean results fail. Every valid diagnostic is logged with its attempt number before the decision, preserving the first failure and any terminal retry-limit failure.
- The single manager restart remains outside the loop at line 135; daemon reload and linger likewise remain outside. The loop never calls restart, StartUnit, activation apply or recovery. Success still requires zero diagnostic exit, production identity success and actual manager CapPrm empty.

No additional concrete safety/privacy blocker was found in this delta. The real new plan failure nevertheless blocks the complete phase.

## Executed local evidence and correct SHA attribution

On the exact candidate source, I independently executed **14 pure error-enum/getter/context scenarios** and **10 scenarios using the actual extracted JavaScript validator**, all passing. Cases included all five names, unknown and short names, non-string and string-subclass values, missing/noncallable/raising getters, a wrapped private error, valid null/fixed enum output, and refusal of unknown/full-name/non-string/missing fields. No diagnostic child, bus, proc-manager or service operation was performed.

```text
f4714e12096e60fb39d30cf0f00f827f919f824c332d0e9b27ec57642bb41cf4  boundary-9f4e5c2-dbus-enum-tests.log
dcf430133d5a9a7c358f87d897de782f890ccf699a72d5081aa54f53d42559c5  boundary-9f4e5c2-dbus-schema-tests.log
1dc4c0fc6927948e1d4aaa43620f5667b91c52d19a91b0140d3e6fb254057fea  boundary-9f4e5c2-dbus-safe-envelope.json
```

A separate independent reviewer, `/root/activate_boundary_review/dbus_abi_crosscheck`, executed **36 isolated tests of the exact extracted workflow loop**, with fake time/subprocess/environment. They passed for immediate/eventual success, first-failure preservation, attempt exhaustion, shrinking timeouts, clipped sleeps, elapsed budget, child timeout, every nonretryable error/binding condition, and invalid success/output shapes. Every simulated call asserted the fixed read-only command. I read that review and its evidence; these 36 tests are attributed to the separate reviewer, not presented as commands run by me.

- Report: `boundary-registration-wait-9f4e5c2-review.md`, SHA-256 `5c6b7c939d6755c3bfe6d158a26ddbe5d150a1e1ee097d9efc989852240ded34`.
- Case record: `boundary-registration-wait-9f4e5c2-checks.json`, SHA-256 `aed354658199fe845bfe1fdfebb9a8cdf68b9e0a3a1ffd3ab0235cbe8bf2567e`.

Node syntax, Python AST, exact diff/production-path comparison, HEAD/tree and clean-worktree checks passed. The independent **259 Python and 14 CLI tests remain explicitly attributed to c6b409c**, whose relevant production/test paths are unchanged; they were not rerun or relabelled as executions on 9f4e5c2. The seven root-writer checks and 25 auxiliary CI pre/postcondition checks also retain their c6b409c attribution. Their commands, complete logs, hashes and first local evidence failures are preserved in `boundary-review-c6b409c.md` (SHA-256 `8aee0c3de21888f256c474988589443ab33fe520e7a60a2961bb9dc37cc5a66b`).

All prior reports and first failures remain unchanged. I did not execute real services, sudo, manager resets, ptrace, deployment or model/client calls locally, and did not lower production identity requirements. The real sent-without-reading-reply recovery case remains unexecuted in CI7 because the initial plan failed. The overall exact-candidate verdict remains **BLOCK**, with the successful setup and existing-services results recorded only for their actual scope.
