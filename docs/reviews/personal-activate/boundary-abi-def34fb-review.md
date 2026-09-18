# Independent dbus-python ABI crosscheck

Verdict: **NO BLOCKER in the reviewed ABI correction and adjacent call paths.** This is a narrow source/API review, not final approval of the entire development phase.

Actual reviewer: `/root/activate_boundary_review/dbus_abi_crosscheck`.

Reviewed repository: `youq616/ultrabrain`, local HEAD `def34fb9577167bebc6f7d41d0c6bb8138220087`, tree `769471a8c864a94c68e2e3b0edcf187ade7b22a1`. HEAD/tree were checked before and after inspection; the worktree was clean. No repository files were edited. I independently read the actual changed call, strict FakeBus declaration, `_call`, `_raw_call`, `fence_sender`, `start_console`, and the complete activation crash helper.

The source/API findings are:

1. `scripts/personal_activate_manager.py:259` correctly supplies `(message, timeout)` positionally. The pinned distribution source reports version **1.3.2** in [.version](https://github.com/openkylin/dbus-python/blob/f05cf618f62336d77ec2dfbb1d40a97e5a207c7a/.version). In the actual [C binding](https://github.com/openkylin/dbus-python/blob/f05cf618f62336d77ec2dfbb1d40a97e5a207c7a/dbus_bindings/conn-methods.c), line 1056 registers this method with `METH_VARARGS` alone; lines 470–483 parse a message and optional double with `PyArg_ParseTuple`. The library's own [Connection.call_blocking](https://github.com/openkylin/dbus-python/blob/f05cf618f62336d77ec2dfbb1d40a97e5a207c7a/dbus/connection.py), lines 633–635, calls the method using exactly this positional form. [BusConnection](https://github.com/openkylin/dbus-python/blob/f05cf618f62336d77ec2dfbb1d40a97e5a207c7a/dbus/bus.py), line 99, inherits Connection and does not override the method.

2. This is an actual keyword incompatibility, not a cosmetic preference. [CPython 3.12.3 methodobject.c](https://github.com/python/cpython/blob/v3.12.3/Objects/methodobject.c), lines 517–550, rejects nonempty keyword arguments for a `METH_VARARGS` function without `METH_KEYWORDS` before invoking the C callback. The new positional-only FakeBus declaration at `test/test_personal_activate_manager.py:148–150` therefore closes the previously permissive fake's specific gap. It does not by itself prove binary or service integration.

3. Timeout units and errors remain compatible. The C binding's lines 488–502 convert nonnegative seconds to integer milliseconds, reject excessive values, and pass that timeout to libdbus. The manager's `_timeout` at lines 236–240 still supplies a positive remaining interval capped at five seconds; normal sub-millisecond truncation can make a call expire earlier and does not create an unbounded wait. C lines 508–511 raise a DBusException for an error and return a low-level message on success. The [exception conversion](https://github.com/openkylin/dbus-python/blob/f05cf618f62336d77ec2dfbb1d40a97e5a207c7a/dbus_bindings/exceptions.c), lines 68–103, preserves the DBus error name; [DBusException.get_dbus_name](https://github.com/openkylin/dbus-python/blob/f05cf618f62336d77ec2dfbb1d40a97e5a207c7a/dbus/exceptions.py), lines 89–90, exposes it. Thus `fence_sender` still distinguishes the exact NameHasNoOwner error from timeout/disconnect/generic failures, then requires the same manager-owner Ping and identity checks. `start_console` still marks the single attempt before dispatch and maps post-dispatch failures to an uncertain result without retrying.

4. Adjacent message APIs match. In [message.c](https://github.com/openkylin/dbus-python/blob/f05cf618f62336d77ec2dfbb1d40a97e5a207c7a/dbus_bindings/message.c), lines 116–140 accept the existing four constructor arguments; 323–383 implement the existing positional activation, no-reply, and interactive-authorization flag setters; 385–435 and 610–656 expose reply serial, message serial, signature, and sender. Lines 819–824 permit keywords for append/get_args_list. The manager's existing reply header/signature/argument checks remain in place at lines 263–269. No companion keyword correction was identified in these calls.

5. `test/personal-activate-crash.py:69–91` remains compatible: non-StartUnit calls delegate all existing positional arguments to the corrected `_raw_call`; its one exact StartUnit branch uses `send_message(message)` and `flush()`, whose C implementations are at conn-methods.c lines 309–340 and 514–525. Neither API takes the changed timeout argument. Queue flush confirms only draining the outgoing queue, not manager acceptance; the existing helper comment and parent process bound continue to describe that limitation accurately. No service call or fixture gate bypass was used in this review.

Execution and limits: I executed source reads, local diff and clean HEAD/tree checks, and a harmless `/usr/bin/python3 -I -B` module-discovery probe. The probe reports CPython 3.12.3 and `dbus module spec: None`. I did not install dependencies, execute the C binding, run systemd/DBus services, or run the application's test suites; the main reviewer owns the affected test execution and phase verdict. I did not independently verify the exact installed CI distro binary against this source snapshot. Initial direct web fetches returned `DisabledError`; the GitHub plugin successfully retrieved all cited sources at the pinned ref (CPython at tag v3.12.3), so no cited source was inferred from a failed fetch. Real service CI remains a separate requirement.

Retrieved source snapshots are preserved beside this report as `boundary-abi-def34fb-{version,conn-methods.c,message.c,connection.py,exceptions.c,exceptions.py,bus.py,cpython-methodobject.c}`. Their SHA-256 values, respectively:

```text
9fcbb9b4235053ccec377fc2aaddc93caf8f06fe890ec7978bb7abf12e622af1  version
f29d7ca09f371fda965e32937a21fefb0c8c5f258d5adba44da42d862a84c897  conn-methods.c
61d7e3ef3ece8992dba0495471c9544e0694fe1c601d2a7fa2686484e570473a  message.c
3e0315a52aa0a42323bcbb99d4ab6b0996b76a8485e1aab23b196a130fcf6b2b  connection.py
0a4ded407fad4ac0b0a2e9919e5b22b6eca1776d6c3ae892ee65044cca5508f1  exceptions.c
ab60e6e19753c783d7f139fc392aba364711827912afa1eda495e7c0b8e4e636  exceptions.py
a493f42eeff277a757bfd18ca099ac4dffc67906fe7fd1325bf9c04e30370bd7  bus.py
b5266338d6371b11d0e783007ce40ec6630404735d93e08bb7934071aa18d016  cpython-methodobject.c
```

Late scope note: the parent reviewer reported that the candidate real-services first plan now fails with manager_process_unverified before any activation checks. I have not independently investigated that result. This narrow ABI no-blocker verdict does not cover that separate failure and must not be read as whole-phase or CI approval.
