# Independent acceptance review — server and console consent

Reviewer identity: `/root/review_consent_server` (separate review agent; no application changes).

Base: `77b4ecf649124fc169e4c838b5202d96211e933e`.
Initial local candidate: `a327511d44e034e62e1802c42248354cb46e92fa`.
Initial candidate tree: `9cc8ce0fea900e468e35d598b054ff5b6e8c9ad1`.
Published candidate: `de5ca16c04d6102da6fd92370d03ff6bf939c58b` (root reports identical tree; reviewer independently fetched its GitHub commit diff and metadata).

## Initial verdict: BLOCK

P1: `src/personal-consolidation.mjs:49–69` samples `lease_until > clock_timestamp()` before the newly awaited `this.configure()` at line 59. If the lease expires during this await while the request signal remains live, `current.generate()` is still called and the result can commit. The two-minute maximum model timeout does not prove a three-minute lease is live: the lease begins during the claim transaction, while response delivery and the pre-timer configuration read can consume its lifetime before the model timeout begins. The earlier source SQL await already makes the sampled predicate age; the added configuration await extends that unguarded interval in the admission boundary being changed.

Independent reproduction: ran `node /workspace/scratch/97afa6ee0b0d/evidence/server-review-lease-repro.mjs` against the initial candidate. It models an already-aging lease with 20 ms remaining at admission and a 50 ms final configuration delay, using synthetic SQL and a stub provider. Actual output:

```json
{"fixture":"synthetic SQL, shortened already-aging lease, stub provider","providerCalls":1,"invokedAfterExpiry":true,"resultState":"completed","model_requests_attempted":1}
```

This is a deterministic boundary reproduction, not a real PostgreSQL run or real provider request. Require a fresh lease/live SQL check after final awaited configuration, keep a live cancellation check and the synchronous adapter profile recheck before the gateway call, and rerun/review the corrected exact commit. Preserve this first-failure evidence.

## Inspected boundaries

- Entire application/test/documentation diff against base, with deeper review of `PersonalConsolidator` claim/admit/commit fencing, source ownership, profile hashes, per-call opt-in, cancellation, timeout and unknown commit behavior.
- `src/adapters/personal-model.mjs:5–21`: pinned upstream config module is loaded once per call; profile is reread synchronously at invocation; aborted signals stop gateway entry. Independently fetched pinned GBrain `src/core/config.ts` and `src/core/ai/gateway.ts` at `a6be012a3bcfac42e279630aedec5cda4a450e29` through GitHub. `loadConfig()` (upstream lines 743–860) uses `readFileSync` on every call. `isAvailable()` is synchronous. `chat()` later awaits provider resolution and passes the caller abort signal into the SDK; the documented gateway-admission boundary is not a guarantee that remote processing can be recalled.
- `web/personal/app.js:24–46,203–217`: authorization binds session, source, form content/project/visibility/metadata and edit identity/revision; authorization is checked after registration and before retry. Unknown delivery retains the original event and input after a later consent refusal. Form changes do not mutate the saved input.
- `src/capture-delivery.mjs`, `src/capture-outbox.mjs`, `src/client-document.mjs`: false and Promise-returning authorization callbacks fail closed; callbacks are rechecked after waits; valid acknowledgement can still clean a previously transmitted journal entry after subsequent revocation. Identity/destination/project pins and original bytes are retained.
- `test/personal-dispatch-integration.mjs:39–69`: lock holder uses the same owner advisory lock, waits until it is acquired, and the worker signals at the second owner-lock request before configuration is changed. The fixture tests real PostgreSQL admission ordering when run by CI, while provider output remains synthetic.
- `test/personal-console-browser.py:44–71,130–162`: intercepts registration after the real response and changes consent/content before releasing it; lost acknowledgement fixture aborts only after the real server has committed. These are useful real-browser/API checks once executed; they do not demonstrate model quality.

## Executed evidence on initial candidate

- Node `v24.19.0`.
- `node --test test/personal-consolidation-admission.test.mjs test/personal-consolidation.test.mjs test/personal-console-consent.test.mjs test/personal-console.test.mjs test/capture-delivery.test.mjs test/capture-hardening.test.mjs test/capture-outbox.test.mjs test/client-document-boundaries.test.mjs`: **139 passed, 0 failed, 0 skipped**.
- `git diff --check 77b4ecf649124fc169e4c838b5202d96211e933e a327511d44e034e62e1802c42248354cb46e92fa`: passed.
- Python AST parse of `test/personal-console-browser.py`: passed.
- External lease reproduction above: reproduced the blocking issue.

Local Bun and PostgreSQL executables are unavailable. No real PostgreSQL, Chromium, packaged-client engine, deployment or real-model quality test was executed by this reviewer. CI was pending at initial review. Passing fixture/unit tests are not acceptance of the identified lease race.

## Corrected-commit review

Pending correction and exact final commit.
