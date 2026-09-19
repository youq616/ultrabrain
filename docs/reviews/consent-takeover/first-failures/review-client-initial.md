# Independent client consent acceptance review — initial candidate

Reviewer session identity: `/root/review_consent_client`.

Reviewed remote commit: `de5ca16c04d6102da6fd92370d03ff6bf939c58b`.

Local execution commit: `a327511d44e034e62e1802c42248354cb46e92fa`.

Both commits have tree `9cc8ce0fea900e468e35d598b054ff5b6e8c9ad1`. I independently verified the fetched remote object with `git cat-file`, `git rev-parse`, and `git diff --exit-code`; there are no content differences. Base: `77b4ecf649124fc169e4c838b5202d96211e933e`.

Verdict: **BLOCK for acceptance of this candidate**. Client-specific checks below found no new blocker, but the newly awaited model configuration leaves a stale lease check before provider invocation. A corrected exact commit requires another review; this report is not approval of a later commit.

## Findings

1. **Blocking model admission boundary**, `src/personal-consolidation.mjs:49–69`: the code reads `lease_until > clock_timestamp()` before `await this.configure()` and invokes the provider after that new await without checking the lease again. A lease can expire during the configuration wait. I independently identified this from the exact diff and reported it to the implementation coordinator. The coordinator subsequently reported that the separate model/server reviewer reproduced the issue; that separate execution evidence is not represented as my test result here. The caller must renew or recheck the lease after asynchronous configuration while retaining the final synchronous native consent guard.
2. **No new client consent blocker found**: `src/capture-delivery.mjs:19–35`, `src/client-document.mjs:49–82`, and `src/capture-outbox.mjs:21–28,131–147,176–219` reject explicit false and Promise-like callbacks, preserve synchronous undefined success, recheck after the relevant waits, retain immutable original events on denial, and keep acknowledgement cleanup independent of post-send revocation. The outbox validates the source, event, journaled state and job UUID before removing a record. Rejected and mismatched acknowledgements retain the entry.
3. **Browser binding inspected and exercised**: `web/personal/app.js:24–46,203–217` binds the event to token, source, editing identity/revision, selected fields and current consent. Unknown earlier delivery remains recorded when reauthorization fails; reauthorization preserves the original request/event. Additional independent tests cover token/source changes and fields outside the added author tests.
4. **Known deferred capture registration issue, not introduced here**: `src/capture-delivery.mjs:32` always requests default custom registration; an existing Agent with other metadata can be rejected by server revision rules. The takeover plan explicitly records this follow-up. Document delivery already uses bounded owned-Agent lookup and preserves existing metadata. This review does not treat that deferred compatibility issue as fixed.

## Scope inspected

I read `AGENTS.md` and the entire 20-file candidate diff, including all changed model/browser tests and documentation. I followed the changed client functions through `packages/ultrabrain-client/src/runtime.mjs`, the CLI and native adapters, automatic capture, profile and identity validation, bundle construction, package metadata, and relevant CI workflows. No migrations, source/principal ownership code, pins or unrelated configuration are changed in this candidate. I did not modify application or repository test files.

The actual SDK runtime imports the shared delivery functions and passes authorization into them (`packages/ultrabrain-client/src/runtime.mjs:55–57`); automatic capture and CLI supply synchronous profile checks. Bundle entry points include these paths. This is source inspection of the shipped build path, not a locally executed SDK/engine integration.

## Executed evidence

Environment: Linux, Node `v24.19.0`, Python `3.12.14`. Bun, PostgreSQL `psql`, installed MCP SDK dependencies, pinned native gateway source, and Playwright are absent locally.

- Initial targeted repository test command: `node --test test/capture-delivery.test.mjs test/capture-hardening.test.mjs test/capture-outbox.test.mjs test/capture-profile-binding.test.mjs test/automatic-capture.test.mjs test/client-document-boundaries.test.mjs test/client-kit.test.mjs test/client-task-context.test.mjs test/client-release-docs.test.mjs test/personal-console-consent.test.mjs test/personal-consolidation-admission.test.mjs` — **172 passed, 0 failed, 0 skipped**. Log: `review-client-node-initial.log`.
- Independent review probes: `node --test /workspace/scratch/97afa6ee0b0d/evidence/review-client-extra.mjs` — **13 passed, 0 failed, 0 skipped**. Log: `review-client-extra-initial.log`. These cover authorization becoming false or asynchronous while queue locks wait, thenable rejection handling, cancellation inside final callbacks, matched acknowledgement followed by revocation across multiple events, mismatched acknowledgement retention, and browser session/selection changes.
- `git diff --check 77b4ecf649124fc169e4c838b5202d96211e933e a327511d44e034e62e1802c42248354cb46e92fa` — passed.
- Python `ast.parse` of `test/personal-console-browser.py` — passed syntax check only.

No initial executed Node test failed; the first-run logs above are retained unaltered. Inspection attempts to read a guessed non-existent `personal-clients.yml` workflow and absent `vendor/gbrain` sources failed; the actual workflow is `client-portability.yml`, and missing native dependencies are recorded as limitations rather than passing integrations.

CI is a separate acceptance gate. I have not run Bun, real PostgreSQL, the packaged Node/MCP wire tests, real Chromium, a live Claude/OpenCode/OpenClaw host, Windows or a real model in this review. Synthetic SQL/DOM/transports establish the exercised branch behavior only. The pending CI result is not independent review approval, and these results do not establish complete personal V1 acceptance.
