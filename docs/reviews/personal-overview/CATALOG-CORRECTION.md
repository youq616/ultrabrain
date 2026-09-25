# Packaged proxy catalogue correction — 2026-09-25

This follow-up is a test/integration correction. All production files remain byte-identical to application commit `21395be76f6a923d59e01b3ad5f6495f627c5166` (tree `359ec64782413533dbabe460a6a52a87679ee8db`). Independent review remains BLOCKED / NOT APPROVED: the actual Codex review response on PR23, comment5830986565, reports exhausted code-review quota. Do not turn the request or successful CI into approval.

## First actual CI failure

Run36124740331, job108038137170, the packaged Node client/proxy step failed at `test/client-kit-integration.mjs:40`. The actual proxy correctly advertised `ultra_personal_overview`, but the independent expected read-tool fixture still listed only the previous nine tools. Other upgrade matrix jobs failed at the same step. Following stages were skipped and are not passed.

The exact excerpt, including runner timestamp and assertion diff, is retained in `catalog-ci-first-failure-excerpt.log`. This is an excerpt, not the entire job log. The corresponding GitHub job log was inspected. Earlier real module-specific PostgreSQL/native MCP and browser checks passed at the same source tree; those successes do not make this failed full workflow pass.

## Correction and additional regression coverage

Add exactly the approved read-only overview to the fixed expected fixture; do not replace it with an imported production allowlist, weaken equality to a count/subset, remove old names, or grant mutating tools. Both original readonly/capture assertions remain.

The old SDK-double catalogue returned names from the expected fixture itself, which concealed omissions in that fixture. Six additional tests use the actual personal plugin registry as the advertised surface and independently verify readonly/capture exact membership, optional legacy-server behavior, a UUID-bound readonly overview round trip, and revocation before transmission/after response. These are explicit SDK doubles, not real MCP execution. The two exact-catalogue tests fail on the unchanged expected fixture; original first run is retained in `catalog-registry-first-failure.tap.gz` (29 tests,27 pass,2 fail). All29 pass after the one-name correction.

The real packaged proxy integration additionally calls the overview over both stdio and authenticated HTTP, validating the full aggregate contract and known counts. The stdio owner observes the seeded record; the read-only HTTP principal observes zero owned records, not the stdio owner's counts. No model, body response, new write permission, migration or application code is added. New real integration results must be read from the corrected commit's CI, not inferred from these assertions.

## Executed evidence and scope

The corrected full Node suite passes2303/2303, zero failures/skips/cancellations. Earlier application-tree Node2297/2297 is historical. Seven disjoint Python batches cover the entire unchanged683-test discovery exactly once, all683 pass without failures/errors/skips. The initial monolithic Python run timed out and remains in the handoff evidence; batch completion does not erase it. Its corrected aggregate record is committed as `python-batched-completion.json`.

For application21395, the actual PR test-merge commit10c55e8c62c655f1c1bb418cf68b2167bd585a65 has the exact same359ec source tree. Module-specific workflow36124740448/job108038137108 logged9 PostgreSQL/native-MCP checks and10 real online Chromium checks, with six application tables unchanged during reads, three explicitly synthetic generators during preparation and zero external models. Windows/Linux portability, HTTP/CSP synthetic-database smoke, native integrations, services, recovery, database identity and task recall passed. Full validation exposed the above catalogue omission. Corrected final-SHA CI is required; do not carry an older failure or success forward as the new result.
