# Personal services: receiver self-review and publication

This is a separate implementation-assistant self-review, not an independent reviewer approval. The full final commit, separate Codex outcome and actually completed CI gates must be recorded in PR #7 before merge. This document is an execution record, not permission to merge any later code.

## Resumed source and fresh execution

The source archive for 5cad51b0c8eafd1b9628bb04181736fa12b236e4 was verified against its Git tree 3a1d19fda8d4aafa42d4252b99eddf720a4dca46, including all four unchanged gitlinks. The previously saved follow-up patch reproduced tree 27a4277072032ddb91e292770114d563fa9fd3bc exactly. It was then published as 60a8a6d04033c402bd438a67fdcf7b71819ed79b, not substituted for a newly invented implementation. The FOLLOWUP.md/.json reports are historical records of that earlier offline checkpoint; their then-local publication status is not a statement about the current PR.

Fresh ordinary-user Linux runs of that checkpoint passed 491 Node tests (no failures or skips) and 210 Python tests. No live systemd user manager was available locally, and none was started. The current CI must perform the actual user-service lifecycle, not merely parse unit text.

## Additional adversarial finding and repair

During review, two additional regression cases failed against the recovered checkpoint: while reading a later unit, another operation could overwrite the already-checked first unit in place, or widen that first unit's permissions. The directory's timestamps do not change for these file-only operations, so the original end-of-directory check incorrectly accepted them.

verify_contents now retains each successfully read file's device/inode, type/mode, owner/group, link count, size, mtime and ctime, and rechecks every observed path after all reads. The two previously failing tests now pass. The same validator is used before export completion and for explicit verification. This detects changes observable at the recheck; it does not claim a globally atomic filesystem snapshot or prevent changes after return.

Final local execution after this repair: 491 Node tests passed with zero failures/skips; 212 Python tests passed. The service-specific Python tests are included in that total, not additional tests. No migration, upstream pin, install-service.py behavior, personal console, consolidation worker, production permission or model configuration was changed. All data and file operations in these tests were synthetic and confined to temporary test directories.

## Scope and independent review

Reviewed the original planner plus the resumed export guardrails and lifecycle harness: double opt-in worker scope, no default model calls, literal systemd arguments, source/home binding, no automatic dotenv, exclusive output, known load-path refusal and alias resolution, bounded file verification, no false success on cleanup failure, and ownership checks before unlinking fixture unit links. The alternate development/personal-services installer branch is intentionally untouched; do not merge overlapping implementations.

The earlier Codex missing-unit comment is addressed by a helper requiring full named state plus status 0/5, not by accepting arbitrary nonzero commands. Upstream systemd v255 show-properties itself can return 0 for a missing unit (src/systemctl/systemctl-show.c, show_one); therefore the old review text alone is not proof that a specific runner failed. Bus errors, empty or conflicting properties remain failures. Actual current-CI behavior remains a separate gate.

Remaining limits: no automatic install/enable/cutover, no live-user deployment or reboot certification, no filesystem sandbox, no guarantee of cancelling already-submitted provider work, and no visibility into all independently configured manager-only unit paths. No generated units, credentials, private configurations or raw service journals are uploaded as evidence.

## Fresh receiver log fingerprints

Raw local test logs stay outside the repository; these hashes identify the freshly executed runs, separately from the historical checkpoint hashes.

```json
{
  "node-initial.log": "6f534a7e4322003f040ffbeece67d8b7797e14aa384a9cef08b299a4f3425c9c",
  "python-initial.log": "5d2d84ba6f83c24411fcffd27673582e4ce72c8e3be1ee907a6c1668bab1c492",
  "self-review-before.log": "75e10f820bd7f2e3ae80e92306ab73be57644e851106ff04d49a48abefa0a6c4",
  "self-review-after.log": "533c82f1a4e4d88eafb4c6e658ee3fb2422691006565603c5287a278f9cb7ffc",
  "node-final.log": "25111372fe9258676a8dad3bcc500dcbf9be18882328375db578247611eb5d3f",
  "python-final.log": "eedda613a7af76d581e481fbee8d8675c9bebf09cb162b5a61f585ac1c86a881"
}
```
