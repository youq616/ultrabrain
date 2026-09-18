# Independent preliminary activation boundary review

- Reviewer: `/root/activate_boundary_review`, a separate reviewer agent; no implementation edits.
- Repository: `youq616/ultrabrain`.
- Worktree base commit: `5b3c88826984a9b5c8b34ca2cf7ffff171501697`.
- Preliminary staged tree reported by coordinator: `f203331b8ead055d57d1b72d4dc3eed439bdb5dd`.
- Review scope: uncommitted activation work; this is not approval of an application commit.
- Preliminary verdict: **BLOCK** pending the device following-set fix and final committed-SHA review.

## P1 — Canonical device can hide a following sibling's startup dependencies

At the reviewed worktree, `scripts/personal_activate_manager.py:64` accepts `.device` graph members and lines 435–437 accept a loaded, stable member when its `Following` property is empty. This does not establish that systemd's following set is empty.

In systemd v255, `transaction.c:1018–1027` recursively expands `unit_following_set()` before recursively processing ordinary dependency atoms. In `device.c:958–959`, the canonical `sys-*` device returns no `Following` unit. Nevertheless, `device_following_set()` at lines 993–1001 adds the other device units with the same sysfs identity. Their Wants/Requires dependencies can therefore join the transaction even though the activation inspector never visits those siblings. A start through an already active canonical device can pull in an inactive Worker via its follower's Wants.

I independently fetched these primary source files at fixed commit `db11bab38ccf1ed257f310d29070843d4c58ea01` through GitHub:

- [systemd transaction.c](https://github.com/systemd/systemd/blob/db11bab38ccf1ed257f310d29070843d4c58ea01/src/core/transaction.c)
- [systemd device.c](https://github.com/systemd/systemd/blob/db11bab38ccf1ed257f310d29070843d4c58ea01/src/core/device.c)
- [systemd unit.c](https://github.com/systemd/systemd/blob/db11bab38ccf1ed257f310d29070843d4c58ea01/src/core/unit.c)

Executed reproduction: imported the existing manager test fixtures without changing repository code; added an active `sys-devices-virtual-review.device` to `basic.target.Wants`; added a separate `dev-review.device` with `Following` set to the canonical unit and `Wants` set to `ultrabrain-personal-worker.service`; called `inspect_start_graph`. Actual output:

```text
{'accepted': True, 'start_units': ['-.slice', 'app.slice', 'basic.target', 'dbus.socket', 'sockets.target', 'sys-devices-virtual-review.device', 'ultrabrain-personal-console.service', 'ultrabrain-postgres.service'], 'follower_seen': False, 'worker_seen': False}
```

The reproduction is a controlled graph fixture. It demonstrates the inspector omission, with systemd's primary source supplying the corresponding transaction behavior. I did not start a real Worker or manipulate a live user manager. The simplest bounded correction is to reject `.device` graph nodes; `.swap`, which also has following sets, should remain refused. The coordinator accepted this as blocking and assigned the fix and regression to the manager implementer.

## Executed checks before the fix

All commands ran from `/workspace/scratch/be43dca0ab34/ultrabrain`:

| Command | Actual result |
| --- | --- |
| `python3 -B -m unittest discover -s test -p 'test_personal_activate_manager.py' -v` | 47 tests passed |
| `python3 -B -m unittest discover -s test -p 'test_personal_ready.py' -v` | 29 tests passed |
| `python3 -B -m unittest discover -s test -p 'test_personal_deploy.py' -v` | 87 tests passed |
| `node --test test/personal-activate-cli.test.mjs` | 6 tests passed |
| `/usr/bin/python3 -I -B -c 'import dbus; ...'` dependency/API probe | First result: `ModuleNotFoundError: No module named 'dbus'`; exit 1 |

The last failure is an environment limitation, not a passed adapter test. No dependency was installed and no ordinary-user gate was bypassed. Real D-Bus/systemd/PostgreSQL activation and recovery remain unexecuted by this reviewer and must be distinguished from fixture tests.

## Other independently inspected boundaries

The v255 transaction dependency atoms were compared with the inspector's selected start, verify and stop closures using [unit-dependency-atom.c](https://github.com/systemd/systemd/blob/db11bab38ccf1ed257f310d29070843d4c58ea01/src/core/unit-dependency-atom.c). Ordinary Requires/Wants/BindsTo/Upholds, Requisite and conflict/stop propagation map to the selected closures. The following-set omission above is the exception found so far.

For the recovery fence, I independently inspected the fixed v255 request handler, the same-UID synchronous authorization branch, and sd-bus receive-queue processing/Ping handler in `dbus-unit.c`, `bus-polkit.c`, `bus-convenience.c` and `sd-bus.c`. The supported same-UID v255 constraint is material: this is not a general proof for asynchronous polkit handlers. A barrier alone is not proof of job completion; the subsequent job/state/readiness checks remain necessary. The D-Bus API documentation says the local Disconnected notification follows queued incoming messages. Actual Ubuntu daemon failure scheduling has not been experimentally reproduced in this review.

The documented bounded selection of cached execution settings, cooperative same-UID maintenance window, lack of source freezing or socket ownership proof, historical-receipt `application_ready: "not_checked"`, and lack of cross-manager-restart recovery were retained as explicit scope limits. I inspected public CLI isolation, shared deployment reservation exclusion, immutable intent/attempt/ack/receipt ordering, and the close-before-lock-release path. Final approval still requires reinspection of the entire exact application commit after corrections.
