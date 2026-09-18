# Independent proc-diagnostic privacy review

**Narrow verdict: NO BLOCKER for the diagnostic-only changes in `80d6314eb55e06c9787b384ada38a169b71a5bdc`.** This is not a whole-phase PASS and does not approve a replacement manager identity proof. The production implementation remains unchanged, and the existing real activation failure remains unresolved pending actual diagnostic evidence and a reviewed correction.

- Actual reviewer: `/root/activate_boundary_review`.
- Exact candidate: `80d6314eb55e06c9787b384ada38a169b71a5bdc`.
- Exact tree: `d31efe0c810746b81a906b3b052302a4d517ffcf`.
- Parent diagnostic candidate: `70cd4cc3880c13c8d53d32627e5c771174a7d3c5`.
- Scope: full two-file delta, `test/personal-activate-crash.py` and `test/personal-activate-integration.mjs`; 175 additions and three deletions. No production files changed.
- Final identity check: 2026-09-18 16:06:34 UTC; exact HEAD/tree and clean worktree confirmed. Reviewer did not edit repository files or implement this change.

## Read and output boundaries

At `test/personal-activate-crash.py:92–243`, the new diagnostic opens the fixed `/proc` directory and only numeric self/manager process directories. The manager PID comes from the existing bus-owner connection path; there is no new arbitrary PID/path command-line option. Invalid PID types/ranges are rejected before opening a target directory. Directory and file operations use fixed names and directory descriptors with no-follow flags.

The reads are limited to `stat` (8192 bytes), `status` (65536 bytes), the fixed `pid`/`net` namespace links, and `attr/current` (4096 bytes). The helper parses only UID/GID quadruples and permitted/effective capability fields from status, uses process start time and repeat observations to describe stability, and compares selected private values. It does not read command lines, environment, memory, credentials, transcripts, a service journal, or model output. All these new calls are read-only; all opened descriptors have cleanup paths.

The returned `proc_checks` has exactly 35 fixed keys. Values are limited to booleans/null, bounded numeric errno/null, or the label enums `unconfined`, `systemd`, `other`, and null. Raw PID, UID/GID numbers, capability masks, namespace identifiers, process names/start times, full status/stat content, and security labels are never inserted into the returned object. Raw labels are used only for equality and the fixed label enum. Missing/denied observations remain false/null plus bounded errno rather than becoming successful identity evidence.

At `test/personal-activate-crash.py:246–260`, the original sanitized exception chain is constructed before the additional proc reads and is retained beside them. The diagnostic still calls only the existing manager identity method and closes the connection in `finally`. The unchanged strict ordinary-user CI/home gate at `:270` onward precedes this path; the branch still exits before creating an activation Context or entering apply/crash dispatch.

At `test/personal-activate-integration.mjs:139–182`, the consumer retains the existing 35-second subprocess bound, 16 KiB accepted output bound, secret check, exception-chain validation, and fixed fallback. It additionally requires the exact 35 proc keys and validates each against its boolean, errno, or label category. It rejects extra raw fields and private label strings before logging. The original plan failure is still rethrown at line 265; the original failure record at line 351 and check count are not replaced by the diagnostic result. No plan retry, service mutation, or acceptance bypass was added.

## Interpretation limit

These values are diagnostic observations, not authorization or proof that ptrace access is permitted. A separate primary-source crosscheck by `/root/activate_boundary_review/dbus_abi_crosscheck` identified a relevant limitation in [Linux v6.8 proc ownership handling](https://github.com/torvalds/linux/blob/v6.8/fs/proc/base.c): the world-readable/executable `/proc/<pid>` directory deliberately retains target effective UID/GID ownership even when the target is nondumpable. Therefore `manager_directory_owner_matches_self_fsuid` cannot establish dumpable state. Failed namespace-link reads must also stay unknown because they are subject to ptrace access checks. No code in this candidate treats these diagnostic comparisons as a successful manager identity proof.

The code does not directly observe target dumpability or target user-namespace identity. Capability-subset and credential comparisons can narrow the cause; they do not alone distinguish every dumpability, user-namespace, or LSM condition. The root agent was notified of this interpretation limit before the report was finalized.

## Independent execution

Six isolated Python checks passed against the frozen helper bytes. A private temporary proc fixture replaced only the helper's fixed `/proc` open; all remaining reads used the actual bounded helper code and real temporary files/symlinks, with mock scalar process IDs and credentials. No live manager proc entries were inspected and no entry gate was bypassed.

The cases covered correct UID/GID three-versus-four comparisons and capability subset/effective-subset distinctions; private label and process-name redaction; namespace EACCES; a missing target; invalid PID inputs; oversized status; and duplicate, overflowing or malformed status fields. The tests tracked every helper-opened descriptor and asserted that all were closed. Six test methods completed with zero failures.

Seven scenarios using the actual extracted JavaScript diagnostic validator also passed. The real Python fixture-produced envelope was accepted. A private label, raw capability number, out-of-range errno, extra raw field, missing required key, and oversized response each produced only the fixed unavailable diagnostic. The subprocess function was mocked, so these checks made no process or service calls.

| Evidence | SHA-256 |
| --- | --- |
| `boundary-diagnostic-ci5-proc-tests.log` | `d6d62c61905f37a4a4524ec2a01145a85a6ad1371cc2a375ed2d8663cd082914` |
| `boundary-diagnostic-ci5-schema-tests.log` | `ac8fb2fb6661c35ae68df02bb7858724a26541670d40eff1d9d59b42ac5fb25b` |
| `boundary-diagnostic-ci5-safe-envelope.json` | `7cab79de40e37a759bd24588666d65a617f69d26f465dc3e2a1c1b018a285991` |

The tests ran on the frozen working-file bytes before the final commit notification; those bytes were then verified identical in the exact candidate. Node syntax, Python AST, full delta inventory, whitespace, HEAD/tree and clean-worktree checks passed. Reviewed file SHA-256 values are:

| File | SHA-256 |
| --- | --- |
| `test/personal-activate-crash.py` | `0ea94f442b364bd8ce8a2b5f2ca8e6f28a2b30013181b3df32d1f4334eb22b9e` |
| `test/personal-activate-integration.mjs` | `7046e4610ce8f5b08f4b49ed687b19301ffb93479e3db766ac6fdbac393b4220` |

The unchanged root/CI entry gate was statically rechecked; its prior actual root-refusal execution remains attributed to the preceding diagnostic review and was not rerun here. The 259 Python/14 CLI suite was not rerun for this diagnostic-only change. No real user-systemd diagnosis, PostgreSQL/activation integration, real client/model call, deployment, root bypass, or service modification was performed by this reviewer.

All earlier reports and first-failure evidence remain unchanged. Actual CI5 results were not independently available in this review. The full phase continues to be BLOCKED until the real failure is diagnosed and corrected, required real checks pass, and the resulting exact application candidate receives another independent review.
