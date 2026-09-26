# Duplicate-review panel — implementer review, 2026-09-26

Status: local implementation and executed local validation complete; NOT PUSHED, no final-SHA remote CI, independent second-agent review NOT EXECUTED / NOT APPROVED. The reviewer in this document is the implementation assistant conducting a separate pass, not another agent. No reviewer-session identifier is invented.

## Provenance and scope

Restored source tree `da01ec0cf5b41613bf400f47d88bb83c0d344083` from the preceding unpushed duplicate-audit candidate `52ae2b2d7d61f98291ddddaba333d7cbcf2fe8ed`. All archived source modes and the four upstream gitlinks were reproduced before editing. Local Git ancestry starts from a reconstruction, not that original commit object or the original remote history. The last confirmed remote application baseline remains `8d373b38195f0134a2374cd3996811568d5621e9`, source tree `41259f0550ce6bb401de965147d1e441bdf90fd6`.

This phase adds the browser review workspace and moves the already implemented exact-text duplicate algorithm into the browser/Node shared contract. The original Node module re-exports that implementation. No new matching heuristic, destructive action, snapshot limit, SQL, migration, MCP catalog or model capability is introduced. Preserve the still-unreviewed predecessor rather than calling it accepted.

## Separate code and UI review

`src/personal-snapshot-contract.mjs:214-263` and `src/snapshot-duplicates.mjs`: the Node and browser APIs expose exactly the same function and field constant. Canonical inspected-file validation occurs before fields are accessed; data-URL module loading has no Node dependencies. Exact strings, not hash equality, determine membership. Cancellation checkpoints/yields still cover scan and large-group projection. The former public wrapper and JSON report remain compatible. Existing 56 duplicate tests and the new shared/parity tests pass.

`web/personal/snapshot-duplicates-ui.js:12-39,49-70,99-115,125-153`: defaults do not scan or reveal text; the second consent gates per-record disclosure; original records are emitted as textContent only. Every action binds the exact inspected file and page generation. Removed controls from old pages cannot reveal old data or erase a newer result. Revocation during scan/cleanup, changes to either input file, navigation, busy/pending and parent reset reject the entire report rather than returning partial or zero counts. Independent drafts and comparison state are not modified.

`web/personal/snapshot-inspector-ui.js:5-7,16-36`: a separate optional consumer hook avoids replacing the existing explorer's reset hook. Both are synchronously reset on file/parent lifecycle changes. Original standalone inspector/explorer tests continue to load without the new consumer. `src/personal-console.mjs:22` adds only a fixed static asset; authentication, exact Host/Origin, no-store and CSP policy are unchanged.

A real-browser usability review found that stacking 20 full group cards ahead of 20 member cards required excessive scrolling. The final layout instead uses two bounded scroll regions, single-column on narrow screens, and translated state/field labels. This is a usability correction, not a security vulnerability. The 390-pixel layout and actual text rendering were rechecked in Chromium.

No remaining blocking code issue was identified in this self-review. This is not proof of zero defects and is not the repository's mandatory independent-agent approval. Full reference equivalence, authenticity, ownership and automatic safe merging remain deliberately unasserted.

## Actual execution

Final application/source state: 2559/2559 Node tests pass as ordinary Linux uid1000, zero failures/skips/cancellations; 59 new tests are included (42 UI, 5 shared/HTTP, 12 review probes). A prior complete run before the last 17 tests passed 2542/2542; these are separate overlapping runs, not additive counts.

Real Chromium144.0.7559.96 ran 14 checks using the complete production HTML/CSS and all seven scripts. A separate Python exact-string grouping oracle checked rendered group/member IDs and counts. Mode is explicitly offline: synthetic login and a Python SHA-256 bridge because the opaque page lacks WebCrypto.subtle. Zero data requests/downloads/model calls during review. Actual online console HTTP/CSP navigation was attempted and blocked by `net::ERR_BLOCKED_BY_ADMINISTRATOR`; that failure is preserved and not bypassed or called passed. The separate actual Node HTTP static-resource test passes with a synthetic DB adapter. No real PostgreSQL or user deployment was executed in this phase.

Bun1.3.13 build and npm pack succeeded. The real packaged offline CLI/path/byte entry tests passed40 checks under the existing descriptor/sticky-denial guard, copied without SDK; source file bytes and mtime were unchanged. These are pre-existing regression checks, not40 new features. The packaged client is not a web deployment bundle. Python browser scripts compile and changed workflow YAML parses; full Python suites, real Windows and the new remote workflows were not executed locally.

## First failures and preparation issues retained

- Initial TDD42 tests failed because the new UI file did not exist; this is an expected red baseline, not42 defects.
- The initial fake adapter for static-route testing omitted its required kind/transaction declarations. Two4-pass/1-fail results are retained; the fixture was corrected without weakening production constructor checks. The final5/5 tests pass.
- The first full-suite invocation was stopped by the tool's45-second timeout; it has no completed verdict. The complete rerun and final2559-pass run are separately recorded.
- The first packaged test failed with EACCES because root unpacked owner-only package files. Ownership was assigned to the ordinary test user only inside the newly created isolated install directory, then all40 checks passed. Production file permissions and tests were not relaxed.
- The online browser navigation policy failure remains outstanding. The successful offline mode is different evidence, not a relabelled retry of the blocked network path.

Full logs remain in the delivery evidence directory; `local-evidence.json` records their hashes, code hashes and results. Cumulative-patch replay against the exact remote baseline is recorded in the final handoff report, not assumed by this document.

## Publication gate

The current GitHub tool exposes reads, no create/write action was found, and an actual command-line Git access attempt failed DNS resolution. No remote branch, PR, main or user service has been modified. Plugin discovery did not expose an installed independent reviewer execution path. Continue to keep all local work unapproved until it is published through an available authorized path, final-SHA CI is executed, and a genuine separate reviewer records identity, full SHA, file/line findings, evidence and verdict. A local worktree, test process, screenshot or this self-review is not that reviewer.
