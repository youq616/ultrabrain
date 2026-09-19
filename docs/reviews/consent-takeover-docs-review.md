# Independent documentation and evidence consistency review

Reviewer identity: `/root/audit_operations`.

Review date: 2026-09-19. Review workspace: `/workspace/scratch/97afa6ee0b0d/ultrabrain-acceptance`.

Verdict: **PASS for the reviewed documentation/evidence snapshot. No blocking documentation inconsistency remains.** This is a documentation consistency review, not a third independent application implementation review or another execution of the application integration suites.

The reviewed staged snapshot contains 30 changed paths, all under `README.md` or `docs/`. Its base is candidate `a9678135d28c6f3094db4e2d42f4077206fcd49b`, tree `e51dca2cfad06fc906d0de8104158bb716deca83`. The documentation is intended to follow main application merge `6aae8a01f0d5f27dedf64e0687af9cb3b02e29ea`. I did not edit repository files, staged content, application code or live services. Only this review report was created outside the repository.

The snapshot is identified by SHA-256 `0f86dfcd4cd83d12bf3f78b0575fcc87c58b3bffd753985afcad594f79de0a9b`. This is the hash of compact, sorted-key JSON mapping every staged changed path to the SHA-256 of its staged bytes. It is an inventory fingerprint, not a Git commit or Git tree hash. Approval covers these reviewed bytes; later content changes require their own check.

## Findings and resolution

1. **Claims agree with their execution evidence.** README, project status, personal V1 checklist, takeover plan and archive README consistently distinguish the final application candidate, PR-tested merge, main application merge and later documentation update. They accurately report two final independent PASS verdicts, 47 successful candidate jobs and 24 successful main jobs. Personal V1, first-run setup, existing Agent registration compatibility, user-host installation, complete client-engine acceptance and real-model quality remain explicitly incomplete.
2. **Initial failures are preserved.** The two initial BLOCK reports remain byte-identical to the original reviewer reports. The initial lease reproduction records one provider call after expiry; the final report records zero calls and `lease_lost`. The archive retains the initial 55-test client run with 21 failures, the five model-admission failures, three lease-correction regression failures, local 558/563 baseline with five failures, and the unrelated initial test-loader/environment failures without relabeling them as product bugs or passes. Both cancelled initial Validate runs retain the earlier candidate SHA and cancelled conclusion.
3. **Publication omission risk resolved.** Eight referenced `.log` files were initially ignored by `.gitignore`. The author explicitly staged the archive files. Final verification confirms that all 21 `files.json` entries, all manifests, all linked archive files and the ZIP are present in the Git index with the exact reviewed bytes. No referenced evidence is left only in ignored working files.
4. **Raw-log whitespace is retained deliberately.** A whole-index `git diff --cached --check` reports trailing whitespace on blank lines emitted by Node in five original failure logs/TAP files. I did not treat this as a content defect or alter the evidence. The focused whitespace check for the five newly authored Markdown documents passes. The report does not claim that the unrestricted whitespace command passed.

## Independently verified evidence

I read `AGENTS.md`, all changed human-readable documentation, both final application reviewer reports and both initial BLOCK reports. I inspected the original local reports/probes/logs and the archived copies. The takeover plan's final amendment correctly marks phase 1 complete and phases 2–4 pending, with an actual acceptance-archive link.

Using the authenticated GitHub plugin, I independently fetched PR #14 metadata and confirmed `merged: true`, final head `a9678135d28c6f3094db4e2d42f4077206fcd49b` and merge `6aae8a01f0d5f27dedf64e0687af9cb3b02e29ea`. Raw Git commit metadata for that main merge and PR-tested merge `ba4447768858b797793f0f01f7c619e98ef95cb6` reports the same tree, `e51dca2cfad06fc906d0de8104158bb716deca83`, and parents `77b4ecf649124fc169e4c838b5202d96211e933e` and the final candidate.

I independently fetched every candidate workflow's job inventory: 13 runs, 47 jobs, all completed successfully; 23 pull-request jobs and 24 push jobs. I then fetched every main workflow's job inventory: seven runs, 24 jobs, all completed successfully. Every recorded job ID, name, run ID, status and conclusion in `evidence.json` matches the independently fetched inventory. Candidate and main execution identities are separate. The two initial Validate runs, `35420809845` and `35420808156`, were independently confirmed as cancelled on `de5ca16c04d6102da6fd92370d03ff6bf939c58b`.

Executed local archive checks:

- All 30 staged changed paths are documentation/evidence paths; staged and working bytes match, and there are no unstaged tracked changes.
- All 21 `files.json` entries match their recorded SHA-256 and byte counts in the index.
- The ZIP contains exactly the eight manifest-listed CI logs; every extracted log matches its recorded SHA-256/size and the original local downloaded log byte-for-byte.
- The four copied initial/final application review reports match their originals byte-for-byte. Additional comparisons checked the independent probes, lease reproductions and final test logs against their original files.
- Every relative link in the five authored Markdown documents resolves to a file available through the Git index.
- Final local logs substantiate 188 client-review tests, 142 server-review tests and 142 implementation-focused tests, with zero failures or skips.
- Candidate raw CI logs substantiate 612 Node tests, 542 Python tests, 11 PostgreSQL provider-admission checks, seven native provider wire checks, 22 packaged capture checks, 13 packaged document checks, 25 Chromium checks and 27 n8n adapter checks with actual n8n CLI execution. The 15 upgrade paths are present as separately successful native-integration jobs.
- Main raw logs explicitly identify `6aae8a01f0d5f27dedf64e0687af9cb3b02e29ea` and repeat 612 Node / 542 Python, 25 Chromium checks and 27 n8n adapter checks with actual n8n CLI. Both candidate and main service evidence records 18 services, 15 deployment, 12 readiness and 18 activation checks.

The original application reviewers' local fixture tests, actual CI PostgreSQL/MCP/systemd/Chromium/n8n execution, synthetic provider responses and user-host/real-model acceptance are appropriately distinguished. Conditional CI diagnostic/cache steps may be skipped; the zero-skip statement is correctly attached to the Node/Python test totals.

## Reviewed file fingerprints

| Path | SHA-256 |
| --- | --- |
| `README.md` | `9cb9708ead196997b66f11f901b6ccece5229934700e7d601e500bb4ba784406` |
| `docs/PROJECT-STATUS.md` | `d8b4b6e14cc9c89c7b774a719bc359a9c64fd92b73acaf2dea4f0f9d1423f08a` |
| `docs/PERSONAL-V1-CHECKLIST.md` | `2c2c74e9b56732211a056450bcf855b45b52f82c48dc5fcd49df4ebf872a9f8e` |
| `docs/TAKEOVER-2026-09-19.md` | `364a4abc81c01a26600b4124c6f7dfe99499e46d30b9bddd403696050e3609bf` |
| `docs/reviews/consent-takeover/README.md` | `f5c1f729457bd2ea47b51b50c04e4c5140834d66a391c0c6b0945d6c6ad0d75a` |
| `docs/reviews/consent-takeover/evidence.json` | `03c3fd7b4464643dbd17cf6595efd1e91ab0ea10f6afd4b48d0d41e4459dd252` |
| `docs/reviews/consent-takeover/ci-logs.zip` | `f6b2d9b4d87a05dc3536277a0be317e7f3aac15f1d70208964077ac3e3574a94` |

No application tests, real databases, user managers, browser engines or models were run in this documentation review. The application results above are independently inspected execution evidence, not tests newly executed by this reviewer. This review does not authorize service changes or certify the unfinished personal V1 milestones.
