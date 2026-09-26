# Snapshot duplicate review — implementation review record

Date: 2026-09-26. Prior unpushed duplicate algorithm source: local52ae2b2d7d61f98291ddddaba333d7cbcf2fe8ed / treeda01ec0cf5b41613bf400f47d88bb83c0d344083. Actual remote parent:8d373b38195f0134a2374cd3996811568d5621e9 / tree41259f0550ce6bb401de965147d1e441bdf90fd6. Restored the full prior tracked tree including gitlinks, then reverse-applied its patch to reproduce the exact remote source tree. Reconstructed local history is not remote history. Publishing the dependency is recovery of prior work, not all new implementation.

## Scope and audit

New explicit review panel consumes one already-inspected local file using the canonical WeakSet-backed contract. Exact-content grouping code moved without new matching semantics into the shared browser/Node contract; old Node entry is a re-export. Replace Node-only timer/byte primitives with event-loop yields and the existing UTF-8 encoder. Group/member order, full-file verification, report fields and non-authority claims remain unchanged.

The panel provides10-group and20-member pages, cross-page A/B selection, separate complete-record disclosure consent, literal-text display and synchronous parent-inspector lifecycle hooks. No API, file upload/download, model, mutation, auto-merge or survivor choice. Metadata and record contents remain private. Current-source ownership and truth cannot be inferred from a local file.

This record is the implementation assistant's separate audit, NOT an independent reviewer-agent result. Reviewed: entire-file rejection outside groups; WeakSet identity shared between browser and Node; cross-project/status inclusion; nested panel revocation; silent identity/source/view changes; stale closures and async delivery; all1000 members reachable; bounded DOM output; consent before body display; preservation of independent drafts; fixed console assets/CSP; unchanged migrations, upstream locks, enterprise permissions and unrelated n8n integration.

## Findings and fixes, with original failures retained

Initial UI regression found that invoking comparison before completing A/B consent invalidated the entire review. Corrected to a safe no-disclosure prompt that preserves a valid scan. Expanded regression found group buttons on the same page became stale after choosing the first group because group and member pagination shared a generation counter. Split these counters: obsolete group pages still fail closed, but switching groups on the current page remains usable. Neither issue is described as a demonstrated remote exploit. The expanded34-test run had32pass/2fail; corrected34/34.

First full Node run also found the new forged-handle test expected an invented error code. Corrected the assertion to the existing `snapshot_not_inspected` contract; production handle rejection was not weakened. Preserve that first2540-test run with2539pass/1fail. Initial missing-new-file TDD failure is retained but not counted as a code vulnerability.

## Actually executed locally

Ordinary Linux uid1000, Node22.16.0: final full Node2540/2540, zero failures/cancellations/skips.40 new tests are included; prior duplicate algorithm suites remain included. Bun1.3.13 compiled the private client, npm pack succeeded,40 actual offline-package entry checks passed under the existing descriptor guard without SDK dependencies, and file bytes/times remained unchanged. This is a built tarball test, not a new npm registry release.

Real Chromium offline:15 interaction checks passed with actual selected synthetic files, independent Python grouping oracle, all7 production scripts, bounded group/member pages, all45 members of the large browser group, cross-page A/B, raw-text injection rejection, cancellation, corrupted-file refusal and narrow viewport. Whole1000-member paging is additionally covered by the production-script Node test. Offline digest bridge is explicitly a Python SHA-256 implementation; do not call it native-browser WebCrypto or onlineCSP.

Real online Chromium was attempted and blocked at page navigation with `net::ERR_BLOCKED_BY_ADMINISTRATOR`; original log retained. No policy bypass or local online success is claimed. Production Node HTTP resource tests did pass. New dedicated CI fixture uses realHTTP/CSP/WebCrypto with only synthetic console startup/list data; it does not claim PostgreSQL, since the review must not query one. Remote results must be recorded on the actual final SHA; olderCI is not new-code validation.

## Acceptance status

Implementation/self-audit completed; independent second-agent review PENDING / NOT APPROVED. A request, separate directory, test runner or greenCI is not independent approval. The final reviewedSHA, actual reviewer identity, findings and verdict must be recorded if a real review executes; later fixes require re-review. Until then draft only, main unchanged, no user deployment. Prior unresolved n8n engine acceptance is not closed by this module.
