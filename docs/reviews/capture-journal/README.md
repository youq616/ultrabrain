# Capture journal publication — implementation review, 2026-09-29

This complete module extends the supplied, previously unpublished local snapshot `661db1faa4a7da7f0daf287c46ae71656a95bae8` (tree `6901ca832526610862cdc3a586a804d2f2628d3a`). The combined remote patch must use the actual PR41 parent `f53e1c8fda8caca2f90ced2adb15b76ad0494626`, not reconstructed local ancestry. The older `capture-locks` report is retained as historical evidence; its read-only-connector/build limitations describe that earlier round, not this one.

The journal primitive closes a complete fsynced temporary before non-overwriting create or atomic replacement, preserves temporary evidence on failure, and never retries unlink or native permission/IO failures. Safe local diagnostics distinguish not-attempted, uncertain and visible publication without claiming server acknowledgement or power-loss durability. Existing format, binding, consent, ownership checks, limits and manual recovery remain. The queue and delivery cleanup boundaries preserve the authentic primary journal error and subsequent lock-release errors.

## Adversarial self-review and retained failures

Three new regressions fail on the exact prior implementation: write failure masked by close failure, duplicate unlink attempt after successful link, and deletion of prepared bytes after failed publication. All pass after this module. The first raw TAP is retained as `regression-before.tap.gz` (0/3 passed).

A separate review identified another primary-error masking boundary: queue/delivery lock release. The first two-case audit also contained a test preparation mistake: the flush fixture injected a release error during the initial list operation, before any journal fault. The original `audit-before.tap.gz` and complete focused failure log in the delivery archive preserve that mistake. Correcting only the fixture to activate after publication reproduced both missing-preservation failures with the fix reversibly removed (`audit-corrected-before.tap.gz`, 0/2 passed). Restoring the fix gives 2/2. No production permission or test success assertion was weakened.

All new cases use synthetic data. Crash tests execute real syscalls in separate Node processes and exit73 without JS cleanup, not a simulated power failure. The link-before-unlink checkpoint deliberately retains an aliased record and verifies fail-closed inspection. Source CLI tests explicitly substitute SDK imports. The separately unpacked compiled package uses the real pinned SDK with native IO faults, forbids server spawning and verifies the exported safe diagnostics.

## Executed before publication

Ordinary Linux UID1000, Node22.16.0: final full suite **3672/3672**, zero failure/cancellation/skip; **57 new tests** included, not added again. Focused journal/lock/existing capture suite **193/193** includes overlapping tests. Intermediate3670 and focused55 counts are not final totals. Final standalone stress is **25 rounds x8 processes**,600 requests,425 exact records and175 idempotent replays across independent queues, no leftovers or server/model calls.

Bun1.3.13 rebuilt the client with official SDK1.29.0 from locally available exact dependencies. `npm pack --ignore-scripts` produced a new private tgz; independent unpack verified all11 JavaScript artifact hashes and four real compiled-CLI cases (status, binding fault, entry fault, attempt replacement fault). These are local dependency links, not a fresh registry installation, live MCP test or user installation. Complete raw logs, package checks and checksums are in the delivery archive.

This is a separate implementation-assistant review, not a second-agent verdict. New remote CI and final-SHA independent review must be read separately and must not be inferred from these results. Old Windows writer_failed root cause remains unconfirmed. No new Windows, PostgreSQL/MCP, browser, complete Python suite or user deployment result is asserted here. Keep the candidate draft until outstanding gates are resolved; do not merge main or modify previous PR heads/user services.

## Independent-review correction

The first publication was reviewed by the actual Codex repository reviewer and received a P2 diagnostic-propagation finding. See `independent-review.md` for the exact review identity, file/line finding, retained negative regression, correction and updated3679/64/five-package-case evidence. Earlier numbers above remain the pre-review implementation history, not the final candidate totals. A corrected-commit review is mandatory before acceptance.
