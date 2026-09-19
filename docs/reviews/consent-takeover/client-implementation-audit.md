# Client audit and consent implementation evidence

- Audited main: `77b4ecf649124fc169e4c838b5202d96211e933e`.
- Session: `/root/audit_clients` (delegated by `/root`).
- Repository: `/workspace/scratch/97afa6ee0b0d/ultrabrain`.
- Read `AGENTS.md` and inspected client kit, capture outbox and last-mile delivery, task recall, automatic capture, native adapters, profile reader and relevant tests/docs.
- No user services, credentials, other projects, migrations or upstream locks were changed.
- This session implemented the client consent fixes. It is NOT an independent approval of those fixes. A separate reviewer must approve the integrated full commit.

## Verified findings

### P1: false authorization still persisted or transmitted private content

On the audited commit `src/capture-delivery.mjs:20–33` and `src/client-document.mjs:52–81` called `authorize()` but never rejected the explicit result `false`. The newer task helper explicitly rejects false (`src/client-task-context.mjs:45`), so the same caller authorization convention silently differed among public runtime methods. `packages/ultrabrain-client/src/runtime.mjs:55–57` exposes and passes custom authorizers to all three helpers. Existing built-in CLI callbacks generally throw on revocation, so the demonstrated route is an SDK caller supplying a boolean authorizer; it is not evidence that the unchanged CLI previously ignored thrown revocation.

`src/capture-outbox.mjs:127,187,189` also ignored false and Promise return values. A false result still wrote the raw transcript to an entry. An `async () => false` callback still sent the queued transcript and removed it on a receipt. An async thrown denial produced an unhandled rejection in addition to the mistaken progress.

`repro-before.mjs` and `repro-before.log` preserve the executed original behavior: capture called agent register and personal capture, document import called agent list/register/import, denied enqueue stored one event, and async-denied flush submitted once with `delivered:1`.

Implemented fixes: explicit false becomes `capture_disabled`; unsupported asynchronous callbacks fail synchronously with `invalid_params` and their rejected Promise is consumed. Void-returning assertion callbacks and thrown errors remain supported. Capture now checks authorization before its first identity request. The queue checks before initial persistence/attempts, after awaited locks/connections and at the actual capture helper's last-mile authorization. A matching receipt received after already-authorized transmission still removes the accepted event; later revocation cannot retract a sent request.

### P2 / next functional increment: captures from an existing non-default agent fail

`src/capture-delivery.mjs:31` on audited main unconditionally registered `{agent_id, agent_type:'custom'}` before capture. A previously registered `coding_agent` with capabilities/workspace has a different registration hash. `src/personal-memory-store.mjs:70–84` correctly protects the existing revision and returns `revision_conflict` because the helper supplies the default expected revision 0. The queued route marks that error blocked (`src/capture-outbox.mjs:16,197`). This preserves metadata but prevents that otherwise-authorized agent from saving conversation observations.

`repro-agent-registration.mjs` and its log execute the actual `PersonalMemoryStore.register` plus `deliverCapture` using a clearly synthetic SQL engine. The observed outcome is `revision_conflict`, 0 capture calls and unchanged existing metadata. This is not real PostgreSQL evidence. A follow-up should reuse the document helper's bounded, owned-agent lookup or otherwise avoid re-registering an existing label, then verify through real PostgreSQL/MCP. Parent explicitly kept this separate from the revocation fix.

The first run of this secondary reproduction stopped before registration with `unsupported_engine: Native PostgreSQL required` because its synthetic engine omitted `kind:'postgres'`; that fixture omission was corrected before the successful reproduction. The failure was printed in the tool output; it was not a product regression or a real database attempt.

## Usability gaps and boundaries

- Automatic capture attempts only its just-enqueued event (`src/automatic-capture.mjs:82–85`). Older failures require explicit `queue-flush`. `docs/AUTOMATIC-CAPTURE.md` discloses this, so it is a feature gap, not a concealed reliability guarantee. A useful future increment is a visible, explicit retry operation showing pending/blocked status while preserving event IDs, consent checks and destination binding.
- Native `contextReader` intentionally freezes profiles for the plugin lifetime, requires reload for changes, and has a corresponding test and documentation. I did not reclassify that advertised contract as a newly found profile-revocation bug.
- Raw MCP task-query permissions are deliberately separate from the newer task-context opt-in, documented in `docs/TASK-CONTEXT.md`; this audit did not claim the opt-in is a global MCP authorization policy.
- Client context envelopes validate source, project, active status, hashes, ownership/visibility and byte budget. Automatic observations exclude attachment/tool/transcript-file inputs, use stable host identifiers, preserve assistant output as unverified observations, and are bound to the original profile and outside-workspace queue.

## Executed tests

1. Baseline: 135/135 Node tests passed in the nine relevant test files, log `baseline-135.log`.
2. First regression run on old source: 55 targeted tests, 34 passed and 21 failed, log `regressions-before.log`. The log also preserves async authorization unhandled-rejection evidence.
3. After source fixes: 159/159 tests passed in the same nine files, log `regressions-after.log`.
4. `node --check test/capture-integration.mjs`, `node --check test/document-client-integration.mjs` and `git diff --check` passed.

The nine test files were `test/client-kit.test.mjs`, `test/client-task-context.test.mjs`, `test/capture-outbox.test.mjs`, `test/capture-delivery.test.mjs`, `test/automatic-capture.test.mjs`, `test/capture-hardening.test.mjs`, `test/capture-profile-binding.test.mjs`, `test/native-adapters.test.mjs` and `test/client-document-boundaries.test.mjs`.

Added real-integration assertions in `test/capture-integration.mjs` and `test/document-client-integration.mjs` are syntax checked and handed to the parent for isolated PostgreSQL/MCP execution. This session does not claim those integrations passed. The existing capture post-registration revocation assertion was moved to the third authorization check to preserve its intended post-registration position after the new pre-network check.

Owned modifications: `src/capture-delivery.mjs`, `src/capture-outbox.mjs`, `src/client-document.mjs`, `test/capture-delivery.test.mjs`, `test/capture-hardening.test.mjs`, `test/capture-outbox.test.mjs`, `test/client-document-boundaries.test.mjs`, `test/capture-integration.mjs`, `test/document-client-integration.mjs`. No commits made by this session.
