#!/usr/bin/env python3
"""Explicitly gated CI process-death/lock fixtures for the actual coordinator.

The normal checkpoints replace only the coordinator's fault callback. The
sent-before-reply case replaces the one fixed StartUnit call with a real queued
and flushed D-Bus message, then exits without waiting for its reply. Durable
files, all other manager calls and recovery use the production implementation.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import pwd
import select
import sys


CHECKPOINTS = (
    "after_journal", "after_attempt", "after_send_before_reply", "after_start_before_ack", "after_ack",
    "after_receipt", "before_clear_pending",
)
DIAGNOSTIC_FILES = frozenset((
    "personal-activate-crash.py", "personal_activate_manager.py", "personal_ready_process.py",
    "personal_deploy_store.py", "personal-activate.py", "personal-ready.py", "personal-deploy.py",
    "preflight.py", "personal-services.py", "contextlib.py",
))
DIAGNOSTIC_FUNCTIONS = frozenset((
    "main", "diagnose_manager", "manager_process", "connection_identity", "verify_identity",
    "_connect", "_call", "_raw_call", "_bus", "_property", "_timeout", "plain", "need",
    "absolute", "open_dir", "directory", "visible", "_process_snapshot", "_proc_directory",
    "_self_namespaces", "_namespaces", "_read", "_number", "_metadata", "_parse_stat",
    "_parse_status", "_executable", "_process_executable", "__enter__", "__exit__",
))
DIAGNOSTIC_TYPES = frozenset((
    "ActivateManagerError", "ReadyError", "DeployError", "PreflightError", "ServicePlanError",
    "OSError", "PermissionError", "FileNotFoundError", "NotADirectoryError", "IsADirectoryError",
    "TypeError", "AttributeError", "KeyError", "ValueError", "RuntimeError", "ImportError",
    "ModuleNotFoundError", "DBusException", "SystemExit", "AssertionError",
))
# Values are matched exactly; no exception message or arbitrary argument is
# rendered. Unknown errors retain only an allowlisted type and bounded frames.
DIAGNOSTIC_CODES = frozenset((
    "manager_process_unverified", "invalid_manager_pid", "unexpected_manager_executable",
    "manager_identity_changed", "manager_process_changed", "manager_owner_uid_mismatch",
    "invalid_bus_identity", "manager_connection_closed", "manager_timeout", "manager_unavailable",
    "ordinary_linux_account_required", "invalid_manager_reply", "manager_value_limit",
    "invalid_manager_value", "invalid_absolute_path", "unsafe_directory_owner",
    "unsafe_directory_permissions", "process_uid_mismatch", "managed_process_not_readable",
    "invalid_process_id", "invalid_process_uid", "process_not_live", "invalid_proc_stat",
    "invalid_proc_status", "process_identity_changed", "unsafe_proc_entry", "proc_file_too_large",
    "proc_file_changed", "invalid_process_namespace", "process_namespace_mismatch",
    "process_namespace_changed", "unsafe_process_executable", "process_executable_changed",
    "process_executable_mismatch", "directory_changed", "untrusted_system_unit_path",
))


def safe_diagnostic(error):
    """At most six exceptions/eight total frames; never stringify an exception."""
    layers, seen = [], set()
    while error is not None and len(layers) < 6 and id(error) not in seen:
        seen.add(id(error))
        name = type(error).__name__
        args = error.args
        layers.append((error, {"type": name if name in DIAGNOSTIC_TYPES else "OtherError",
            "safe_code": args[0] if len(args) == 1 and type(args[0]) is str
                and args[0] in DIAGNOSTIC_CODES else None,
            "errno": error.errno if isinstance(error, OSError) and type(error.errno) is int
                and 0 <= error.errno <= 4095 else None, "frames": []}))
        error = error.__context__
    remaining = 8
    # Keep the innermost failure's final frames first; wrapper traceback frames
    # must not consume the budget and hide the actual failing guard.
    for error, result in reversed(layers):
        frames, current = [], error.__traceback__
        while current is not None:
            code = current.tb_frame.f_code
            basename = Path(code.co_filename).name
            frames.append({"file": basename if basename in DIAGNOSTIC_FILES else "other",
                "function": code.co_name if code.co_name in DIAGNOSTIC_FUNCTIONS else "other",
                "line": min(max(current.tb_lineno, 0), 1000000)})
            if len(frames) > 8:
                frames.pop(0)
            current = current.tb_next
        result["frames"] = frames[-remaining:] if remaining else []
        remaining -= len(result["frames"])
    return {"diagnostic": "personal_activation_manager", "ok": False,
            "exception_chain": [value for _, value in layers]}


def diagnose_manager(activate):
    manager = activate.MANAGER.LocalManager()
    try:
        manager.connection_identity()  # Read-only identity verification only.
    except Exception as error:
        print(json.dumps(safe_diagnostic(error), ensure_ascii=True))
        return 1
    else:
        print(json.dumps({"diagnostic": "personal_activation_manager", "ok": True,
                          "exception_chain": []}))
        return 0
    finally:
        manager.close()


def load(path):
    spec = importlib.util.spec_from_file_location("ci_personal_activate", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    expected = Path(pwd.getpwuid(os.getuid()).pw_dir) / "ultrabrain-personal-services-test"
    if (sys.platform != "linux" or os.getuid() != os.geteuid() or os.getuid() == 0
            or os.environ.get("GITHUB_ACTIONS") != "true"
            or os.environ.get("ULTRABRAIN_TEST_ALLOW_WRITE") != "1"
            or os.environ.get("ULTRABRAIN_SYSTEMD_TEST") != "1"
            or os.environ.get("ULTRABRAIN_HOME") != str(expected)):
        raise SystemExit("Disposable ordinary-user CI fixture required")
    parser = argparse.ArgumentParser(allow_abbrev=False)
    actions = parser.add_subparsers(dest="action", required=True)
    apply = actions.add_parser("apply", allow_abbrev=False)
    for name in ("home", "bun", "source", "expected-current", "expected-instance", "expected-plan"):
        apply.add_argument("--" + name, required=True)
    apply.add_argument("--port", type=int, required=True)
    apply.add_argument("--checkpoint", choices=CHECKPOINTS, required=True)
    hold = actions.add_parser("hold-lock", allow_abbrev=False)
    hold.add_argument("--home", required=True)
    diagnose = actions.add_parser("diagnose-manager", allow_abbrev=False)
    diagnose.add_argument("--home", required=True)
    args = parser.parse_args()
    if Path(args.home) != expected:
        raise SystemExit("Wrong fixture installation")
    root = Path(__file__).resolve().parent.parent
    activate = load(root / "scripts/personal-activate.py")
    if args.action == "diagnose-manager":
        raise SystemExit(diagnose_manager(activate))

    def crash(label):
        if label == args.checkpoint:
            os._exit(73)  # Abrupt death: no finally block may repair the journal.

    context = activate.Context(expected, fault=crash if args.action == "apply" else None)
    if args.action == "hold-lock":
        with context._held(exclusive=True):
            print("ULTRABRAIN_ACTIVATION_LOCK_READY", flush=True)
            available, _, _ = select.select([sys.stdin], [], [], 30)
            if not available or sys.stdin.readline(32) != "release\n":
                raise SystemExit("Lock fixture requires bounded explicit release")
        print("ULTRABRAIN_ACTIVATION_LOCK_RELEASED", flush=True)
        return
    if args.checkpoint == "after_send_before_reply":
        manager = context.manager
        original = manager._raw_call

        def send_then_die(destination, path, interface, method, signature, values, timeout):
            if method != "StartUnit":
                return original(destination, path, interface, method, signature, values, timeout)
            expected_call = (manager._identity["manager_owner"], activate.MANAGER.MANAGER_PATH,
                             activate.MANAGER.MANAGER, "ss", (activate.MANAGER.CONSOLE, "fail"))
            if (destination, path, interface, signature, values) != expected_call:
                raise SystemExit("Unexpected activation fixture dispatch")
            from dbus.lowlevel import MethodCallMessage
            message = MethodCallMessage(destination, path, interface, method)
            message.set_auto_start(False)
            message.set_allow_interactive_authorization(False)
            message.set_no_reply(False)
            message.append(*values, signature=signature)
            manager.connection.send_message(message)
            # Flush drains only our outgoing queue. It does not establish that
            # the manager accepted StartUnit: sender credential lookup may lose
            # the race with this abrupt exit. The parent has a 75-second bound.
            manager.connection.flush()
            os._exit(73)

        manager._raw_call = send_then_die
    context.apply(bun=args.bun, source=args.source, port=args.port,
                  expected_current=args.expected_current, expected_instance=args.expected_instance,
                  expected_plan=args.expected_plan)
    raise SystemExit("The required activation checkpoint was not reached")


if __name__ == "__main__":
    main()
