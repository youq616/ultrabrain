# Complete personal-document module: final independent-review corrections

Baseline: `98451ebeba7b279c2ed95202c22b6608b5156b21`, tree `2a7ab81baebf651cca99919ddf79fa860342740a`. The prior local-only read patch is already upstream via `2ed1e2a`; it was not reapplied. The exact tracked candidate archive from Actions artifact 10604609717 was extracted into a new disposable worktree. Restoring the four existing gitlinks produced the exact baseline tree before editing. No user worktree or service was changed.

Independent Codex review 5260544188 contained two P2 findings: 4056915947 requires canonical document timestamps; 4056915948 requires checking the retained fragment linkage, not just document/memory/job counts. The old candidate's eight green workflows did not waive these findings. Both findings must receive corrected-commit review before acceptance.

## Fixes and reproduction

`verifyDocumentMetadata` now requires the actual JSON Date UTC shape with three fractional digits, plus parse/ISO-format round trip. Abbreviated timestamps, normalized impossible dates, alternative offsets and overflowed times fail before any list card/export action is exposed. The same validator protects selected reads. Existing valid test timestamps were changed to the actual server spelling, without weakening assertions. The new 21-case targeted test first produced 5 passes/16 failures on the unchanged application; it now passes. The first failure is retained in this directory.

The final real database counts now include `personal_document_fragments`. An acceptance-only helper uses source/actor-bound LEFT JOINs to retain missing link targets as null, then checks exactly one linked archived document, retained archived fragment memory and stale zero-attempt job. It also checks byte range, UTF-8 unit, original BOM/text and SHA-256 against the known synthetic input, not against another unverified response. Twenty-seven mutation tests show the oracle refuses missing/duplicate fragments, absent/misdirected links, changed state, range, content and hashes. These are oracle unit tests, not a PostgreSQL run.

The real whole-module browser test retains import -> list/filter/paging -> verified preview/download -> queue -> archive -> retained download, and adds three hostile timestamp response cases. Existing original console, memory/document read/receipt, Windows, n8n and historical-upgrade tests remain.

## Actual local execution

Ordinary account `oai`, Node22.16.0: 1,144/1,144 tests, zero failures/cancellations/skips; Python3.13.5: 683/683, exit 0 (18.118 seconds). Timestamp/read combination 143/143 and linkage oracle 27/27 are subsets, not additive totals. The 48 added Node tests are 21 timestamp plus 27 oracle cases. Syntax, browser Python AST and incremental whitespace checks pass.

The first whole-Node attempt ran as root and failed five offline preflight/service checks. Those checks deliberately reject root; no code or assertion was loosened. The ordinary-account complete rerun passed. One outer-time-limited Python attempt was interrupted and is not a pass; a bounded supervised rerun completed with a recorded exit code. All original logs are kept in the final evidence artifact with SHA-256 identifiers.

## Final gate and scope

At commit creation, new complete CI and independent corrected-SHA review are PENDING. Final status belongs in PR #20 with exact commit/workflow/reviewer evidence, not inferred from this document. No internal reviewer session or tests will be invented if the reviewer does not expose them. The module covers explicitly chosen UTF-8 TXT/MD/JSON/CSV/LOG files up to 128 KiB. PDF/OCR, folder monitoring, automatic model calls, physical erasure, production deployment and full personal-V1 release are not part of this module acceptance. Main stays unchanged.
