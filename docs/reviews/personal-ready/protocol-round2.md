**AUTHORITATIVE CORRECTION: BLOCK** for full commit **`7ffbe5c14c5cf31e90510c6f62ed752a6552b5c3`**, tree **`fba254ad0a0ba6719520222475ec06526a984ac5`**, reviewed by **`/root/ready_protocol_review`**. The full-commit PASS recorded below is withdrawn. The HTTP framing fix remains validated, but the unchanged SQL address expression prevents a valid live PostgreSQL readiness result. Do not merge or accept this commit.

After the framing review, the implementation agent reported that actual CI had progressed to `readiness_unverified` and identified the PostgreSQL inet text-cast mismatch. I independently verified the technical cause using the official PostgreSQL 18 documentation and the exact pinned PostgreSQL source. At `src/personal-readiness.mjs:53`, `pg_catalog.inet_server_addr()::text` returns the address with a netmask, such as `127.0.0.1/32`. At `src/personal-readiness.mjs:76`, the response validator requires the exact address `127.0.0.1`, so it rejects the real successful query. The resulting HTTP response cannot establish readiness. The appropriate correction is `pg_catalog.host(pg_catalog.inet_server_addr())`, preserving the exact loopback-address check.

The official documentation states that the explicit inet-to-text cast retains the netmask and that `host(inet)` returns the address without it. [PostgreSQL 18 network functions](https://www.postgresql.org/docs/18/functions-net.html)

In the pinned PostgreSQL revision `724edf9bde9d356724ad384a2e196edc3c9f80f7`, `network_show` implements this cast and adds the netmask at `src/backend/utils/adt/network.c:1176–1180`; `network_host` removes any netmask at lines 1151–1153. This verifies the documented distinction against the actual pinned database implementation. [Pinned PostgreSQL network.c](https://github.com/postgres/postgres/blob/724edf9bde9d356724ad384a2e196edc3c9f80f7/src/backend/utils/adt/network.c)

I also executed an independent `node --input-type=module` adapter-boundary counterexample with otherwise valid authenticated readiness data. The documented cast result `127.0.0.1/32` was rejected with `readiness_unavailable`, while `127.0.0.1` was accepted. Its output was `{"explicit_cast_format_rejected":true,"host_format_accepted":true}`. This is a fixture confirmation of the application comparison, not a claim of locally executing PostgreSQL.

The following earlier report is preserved verbatim as the superseded assessment. Its executed tests and framing findings remain evidence; its full-commit PASS and statement that no blocker remained are superseded by the BLOCK above. This review missed the SQL cast semantics during its first inspection. A corrected full commit must receive another explicit review, and real systemd/PostgreSQL/HTTP CI remains required.

---

Independent review verdict: **PASS** for full corrected commit **`7ffbe5c14c5cf31e90510c6f62ed752a6552b5c3`**, tree **`fba254ad0a0ba6719520222475ec06526a984ac5`**, against phase base **`d2d8c30b939000b26fe41fc0e5bcab618232ca28`**.

Actual reviewer session identity: **`/root/ready_protocol_review`**. I did not implement this phase, modify repository source, start services, commit, or merge. I inspected the full phase in the initial review and independently inspected the complete three-file correction from `fde82fa97843d22b3f1a92fb83926cc99d53dcaa` to this exact commit. The original BLOCK remains valid for the original commit and is preserved in `protocol-initial.md`; this report does not retroactively approve it.

The original blocker is **resolved**. At `scripts/personal-ready.py:127–157`, partial parsing now distinguishes a bounded incomplete response from a complete, valid single response. It still requires exact, bounded Content-Length, unique headers, supported content type, a 200 status and absence of compression or transfer encoding. At `scripts/personal-ready.py:186–204`, the client parses received bytes incrementally and returns once the complete frame is present. Returning unwinds both context managers and closes the client socket. It does not require the peer to send EOF, reuse the connection or send a second authenticated request.

I repeated my independent retained-connection counterexample against this commit. The peer sent the complete frame, then observed our socket close without closing its side first. The client returned the exact body immediately within the supplied 200 ms deadline:

```json
{"complete_frame_sent":true,"client_closed":true,"result_matches":true,"elapsed_ms":0}
```

The exact millisecond value reflects rounding on this local loopback fixture; it is not a production latency guarantee. This confirms the framing bug is fixed without depending on a repository test’s assertion.

I independently ran 145 additional framing checks. These exercised every proper byte prefix of a representative response, completion of that frame, malformed lengths, signed and zero-prefixed length spellings, duplicate and case-variant duplicate headers, control characters, folded headers, oversized headers and declared bodies, wrong media types, redirects and other non-200 statuses, bare-LF framing, already-buffered excess bytes and two concatenated messages. An incomplete prefix remained incomplete in partial mode and was rejected as a final response. Already-buffered excess data was rejected. The final check used the retained-connection peer and verified closure of the client socket. All 145 checks passed.

The regression at `test/test_personal_ready.py:168–177` directly exercises a complete response whose peer remains open. The changed expectation at `test/test_personal_ready.py:184–189` accepts either of the two safe, bounded refusal codes for a 9000-byte malformed header. Incremental parsing can now refuse the header before reaching the overall byte budget. This change does not permit a response previously rejected for size or malformed framing.

The scope clarification at `scripts/personal-ready.py:335–342` and `docs/PERSONAL-READY.md:29,48,52` accurately limits the conclusion to the installed unit bytes, observed manager metadata, actual console invocation/arguments and live managed database. It does not claim to attest every cached systemd setting, direct kernel socket ownership or future availability. No new activation, model, database write, credential transmission or service-management operation was introduced by the correction.

No unresolved blocker was found in the reviewed protocol, HTTP framing, SQL boundary or CLI integration on this exact corrected SHA.

Executed verification on `7ffbe5c14c5cf31e90510c6f62ed752a6552b5c3`:

| Command or check | Actual result |
|---|---|
| `python3 -B -m unittest discover -s test -p 'test_personal_ready*.py' -v` | **70 passed, 0 failed, 0 skipped** |
| `node --test test/personal-ready-cli.test.mjs` | **4 passed, 0 failed, 0 skipped** |
| Independent `python3 -I -B` framing matrix and retained-connection socket fixture | **145 checks passed** |
| `git rev-parse HEAD`, `git rev-parse HEAD^{tree}`, `git status --short` | Exact SHA/tree matched; worktree clean |

The prior review also independently executed 53 Node console/readiness/CLI tests on `fde82fa97843d22b3f1a92fb83926cc99d53dcaa`; all passed without skips. The Node server and protocol source/test files are unchanged in this correction. Those 53 executions remain attributed to the original SHA, not represented as a new execution on the corrected SHA. The Python-invoking CLI tests were rerun on the corrected commit as listed above.

First-failure evidence from my new adversarial harness is preserved here: its initial malformed-length cases used a hardcoded 32-byte Content-Length substitution, while the selected body was actually 33 bytes. The substitution therefore left one valid frame unchanged and the harness falsely labeled its acceptance as malformed. I corrected the review harness to derive the declared length from `len(body)` and reran the full 145-check matrix successfully. No repository change or product guard relaxation resulted from that reviewer fixture correction.

This is an explicit independent code-review **PASS for `7ffbe5c14c5cf31e90510c6f62ed752a6552b5c3` only**. Actual ordinary-user systemd, managed PostgreSQL and authenticated HTTP CI is a separate required acceptance gate. I did not run those services in this root-only review environment and do not attribute pending or subsequently reported CI results to this review. Any later application change requires review of its own final full SHA.
