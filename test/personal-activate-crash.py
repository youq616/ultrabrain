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
import re
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
    "main", "diagnose_manager", "diagnose_plan", "manager_process", "connection_identity", "verify_identity",
    "_connect", "_call", "_raw_call", "_bus", "_property", "_timeout", "plain", "need",
    "plan", "_plan", "_observe", "activation_graph", "names", "select", "read",
    "inspect_graph", "inspect_start_graph", "_console_guard", "_load", "_all", "_paths",
    "_row", "_invocation", "__call__", "expected_command",
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
    "invalid_manager_dependencies", "invalid_unit_name", "manager_property_missing",
    "invalid_manager_response", "invalid_unit_object", "unit_alias_refused", "invalid_manager_action",
    "unsupported_manager_unit_paths", "console_unit_unavailable", "invalid_console_invocation",
    "invalid_activation_arguments", "activation_graph_limit", "unsupported_activation_unit",
    "unexpected_activation_unit", "activation_unit_not_stable", "dependency_stop_when_unneeded",
    "invalid_activation_graph", "activation_dependency_not_ready", "database_unit_not_ready",
    "activation_graph_changed", "console_cache_mismatch", "console_dependency_side_effect",
    "console_dependency_mismatch", "console_extra_command", "console_exec_mismatch",
    "console_not_running", "console_must_be_stopped",
))
DIAGNOSTIC_DBUS_ERRORS = {"org.freedesktop.DBus.Error." + name: name for name in (
    "NameHasNoOwner", "ServiceUnknown", "NoReply", "Disconnected", "AccessDenied",
)}
DIAGNOSTIC_SUFFIXES = frozenset((
    "service", "target", "socket", "path", "timer", "slice", "mount", "automount", "scope", "device", "swap",
))
DIAGNOSTIC_UNIT_KINDS = {
    "ultrabrain-personal-console.service": "console", "ultrabrain-postgres.service": "database",
    "ultrabrain-personal.target": "target", "-.slice": "root_slice", "app.slice": "app_slice",
    "basic.target": "basic_target", "sockets.target": "sockets_target",
    "dbus.service": "dbus_service", "dbus.socket": "dbus_socket",
}


def diagnostic_dbus_error(error):
    try:
        method = getattr(error, "get_dbus_name", None)
        value = method() if callable(method) else None
    except Exception:
        return None
    return DIAGNOSTIC_DBUS_ERRORS.get(value) if type(value) is str else None


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
            "dbus_error": diagnostic_dbus_error(error),
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


def diagnostic_errno(error):
    return error.errno if isinstance(error, OSError) and type(error.errno) is int \
        and 0 <= error.errno <= 4095 else None


def diagnostic_status(raw):
    values = {}
    for line in raw.splitlines():
        key, separator, value = line.partition(b":")
        if separator and key in (b"Uid", b"Gid", b"CapPrm", b"CapEff"):
            if key in values:
                raise ValueError()
            fields = value.split()
            if key in (b"Uid", b"Gid"):
                if len(fields) != 4 or not all(re.fullmatch(rb"[0-9]{1,10}", v) for v in fields):
                    raise ValueError()
                values[key] = tuple(int(v) for v in fields)
                if any(v >= 2**32 for v in values[key]):
                    raise ValueError()
            else:
                if len(fields) != 1 or not re.fullmatch(rb"[a-fA-F0-9]{1,16}", fields[0]):
                    raise ValueError()
                values[key] = int(fields[0], 16)
    if set(values) != {b"Uid", b"Gid", b"CapPrm", b"CapEff"}:
        raise ValueError()
    return values


