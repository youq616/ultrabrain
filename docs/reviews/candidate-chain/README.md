# Candidate chain implementation and implementer review — 2026-09-27

Base remote commit: 91c2eec7f2e82c818f0f7e062a3d4dbab79926cb; exact tree0f2f34e4bc40a137a7c1052b16b444e119fb725c. All810 archived blobs and four gitlinks were verified against the supplied final-source index before editing. The local baseline is a reconstruction, not original remote history; publication uses the real remote parent. The prior ten workflow results were actually read as success, including the real single-candidate GitHub integration. Those do not certify this phase.

## Implemented module

Explicit 1–8 PR chain selection and standalone bounded-stdin Node CLI; immutable topology/reviewer policy, Git ancestry summaries, reuse of the existing single-candidate policy, same repository-ID binding across layers, reverse reobservation of every layer and final anchor check. The anchor and unselected dependencies remain unaccepted, merge_authorized stays false. No code is loaded or executed from the selected PRs. GitHub GET paths, token headers, response limits and non-retry behavior are inherited; only an explicit opt-in permits the precise SHA comparison metadata page.

The single-candidate collector's default response is unchanged. A separate explicit option adds a hash over decision-bound evidence (including invalid review bodies and job identities) so chain comparison is not limited to verdict equality. That digest attests neither an actual reviewer nor a successful checkout/test. No memory schema/store, migration, upstream pin, client tarball, n8n, qbrain or running user service is changed.

## Separate implementer review, not a second agent

Two defects were actually reproduced in a13-test pass11/fail2 run:

1. Separately consistent layers could share a repository name while using different repository IDs. Bind the first selected PR's numeric repository identity across all subsequent and repeated PR reads.
2. A review edit could preserve a blocked verdict and empty accepted-approval list, evading verdict-only reobservation. Bind a canonical SHA-256 of the underlying observed PR/commit/run/review/job fields; this catches invalid-receipt changes and job-identity replacement without disclosing bodies.

The full initial failure TAP is retained as review-first-failures.tap.gz, with its uncompressed digest in local-evidence.json. Two regression assertions are not two claims of exploitable remote vulnerabilities. Additional probes cover8 layers,320-request budget, unchanged order, mismatched base/merge base, unknown fields/accessors/proxies, anchor reobservation, callback and SIGINT-style cancellation, malformed/duplicate/oversize stdin, prior-collector compatibility and additive CI wiring. No remaining blocking finding was identified by the implementation assistant; this is not zero-defect assurance or independent-agent approval.

The first red test was a missing module import, not a failed security case. The first implementation suite had159pass/1fail because an8-layer test generated80-character fake tree IDs at indices6/7. Corrected the test generator to valid40-character hex, without relaxing production commit validation. A streaming terminal request was unsupported and did not execute the command; the ordinary command was subsequently executed, with its actual results recorded.

## Verification and boundaries

Final full-suite and focused results are recorded in local-evidence.json and the final handoff. All local test processes run as ordinary Linux uid1000 under Node22.16.0. Focused tests comprise87 new checks plus115 prior checks. The final tree is also replayed as a patch onto a clean exact remote source baseline. No inherited suite or assertion is removed.

Actual local native GitHub integration was attempted, but the safe collector returned candidate_http_failed; an independent getent lookup for api.github.com exited2. This is a real failed attempt, not online success. A current connector read of the compare endpoint verified the real SHA ancestry summary/page shape, but is different evidence from executing this Node collector. The candidate-evidence workflow adds actual online two-layer verification after the retained single-layer check; its final-SHA execution must be inspected before claiming success. The fixed fixture intentionally stays blocked with no configured reviewer. Windows/Ubuntu are explicit additional CI steps, not local Windows claims. No local PostgreSQL, model, browser, deployment or full Python suite claim is made for this Node repository tool.

## Approval boundary

Independent second-agent review remains NOT APPROVED until an actual reviewer session inspects the final complete SHA and records findings, tests and verdict. Implementation self-review, independent test algorithms, fresh worktrees, API receipts and green CI are not such a reviewer. Keep the new branch/PR draft, main and prior PR heads unchanged. Any blocking correction requires re-review of the new SHA. User services are not deployed or restarted.
