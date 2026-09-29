# First remote CI and timing-contract follow-up

Initial published head: f1281267dc9bf69d66d5248cf3955319c8ccf074, tree259b7be17022ac32377bf5b17d24c67e05b7af59; PR43.

Read-only audit run36519807832, Windows22 job109249967748: **176 tests,173 passed,1 failed,2 explicitly POSIX-only skips**. The failure was `lock: persistent contention exhausts the bound with safe diagnostic`, asserting at least two calls inside a20ms real-time budget. The observed test took397.6443ms. Once the event loop has consumed the deadline, one initial create attempt is valid; demanding a second contradicts the production rule forbidding retries past the deadline.

Correct the timing-sensitive lower bound to one while preserving rejection, diagnostic, the upper bound and the explicit zero-wait/late-resume tests. Add a deterministic clock regression asserting exactly one claim when the first collision consumes the deadline. This is a **test-contract correction**, not a new production queue repair and not removal of the original eight-process data-integrity assertions.

The same run's Windows22.16 job109249967645 failed before testing because the Bun1.3.13 binary download returned HTTP500 three times after built-in retries. No source test or package case ran there. Move the existing Bun setup after source contracts so a build-tool download failure cannot prevent recording dependency-free source-test evidence. Keep the compiler pin and failure semantics; do not swallow install or test failures. New-head CI provides a new attempt, not reclassification of the first failure.

The two Ubuntu audit matrix jobs109249967756 and109249967951 succeeded (source contracts, current build and isolated compiled-package checks). These are results of the initial head, not automatic evidence for later heads.

The handoff evidence includes the entire downloaded initial Windows22 test artifact (`remote-windows-first/audit-tests.tap`), not a reconstructed log. Artifact11012194002, ZIP SHA256 df45d472f3616a4e908479cb7edc179574d29f61509a915de7d5f60a9041d802. Original artifact belongs to PR merge ref a6620cacab6191748faa7e1f59d6303bf5e11963 for head f1281267.

The older PR41 writer_failed root cause remains unknown. A subsequent passing run is not proof of root-cause remediation. No acceptance, independent review approval or main merge is implied.

## Additional Windows acceptance blockers (not fixed by the timing test change)

Lock run36519807697, Windows22 job109249967102: source contracts136/136 passed, but the25-round real-process script failed on round13 after12 successful rounds. One writer reported `outbox_lock_io` with `{kind:queue, phase:create, system_code:EPERM}`; no native message or path was exposed. This establishes the stage and errno of this **new** failure, not the root cause of the older PR41 generic writer_failed. The code intentionally does not treat EPERM as EEXIST contention. No permission widening or broad retry is added.

The same run's Windows22.16 job109249966972 had136 tests,84 pass/52fail. Failures include existing profile integrity reads (`insecure_profile`, "Profile changed or exceeds size limit") and queue release verification (`outbox_corrupt`), then consequent waiters exhausting their bounded retries. The observed errors are retained; their underlying filesystem/Node/platform cause is not established. They cannot be dismissed as test-only or called fixed by an unrelated timing assertion correction. The production profile and file-integrity checks remain intact.

These Windows failures are explicit acceptance blockers. Keep PR43 draft and main unchanged. Linux local passes, both successful Ubuntu matrix jobs, a subset of Windows tests, or a subsequent lucky retry do not close them. The final handoff must report actual latest-head CI separately from these preserved first failures. The extra complete TAPs are preserved under `remote-locks-win22-first` and `remote-locks-win2216-first` in the handoff evidence. The full contention JSON is also committed alongside this note.

## Independent review actually returned for the initial head

Reviewer `chatgpt-codex-connector[bot]` responded on2026-09-29 at04:07:58UTC in PR43 comment5883454870: "Codex Review: Didn't find any major issues." The response identifies reviewed commit f1281267dc, matching the full initial head above; activity summary comment5883455310 reports Completed at04:07:59.816043UTC. No independently executed test log, separate run identifier or detailed file-by-file checklist was exposed. Record this as an actual external code-review response, not a claim that the bot ran the3683 tests or certified Windows. It does not approve this subsequent timing/CI/evidence follow-up; request fresh final-head review. Windows blockers are not overruled by a no-major-issues code review.

After the timing-test correction, ordinary Linux UID1000 Node22.16.0 full suite passed3684/3684 (zero fail/skip/cancel), with69 added tests relative to the prior661db delivery. Production source and all12 compiled-client artifact bytes are unchanged from f1281267. Repeated full-suite runs are not additive coverage.
