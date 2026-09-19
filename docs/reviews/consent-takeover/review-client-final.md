# Independent acceptance review — client consent and affected boundaries

Reviewer session identity: `/root/review_consent_client`.

Reviewed final remote commit: **`a9678135d28c6f3094db4e2d42f4077206fcd49b`**.

Reviewed tree: **`e51dca2cfad06fc906d0de8104158bb716deca83`**.

Base: `77b4ecf649124fc169e4c838b5202d96211e933e`.

Verdict: **PASS for independent code review of this exact final commit.** No remaining blocking finding was identified in the reviewed change and affected boundaries. Required CI and real integration execution remain separate gates; this report does not claim that pending CI, a real client engine, or personal V1 acceptance has passed.

## Exact revision and independence

I read the repository's `AGENTS.md`, independently inspected all final changes, and ran the checks below. I did not implement the application changes and did not modify repository application or test files. My additional review probes and reports are outside the repository.

The first candidate was remote `de5ca16c04d6102da6fd92370d03ff6bf939c58b`, tree `9cc8ce0fea900e468e35d598b054ff5b6e8c9ad1`; its initial review remains **BLOCK** in `review-client-initial.md`. That verdict was not silently changed. The final candidate adds the lease correction described below.

The local tested commit is `443d0b1e23c56a839513b0246e8eb386f77666da`. I independently inspected the fetched remote commit object with `git cat-file -e` and `git show`; its full SHA is `a9678135d28c6f3094db4e2d42f4077206fcd49b`, its parent is `de5ca16c04d6102da6fd92370d03ff6bf939c58b`, and its tree is `e51dca2cfad06fc906d0de8104158bb716deca83`. `git diff --exit-code 443d0b1e23c56a839513b0246e8eb386f77666da a9678135d28c6f3094db4e2d42f4077206fcd49b` passed with no content differences. The worktree was clean at the final check. The test results therefore cover the exact final remote tree, despite different commit headers.

## Findings and resolution

1. **Resolved initial blocker: lease expiry during the newly added configuration wait.** The initial candidate checked `job.live` before `await this.configure()` and could invoke a provider after that lease expired. I independently identified the stale check from code and notified the coordinator; the separate server reviewer supplied the initial executable failure, which I do not claim as my own run. In the final candidate, `src/personal-consolidation.mjs:59–78` rechecks the job state, lease ID and database clock after configuration, while the owner, job and source locks are still held. It checks the abort signal and principal before invocation. `src/adapters/personal-model.mjs:16–21` retains the synchronous native host-consent check after the final SQL await. The corrected Node tests exercise lease loss, abort during the final query, and native profile revocation during that query; they passed in my run. The new real PostgreSQL and pinned-provider tests were inspected but not executed locally.

2. **Client capture and document consent: no remaining blocker.** `src/capture-delivery.mjs:19–35` and `src/client-document.mjs:49–82` reject explicit `false`, non-functions, and Promise-like authorization assertions; synchronous successful `undefined` remains compatible. Promise rejections are consumed instead of leaking an unhandled rejection. The selected bytes are cloned before asynchronous work. Authorization and cancellation are checked before a new raw-text request after identity, listing or registration waits. Document delivery preserves existing owned-Agent metadata and validates the destination, event, original content hash, Agent, project and document UUID in its receipt.

3. **Outbox consent, replay and durability: no remaining blocker.** `src/capture-outbox.mjs:21–28,131–147,176–219` checks authorization before creating a raw-text entry and again after acquiring the queue lock. Flush checks authorization before consuming attempts and again after connection. The authorization assertion is forwarded into the actual capture delivery path. Source/instance/actor/workspace/server binding, canonical immutable request hashes, bounded retries, explicit stale-lock recovery and fsync behavior remain intact. A matching source/event/journaled/job-UUID receipt permits cleanup even if consent has since been withdrawn. A mismatched receipt retains the event. My independent multi-entry probe confirmed that post-ack revocation can remove the confirmed entry while retaining the remaining event byte-for-byte without spending its attempt.

