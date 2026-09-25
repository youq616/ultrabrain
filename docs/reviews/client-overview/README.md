# Explicit client overview — implementation and self-review

Base: `210cf8305bead6096d63b08405f66784325f9b7c`, tree `5cdcc21468058c4def91cf2a519082985f5d4159`. The source archive was restored and its full tree, including original tracked review logs and four gitlinks, verified against GitHub. Local snapshot commits are not represented as remote history. Publication uses the exact remote parent on a separate draft branch; PR23, PR20 and main are not rewritten or merged.

## Implementation scope

A complete explicit one-shot CLI/SDK path for the existing owner-only overview. The request requires pinned identity, matching workspace, explicit consent and explicit all-project scope. The wire request contains only an internally generated UUID. No server schema, migration, tool catalog, existing permission allowlist, upstream pin, model configuration, user service or qbrain change. The report is metadata only, validated with the existing shared overview contract. No fallback context, polling or automatic retry.

The runtime `.overview` method composes connection and per-operation authority/cancellation. The public SDK copies input before connection, closes that connection, then verifies current authority and workspace again. CLI pins profile before stdin and does not adopt observed changes. Input JSON is bounded to16KiB and uses the existing duplicate-key/depth parser. Error delivery tracks conservative local attempts, not remote-asserted status.

## Separate self-review pass: findings and fixes

This is the implementation assistant's own review, **not an independent reviewer agent**. Three boundary gaps were reproduced before fixing; six failing regression assertions are not six distinct vulnerabilities:

- CLI JSON parsing accepted duplicate consent/scope keys, including escaped aliases. Use the existing bounded duplicate-key parser only for the new command; other commands retain their parser defaults.
- A workspace could disappear during the one-shot SDK's asynchronous connection cleanup, after the core read checks. Repeat request/workspace validation and authority checks at public delivery; retain `unconfirmed` when a read already occurred.
- Error sanitization accessed `.code` directly. A getter or revoked Proxy could make the sanitizer throw. Read a data descriptor inside a reflection guard; do not invoke exception accessors or trust remote attempt metadata.

`self-review-first-failures.tap.gz` contains the actual80-test run:74pass,6fail. Corrected80/80 passed; four packaging/wiring tests added afterwards bring the module total to84. Initial TDD run failed because the new module did not yet exist; that failure is retained in handoff evidence and is not described as a vulnerability.

Final review also checked consent before transport, before/after identity pins, workspace/project disclosure boundary, one-call/no-retry behavior, malformed entire-result rejection, cancellation at the wire and during cleanup, profile change before stdin and after response, SDK environment handling, fixed bundle inclusion/digests, and unmodified migration/upstream/managed tool boundaries. No remaining blocking finding was identified in this self-review; that is not proof of zero defects.

## Executed locally

Ordinary Linux uid1000, Node22.16.0:2396/2396 complete Node tests, no failures/skips/cancellations, exit0. The84 new tests are included, not added again. Bun1.3.13 built and npm packed the client; the new overview bundle passed existing no-server-code checks and tarball inclusion verification.

13 real integration checks passed using the tarball extracted into an isolated node_modules directory with the locked official SDK dependencies linked from a verified prior CI artifact. This is a real compiled package/SDK/PostgreSQL/stdio/HTTP test, but not a clean network-based npm install. The database was newly initialized in this task's container as uid1000 using the pinned runtime; runtime directory permissions were corrected during preparation before initialization succeeded. No user's database, host credentials or services were used. Do not equate container initialization with rebuilding upstream sources or a user deployment.

The read phase checked six application tables unchanged; fixtures include global/two-project records, source sharing, archive, capture and document queue metadata, with zero generators or external models. Both CLI and public SDK return known owner counts over stdio and zero counts for the distinct read-only HTTP principal; revoked HTTP token cannot read. All actual results and log hashes are in `local-evidence.json`. Python suites and actual Windows were not rerun locally; final GitHub CI results must be read separately.

## Acceptance boundary

Independent-agent review **PENDING / NOT APPROVED**. PR23's prior review request returned quota exhaustion; no second agent has executed this phase's review. Do not label the self-review, test runner, fresh directory or green CI as independent approval. Keep the new PR draft and main unchanged until an actual separate reviewer inspects the complete final SHA and records session, findings, executed tests and verdict. Fixes require review of the corrected SHA. No deployment or production release is requested by this phase.
