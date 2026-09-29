# Dual-descriptor local-file confirmation — 2026-09-30

Base: actual PR46 head b81dd4c334fd4d0b77682eb374703d74a987fa53, tree ca68cc42efbc2e2aaa0bd9bb9899ebd275cda61c. The source artifact11041378113 was restored and verified:995 blobs, executable modes and4 unchanged gitlinks. Local reconstructed commit ancestry is not remote history; publish only against the real remote parent. Do not import the earlier parallel local ceb11205 queue-control design.

## Implemented boundary

Retain the existing BigInt full-width metadata reader and arithmetic compatibility helper unchanged. When Win32 path and handle devices are valid, nonzero but not arithmetically comparable, open a second read-only descriptor by the selected path and hold it throughout the bounded read. Require exact device and all other metadata equality between descriptors, exact path/path equality in its own domain, initial and final path observations plus a path-anchor sample. Reject unrecognized pairs elsewhere, changed metadata, alias/type violations and all native failures. Close both handles once each, preserving the first failure. No create/truncate/unlink/chmod, lock stealing, permission retry, journal format, network or server changes.

The preceding native Windows22.16 report classified both devices as unsigned32 with unmatched representations, equal inode and other metadata; it failed before reading. Its raw ZIP/hash and entry provenance are recorded here. No raw identifiers were present. Synthetic701/909 and101/303 test values are not those machine's identifiers. This proves the old mapping did not qualify that observation, not that every Windows failure has this cause.

This remains a bounded observation in a trusted directory, not a hostile same-user sandbox, NTFS ACL/volume attestation, atomic filesystem snapshot or power-loss guarantee. Unobserved replacement/restoration and metadata/file-ID reuse remain limitations. The arithmetic helper still rejects unmatched pairs: the additional confirmation requires actual same-domain handles, not a blanket dev comparison exception.

## Separate implementation-assistant review and retained failures

Two new same-file/consumer regressions on the unchanged baseline failed0/2; both passed after adding the anchor. Existing67 reader tests remained intact. Added48 implementation cases include full-width second-handle/path comparisons before and after reads, invalid and zero devices, non-Windows refusal, bounded errors, close ordering and real profile/queue consumers.

A separate audit adds15 cases: real pathname replacement, a different opened inode with identical text, late replacement, real truncation, changed primary device, alias rules, read-only effects, opaque errors, repeated-handle cleanup, native probe semantics and pipeline wiring. Initial audit11 had9pass/2fail due solely to fixture preparation: the injected truncation used an extra counted open/close, and mocking process.platform changed os.tmpdir selection. Use separate original handles for the deliberate write injection and explicitly set the child scratch TEMP/TMP; retain the two-close and data-refusal assertions. Corrected11/11 passed.

The further audit exposed a genuine diagnostic propagation gap: the existing subprocess report stripped nested local-file diagnostics. Its15-case run had12pass/3fail. The allowlisted worker projection now preserves bounded file_read kind/phase/reason/errno/close_failed while dropping arbitrary paths, IDs, messages and unknown shapes. It also recognizes safe EBADF close diagnostics. Serialization remains a report, not authenticated local error or server evidence. Original TAP from all three red runs is preserved in the handoff with recorded SHA256; the baseline red run is also committed as deterministic gzip, and exact audit failure summaries are committed here. This is an implementation assistant's audit, not a second-agent approval. No remaining blocking implementation finding identified; no zero-defect claim.

## Actually executed locally

Ordinary Linux UID1000, Node22.16.0: final full3889/3889, no failures/skips/cancellations;63 added tests included. The prior3885 run predates four final diagnostic regressions. Focused reader/anchor/control210/210 passed. Exact-baseline patch replay is recorded separately after it executes.

Native Linux probe201 successful reads plus outbox alias rejection passed. Unmodified enqueue checker25 rounds x8 independent processes passed:600 calls,425 records,175 idempotent replays across25 distinct temporary queues. Control checker25 rounds x8 passed again after diagnostic projection repair:8 unchanged records/round,1 resume winner/7 stale conflicts, attempts0. These are not200 simultaneously running workers or a single425-entry queue. No real server/model/DB invocation or user queues involved.

Bun1.3.13 build and npm pack succeeded; final tgz SHA25633aa44ab561260844b0d09f021647ba9593e1366f9afbe5e1825456a2628ce66. Fresh independent unpack checked11 bundle digests and ran29 actual compiled-CLI cases: original21 native/unsigned/signed cases unchanged,7 independent-device queue cases and1 mismatched-anchor rejection. Official SDK imported with no server startup; the Win32 stat seams are synthetic, not native Windows execution. The final README-only repack left all11 compiled bundles identical and all29 tests were rerun on the exact final tgz.

Build/runtime dependency bytes came from previously verified archive9c2db948f54f99c04ca7e0f624751a4c23ce130b8ddadf5fba319f9010f8f7b8; local npm pack, extraction and pinned SDK linkage are not a fresh registry installation. No dependency links/bytes are committed. No new PostgreSQL/MCP, full Python, native Windows or user deployment claimed locally. CI must execute the new head before native qualification is reported.

## Release gate

Final-SHA independent second-agent review PENDING at source finalization. Request an actual review after publication and record only the supplied identity/findings/tests/verdict; no self-review or old-head feedback substitutes. Keep draft, main/other branches unchanged. Prior Windows lock-create EPERM and other failed workflows are not automatically fixed by this reader; never weaken their tests to obtain green results. Original queue/pause/journal APIs, n8n, qbrain, server tools/migrations, upstream locks and the protected console work remain unchanged.
