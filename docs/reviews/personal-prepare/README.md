# Personal activation prepare — implementation review

## Fixed scope

Base: `57c6c98712020e51f5ff276cf9bff3909bad8d01` (PR #17, stacked on PR #16). Import only the nine exact application/test blobs from PR #15 `b18ca811ed699c5c0fc56c6b2742cf508512da19`; do not overwrite its branch or copy its archived review claims into this candidate. The new integration branch is not main and none of these PRs is treated as accepted by inheritance.

This phase adds public `personal-activate prepare`, retains explicit `apply`, fixes eager default-home lookup in activation argument parsing, and propagates a containing deadline to the read-only identity observer. The existing systemd/managed-PostgreSQL workflow now runs identity-before-token initialization and exercises prepare/plan equality, no-start/no-state-mutation assertions, explicit activation, readiness and the existing crash-recovery sequence on one candidate.

## Implementation assistant's own review (not independent review)

Reviewed the changed preparation/CLI code, identity observer's authentication, bounded psql lifetime and process binding, existing plan/apply/current-receipt contract, deployment reader lock and pending reservations, affected client capture/document registration paths, and disposable-service fixture cleanup. This is a scoped review, not an exhaustive audit or a guarantee that no defects remain.

Two concrete implementation findings were corrected before this candidate:

1. The activation parser eagerly evaluated the passwd-home fallback even with explicit/environment home, and before some argument/platform refusals. Resolve it only when needed, after validation; retain redacted failure handling. Regression coverage includes explicit/environment home, invalid/root invocation, and default lookup failure.
2. The first prepare implementation gave nested identity observation its own fresh 10-second budget rather than the containing operation's remaining deadline. The observer now takes an optional internal monotonic deadline and uses the shorter budget; reject expired/nonfinite/boolean values. Public CLI does not expose a deadline override. Existing standalone identity still has at most its original 10-second budget plus its existing cleanup bound.

Additional probes cover source/instance proof validation, token/database/manager/graph changes during observation, missing credentials, pending activation, competing deployment locks, no-start/no-file-mutation behavior, manager close on failure, and successful canonical-plan dispatch only through explicit apply. No migration, upstream pin, native database layout, model grant, client pin or production service is changed.

## Executed local evidence

Ordinary-account final Node run: **652/652**, zero failed/skipped, exit 0. Final Python run: **647 tests / OK**, exit 0. Focused prepare suite: **20/20**; optimized `-OO` prepare suite: **20/20**; existing identity suite: **33/33**. Node syntax checks, Python AST parsing and `git diff --check` passed. The baseline PR #17 had 618 Node / 627 Python: the Node increase includes 32 already-existing PR #15 regressions plus two new CLI tests; the 20 Python tests are new in this phase.

`first-failures.log.gz` preserves raw missing-feature/home-regression and nested-deadline first failures; failure/subTest counts do not represent distinct vulnerabilities. `prepare-tests.log` is the final focused run. `local-evidence.json` records all local log hashes and exact changed/imported Git blobs. The complete supplemental archive is a conversation attachment, not claimed as committed. The initial full Node invocation was terminated by its execution limit; a supervised subsequent run with concurrency 2 completed. Pre-deadline-correction results remain historical and are not substituted for the final run.

Real PostgreSQL, installed systemd, Windows portability and n8n execution were **not run locally** in this container. The modified real workflow must run on this exact candidate; prior green PRs are not proof that the composition works. Actual candidate SHA, run IDs, results and log evidence are added to the PR conversation after execution without modifying tested application code.

## Acceptance gate and continuation

**Independent reviewer: PENDING. Main unchanged.** These are implementation-assistant self-review findings, not separate-agent findings. Attempt an actual repository reviewer on the final SHA, record the real result, and do not count a request, quota refusal, self-review or CI as approval. The new candidate and its unaccepted parent stack require genuine independent approval under AGENTS.md before acceptance/merge. Any later correction requires review of that corrected final SHA.

Personal V1 remains in first-use integration/acceptance, not production-complete. After this candidate's gate, remaining product work includes a user-facing guided setup experience, real installed-client/model-quality acceptance, and separately scoped document-format expansion. Do not enable a paid model, production service, automatic capture, credential rotation or client rebinding merely to make a test pass. Exact local reviewer handoff, if needed, belongs in one paragraph on the final candidate PR and references these committed files.
