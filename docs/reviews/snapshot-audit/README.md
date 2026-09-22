# Snapshot source audit: implementation and review evidence

Remote base: `094f24d0a5cc35f95596d93a90084573c7521540`, tree
`a940081f25b4477592ac3e86729038715598cdfd`. The carry-forward of local
`0fab49a8975c2727017e10f136ed439085b52146` was independently reconstructed to its
exact tree `c71352eadf2483f238ce52bf3a0beb19d6446b0f` before implementation.
No missing historical tracked logs or gitlinks were silently discarded.

## Implemented module

The existing snapshot CLI and both public Node APIs now accept `audit` on exactly
one selected file or byte buffer. Optional memory_id chooses a single record, but
the entire snapshot must still pass the canonical verifier. Direct source lookup
uses only the authenticated, frozen inspected handle's in-file index. It reuses
the existing nine-field lineage reference and comparison semantics; no second
approximate source-proof contract is introduced. Nine mutually exclusive states
include missing, malformed and unsupported origins as explicit findings. No body,
quote, provenance or unchecked reference is reflected into the report.

References are not fetched outside the selected file. Every 32 records yields to
the event loop and rechecks authority. Reports are frozen; there is no cache, repair,
write, credential/Profile/SDK load, external model call or recursive ancestry check.
Successful execution with findings is not an all-clear verdict. graph_verified,
identity_verified and truth_verified remain false. Cross-project consistency is a
file-local observation, not a new online workspace grant.

## Implementer review and executed local tests

Node 22.16.0, ordinary uid 1000, Linux: **1995 tests passed, 0 failed/cancelled/
skipped, exit 0**, 33.743 seconds. Includes **65 new tests**, not additional to the
full total. One new property-style case runs 120 deterministic relationship changes.
Python 3.13.5: **683 tests passed**, seven nonoverlapping full-discovery batches;
the exact ID union was checked for completeness and uniqueness, no failures,
errors, expected failures, unexpected successes or skips. No timeout was raised.

TDD first run (before the operation existed): 50 tests, 11 negative controls pass,
39 fail, exit 1. This is missing-feature evidence, not 39 security defects. The first
implemented 50-test run passed. The CLI/race/packaging focused run passed 84 tests.
The original outputs and final full logs are retained in the delivery evidence.

Self-review checked immutable selection, full-file verification before single-ID
selection, typed reference projection, no quoted text reflection, canonical verdict
precedence, separate mismatch dimensions, unsupported document origins, absent
source semantics, bounded nonrecursive cycles, cancellation inside the audit loop,
actual guarded CLI execution, unchanged input bytes/mtime, and build import closure.
JavaScript syntax, Python AST, YAML, whitespace, original workflow step ordering,
old test coverage, permissions, timeouts and Windows/Linux matrix checks passed.

## Prior Windows race fixture correction

The old replacement test propagated an attack-side rename failure into the product
read, which could yield snapshot_file_unavailable rather than proving an observed
replacement. Replacement outcomes are now kept separate: a successful mutation
still MUST be rejected with its exact expected code and the descriptor closed.
Only Windows EPERM/EACCES/EBUSY on the rename itself may take the OS-blocked branch;
that branch MUST prove no completed mutation, the exact original file bytes, source
hash, returned body and closed descriptor. Parent move targets must remain absent.
No tests are skipped or globally weakened to accept arbitrary errors. This covers
an OS-refused attack separately from successful application-detected replacement.
Local execution is Linux only; Windows confirmation requires the new remote CI.

## Build/database and independent-review gates

Added actual built-package audit checks to the existing SDK-free acceptance.
Added a separate PostgreSQL/consolidator fixture after all existing task workflow
stages: six actual exported records, three injected synthetic generations, zero
external models; matched/changed/archived source results through actual installed
CLI, path API and byte API; six table fingerprints and input bytes/mtime unchanged
in the audit phase. Preparation explicitly performs synthetic writes.

Local Bun build/database execution is unavailable; these acceptance results must
come from the exact submitted commit's CI, never from older artifacts. Request a
separate reviewer on the full final SHA and affected boundaries. A self-review,
second directory, green test run or request is not independent approval. Final SHA,
actual remote jobs, reviewer identity/findings/verdict belong in the PR evidence
comment. **Independent review and remote acceptance are PENDING at this commit's
creation; keep main unchanged and PR draft until actual gate evidence exists.**
