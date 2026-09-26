# Browser regression response barrier — 2026-09-26

Follow-up to `c3e144033f914f00cd22c71436a903f2f5c23bc8`. This is a **test-fixture correction only**; all application source, compiled package inputs, migrations and upstream pins are byte-identical to that commit. It is not a change to the new offline duplicate audit or production job behavior. The independent review bot actually replied with exhausted quota in PR26 comment5842922098; no second-agent approval has been received.

## Actual CI failure and inspection

Personal recall preview run36216042831/job108332089138 failed in the existing job-manager browser fixture, at `corrupt -> route.fulfill`, with `Route is already handled!`. The selected final-SHA installed duplicate-package probe and Windows/Ubuntu tests passed at c3e1440, but that success does not erase this failing workflow or its skipped later stages. Preserve the exact first-failure excerpt alongside this record.

The two damaged-response rounds share the same `job_page_unconfirmed` text and empty results. Production `load()` clears the cards but leaves the previous message while the new response is pending. The old fixture could therefore satisfy its second-round DOM assertions before that round's intercepted response completed, unregister its callback and submit the next request. This is a fixture synchronization defect; there is no offline duplicate-audit import in the failing browser path.

## Minimal correction and deterministic regression

For each damaged jobs response, enter `page.expect_response` before clicking, require a matching POST jobs response, wait for its body completion, and explicitly verify the intended corruption in the observed response. Then require both the existing rejection UI and the current coverage failure state. Use `page.unroute_all(behavior='wait')` to finish active handlers before proceeding, also at the later damaged-cancellation and intentionally late-response cleanup points. Do not use ignoreErrors, remove assertions, retry until green, or alter the production UI.

`test/test_job_browser_response_barrier.py` executes the **actual extracted corruption loop AST**, not a copied implementation, with delayed synthetic response/handler objects and an intentionally stale error DOM. The old exact c3e1440 fixture fails at active-handler removal. The corrected loop observes and finishes each of the two distinct damaged responses and drains each callback. This is one deterministic test-harness regression, not a real Playwright/HTTP execution. The red output is retained as `browser-barrier-red.log`.

The public Playwright Python API documents `expect_response`, `Response.finished`, and `unroute_all(behavior='wait')`; the latter is available from1.41, before this repository's1.57.0 pin. References: https://playwright.dev/python/docs/api/class-page#page-expect-response ; https://playwright.dev/python/docs/api/class-response#response-finished ; https://playwright.dev/python/docs/api/class-page#page-unroute-all . No dependency version was changed.

## Evidence and acceptance

The local application/Node suite remains2504/2504. Python full discovery with the new harness regression passes684/684, versus683 before this test was added. First-failure evidence is retained; local runs are not claims of real online Chromium execution. The final corrected commit requires new CI, including the previously failing actual PostgreSQL/Chromium workflow. Current final-SHA status belongs in the PR completion comment and delivery report, not inferred from this source file.

The independent-agent gate remains BLOCKED / NOT APPROVED because of the actual quota response. Do not resubmit around the quota or label implementer self-review, the AST test, a new worktree or green CI as an independent approval. Keep the draft branch and main unchanged.
