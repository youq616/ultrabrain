# Capture journal publication and crash boundaries

The client outbox is a local plaintext delivery journal, not a memory database or a server acknowledgement. This module keeps the existing format, event IDs, binding checks, consent, limits, lock ownership and explicit recovery policy. It does not change server tools, migrations, upstream pins, qbrain or automatic capture permissions.

## Behaviour

`src/capture-journal.mjs` provides an internal synchronous publication primitive used by every `CaptureOutbox.#write`: initial binding, new event, attempt bookkeeping and retained/blocked state updates. The caller still owns the queue lock and validates its private directory and authority. The primitive is not a sandbox or public capture permission grant.

A bounded private temporary file is exclusively created, completely written, fsynced and closed before publication. New events use a non-overwriting hard link; updates use the existing rename replacement. A successful new-event link is followed by one unlink of its temporary name. On supported platforms the directory is then fsynced. There is no rename-overwrite fallback for an exclusive create and no retry of permission, busy, disk-full or IO failures.

A failed operation does not delete its temporary evidence, roll back a possibly published destination, invent a successful local receipt or retry a server request. A failed temporary unlink is attempted once, not retried by a finally block. A failed exclusive temporary open never causes an existing path to be removed. Retained temporaries consume the existing queue file/byte limits; they are not promoted or cleaned automatically. A partial initial binding therefore requires explicit inspection and cannot be silently assigned to another profile.

The first write/fsync error survives a subsequent file-close failure. The directory fsync error also survives a directory-close error; these both remain within the `directory-sync` diagnostic boundary. If queue or delivery lock release subsequently fails, an authentic journal error remains primary and up to two authentic lock diagnostics are retained alongside it. Other error types retain their existing behaviour. No filesystem close retry is attempted; a native close failure can leave descriptor state uncertain.

## Safe diagnosis

A local journal failure is `outbox_journal_io`. `captureJournalDiagnostic(error)` recognizes only locally tracked error objects; spreading, cloning or attaching fields to an unrelated error does not create a diagnostic. Only fixed categories and allowlisted native error codes are retained. Unknown codes become null; getters, raw messages, stacks, native paths, event IDs, payloads and credentials are not copied to the diagnostic.

Queue CLI errors include a `journal` object when available. When `queue-capture` has already enqueued an event and its immediate flush fails, `result.queued` remains the local receipt and `result.delivery.journal` / `result.delivery.lock` retain only authentic local IO diagnostics. The automatic-capture manager preserves the same diagnostics under its returned `delivery` object. A remote or copied exception cannot populate them, and neither path upgrades the local receipt to server confirmation. For example:

```json
{"ok":false,"error":"outbox_journal_io","delivery":"unconfirmed","journal":{"target":"entry","operation":"create","phase":"publish","system_code":"EPERM","publication":"unconfirmed","directory_sync":"not_attempted","secondary":[]}}
```

`publication` describes only this local operation:

- `not_attempted`: the destination publication syscall was not invoked; a partial temporary file may exist.
- `unconfirmed`: publication was invoked but did not return successfully. The destination may already have changed. This does not mean “nothing was saved.”
- `visible`: publication returned successfully before a later operation failed. This is not a server receipt or a power-loss guarantee.

`phase` is `create`, `write`, `file-sync`, `close`, `publish`, `temporary-unlink` or `directory-sync`. `target` is only `binding` or `entry`; `operation` is `create` or `replace`. `secondary` contains a later temporary-file close failure, if any. The optional `lock_release` array preserves queue/delivery release failures without copying arbitrary causes. The source-only contention runner uses the same diagnosis.

Existing `queue-status`, `queue-lock` and `queue-recover-lock` safeguards remain. Recovery requires a stopped writer and the exact current lock hash; no age/PID heuristic steals locks. After a crash between hard-link publication and temporary unlink, the record has two names and is deliberately rejected by existing alias checks. No new automatic repair/delete command is introduced. Preserve the whole private journal and inspect it explicitly rather than deleting files to make a check green.

## Verification and limits

`test/capture-journal*.test.mjs` covers real local files with injected IO errors, exclusive-create collisions, primary/secondary failure ordering, uncertainty after a syscall actually changed the filesystem, safe diagnostic projection, consent/attempt boundaries and source CLI processes. The CLI fixture explicitly substitutes the SDK and forbids a connection; it is not a live MCP test.

The crash worker is a real separate Node process. It executes a selected real syscall and immediately exits with code 73 without JS finally cleanup. Reopening verifies the retained lock, requires the existing hash-guarded dead-writer recovery, and checks complete immutable entries, temporaries, alias rejection and persisted attempt scheduling. These tests demonstrate abrupt process-exit behaviour, NOT power loss, kernel crashes, drive-controller caches, all Windows termination mechanisms or network filesystem correctness. The `directory-sync` checkpoint is only exercised on non-Windows platforms because production does not claim directory flushing on Windows.

The existing `capture-locks.yml` Linux/Windows and Node 22.16.0/22 matrix now includes the module tests; all old test commands remain. Local results, remote CI and independent-agent review are separate evidence categories. In particular, safe phase diagnosis and Linux success do not establish the root cause or repair of the earlier Windows `writer_failed` incident.
