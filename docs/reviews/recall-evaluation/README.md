# Explicit recall evaluation — implementation and review (2026-09-27)

Base commit19fd7a64bf9eaf203f16da03282e956e66d2d49f, treecbfec58177f2abff164b3958d640378b53f82f0a. Supplied source archive was restored and every tracked blob/mode plus all four gitlinks reproduced before editing. Local baseline ancestry is reconstructed, not a remote commit to force-push. Publish using the real remote parent on a separate draft branch; main and prior PRs stay unchanged.

## Complete module

Manual client CLI, standalone installable SDK, connection method and one canonical annotated ranking evaluator. Reuse the existing taskContextRequest/clientContext contract and actual personal context tool, no second ranker, new server tool, migration or permission. Every case requires explicit task-read authorization under pinned source/principal/workspace. Validate the complete bounded suite before any connection. Labels never go to the server; tasks do. Every result is checked before scoring and bracketed by identity checks. Reports contain metadata/ID scores only. Negative-only cases have null positive metrics; forbidden checks cover the complete returned list, not merely top-k. No pass threshold or semantic/answer-quality certification.

Selections, labels and outputs are frozen. Sequential calls are bounded to32 with cancellation and no retries. Partial failures withhold all scores; locally tracked attempts cannot be forged by a remote exception. The standalone SDK rechecks authority/workspace after asynchronous close; profile changes in CLI are latched using the existing helper. Existing client commands, memory permissions, upstream pins, n8n and qbrain are unchanged. Dedicated package bins/build digests/mandatory tarball entries and additive cross-platform plus actual-installed CI are present.

## Separate implementer review

The first73-test combined run found one error-classification issue: workspace loss during SDK cleanup was denied, but reported invalid_params instead of workspace_mismatch. No unauthorized result was delivered. Check workspace with the explicit safe projector before per-case task validation;73/73 then passed. Original72-pass/1-fail log retained as deterministic gzip. Initial missing-module red test is a development baseline, not a vulnerability.

A separate adversarial pass adds16 tests: independently written loop-based metric oracle on20 deterministic rankings, the complete32-case sequential boundary, five invalid context forms, sparse/hidden/symbol/accessor arrays, whole-suite size refusal, exact task transmission with no label/workspace leakage, revoked exception proxies, suite fingerprint variation and package/CI wiring. Together with core/runtime/CLI tests this phase has89 new tests. No remaining blocking issue was identified by the implementation assistant; these tests/oracle/self-review are not an independent reviewer agent or proof of zero defects.

## Executed evidence

Ordinary Linux uid1000, Node22.16.0: full2986/2986 with test-concurrency4, zero failures/skips/cancellations, exit0.89 new cases are included. The first monolithic invocation was killed by the outer tool after120seconds and has no final verdict; preserve its partial TAP and timeout record, do not count it passed. The completed rerun is separate evidence.

Actual Bun1.3.13 build and npm pack passed. The tgz was extracted to a private isolated package directory with pinned official SDK dependencies linked from the verified CI artifact; this is not a fresh online npm install. New isolated PostgreSQL was initialized and migrated with the pinned runtime as an ordinary user, then explicitly stopped.12 real integration checks passed through actual compiled CLI/SDK, official MCP, stdio and authenticated read-only HTTP. Synthetic fixtures test correct ranking, shared-only read principal versus owner, project/candidate/archive exclusion, identity mismatch, all-before-send validation, revocation and unchanged six personal tables. No injected generator or external model call. Local synthetic scores are not a real-user quality benchmark.

The source change includes the corresponding actual installed-package CI after its existing npm install and before database shutdown, plus the four new suites in both Windows/Ubuntu jobs without deleting prior gates. Final-SHA CI, real Windows and separate reviewer results must be read from the PR; scripts alone are not evidence. Clean patch-replay/full-source validation and final package verification are reported in the final handoff after this source note.

## Acceptance boundary

Independent second-agent review PENDING as of source commit. Request a genuine review of the complete final SHA; record actual findings and verdict separately rather than fabricate reviewer session/tests. Any blocking fix requires review of the new SHA. Maintain draft and leave main/user deployment untouched until the repository's acceptance gates are satisfied. No new customer-host, external-model-quality, full local Python or end-to-end installed Agent-model certification is claimed.
