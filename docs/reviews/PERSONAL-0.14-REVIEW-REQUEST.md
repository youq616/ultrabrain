# Personal 0.14 — independent reviewer request

Status: PENDING. This is a task specification, not an independent review or approval. Do not merge this phase merely because CI is green.

Base commit: `57852fed3d1839bab105c5b56632af1f65bb4b15`. Candidate branch: `development/automatic-capture-review`. Freeze and report its full HEAD at review start. Subsequent implementation changes require review again.

## Independence and scope

Run a genuinely separate reviewer agent/session that did not implement the code. The parent agent dispatches and collects the report, not impersonates the reviewer. If dispatch is unavailable, report BLOCKED rather than inventing an identifier. Do not modify product code, merge, deploy, read credentials or real transcripts, or upgrade dependencies during review.

Inspect the complete diff from the base and affected existing paths: capture-outbox, automatic-capture, client contracts/runtime/proxy, profile/config tools, native adapters, build/package entrypoints, personal capture/Store/queue, tests and CI. Check consent before persistence/transmission, identity/workspace/scope binding, source grammar, stable events, Unicode, captured-field exclusion, main-session filtering, immutable snapshots, two-lock concurrency, quotas/backoff, crash recovery, exact receipts before deletion, cancellation, revocation and unknown-outcome reporting. Check Windows paths and stated durability limits; do not confuse a passing config fixture with a real Agent run.

## Reproducible local subset

Node.js 22.16+ and Python 3.11+ suffice for this synthetic subset, with no Bun, database, API key or WSL:

```sh
node --test test/client-kit.test.mjs test/native-adapters.test.mjs test/capture-outbox.test.mjs test/automatic-capture.test.mjs test/capture-hardening.test.mjs test/capture-delivery.test.mjs test/capture-profile-binding.test.mjs test/client-release-docs.test.mjs
python -m unittest discover -s test -p test_automatic_capture_config.py -v
```

Read same-commit GitHub CI for Linux PostgreSQL, actual OpenCode host, packaging, browser, n8n and old-data upgrades. Mark unexecuted checks as unexecuted. Preserve first failures and never delete assertions to force success.

## Required report

Give the base SHA, full reviewed candidate SHA, actual independent reviewer identity/run/session, scope and omissions, commands/results, P0/P1/P2 findings with path/line/trigger/impact and reproduction or reasoning, and verdict PASS / CHANGES_REQUESTED / BLOCKED. No findings means only no blocking findings in the inspected scope, not proof of absence of vulnerabilities.

Attach the report as the actual review on the PR or save it on a separate review branch at `docs/reviews/PERSONAL-0.14-INDEPENDENT-REVIEW.md`. Do not overwrite the development branch or main to fabricate approval. Do not include secrets or raw personal data. Implementation fixes belong to the implementer, followed by review of the new full commit.