4. **Browser session/selection and unknown delivery: no remaining blocker.** `web/personal/app.js:24–46,203–217` binds save, update and raw capture authorization to the token, source, editing identity/revision, form fields and current consent. The registration await cannot send stale selected text after revocation or edits. A previously unconfirmed delivery remains pending if retry authorization fails, and reauthorization reuses the original request and event. Independent probes additionally exercised token/source changes, editing identity and less obvious form fields. These are synthetic DOM tests, not a real Chromium claim.

5. **Known deferred compatibility issue remains accurately documented.** `src/capture-delivery.mjs:32` still requests default custom registration, so an existing differently configured Agent can cause capture to be rejected by server version rules. `docs/TAKEOVER-2026-09-19.md` explicitly records the follow-up. This review does not mark that compatibility issue, first-use setup, real-engine acceptance or broader personal V1 work as complete. No new regression in that boundary was introduced by this phase.

## Scope inspected

I inspected the entire original 20-file diff and all four files in the correction, including the newly affected `test/personal-provider-integration.mjs`; the final base-to-candidate diff has 21 files. I read the affected browser/model/documentation tests and followed the client code through:

- `packages/ultrabrain-client/src/runtime.mjs`, CLI, native adapters and package metadata;
- `src/automatic-capture.mjs`, `src/client-profile-file.mjs`, `src/client-kit.mjs`, capture delivery, document delivery and outbox;
- `scripts/build-client.mjs` and the client portability/native integration/browser workflow steps;
- personal consolidation admission, native model configuration and generated-candidate handling.

The SDK runtime at `packages/ultrabrain-client/src/runtime.mjs:55–57` uses these shared delivery functions and forwards the authorization callback. The CLI and automatic adapters supply synchronous profile checks, and the build entry points include them. This establishes the source path included by the shipped build; the actual package was not built locally because Bun and dependencies are absent. No database migrations, upstream pins, source/principal ownership implementation, or unrelated Agent configuration were changed by this candidate.

## Executed evidence

Environment: Linux; Node `v24.19.0`; Python `3.12.14`.

Final corrected run:

```text
node --test test/capture-delivery.test.mjs test/capture-hardening.test.mjs test/capture-outbox.test.mjs test/capture-profile-binding.test.mjs test/automatic-capture.test.mjs test/client-document-boundaries.test.mjs test/client-kit.test.mjs test/client-task-context.test.mjs test/client-release-docs.test.mjs test/personal-console-consent.test.mjs test/personal-consolidation-admission.test.mjs /workspace/scratch/97afa6ee0b0d/evidence/review-client-extra.mjs

tests 188
pass 188
fail 0
cancelled 0
skipped 0
todo 0
```

This is 175 repository tests and 13 independently authored review probes. The unaltered log is `review-client-node-corrected-initial.log`; probe source is `review-client-extra.mjs`.

Additional checks:

- `git diff --check 77b4ecf649124fc169e4c838b5202d96211e933e a9678135d28c6f3094db4e2d42f4077206fcd49b` — passed.
- Python `ast.parse` for the changed `test/personal-console-browser.py` — passed syntax check only.
- Remote/local tree equality and clean worktree — verified as described above.

Initial evidence is preserved separately: `review-client-node-initial.log` records 172/172 repository tests; `review-client-extra-initial.log` records 13/13 independent probes; `review-client-initial.md` records the first candidate's BLOCK and the original stale-lease finding. None of my executed Node tests failed. The separate model review's first failure must remain attributed to that reviewer and retained with its evidence.

## Limits and remaining gates

Bun, PostgreSQL `psql`, installed MCP SDK dependencies, the pinned native gateway source and Playwright are absent in this local checkout. I did not run actual Bun/PG, package build/MCP wire integration, real Chromium, Windows, live Claude/OpenCode/OpenClaw engines, or a real model. Source inspection confirms the necessary repository CI exercises exist; their pending outcomes are not marked passed here. Synthetic transports, DOM and model/SQL fixtures only establish their exercised code paths. This independent code review PASS must be combined with actual required CI and the other independent review before application changes are accepted into main.