def diagnostic_proc(manager_pid):
    """Read fixed proc fields; disclose only bounded booleans/errno/label enums."""
    result = {}
    for who in ("self", "manager"):
        result.update({who+"_proc_available": False, who+"_proc_errno": None,
                       who+"_process_stable": None, who+"_capprm_nonzero": None})
        for name in ("pid_namespace", "net_namespace", "security_label"):
            result[who+"_"+name+"_readable"] = False
            result[who+"_"+name+"_errno"] = None
        result[who+"_security_label_kind"] = None
    for key in ("self_fsuid_matches_euid", "self_fsgid_matches_egid", "self_capeff_nonzero",
                "manager_directory_owner_matches_self_fsuid", "manager_uids_three_match_self_fsuid",
                "manager_uids_four_match_self_fsuid", "manager_gids_three_match_self_fsgid",
                "manager_gids_four_match_self_fsgid", "manager_capprm_subset_self_capprm",
                "manager_capprm_subset_self_capeff", "pid_namespace_equal", "net_namespace_equal",
                "security_label_equal"):
        result[key] = None
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    root_fd = None

    def read(fd, name, limit):
        child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        try:
            chunks, size = [], 0
            while True:
                block = os.read(child, min(16384, limit-size+1))
                if not block:
                    return b"".join(chunks)
                size += len(block)
                if size > limit:
                    raise ValueError()
                chunks.append(block)
        finally:
            os.close(child)

    def stat_identity(fd, pid):
        raw = read(fd, "stat", 8192)
        end = raw.rfind(b") ")
        if not raw.startswith(str(pid).encode()+b" (") or end < 0:
            raise ValueError()
        fields = raw[end+2:].split()
        if len(fields) < 20 or not re.fullmatch(rb"[0-9]{1,20}", fields[19]):
            raise ValueError()
        return int(fields[19])

    def probe(who, pid):
        fd = None
        private = {"status": None, "owner": None}
        if type(pid) is not int or not 1 <= pid <= 2147483647:
            return private
        try:
            fd = os.open(str(pid), directory_flags, dir_fd=root_fd)
            before = os.fstat(fd)
            private["owner"] = before.st_uid
            started = stat_identity(fd, pid)
            private["status"] = diagnostic_status(read(fd, "status", 65536))
            result[who+"_proc_available"] = True
            result[who+"_capprm_nonzero"] = private["status"][b"CapPrm"] != 0
            for name in ("pid", "net"):
                nsfd = None
                try:
                    nsfd = os.open("ns", directory_flags, dir_fd=fd)
                    value = os.readlink(name, dir_fd=nsfd)
                    if not re.fullmatch(name+r":\[[0-9]{1,20}\]", value):
                        raise ValueError()
                    private[name] = value
                    result[who+"_"+name+"_namespace_readable"] = True
                except (OSError, ValueError) as error:
                    result[who+"_"+name+"_namespace_errno"] = diagnostic_errno(error)
                finally:
                    if nsfd is not None:
                        os.close(nsfd)
            attr = None
            try:
                attr = os.open("attr", directory_flags, dir_fd=fd)
                label = read(attr, "current", 4096).strip()
                private["label"] = label
                result[who+"_security_label_readable"] = True
                result[who+"_security_label_kind"] = "unconfined" if label == b"unconfined" \
                    else "systemd" if label == b"systemd" else "other"
            except (OSError, ValueError) as error:
                result[who+"_security_label_errno"] = diagnostic_errno(error)
            finally:
                if attr is not None:
                    os.close(attr)
            after = os.stat(str(pid), dir_fd=root_fd, follow_symlinks=False)
            result[who+"_process_stable"] = (before.st_dev, before.st_ino, before.st_uid) == \
                (after.st_dev, after.st_ino, after.st_uid) and started == stat_identity(fd, pid) \
                and private["status"] == diagnostic_status(read(fd, "status", 65536))
        except (OSError, ValueError) as error:
            result[who+"_proc_errno"] = diagnostic_errno(error)
        finally:
            if fd is not None:
                os.close(fd)
        return private

    try:
        root_fd = os.open("/proc", directory_flags)
        caller = probe("self", os.getpid())
        target = probe("manager", manager_pid)
        a, b = caller["status"], target["status"]
        if a is not None:
            fsuid, fsgid = a[b"Uid"][3], a[b"Gid"][3]
            result["self_fsuid_matches_euid"] = fsuid == os.geteuid()
            result["self_fsgid_matches_egid"] = fsgid == os.getegid()
            result["self_capeff_nonzero"] = a[b"CapEff"] != 0
            if target["owner"] is not None:
                result["manager_directory_owner_matches_self_fsuid"] = target["owner"] == fsuid
            if b is not None:
                for key, expected, suffix in ((b"Uid", fsuid, "fsuid"), (b"Gid", fsgid, "fsgid")):
                    for size, count in ((3, "three"), (4, "four")):
                        result["manager_"+key.decode().lower()+"s_"+count+"_match_self_"+suffix] = \
                            all(value == expected for value in b[key][:size])
                result["manager_capprm_subset_self_capprm"] = b[b"CapPrm"] & ~a[b"CapPrm"] == 0
                result["manager_capprm_subset_self_capeff"] = b[b"CapPrm"] & ~a[b"CapEff"] == 0
        for key, output in (("pid", "pid_namespace_equal"), ("net", "net_namespace_equal"), ("label", "security_label_equal")):
            if key in caller and key in target:
                result[output] = caller[key] == target[key]
    except (OSError, ValueError) as error:
        result["self_proc_errno"] = result["manager_proc_errno"] = diagnostic_errno(error)
    finally:
        if root_fd is not None:
            os.close(root_fd)
    return result


