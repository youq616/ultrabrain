# Independent diagnostic privacy review

**Narrow verdict: NO BLOCKER for the diagnostic-only changes in `70cd4cc3880c13c8d53d32627e5c771174a7d3c5`.** This is not a whole-phase PASS. The production implementation is unchanged from the blocked candidate `def34fb9577167bebc6f7d41d0c6bb8138220087`, and the real first-plan `manager_process_unverified` failure still requires diagnosis and resolution.

- Actual independent reviewer: `/root/activate_boundary_review`.
- Exact reviewed commit: `70cd4cc3880c13c8d53d32627e5c771174a7d3c5`.
- Exact tree: `3d479a0bda547482d61353f8de4a4880247cf095`.
- Parent: `def34fb9577167bebc6f7d41d0c6bb8138220087`.
- Scope: complete two-file delta, `test/personal-activate-crash.py` and `test/personal-activate-integration.mjs`; 118 additions and one deletion. The existing subprocess wrapper and imported manager path were also inspected for side effects and output handling.
- Final identity verification: 2026-09-18 15:50:41 UTC; exact HEAD/tree and clean worktree confirmed. No repository files were edited by the reviewer.

## Findings

At `test/personal-activate-crash.py:113–138`, the new command passes the existing Linux, matching nonzero real/effective UID, fixed disposable account home, and explicit CI environment checks before importing and invoking the activation implementation. It requires the exact fixture `--home`. The diagnostic branch exits before constructing `Context` or entering the apply, lock, or crash-dispatch paths.

At `test/personal-activate-crash.py:91–103`, diagnosis constructs the production `LocalManager`, invokes only `connection_identity()`, and closes the connection in `finally`. The inspected identity path reads the fixed local bus's identity/owner/UID/PID, selected manager property, and process identity; it sends no `LoadUnit`, `StartUnit`, stop, restart, reset, enablement, or other service mutation. This branch does not read a transcript, credential file, process environment, database, or model response. It does not print the successful identity value.

At `test/personal-activate-crash.py:23–88`, output uses fixed allowlists for exception types, exact safe codes, source basenames and function names. Unknown values become `OtherError`, `other`, or null. It never stringifies an exception or prints its arguments, raw path, traceback source text, locals, or error message. OSError errno is emitted only when it is an exact integer in 0–4095; booleans and other types are excluded. Line numbers are bounded. The chain is limited to six distinct exceptions, with cycle detection; at most eight frames are emitted in total, prioritizing the inner cause. Following `__context__` preserves a hidden cause beneath `raise ... from None` without rendering its raw message.

At `test/personal-activate-integration.mjs:139–167`, the diagnostic subprocess has a 35-second parent bound, a 16 KiB accepted response limit, exact structural keys, bounded frame/chain counts, field-format/numeric validation, and a check against known fixture secrets. The producer supplies the fixed allowlists; the JavaScript side validates the entire structure and bounds before logging it. The existing `run` wrapper drains/discards stderr and kills overflowing or timed-out children. Malformed, oversized, secret-containing, or otherwise invalid output is replaced by one fixed `available:false` diagnostic object, never raw stdout/stderr.

At `test/personal-activate-integration.mjs:250`, the additional diagnostic runs only after initial plan failure, then rethrows the same original error. It does not change `activeCase`, `lastCode`, the check counter, or the original failure record at line 336. It does not retry the plan or turn diagnostic success into activation success. The prior first-failure log and whole-phase BLOCK report remain intact.

No privacy or unauthorized-side-effect blocker was identified in this two-file change. This conclusion does not prove what the next real diagnostic will report or close the existing process-verification failure.

## Executed checks

I independently executed six isolated checks against the frozen helper bytes and confirmed afterward that both reviewed files were byte-identical in the exact committed candidate:

1. A wrapped PermissionError containing a private marker and private filename retained only errno 13 and the outer allowlisted code.
2. A private exception class, dynamic source filename, function name, and message were redacted.
3. A cyclic 15-exception context chain stayed within the six-layer/eight-frame limits.
4. Boolean, negative, oversized and string errno values were omitted.
5. A mocked failing manager called only identity and close, and emitted sanitized output.
6. A mocked successful manager called only identity and close, and did not print its returned private identity value.

All six passed. These are pure rendering/lifecycle tests with internal mocks, not manager service calls or an ordinary-user gate bypass. Complete output: `boundary-diagnostic-candidate4-checks.log`; SHA-256 `3ce6db6e23b4dfbc0156798e86f4ea72dae63e46a546d887764161df61a88c36`.

An actual `/usr/bin/python3 -I -B test/personal-activate-crash.py diagnose-manager --home /tmp/boundary-diagnostic-review` invocation as this container's root account refused before diagnosis, with expected exit 1 and fixed text `Disposable ordinary-user CI fixture required`. Node syntax, Python AST, exact diff inventory, `git diff --check`, HEAD/tree and clean-worktree checks also passed.

Reviewed file hashes:

| File | SHA-256 |
| --- | --- |
| `test/personal-activate-crash.py` | `1b2525cd1cce743d2e22272864fbe9dee664b789d43a93f61746e19c02dfe461` |
| `test/personal-activate-integration.mjs` | `c54940b140c1fb3be11adac8561d62d9d802250a24431690be5e44d46735dce2` |

The 259 Python/14 CLI suite was intentionally not rerun for this narrow diagnostic review; its previous result remains attributed to def34fb. I did not execute real manager diagnosis, user services, PostgreSQL, the activation integration, or any deployment. The full phase stays blocked pending a corrected application candidate, completed real verification, and another exact-commit independent review.
