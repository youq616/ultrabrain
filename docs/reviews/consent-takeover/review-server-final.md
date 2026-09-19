# Independent corrected-candidate review — server and console consent

Reviewer identity: `/root/review_consent_server` (separate review agent; no application changes).

Reviewed final published commit: **`a9678135d28c6f3094db4e2d42f4077206fcd49b`**.
Reviewed tree: `e51dca2cfad06fc906d0de8104158bb716deca83`.
Base: `77b4ecf649124fc169e4c838b5202d96211e933e`.
Equivalent local tested commit: `443d0b1e23c56a839513b0246e8eb386f77666da`.

## Verdict: PASS for independent code review of the exact final candidate

The initial lease-admission blocker is resolved. No additional blocking issue was found in the reviewed application, test and documentation diff and affected server/client/browser boundaries. This verdict does not assert that pending integration CI, a user deployment, real client engines or real-model quality have passed. Required CI must succeed on this exact candidate before merge.

The initial BLOCK review and reproduction remain unchanged in `review-server.md` and `server-review-lease-repro.mjs`. They cover the earlier local `a327511d44e034e62e1802c42248354cb46e92fa` / published `de5ca16c04d6102da6fd92370d03ff6bf939c58b` tree and are not approval of that earlier candidate.

## Identity and equivalence checks

- Independently fetched the final GitHub commit metadata/diff at `a9678135d28c6f3094db4e2d42f4077206fcd49b`.
- Independently fetched every one of the 21 changed file blobs from that exact remote commit; all 21 blob SHAs matched local tested commit `443d0b1e23c56a839513b0246e8eb386f77666da`.
- After the published object became available locally, `git rev-parse a9678135d28c6f3094db4e2d42f4077206fcd49b^{tree}` returned `e51dca2cfad06fc906d0de8104158bb716deca83` and `git diff --exit-code a9678135d28c6f3094db4e2d42f4077206fcd49b 443d0b1e23c56a839513b0246e8eb386f77666da` exited 0. The tested and accepted trees are identical.

## Findings and inspected boundaries

**Resolved P1 — fresh lease admission:** `src/personal-consolidation.mjs:59–78` now obtains the fresh model binding after the owner/source queries, rereads job state, lease ID and PostgreSQL `clock_timestamp()` after that awaited configuration, then checks the request signal and principal before invoking the provider. The held owner/job/source locks continue to fence cancel/archive/edit. A stale lease takes the existing `lease_lost` path without generating or committing output; explicit recovery semantics remain intact. This closes the independently reproduced final-configuration expiry window.

**Profile revocation at the final SQL boundary:** `src/adapters/personal-model.mjs:11–21` retains the synchronous actual-config reread and profile hash comparison immediately before gateway entry. Thus a change during the new final SQL await is caught by the default provider closure. Cancellation is checked after the final SQL and inside the native closure. Trusted host-injected generators are documented as responsible for the same synchronous invocation boundary; they are not request-controlled generators.

**Browser revocation and immutable unknown delivery:** `web/personal/app.js:24–46,203–217` binds authorization to the session/source, all selected memory fields and edited ID/revision. Registration waits cannot transmit stale text after consent withdrawal or form changes. A failed retry after a previous unknown delivery preserves the original event, input and unconfirmed status; restoring matching content/consent replays the original request. No replacement event or altered payload is silently created. The browser journal remains explicitly an in-memory recovery aid, not a durable client outbox.

**Client interactions:** `src/capture-delivery.mjs`, `src/client-document.mjs` and `src/capture-outbox.mjs` reject false/Promise authorization and recheck after lock, connection and identity waits. Existing source/instance/actor/project/destination pins, immutable event bytes and acknowledgement validation remain in force. Consent withdrawal after a matching server acknowledgement still permits local cleanup of the already delivered event.

**Actual pinned upstream source:** independently fetched GBrain config and gateway at `a6be012a3bcfac42e279630aedec5cda4a450e29`. Upstream `loadConfig()` rereads the file synchronously, `isAvailable()` is synchronous, and gateway `chat()` carries the caller abort signal into its later SDK invocation. Review accepts the documented gateway-admission boundary; it does not claim cancellation can recall an already admitted/scheduled/remote request or guarantee no charge after that boundary.

**Fixture semantics:** reviewed `test/personal-consolidation-admission.test.mjs:97–120,165–174` for late lease expiry, final SQL cancellation and final SQL profile revocation. Reviewed `test/personal-dispatch-integration.mjs:39–91`: the lock barrier genuinely coordinates on the same PostgreSQL owner lock; the added expiry case uses a shortened test lease and PostgreSQL time within the held admission transaction. Reviewed `test/personal-provider-integration.mjs:42–52`: it obtains the actual default binding, changes the isolated on-disk config, asserts synchronous rejection before loopback traffic, restores config and preserves the existing subprocess/native-SDK wire test. Reviewed real-browser registration and dropped-ack fixtures in `test/personal-console-browser.py:44–71,130–162`. These tests are meaningful protocol/boundary tests; synthetic provider responses do not establish model quality.

The full corrected diff preserves migrations, upstream pins, owner-derived identity and independent qbrain scope.

## Independently executed checks

On Node `v24.19.0`, reran:

```text
node --test test/personal-consolidation-admission.test.mjs test/personal-consolidation.test.mjs test/personal-console-consent.test.mjs test/personal-console.test.mjs test/capture-delivery.test.mjs test/capture-hardening.test.mjs test/capture-outbox.test.mjs test/client-document-boundaries.test.mjs
```

Actual result: **142 tests passed, 0 failed, 0 skipped**. Full output is in `server-review-targeted-final.log` outside the application repository.

Created a separate corrected expectation version of the independent lease reproduction, preserving the initial file. Executed `node /workspace/scratch/97afa6ee0b0d/evidence/server-review-lease-fixed.mjs` against the final tree. Actual output:

```json
{"fixture":"synthetic SQL, shortened already-aging lease, stub provider","providerCalls":0,"invokedAfterExpiry":false,"resultState":"lease_lost","model_requests_attempted":0}
```

The corrected verifier also asserts the job remains `processing` and has no result. It uses synthetic SQL/time and a stub provider, not PostgreSQL or a paid model.

Additional executed checks: `git diff --check` for the entire exact base-to-final candidate; `node --check` for consolidation, dispatch integration and provider integration; Python AST parse of the real-browser test. All passed. The application worktree remained clean throughout this final check.

## Remaining execution limits

Bun and PostgreSQL are unavailable in this local reviewer environment. The real PostgreSQL admission/expiry integration, actual pinned SDK loopback integration, Chromium console, packaged client engines and deployment checks were inspected but not executed by this reviewer; final-candidate CI was scheduled/pending at this verdict. No real provider, user conversation, production configuration or user deployment was used. Merge acceptance must incorporate actual successful required CI on this exact final commit; no later application commit is covered by this approval.
