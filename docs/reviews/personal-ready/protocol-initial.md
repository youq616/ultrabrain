Independent review verdict: **BLOCK** for full commit **`fde82fa97843d22b3f1a92fb83926cc99d53dcaa`**, tree **`23553b76ec2fab50268c7217fa6ba3c8aa64cd59`**, against base **`d2d8c30b939000b26fe41fc0e5bcab618232ca28`**.

Actual reviewer session identity: **`/root/ready_protocol_review`**. I did not implement this phase, change repository source, start services, commit, or merge.

The blocking finding is in **`scripts/personal-ready.py:180–191`**. `probe_http` waits for the peer to close its TCP connection before passing the accumulated response to `parse_http`. A complete response with a valid, bounded `Content-Length` is consequently rejected as `readiness_timeout` when the peer retains the connection. This defeats readiness for an otherwise successful HTTP exchange. The response is already self-delimited, so EOF must not be an additional success requirement.

I independently reproduced this with a loopback TCP peer that:

1. Read the request.
2. Sent a complete `HTTP/1.1 200 OK` response with `Content-Type: application/json; charset=utf-8`, exact `Content-Length`, `Connection: close`, and the complete JSON body.
3. Retained the TCP connection until the client’s observation deadline expired.

The exact result was:

```json
{"complete_frame_sent":true,"error":"readiness_timeout","elapsed_ms":201}
```

The test supplied a 200 ms deadline. This reproduces the client bug independently of the reported CI failure. I have not independently established which Bun/server behavior caused the CI connection to remain open. Corrected real CI is necessary to connect that failure to the fix.

The correction should recognize a complete bounded HTTP frame, validate its framing, and close the socket once the frame has been received. It must preserve rejection of ambiguous or duplicate headers, malformed or oversized `Content-Length`, compression, transfer encoding, non-200 status, incomplete bodies, and excess bytes already received beyond the single response.

I independently inspected the other principal boundaries and found no additional blocker in them:

- **`src/personal-readiness.mjs:21–37`** authenticates the exact request fields before database access, uses separate request and response HMAC domains, binds the request to the captured invocation and actual origin, and constrains request timestamps. It does not send the bearer credential.
- **`src/personal-readiness.mjs:39–85`** queries the source and database identity in a dedicated read-only transaction, sets local statement and lock timeouts, validates the returned fields, and signs the request binding together with the actual source, invocation, process and database fields.
- **`src/personal-console.mjs:114–134`** keeps timed-out database work within the existing four shared concurrency slots. Its HTTP deadline does not release capacity while the actual operation is unresolved.
- **`scripts/personal-ready.py:91–124`** rejects missing or extra response fields, ambiguous JSON keys, wrong types, forged proofs, and signed responses whose expected source, process, invocation, logical instance or database binding does not match.
- **`scripts/personal-ready.py:248–329`** checks the deployment receipt, generation, visible links, manager state, console process, private database binding, token and database backend, and compares observations around the authenticated request. It exposes the limitations of this observation rather than claiming socket-owner attestation or future health.
- **`src/cli.mjs:37–41`** routes the command to isolated Python without initializing the application database runtime. The production ordinary-user boundary remains intact.
- The documented scope correctly excludes activation, worker readiness, model quality, a frozen source tree, and direct kernel socket ownership.

Executed verification:

| Command or check | Actual result |
|---|---|
| `node --test test/personal-readiness.test.mjs test/personal-ready-cli.test.mjs test/personal-console.test.mjs` | **53 passed, 0 failed, 0 skipped** |
| `python3 -B -m unittest discover -s test -p 'test_personal_ready*.py' -v` | **69 passed, 0 failed, 0 skipped** |
| Independent complete-response/retained-connection counterexample | **Bug reproduced**, as described above |
| Independent HTTP malformed-proof check: valid proof plus appended line feed | **400, no readiness database transaction** |
| Git identity check before the counterexamples | HEAD and tree matched the reviewed SHA/tree; worktree was clean |

The first attempt at my malformed-proof counterexample omitted the fixture engine’s required `kind:'postgres'` field and stopped at the existing `unsupported_engine` guard. After correcting that review fixture, the malformed proof was safely rejected. This was a reviewer fixture error, not a product finding.

I also inspected the pinned GBrain transaction implementation at **`a6be012a3bcfac42e279630aedec5cda4a450e29`**. Its `transaction()` creates a scoped engine bound to the transaction connection, and `executeRaw()` uses that scoped connection, supporting the application’s same-connection use of the local SQL settings. [Pinned PostgreSQL engine](https://github.com/youq616/gbrain/blob/a6be012a3bcfac42e279630aedec5cda4a450e29/src/core/postgres-engine.ts)

PostgreSQL’s documentation confirms that `SET TRANSACTION READ ONLY` applies to the current transaction, and that the timeout settings have the statement/lock meanings used here. These checks do not replace execution against the actual database. [PostgreSQL 18 SET TRANSACTION](https://www.postgresql.org/docs/18/sql-set-transaction.html), [PostgreSQL 18 client connection settings](https://www.postgresql.org/docs/18/runtime-config-client.html)

**Do not accept or merge this SHA.** Preserve this finding and obtain an explicit review of the corrected full commit, followed by the required real systemd/PostgreSQL/HTTP CI acceptance.
