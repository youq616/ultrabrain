# n8n personal overview — implementation review

Base commit `91b581a3ae74f5779301106757e57391ab2914b8`, exact source tree `df1430f937dd8791890326e1a57866e8ebd1820c`. Prior PR24's nine CI workflows were confirmed successful before starting. The source archive was restored with original modes, tracked logs and four gitlinks and matched that tree. Local reconstructed history is not the remote commit history.

## Scope

Complete new n8n operation `personal_overview`: UI properties, credential pin instructions, execution routing, existing MCP service call, canonical whole-response validation, per-input pairing and safe read-delivery errors. Source-root and observed instance/actor pins are mandatory; consent and scope must be explicit. No input data/attachments, hidden context/capture expressions, bodies, models or mutations requested. The manual example is inactive, credential-free, unconsented and disables workflow execution saving; no global log or service configuration is changed. n8n history remains a separate privacy boundary.

Legacy capture, context, project and session operations retain their dispatch/receipt semantics. Credentials are copied once instead of retaining the mutable return object. New cancellation handling affects only pending overview outputs, not confirmed legacy writes. No server catalog/permissions, migrations, upstream pins, CLI package, user service, main or other project changes.

## Separate implementer review, not independent-agent approval

Two issues were found and reproduced by four added assertions (40 tests,36 pass/4 fail):

1. The executor evaluated hidden context parameters for overview. Branch the settings construction so overview evaluates only operation, timeout, scope and consent. This avoids needless evaluation and failures from unrelated hidden expressions.
2. The executor constructed output before asynchronous close. Cancellation during cleanup or a later item could return an earlier private overview. After cleanup, withhold all successful overview entries if cancellation was observed; preserve pairing and read-delivery semantics. When stopping on an error, preserve the original exception rather than overwrite a confirmed write outcome.

The complete first-failure TAP is stored as `self-review-first-failures.tap.gz`. Those four assertions then passed. Two additional cancellation/directory-scope checks and six wrapper/example/boundary checks bring new tests to48. No remaining blocker was identified by the implementer's review; this is not zero-defect proof or an independent reviewer session.

A separate integration-fixture failure expected scope_denied for a malformed directory URI with a trailing slash; actual rejection was invalid_uri. Correct the fixture to the canonical directory URI without the trailing slash and verify scope_denied; do not relax production URI validation. The initial and corrected integration logs/hashes are retained in the handoff.

## Actually executed locally

Full Node2444/2444 as ordinary uid1000, no failures/cancellations/skips. New48 are a subset. Existing40 automation/n8n tests passed at first implementation. The final built adapter with official pinned SDK1.29.0 and a newly initialized disposable project PostgreSQL completed26 integration checks, including8 new overview checks. Six personal tables unchanged during read phase. The fixture performs explicit synthetic setup writes and has no overview model calls.

Bun1.3.13 build and npm pack passed with existing no-server-code bundle gate; package hash and raw-log hashes are in `local-evidence.json`. Local protocol tests used the actual build and pinned SDK dependencies from the verified prior CI diagnostic archive. They are not real local n8n-engine execution or a fresh online install. The attempted upload of the extended `test/n8n-integration.mjs` was blocked by the write safety check. It was not retried through another encoding or channel; the remote integration file remains unchanged. The extra8 protocol checks are local-only evidence. Existing actual-host CI cannot prove the new overview engine path. Final-SHA unit/portability/build and existing integration results must be read separately. A dedicated additive Node step covers the new48 tests on Windows and Ubuntu.

## Acceptance

Independent second-agent review is PENDING / NOT APPROVED. No available independent execution was performed locally; the prior Codex request hit its review quota. Self-review, another worktree or CI cannot stand in for another reviewer. Keep the branch/PR draft until a separate reviewer records final SHA, session identity, concrete findings and verdict. No main merge or deployment is part of this phase.
