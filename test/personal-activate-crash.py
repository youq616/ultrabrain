#!/usr/bin/env python3
"""Explicitly gated CI process-death/lock fixtures for the actual coordinator.

The normal checkpoints replace only the coordinator's fault callback. The
sent-before-reply case replaces the one fixed StartUnit call with a real queued
and flushed D-Bus message, then exits without waiting for its reply. Durable
files, all other manager calls and recovery use the production implementation.
"""
import argparse
import importlib.util
import os
from pathlib import Path
import pwd
import select
import sys


CHECKPOINTS = (
    "after_journal", "after_attempt", "after_send_before_reply", "after_start_before_ack", "after_ack",
    "after_receipt", "before_clear_pending",
)


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
    args = parser.parse_args()
    if Path(args.home) != expected:
        raise SystemExit("Wrong fixture installation")
    root = Path(__file__).resolve().parent.parent
    activate = load(root / "scripts/personal-activate.py")

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