def diagnose_manager(activate):
    manager = activate.MANAGER.LocalManager()
    try:
        manager.connection_identity()  # Read-only identity verification only.
    except Exception as error:
        value = safe_diagnostic(error)
        value["proc_checks"] = diagnostic_proc(getattr(manager, "manager_pid", None))
        print(json.dumps(value, ensure_ascii=True))
        return 1
    else:
        print(json.dumps({"diagnostic": "personal_activation_manager", "ok": True,
                          "exception_chain": [], "proc_checks": diagnostic_proc(manager.manager_pid)}))
        return 0
    finally:
        manager.close()


def diagnostic_suffix(name):
    suffix = name.rsplit(".", 1)[-1] if type(name) is str else None
    return suffix if suffix in DIAGNOSTIC_SUFFIXES else "other"


def diagnostic_dependency(module, unit, key, value, present):
    unit_kind = DIAGNOSTIC_UNIT_KINDS.get(unit) if type(unit) is str else None
    if unit_kind is None:
        suffix = diagnostic_suffix(unit)
        unit_kind = "other_" + suffix if suffix != "other" else "other"
    value_type = {list: "list", str: "string", int: "integer", bool: "boolean", dict: "object",
                  float: "number", type(None): "null"}.get(type(value), "other") if present else "missing"
    length = len(value) if type(value) is list else None
    strings = all(type(item) is str for item in value) if length is not None and length <= 512 else None
    invalid = [name for name in value if not module.UNIT_NAME.fullmatch(name)] if strings else None
    return {"unit_kind": unit_kind, "property": key, "value_type": value_type,
            "length": min(length, 513) if length is not None else None,
            "over_limit": length > 512 if length is not None else None, "all_strings": strings,
            "has_duplicates": len(value) != len(set(value)) if strings else None,
            "matches_unit_name": not invalid if strings else None,
            "name_over_255": any(len(name) > 255 for name in value) if strings else None,
            "invalid_charset": any(not re.fullmatch(r"[A-Za-z0-9_.:@\\-]+", name) for name in value) if strings else None,
            "invalid_suffixes": sorted({diagnostic_suffix(name) for name in invalid}) if invalid else []}


def diagnose_plan(activate, args):
    manager = activate.MANAGER.LocalManager()
    original = manager._all
    failures, truncated = [], False

    def observe_all(path, interface):
        nonlocal truncated
        raw = original(path, interface)
        if interface == activate.MANAGER.UNIT and type(raw) is dict:
            for key in ("Names", *activate.MANAGER.EDGES):
                try:
                    activate.MANAGER.names(raw.get(key))
                except activate.MANAGER.ActivateManagerError:
                    if len(failures) < 8:
                        failures.append(diagnostic_dependency(activate.MANAGER, raw.get("Id"), key,
                                                              raw.get(key), key in raw))
                    else:
                        truncated = True
        return raw  # Preserve the actual response, including the rejected value.

    manager._all = observe_all
    try:
        context = activate.Context(args.home, manager=manager)
        context.plan(bun=args.bun, source=args.source, port=args.port,
                     expected_current=args.expected_current, expected_instance=args.expected_instance)
    except Exception as error:
        value = safe_diagnostic(error)
        code = 1
    else:
        value = {"ok": True, "exception_chain": []}
        code = 0
    finally:
        manager._all = original
        manager.close()
    value.update(diagnostic="personal_activation_plan", dependency_failures=failures,
                 dependency_failures_truncated=truncated)
    print(json.dumps(value, ensure_ascii=True))
    return code


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
    plan_diagnostic = actions.add_parser("diagnose-plan", allow_abbrev=False)
    for name in ("home", "bun", "source", "expected-current", "expected-instance"):
        plan_diagnostic.add_argument("--" + name, required=True)
    plan_diagnostic.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    if Path(args.home) != expected:
        raise SystemExit("Wrong fixture installation")
    root = Path(__file__).resolve().parent.parent
    activate = load(root / "scripts/personal-activate.py")
    if args.action == "diagnose-manager":
        raise SystemExit(diagnose_manager(activate))
    if args.action == "diagnose-plan":
        raise SystemExit(diagnose_plan(activate, args))

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
