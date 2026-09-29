# Explicit capture delivery pause and resume

This is a **local delivery gate**, not server revocation, a stop-capture switch,
queue encryption, or a new memory store. It is built into `ultrabrain-client` and
all automatic adapters that use the shared capture outbox. Existing capture
consent, automatic scopes, immutable event replay, destination/actor/project/
workspace bindings and retry limits remain mandatory and unchanged.

## Commands

Use the same trusted private profile that owns the queue. Neither command reads
stdin, starts the configured server, makes a network call, changes the profile,
resets attempts, retries blocked entries, or automatically flushes the queue.

```sh
ultrabrain-client queue-pause --profile /absolute/private/profile.json
ultrabrain-client queue-status --profile /absolute/private/profile.json
ultrabrain-client queue-resume --profile /absolute/private/profile.json --expected-sha CURRENT_PAUSE_SHA256 --confirm-resume
```

Replace `CURRENT_PAUSE_SHA256` with `result.control_sha256` from the successful
pause command, or `result.delivery.control_sha256` from a current queue-status
inspection. The checksum must be exactly 64 lower-case hexadecimal characters.
It is an observation for compare-and-swap, **not a secret or authorization token**.
There is no force-resume option. Every successful pause creates a new revision
and random change ID, even if the queue was already paused. A stale observation,
an already-running state, or a competing resume returns `conflict` without
changing the control or events. Inspect again rather than blindly retrying.

After resuming, a separately authorized `queue-flush` or subsequent automatic
capture may deliver eligible entries. Resume does not bypass backoff or unblock
an event. Existing `queue-flush --retry-blocked` remains a separate explicit
operation; it cannot bypass the pause gate.

Successful pause/resume output contains `local_control: "confirmed"` and
`delivery: "not_submitted"`. An error after entering the local operation reports
`local_control: "unconfirmed"`; it does not prove the old or requested state.
Inspect current status before taking further action. Authentic `journal`
diagnostics distinguish preparation, publication and directory-sync failures;
paths, raw error messages, payloads and server credentials are not returned.
A failed command is not automatically retried, rolled back or treated as success.

## What pausing does and does not stop

A paused queue can still receive explicitly consented input, including enabled
automatic-capture scopes. The original plaintext event remains in the private
local journal. `queue-capture` can therefore return a valid local queued receipt
alongside `outbox_paused` and a nonzero exit status. That is not server acceptance.
To stop capture itself, revoke the capture profile/automatic scopes separately.
A disabled capture profile may pause its own queue but cannot resume delivery.

A flush checks the gate before acquiring the delivery lease, after queue waits,
before reserving an attempt and at the existing last-mile authorization checks
around identity/registration/capture. A pause can complete while a network call
is in flight because it uses only the short queue lock. An already-dispatched
request cannot be recalled. A valid server receipt still completes local
acknowledgement deletion; an uncertain result retains the original event for
idempotent recovery. An attempt already durably reserved before a concurrent
pause may remain consumed. A pause observed before reservation consumes none.
A pause between entries returns earlier confirmed deliveries and remaining
counts instead of replacing the entire batch with a misleading total failure.

The cooperative check-to-network-dispatch gap is not a cross-process atomic
revocation barrier. A call that passed its last check can race with pause.
Direct non-queue capture, other client versions or another queue are outside
this gate. Resume is not a guarantee of continuous authorization: the normal
live-profile and server-identity checks still run before sending.

## Storage, corruption and failure boundaries

`delivery-control.json` is a bounded, canonical UTF-8 JSON record with exactly
`format`, `binding_sha256`, `state`, `revision`, `change_id` and `changed_at`.
It is private, has one file link and is bound to this journal. New queues without
this file have legacy running state, revision zero and no checksum; status does
not create a control record. Old clients that validate the original filename
allowlist refuse a queue containing this new file rather than silently deliver.
Coordinate upgrades for every writer using this queue; do not delete the control
to work around an old client.

State changes use the existing atomic journal publication: exclusive private
temporary write, fsync and close, then non-overwriting initial publication or
replacement. Errors preserve prepared evidence and the original primary IO
diagnostic, including subsequent lock-release diagnostics. There is no native
permission retry, overwrite fallback, stale-lock stealing or automatic repair.
Unexpected names, excessive file inventory, malformed/oversized/aliased control,
wrong binding or revision exhaustion refuse mutation/delivery. Operator recovery
of a crashed lock remains separate from resuming delivery. Temporary evidence is
bounded by the existing inventory limit, not silently removed to make room.

The owner account is trusted. A checksum does not prevent that account from
rewriting/deleting files; deletion cannot be distinguished from a legacy absent
control. Do not manually delete or roll back gate files. This is not an audit
ledger or a security sandbox. Successful file/directory fsync is not a general
power-loss guarantee. Windows retains the existing file-fsync-only boundary;
directory flush is unavailable there. A SIGKILL-after-ack test is not a hardware
power-cut test.

## Verification

```sh
node --test test/capture-delivery-control*.test.mjs
node scripts/check-capture-delivery-control.mjs --rounds 25
```

The checker only creates private temporary synthetic queues. Each round starts
eight independent Node processes, queues eight synthetic entries while paused,
and makes them compete to resume the same observation. Exactly one succeeds;
seven must conflict. Entry bytes and attempts must be unchanged and no lock or
temporary file may remain. It takes no user profile or queue directory and makes
zero server/model calls. Source CLI unit tests explicitly substitute SDK imports;
packaged CLI verification uses the real pinned SDK and blocks unexpected server
starts. Neither kind alone is live MCP/PostgreSQL or actual Agent-engine testing.

See `docs/reviews/capture-delivery-control/REVIEW.md` for exact evidence and open
gates. Draft status and older CI/reviewer results are not release approval.
