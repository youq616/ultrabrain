**Independent review verdict: PASS for `715314236183ff75f97bc96fcfef57bd6b421192`.**

Reviewer session: `/root/ready_binding_review`. Reviewed tree: `38dece61288c8f7e9eb2b3726e6343b5595b1ef5`. Full phase comparison base: `d2d8c30b939000b26fe41fc0e5bcab618232ca28`. I did not implement this phase. I independently inspected its installation, manager, process, PostgreSQL, filesystem, protocol, and integration-cleanup boundaries; reviewed the complete corrections from both rejected candidates; and executed the checks below against this exact SHA. Independent probes used an immutable scratch export of the commit. No repository implementation files or user services were changed by this review.

The initial BLOCK for `fde82fa97843d22b3f1a92fb83926cc99d53dcaa` remains preserved verbatim in `binding-initial.md`. The second BLOCK for `7ffbe5c14c5cf31e90510c6f62ed752a6552b5c3` remains preserved in `binding-round2.md`. Neither historical rejection is rewritten as an approval.

All findings raised in those reviews are resolved:

- **Complete HTTP response handling:** `scripts/personal-ready.py:127–160,194–206` parses strict length-delimited responses incrementally and returns after the complete response without waiting for peer EOF. My actual-loopback peer deliberately retained the connection; the corrected client completed before peer close and within its 150 ms test deadline. The connection is closed locally and never reused. Duplicate headers, transfer/content encodings, incomplete bodies at EOF, and extra bytes already received remain rejected.
- **Maximum-header separator fragmentation:** `scripts/personal-ready.py:130–138` allows only the zero-to-three trailing bytes that can form an incomplete header delimiter. Independent tests confirmed that every pending-delimiter prefix works after a valid 4096-byte header, while genuinely 4097-byte headers are still rejected for every prefix and as a complete response. The header and overall response budgets are not increased.
- **PostgreSQL address representation:** `src/personal-readiness.mjs:53` now obtains the canonical host using `pg_catalog.host(pg_catalog.inet_server_addr())`, while line 76 retains the strict `127.0.0.1` requirement. This fixes the explicit `inet::text` mask mismatch without accepting additional destinations. `test/personal-ready-integration.mjs:52–56` independently asserts the actual PostgreSQL cast and host representations. The distinction is documented by the [official PostgreSQL 18 network functions](https://www.postgresql.org/docs/18/functions-net.html), and the real CI result below confirms the pinned installation exercised it.
- **Manager-attestation scope:** `scripts/personal-ready.py:338–345` and `docs/PERSONAL-READY.md:29,48` expressly limit the claim to installed bytes, observed fixed-unit metadata, actual console arguments/invocation, and the live managed database. They do not claim verification of every cached systemd setting. HMAC authentication remains distinct from kernel socket-owner verification.

The final implementation preserves the reviewed boundaries:

- `scripts/personal-ready.py:264–306,308–337` holds the existing account-global shared deployment lock, requires an accepted current receipt and exact reconstructed console-only plan, refuses pending deployment work and observed overrides, and compares filesystem, manager, and process observations around the authenticated exchange. Reused `scripts/personal-deploy.py:226–253` checks complete receipt and generation bytes. Private-file checks were not weakened.
- `scripts/personal_ready_process.py:194–246` binds the manager's MainPID to the actual executable inode, exact NUL-terminated command line, UID fields, process start ticks, cgroup, and PID/network namespaces. `scripts/personal_ready_process.py:270–321` binds the configured cluster to the actual postmaster's runtime executable and PGDATA working-directory inode, and binds the authenticated backend PID to that postmaster's real child. The SQL and PID-file start timestamps are not incorrectly assumed identical.
- `src/personal-readiness.mjs:26–86` authenticates before the fixed read-only database transaction, validates server-derived source/process/database facts, and signs all returned identity fields. The checker never transmits the bearer token or database password, never reads process environment files or memory bodies, and performs no model call, migration, or service action. The pinned upstream transaction implementation was independently inspected in the initial review and confines these statements to one transaction connection.
- `test/personal-ready-integration.mjs:37–56,128–189` is restricted to the authorized disposable ordinary-user CI installation. Its source-removal, token-rotation, and exclusive-table-lock scenarios retain their restoration paths. The enclosing deployment fixture owns service cleanup. Final snapshots check configuration, deployment state, invocation identity, enablement-related state, token bytes, and record counts; this is not a claim of byte-for-byte preservation of every database row.

Executed local evidence on this exact SHA:

| Command | Actual result |
|---|---|
| `python3 -I -B -m unittest discover -s test -p 'test_personal_ready*.py' -v` | **71 passed**, zero failures |
| `node --test test/personal-console.test.mjs test/personal-ready-cli.test.mjs test/personal-readiness.test.mjs` | **53 passed**, zero failures or skips |
| `python3 -I -B /workspace/scratch/be43dca0ab34/ready-binding-independent-715.py` | **7 passed** |
| `python3 -I -B /workspace/scratch/be43dca0ab34/ready-binding-framing-715.py` | **6 passed** |
| `git diff --check`, `git status --short`, and `git rev-parse HEAD` | Passed; worktree clean and HEAD equal to the full reviewed SHA |

The seven independent cases cover a same-length unit edit with restored old mtime, an unexpected generation file, token mutation and restoration with the original inode and mtime, shared-lock inode replacement, backend identity change at the final boundary, a symlink to otherwise identical unit bytes, and an actual retained-peer HTTP response. The six additional framing cases cover every incremental boundary of a valid response, ambiguous or malformed headers, incomplete bodies at EOF, already-received trailing messages, all maximum-header delimiter prefixes, and refusal of genuinely oversized headers. All final cases now test the intended behavior; the prior defect reproductions remain in the historical review evidence.

I also independently fetched the completed **successful** [push services CI run 35292736874](https://github.com/youq616/ultrabrain/actions/runs/35292736874), job `105438869882`, for this candidate. Its actual log reports:

- Existing user-service integration: **18 checks**, with two calls to the local synthetic provider.
- Existing deployment integration: **15 checks**, using the actual user manager, managed PostgreSQL, and authenticated console HTTP.
- New readiness integration: **12 checks**, including live source removal, a real PostgreSQL exclusive table lock, restoration without changing the console invocation, unchanged final snapshots, `actual_postgres_address_conversion_verified:true`, and **zero model calls**.

These are CI executions, not services run in this root review container and not a deployment to the user's host. At the last independent status retrieval, [PR services run 35292739684](https://github.com/youq616/ultrabrain/actions/runs/35292739684) was still in progress; this report does not claim that all required PR workflows had completed. The implementation review gate is approved for the exact SHA above. Merge acceptance still requires all required CI gates to pass.

No unresolved blocking or advisory code finding remains from this review. The documented limitations continue to apply: trusted service account and cooperative maintenance window, bounded observations rather than isolation from arbitrary same-UID mutation, no source-tree or every-setting attestation, no worker/model-quality validation, and no guarantee of future availability. This approval does not cover later application changes.
